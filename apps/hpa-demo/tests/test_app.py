"""Unit tests for apps/hpa-demo/app/app.py (standard library only, no extra packages needed).

Run: python3 -m unittest discover -s apps/hpa-demo/tests -v
"""

import importlib.util
import pathlib
import threading
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
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as r:
                return r.status, r.read().decode(), r.headers.get("Content-Type")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(), e.headers.get("Content-Type")

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


if __name__ == "__main__":
    unittest.main()
