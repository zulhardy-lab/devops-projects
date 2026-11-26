"""Tiny web app for the load-balancing and autoscaling demo.

GET /         does some CPU work, then replies with the name of the pod that served it
              (repeat the request to see different pods answering = load balancing)
GET /healthz  cheap health check for Kubernetes
"""

import math
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
WORK = int(os.environ.get("CPU_WORK_ITERATIONS", "1000000"))
POD = socket.gethostname()


def burn_cpu(iterations: int) -> float:
    x = 0.0001
    for _ in range(iterations):
        x += math.sqrt(x)
    return x


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: str) -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 (name required by BaseHTTPRequestHandler)
        if self.path == "/healthz":
            self._reply(200, "ok\n")
        elif self.path == "/":
            burn_cpu(WORK)
            self._reply(200, f"OK from {POD}\n")
        else:
            self._reply(404, "not found\n")

    def log_message(self, fmt: str, *args) -> None:  # keep logs quiet under load
        pass


if __name__ == "__main__":
    print(f"hpa-demo listening on :{PORT} as {POD}", flush=True)
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
