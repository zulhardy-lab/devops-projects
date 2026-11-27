"""Tiny web app for the load-balancing and autoscaling demo, with a live dashboard.

GET /            browsers (Accept: text/html): the dashboard page
                 everything else (curl, wget, the load generator): does some CPU work, then replies
                 "OK from <pod>" (repeat the request to see different pods answering = load balancing)
GET /burn        uses a fixed slice of CPU time (BURN_MS), then replies with the pod's name as JSON.
                 The dashboard's load slider sends these at a steady rate.
GET /api/state   the app's pods, their CPU and the autoscaler, read from the Kubernetes API (read-only,
                 own namespace, with the "app-reader" ServiceAccount). Outside a cluster: {"available": false}
GET /healthz     cheap health check for Kubernetes
GET /static/...  the dashboard's CSS and JavaScript

Standard library only.
"""

import json
import math
import os
import pathlib
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
WORK = int(os.environ.get("CPU_WORK_ITERATIONS", "1000000"))
BURN_MS = int(os.environ.get("BURN_MS", "20"))  # CPU time per /burn request
APP_LABEL = os.environ.get("APP_LABEL", "app=hpa-demo")
HPA_NAME = os.environ.get("HPA_NAME", "hpa-demo")
CPU_REQUEST_M = int(os.environ.get("CPU_REQUEST_MILLICORES", "100"))  # matches the Deployment's request
POD = socket.gethostname()

