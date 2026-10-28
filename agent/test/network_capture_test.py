import http.client
import http.server
import importlib.util
import json
import pathlib
import socket
import threading
import time
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).resolve().parents[1] / "src" / "network-proxy.py"
spec = importlib.util.spec_from_file_location("traffic_proxy", source)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
from network_capture import BodyPreview, Capture, error_kind, safe_headers


def until(predicate):
    deadline = time.monotonic() + 3
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("condition did not become true")
        time.sleep(.01)


class StoreTests(unittest.TestCase):
    def test_preview_is_explicit_bounded_and_text_only(self):
        hidden = BodyPreview(False, "application/json")
        hidden.add(b'{"password":"sample"}')
        self.assertIsNone(hidden.snapshot()["text"])
        visible = BodyPreview(True, "application/json")
        visible.add(b"x" * 9000)
        self.assertEqual(visible.snapshot()["capturedBytes"], 4096)
        self.assertTrue(visible.snapshot()["truncated"])
        self.assertEqual(BodyPreview(True, "image/png").snapshot()["reason"], "binary")
        self.assertEqual(BodyPreview(True, "text/plain", "gzip").snapshot()["reason"], "encoded")

    def test_text_previews_and_metadata_remain_within_status_budget(self):
        store = Capture()
        store.start(bodies=True)
        for n in range(200):
            item = store.event("POST", "http://example.test/" + '"' * 2048)
            values = safe_headers([("Content-Type", '"' * 300)] * 16)
            store.change(item, requestHeaders=values, responseHeaders=values)
            for direction in ("bytesSent", "bytesReceived"):
                preview = BodyPreview(True, "text/plain")
                store.progress(item, direction, b'"' * 4096, preview)
            store.finish(item)
        encoded = json.dumps(store.snapshot(), ensure_ascii=False).encode("utf-8")
        self.assertLess(len(encoded), 8 * 1024 * 1024)
        self.assertEqual(safe_headers([("Content-Type", "\x00")])[0]["value"], " ")
        self.assertEqual(safe_headers([("Content-Type", "application/json")])[0]["value"], "application/json")
        binary = BodyPreview(True, "text/plain")
        binary.add(b"\x00")
        self.assertEqual(binary.snapshot()["reason"], "binary")
        invalid = BodyPreview(True, "text/plain")
        invalid.add(b"\xff" * 4096)
        self.assertLessEqual(len(invalid.snapshot()["text"].encode("utf-8")), 4096)
        self.assertTrue(invalid.snapshot()["truncated"])

    def test_stopping_freezes_records_without_claiming_completion(self):
        store = Capture()
        store.start()
        entry = store.event("GET", "http://example.test/path?token=sample")
        store.progress(entry, "bytesReceived", b"abc")
        store.stop("time_limit")
        store.progress(entry, "bytesReceived", b"ignored")
        store.finish(entry)
        state = store.snapshot()
        self.assertEqual(state["stopReason"], "time_limit")
        self.assertEqual(state["entries"][0]["outcome"], "stopped")
        self.assertEqual(state["entries"][0]["bytesReceived"], 3)
        self.assertNotIn("sample", json.dumps(state))
        capture_id = state["captureId"]
        store.start(True, True)
        self.assertNotEqual(store.snapshot()["captureId"], capture_id)
        self.assertTrue(store.snapshot()["captureBodies"])

    def test_eviction_and_live_progress_are_explicit(self):
        store = Capture()
        store.start()
        for n in range(205):
            item = store.event("GET", "http://example.test/" + str(n))
            store.phase(item, "receive")
            store.progress(item, "bytesReceived", b"abc")
        state = store.snapshot()
        self.assertEqual((len(state["entries"]), state["totalCaptured"], state["evicted"]), (200, 205, 5))
        self.assertEqual(state["entries"][-1]["outcome"], "pending")
        self.assertEqual(state["entries"][-1]["bytesReceived"], 3)
        self.assertGreaterEqual(state["entries"][-1]["elapsedMs"], 0)
        self.assertGreaterEqual(state["entries"][-1]["timings"]["receive"], 0)

    def test_transport_errors_use_safe_categories(self):
        for error, expected in [(socket.gaierror("private"), "dns"), (TimeoutError("private"), "timeout"),
                                (ConnectionRefusedError("private"), "refused"), (http.client.IncompleteRead(b"", 10), "incomplete")]:
            store = Capture()
            store.start()
            item = store.event("GET", "http://example.test/api")
            store.change(item, status=200, statusSource="upstream")
            store.phase(item, "receive")
            store.finish(item, error)
            row = store.snapshot()["entries"][0]
            self.assertEqual(row["errorKind"], expected)
            self.assertEqual(row["outcome"], "error")
            self.assertEqual(row["status"], 200)
            self.assertEqual(row["errorPhase"], "receive")
            self.assertNotIn("private", json.dumps(row))


