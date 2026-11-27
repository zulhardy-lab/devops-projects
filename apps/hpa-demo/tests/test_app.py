"""Unit tests for apps/hpa-demo/app/app.py (standard library only, no extra packages needed).

Run: python3 -m unittest discover -s apps/hpa-demo/tests -v
"""

import importlib.util
import json
import pathlib
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

APP_FILE = pathlib.Path(__file__).resolve().parents[1] / "app" / "app.py"
spec = importlib.util.spec_from_file_location("hpa_demo_app", APP_FILE)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class BurnCpuTest(unittest.TestCase):
    def test_returns_a_growing_number(self):
        self.assertGreater(app.burn_cpu(1000), 0.0001)

    def test_zero_iterations_returns_start_value(self):
        self.assertEqual(app.burn_cpu(0), 0.0001)


class HandlerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.WORK = 1000  # keep tests fast
        app.BURN_MS = 5
        app.KUBE = app.Kube(pathlib.Path("/nonexistent"))  # never a real cluster, even if run inside one
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path, accept=None, headers=False):
        req = urllib.request.Request(self.base + path, headers={"Accept": accept} if accept else {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                out = (r.status, r.read().decode(), r.headers.get("Content-Type"))
                return out + (r.headers,) if headers else out
        except urllib.error.HTTPError as e:
            out = (e.code, e.read().decode(), e.headers.get("Content-Type"))
            return out + (e.headers,) if headers else out

    def test_healthz(self):
        status, body, _ = self.get("/healthz")
        self.assertEqual((status, body), (200, "ok\n"))

    def test_root_names_the_pod(self):
        status, body, ctype = self.get("/")
        self.assertEqual(status, 200)
        self.assertEqual(body, f"OK from {app.POD}\n")
        self.assertTrue(ctype.startswith("text/plain"))

    def test_unknown_path_is_404(self):
        status, body, _ = self.get("/nope")
        self.assertEqual((status, body), (404, "not found\n"))

    def test_browser_gets_the_dashboard(self):
        status, body, ctype, h = self.get("/", accept="text/html,application/xhtml+xml", headers=True)
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith("text/html"))
        self.assertIn("<title>hpa-demo", body)
        self.assertIn("default-src 'self'", h.get("Content-Security-Policy"))
        self.assertEqual(h.get("X-Content-Type-Options"), "nosniff")

    def test_burn_names_the_pod(self):
        status, body, ctype = self.get("/burn")
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith("application/json"))
        self.assertEqual(json.loads(body), {"pod": app.POD})

    def test_state_outside_a_cluster(self):
        status, body, _ = self.get("/api/state")
        self.assertEqual(status, 200)
        state = json.loads(body)
        self.assertFalse(state["available"])
        self.assertEqual(state["servedBy"], app.POD)

    def test_static_files_and_nothing_else(self):
        for path, kind in (("/static/app.js", "text/javascript"), ("/static/app.css", "text/css")):
            status, body, ctype = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertTrue(ctype.startswith(kind), path)
            self.assertTrue(body, path)
        for path in ("/static/../app.py", "/static/index.html", "/static/", "/app.py"):
            self.assertEqual(self.get(path)[0], 404, path)


class ParseCpuTest(unittest.TestCase):
    def test_units(self):
        self.assertEqual(app.parse_cpu("250m"), 250)
        self.assertEqual(app.parse_cpu("1"), 1000)
        self.assertAlmostEqual(app.parse_cpu("12345678n"), 12.345678)
        self.assertAlmostEqual(app.parse_cpu("500u"), 0.5)
        self.assertEqual(app.parse_cpu(""), 0)


class BurnForTest(unittest.TestCase):
    def test_uses_at_least_the_cpu_time_asked_for(self):
        start = time.thread_time()
        app.burn_for(15)
        self.assertGreaterEqual(time.thread_time() - start, 0.015)


def pod(name, node="dev01", ready=True, phase="Running", deleting=False):
    meta = {"name": name, "creationTimestamp": "2026-11-27T08:58:00Z"}
    if deleting:
        meta["deletionTimestamp"] = "2026-11-27T09:00:00Z"
    return {"metadata": meta, "spec": {"nodeName": node},
            "status": {"phase": phase, "conditions": [{"type": "Ready", "status": "True" if ready else "False"}]}}


class BuildStateTest(unittest.TestCase):
    PODS = {"items": [pod("hpa-demo-b"), pod("hpa-demo-a"), pod("hpa-demo-c", ready=False, phase="Pending"),
                      pod("hpa-demo-d", deleting=True)]}
    METRICS = {"items": [
        {"metadata": {"name": "hpa-demo-a"}, "containers": [{"usage": {"cpu": "75000000n"}}]},
        {"metadata": {"name": "hpa-demo-b"}, "containers": [{"usage": {"cpu": "40m"}}, {"usage": {"cpu": "10m"}}]},
    ]}
    HPA = {"spec": {"minReplicas": 1, "maxReplicas": 5, "metrics": [
               {"type": "Resource", "resource": {"name": "cpu", "target": {"type": "Utilization", "averageUtilization": 50}}}]},
           "status": {"currentReplicas": 3, "desiredReplicas": 4, "lastScaleTime": "2026-11-27T08:59:00Z",
                      "currentMetrics": [{"type": "Resource", "resource": {"name": "cpu", "current": {"averageUtilization": 62}}}]}}

    def test_pods_sorted_with_state_node_and_cpu(self):
        s = app.build_state(self.PODS, self.HPA, self.METRICS, "me")
        self.assertTrue(s["available"])
        self.assertEqual(s["servedBy"], "me")
        by = {p["name"]: p for p in s["pods"]}
        self.assertEqual([p["name"] for p in s["pods"]], ["hpa-demo-a", "hpa-demo-b", "hpa-demo-c", "hpa-demo-d"])
        self.assertEqual((by["hpa-demo-a"]["state"], by["hpa-demo-a"]["cpuPercent"]), ("Ready", 75))
        self.assertEqual(by["hpa-demo-b"]["cpuPercent"], 50)  # containers added up
        self.assertEqual((by["hpa-demo-c"]["state"], by["hpa-demo-c"]["cpuPercent"]), ("Starting", None))
        self.assertEqual(by["hpa-demo-d"]["state"], "Terminating")
        self.assertEqual(by["hpa-demo-a"]["node"], "dev01")
        self.assertEqual(by["hpa-demo-a"]["created"], "2026-11-27T08:58:00Z")

    def test_autoscaler(self):
        a = app.build_state(self.PODS, self.HPA, self.METRICS, "me")["autoscaler"]
        self.assertEqual(a, {"min": 1, "max": 5, "targetPercent": 50, "cpuPercent": 62, "current": 3, "desired": 4,
                             "lastScaleTime": "2026-11-27T08:59:00Z"})

    def test_missing_hpa_and_metrics(self):
        s = app.build_state(self.PODS, None, None, "me")
        self.assertIsNone(s["autoscaler"])
        self.assertTrue(all(p["cpuPercent"] is None for p in s["pods"]))


if __name__ == "__main__":
    unittest.main()
