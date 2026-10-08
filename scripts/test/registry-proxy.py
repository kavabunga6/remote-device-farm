#!/usr/bin/env python3
"""Exercise the production registry proxy with real nginx and loopback-only stubs.

Run in CI's --network none container; no Docker socket, published ports, or farm data.
Only addresses/paths are rewritten. Auth, streaming and body-limit directives remain
exactly as shipped, so removing the auth subrequest limit reproduces HTTP 500.
"""
import argparse
import base64
import hashlib
import http.client
import http.server
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest


PUSH = "Basic " + base64.b64encode(b"rdf:test-push-token").decode()
PULL = "Basic " + base64.b64encode(b"rdf:test-pull-token").decode()
PAYLOAD = b"registry-upload-regression\x00" * 85_000  # Over nginx's default 1 MiB.
UPLOAD_PATH = "/v2/rdf-emulator/blobs/uploads/fixture?state=fixture&digest=sha256:" + hashlib.sha256(PAYLOAD).hexdigest()


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        original_method = self.headers.get("X-Original-Method")
        hit = {"method": self.command, "path": self.path, "originalMethod": original_method,
               "originalUri": self.headers.get("X-Original-URI"), "bytes": len(body),
               "contentLength": self.headers.get("Content-Length"),
               "transferEncoding": self.headers.get("Transfer-Encoding"),
               "digest": hashlib.sha256(body).hexdigest()}
        self.server.hits.append(hit)
        if self.server.auth:
            credential = self.headers.get("Authorization")
            status = 200 if credential == PUSH or credential == PULL and original_method in ("GET", "HEAD") else 403 if credential == PULL else 401
        else:
            status = 201 if self.command == "PUT" else 200
        self.send_response(status)
        if status == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="fixture"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_HEAD = do_PUT = respond


def fixture(auth):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    server.auth = auth
    server.hits = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class RegistryProxyTest(unittest.TestCase):
    def request(self, method, path, token=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/octet-stream"}
        if token:
            headers["Authorization"] = token
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            response.read()
            return response.status, dict(response.getheaders())
        finally:
            connection.close()

    def test_large_push_reaches_registry_without_sending_auth_body(self):
        self.assertGreater(len(PAYLOAD), 1024 * 1024)
        auth_start = len(self.auth.hits)
        registry_start = len(self.registry.hits)
        status, _ = self.request("PUT", UPLOAD_PATH, PUSH, PAYLOAD)
        self.assertEqual(status, 201, self.nginx_errors.read_text())
        self.assertEqual(len(self.registry.hits), registry_start + 1)
        uploaded = self.registry.hits[-1]
        self.assertEqual(uploaded["method"], "PUT")
        self.assertEqual(uploaded["path"], UPLOAD_PATH)
        self.assertEqual(uploaded["bytes"], len(PAYLOAD))
        self.assertEqual(uploaded["digest"], hashlib.sha256(PAYLOAD).hexdigest())
        self.assertEqual(len(self.auth.hits), auth_start + 1)
        auth = self.auth.hits[-1]
        self.assertEqual((auth["method"], auth["path"], auth["originalMethod"]), ("GET", "/api/registry/auth", "PUT"))
        self.assertEqual(auth["originalUri"], UPLOAD_PATH)
        self.assertEqual(auth["bytes"], 0)
        self.assertIsNone(auth["contentLength"])
        self.assertIsNone(auth["transferEncoding"])

    def test_pull_token_can_read_but_cannot_upload_large_blob(self):
        status, _ = self.request("HEAD", "/v2/rdf-emulator/blobs/fixture", PULL)
        self.assertEqual(status, 200)
        self.assertEqual(self.auth.hits[-1]["originalMethod"], "HEAD")
        before = len(self.registry.hits)
        status, _ = self.request("PUT", UPLOAD_PATH, PULL, PAYLOAD)
        self.assertEqual(status, 403, self.nginx_errors.read_text())
        self.assertEqual(len(self.registry.hits), before, "Denied writes must not reach registry")
        auth = self.auth.hits[-1]
        self.assertEqual((auth["method"], auth["originalMethod"], auth["bytes"]), ("GET", "PUT", 0))
        self.assertIsNone(auth["contentLength"])
        self.assertIsNone(auth["transferEncoding"])

    def test_missing_credentials_receive_distribution_challenge(self):
        before = len(self.registry.hits)
        status, headers = self.request("GET", "/v2/")
        self.assertEqual(status, 401)
        self.assertEqual(headers.get("Docker-Distribution-Api-Version"), "registry/2.0")
        self.assertIn("Basic ", headers.get("WWW-Authenticate", ""))
        self.assertEqual(len(self.registry.hits), before)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nginx", default="nginx")
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("nginx.conf"))
    args = parser.parse_args()
    nginx = shutil.which(args.nginx)
    if not nginx:
        parser.error("real nginx is required; run the registry-proxy Docker test image")
    process = None
    auth = fixture(True)
    registry = fixture(False)
    try:
        with tempfile.TemporaryDirectory(prefix="rdf-registry-proxy-") as temporary:
            root = Path(temporary)
            certificate = root / "ip.crt"
            key = root / "ip.key"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", str(key), "-out", str(certificate)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            port = free_port()
            tls_port = free_port()
            while tls_port == port:
                tls_port = free_port()
            config = args.config.read_text(encoding="utf-8")
            replacements = {
                "listen 80;": f"listen 127.0.0.1:{port};",
                "listen 443 ssl;": f"listen 127.0.0.1:{tls_port} ssl;",
                "http://server:8080": f"http://127.0.0.1:{auth.server_port}",
                "http://registry:5000": f"http://127.0.0.1:{registry.server_port}",
                "/etc/nginx/tls/ip.crt": str(certificate),
                "/etc/nginx/tls/ip.key": str(key),
            }
            for old, new in replacements.items():
                if old not in config:
                    raise RuntimeError(f"Production nginx configuration changed: missing {old}")
                config = config.replace(old, new)
            error_log = root / "error.log"
            # All writable nginx paths are under the isolated temporary directory.
            prefix = f"daemon off; master_process off; pid {root}/nginx.pid; error_log {error_log} info; events {{ worker_connections 32; }}\n"
            runtime = root / "nginx.conf"
            temp_paths = " ".join(f"{kind}_temp_path {root / kind};" for kind in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi"))
            runtime.write_text(prefix + "http { access_log off; " + temp_paths + "\n" + config + "\n}\n", encoding="utf-8")
            subprocess.run([nginx, "-t", "-p", str(root), "-c", str(runtime)], check=True)
            process = subprocess.Popen([nginx, "-p", str(root), "-c", str(runtime)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            deadline = time.monotonic() + 10
            while True:
                if process.poll() is not None:
                    raise RuntimeError("nginx exited before listening: " + process.stderr.read().decode(errors="replace"))
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("nginx did not start listening")
                    time.sleep(0.05)
            RegistryProxyTest.port = port
            RegistryProxyTest.auth = auth
            RegistryProxyTest.registry = registry
            RegistryProxyTest.nginx_errors = error_log
            result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RegistryProxyTest))
            process.terminate()
            process.communicate(timeout=5)
            process = None
            return 0 if result.wasSuccessful() else 1
    finally:
        if process is not None:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        for server in (auth, registry):
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