class ProxyTests(unittest.TestCase):
    def setUp(self):
        m.capture = Capture()
        m.capture.start()
        self.release = threading.Event()
        outer = self
        class Origin(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read()

            def do_GET(self):
                self.send_response(502 if self.path == "/upstream-502" else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "100" if self.path == "/broken" else "10" if self.path == "/slow" else "2")
                self.send_header("Set-Cookie", "private=sample")
                self.end_headers()
                if self.path == "/broken":
                    self.wfile.write(b"short")
                elif self.path == "/slow":
                    self.wfile.write(b"first"); self.wfile.flush()
                    outer.release.wait(3)
                    self.wfile.write(b"last!")
                else:
                    self.wfile.write(b"{}")
                self.close_connection = True
            def log_message(self, *_):
                pass
        self.origin = http.server.HTTPServer(("127.0.0.1", 0), Origin)
        self.proxy = m.Threaded(("127.0.0.1", 0), m.Handler)
        for server in (self.origin, self.proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.release.set()
        self.proxy.shutdown(); self.proxy.server_close()
        self.origin.shutdown(); self.origin.server_close()

    def request(self, path):
        client = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=3)
        client.request("GET", "http://127.0.0.1:%d%s" % (self.origin.server_port, path), headers={"Authorization": "Bearer sample"})
        return client, client.getresponse()

    def test_incomplete_body_after_200_is_recorded_as_transport_failure(self):
        client, response = self.request("/broken")
        self.assertEqual(response.status, 200)
        with self.assertRaises(http.client.IncompleteRead):
            response.read()
        client.close()
        until(lambda: m.capture.snapshot()["entries"][0]["outcome"] == "error")
        row = m.capture.snapshot()["entries"][0]
        self.assertEqual((row["status"], row["statusSource"], row["errorKind"]), (200, "upstream", "incomplete"))
        self.assertEqual(row["bytesReceived"], 5)

    def test_short_uploads_are_incomplete_after_client_half_close(self):
        for framing, body in ((b"Content-Length: 10", b"short"),
                              (b"Transfer-Encoding: chunked", b"a\r\nshort")):
            with self.subTest(framing=framing):
                m.capture.clear()
                with socket.create_connection(("127.0.0.1", self.proxy.server_port), timeout=3) as client:
                    request = (b"POST http://127.0.0.1:%d/upload HTTP/1.1\r\nHost: localhost\r\n" %
                               self.origin.server_port) + framing + b"\r\nConnection: close\r\n\r\n" + body
                    client.sendall(request)
                    client.shutdown(socket.SHUT_WR)
                    self.assertIn(b"502", client.recv(4096))
                until(lambda: m.capture.snapshot()["entries"][0]["outcome"] == "error")
                row = m.capture.snapshot()["entries"][0]
                self.assertEqual((row["statusSource"], row["errorKind"], row["errorPhase"]),
                                 ("proxy", "incomplete", "send"))
                self.assertEqual(row["bytesSent"], 5)

    def test_upstream_502_is_distinct_from_proxy_failure(self):
        client, response = self.request("/upstream-502")
        self.assertEqual(response.read(), b"{}")
        client.close()
        until(lambda: m.capture.snapshot()["entries"][0]["outcome"] == "complete")
        row = m.capture.snapshot()["entries"][0]
        self.assertEqual((row["status"], row["statusSource"], row["errorKind"]), (502, "upstream", None))
        self.assertNotIn("sample", json.dumps(row))
        self.assertTrue(all(key in row["timings"] for key in ("connect", "send", "wait", "receive")))

    def test_receiving_request_has_live_counters_and_optional_preview(self):
        m.capture.stop(); m.capture.start(bodies=True)
        client, response = self.request("/slow")
        self.assertEqual(response.read(5), b"first")
        until(lambda: m.capture.snapshot()["entries"][0]["bytesReceived"] == 5)
        row = m.capture.snapshot()["entries"][0]
        self.assertEqual(row["phase"], "receive")
        self.assertEqual(row["outcome"], "pending")
        self.assertIsNone(row["durationMs"])
        self.assertEqual(row["responseBody"]["text"], "first")
        self.release.set()
        self.assertEqual(response.read(), b"last!")
        client.close()
        until(lambda: m.capture.snapshot()["entries"][0]["outcome"] == "complete")

    def test_capacity_refusal_is_explicit_and_counted(self):
        with patch.object(m, "slots", threading.BoundedSemaphore(0)):
            for _ in range(20):
                client = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=3)
                client.request("GET", "http://example.test/")
                response = client.getresponse()
                self.assertEqual(response.status, 503)
                self.assertEqual(response.read(), b"")
                client.close()
        self.assertEqual(m.capture.snapshot()["rejectedConnections"], 20)

    def test_connect_keeps_idle_socket_and_reports_open_then_complete(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0)); listener.listen(1)
        def echo():
            peer, _ = listener.accept()
            with peer:
                peer.sendall(peer.recv(4))
        threading.Thread(target=echo, daemon=True).start()
        original = m.select.select
        calls = [0]
        def empty_once(*args):
            calls[0] += 1
            return ([], [], []) if calls[0] == 1 else original(*args)
        with patch.object(m.select, "select", empty_once):
            client = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=3)
            client.set_tunnel("127.0.0.1", listener.getsockname()[1])
            client.connect()
            until(lambda: m.capture.snapshot()["entries"][0]["outcome"] == "open")
            client.sock.sendall(b"ping")
            self.assertEqual(client.sock.recv(4), b"ping")
            client.close()
            until(lambda: m.capture.snapshot()["entries"][0]["outcome"] == "complete")
        listener.close()
        self.assertEqual(m.capture.snapshot()["entries"][0]["bytesSent"], 4)
        self.assertEqual(m.capture.snapshot()["entries"][0]["bytesReceived"], 4)


if __name__ == "__main__":
    unittest.main()