STATIC = pathlib.Path(__file__).resolve().parent / "static"
FILES = {  # the only files served; nothing else on disk is reachable
    "/static/app.css": ("app.css", "text/css; charset=utf-8"),
    "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
SA_DIR = pathlib.Path(os.environ.get("SA_DIR", "/var/run/secrets/kubernetes.io/serviceaccount"))
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


def burn_cpu(iterations: int) -> float:
    x = 0.0001
    for _ in range(iterations):
        x += math.sqrt(x)
    return x


def burn_for(ms: int) -> None:
    """Use about `ms` milliseconds of this thread's CPU time (not wall time), whatever the processor's speed."""
    end = time.thread_time() + ms / 1000
    x = 0.0001
    while time.thread_time() < end:
        for _ in range(1000):
            x += math.sqrt(x)


def parse_cpu(quantity: str) -> float:
    """Kubernetes CPU quantity -> millicores: '250m' -> 250, '1' -> 1000, '12345678n' -> 12.3, 'u' = micro."""
    if not quantity:
        return 0.0
    units = {"n": 1e-6, "u": 1e-3, "m": 1.0}
    if quantity[-1] in units:
        return float(quantity[:-1]) * units[quantity[-1]]
    return float(quantity) * 1000


def build_state(pods: dict, hpa: dict | None, metrics: dict | None, served_by: str) -> dict:
    """Turn raw Kubernetes API answers into what the dashboard draws. Pure function, so it is unit-tested."""
    usage = {}
    for item in (metrics or {}).get("items", []):
        usage[item["metadata"]["name"]] = sum(parse_cpu(c.get("usage", {}).get("cpu", "0"))
                                              for c in item.get("containers", []))
    out = []
    for p in pods.get("items", []):
        meta, spec, status = p.get("metadata", {}), p.get("spec", {}), p.get("status", {})
        name = meta.get("name", "")
        conds = {c.get("type"): c.get("status") for c in status.get("conditions", [])}
        ready = conds.get("Ready") == "True"
        if meta.get("deletionTimestamp"):
            phase = "Terminating"
        elif ready:
            phase = "Ready"
        else:
            phase = "Starting" if status.get("phase") in ("Pending", "Running") else status.get("phase", "Unknown")
        cpu_m = usage.get(name)
        out.append({
            "name": name,
            "node": spec.get("nodeName") or "",
            "created": meta.get("creationTimestamp"),
            "state": phase,
            "cpuMillicores": round(cpu_m, 1) if cpu_m is not None else None,
            "cpuPercent": round(cpu_m / CPU_REQUEST_M * 100) if cpu_m is not None else None,
        })
    out.sort(key=lambda x: x["name"])

    auto = None
    if hpa:
        spec, status = hpa.get("spec", {}), hpa.get("status", {})
        target = None
        for m in spec.get("metrics", []):
            if m.get("type") == "Resource" and m["resource"].get("name") == "cpu":
                target = m["resource"].get("target", {}).get("averageUtilization")
        current = None
        for m in status.get("currentMetrics", []) or []:
            if m.get("type") == "Resource" and m["resource"].get("name") == "cpu":
                current = m["resource"].get("current", {}).get("averageUtilization")
        auto = {
            "min": spec.get("minReplicas", 1),
            "max": spec.get("maxReplicas"),
            "targetPercent": target,
            "cpuPercent": current,
            "current": status.get("currentReplicas"),
            "desired": status.get("desiredReplicas"),
            "lastScaleTime": status.get("lastScaleTime"),
        }
    return {"available": True, "servedBy": served_by, "pods": out, "autoscaler": auto, "time": int(time.time())}


class Kube:
    """Read-only Kubernetes API client using the pod's own ServiceAccount token."""

    def __init__(self, sa_dir: pathlib.Path = SA_DIR):
        host, port = os.environ.get("KUBERNETES_SERVICE_HOST"), os.environ.get("KUBERNETES_SERVICE_PORT", "443")
        self.ok = bool(host) and (sa_dir / "token").exists()
        if not self.ok:
            return
        self.base = f"https://{host}:{port}"
        self.sa_dir = sa_dir
        self.namespace = (sa_dir / "namespace").read_text().strip()
        self.ctx = ssl.create_default_context(cafile=str(sa_dir / "ca.crt"))

    def get(self, path: str) -> dict | None:
        token = (self.sa_dir / "token").read_text().strip()  # re-read: Kubernetes rotates it
        req = urllib.request.Request(self.base + path, headers={"Authorization": f"Bearer {token}",
                                                                "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=3, context=self.ctx) as r:
                return json.load(r)
        except (urllib.error.URLError, OSError, ValueError):
            return None


KUBE = None
_cache = {"at": 0.0, "state": None}
_cache_lock = threading.Lock()


def cluster_state() -> dict:
    """The dashboard's data, at most once a second per pod (many open pages don't flood the API)."""
    global KUBE
    with _cache_lock:
        if KUBE is None:
            KUBE = Kube()
        if not KUBE.ok:
            return {"available": False, "servedBy": POD, "reason": "Not running in Kubernetes"}
        if _cache["state"] and time.monotonic() - _cache["at"] < 1:
            return _cache["state"]
        ns, sel = KUBE.namespace, urllib.request.quote(APP_LABEL)
        pods = KUBE.get(f"/api/v1/namespaces/{ns}/pods?labelSelector={sel}")
        if pods is None:
            return {"available": False, "servedBy": POD, "reason": "Can't read the Kubernetes API"}
        hpa = KUBE.get(f"/apis/autoscaling/v2/namespaces/{ns}/horizontalpodautoscalers/{HPA_NAME}")
        metrics = KUBE.get(f"/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods?labelSelector={sel}")
        state = build_state(pods, hpa, metrics, POD)
        state["namespace"] = ns
        _cache.update(at=time.monotonic(), state=state)
        return state


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: str | bytes, ctype: str = "text/plain; charset=utf-8",
               cache: str = "no-store") -> None:
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 (name required by BaseHTTPRequestHandler)
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self._reply(200, "ok\n")
        elif path == "/" and "text/html" in self.headers.get("Accept", ""):
            self._reply(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif path == "/":
            burn_cpu(WORK)
            self._reply(200, f"OK from {POD}\n")
        elif path == "/burn":
            burn_for(BURN_MS)
            self._reply(200, json.dumps({"pod": POD}), "application/json")
        elif path == "/api/state":
            self._reply(200, json.dumps(cluster_state()), "application/json")
        elif path in FILES:
            name, ctype = FILES[path]
            self._reply(200, (STATIC / name).read_bytes(), ctype, "max-age=300")
        else:
            self._reply(404, "not found\n")

    def log_message(self, fmt: str, *args) -> None:  # keep logs quiet under load
        pass


if __name__ == "__main__":
    print(f"hpa-demo listening on :{PORT} as {POD}", flush=True)
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
