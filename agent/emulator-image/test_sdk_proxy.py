import base64
import contextlib
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('sdk_proxy', pathlib.Path(__file__).with_name('sdk-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class Upstream(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class TLSUpstream(Upstream):
    def get_request(self):
        stream, address = super().get_request()
        try:
            return self.tls.wrap_socket(stream, server_side=True), address
        except BaseException:
            stream.close()
            raise


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        head = bytearray()
        while not head.endswith(b'\r\n\r\n'):
            data = self.request.recv(1)
            if not data:
                return
            head.extend(data)
        self.server.requests.append(bytes(head))
        if self.server.reject:
            self.request.sendall(b'HTTP/1.1 407 Rejected\r\nContent-Length: 0\r\n\r\n')
        elif head.startswith(b'CONNECT '):
            self.request.sendall(b'HTTP/1.1 200 Connected\r\n\r\n')
            while True:
                data = self.request.recv(1024)
                if not data:
                    return
                self.request.sendall(data)
        else:
            self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')


@contextlib.contextmanager
def serving(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown(); server.server_close(); thread.join()


class ProxyTests(unittest.TestCase):
    def upstream(self, reject=False):
        server = Upstream(('127.0.0.1', 0), Handler)
        server.reject, server.requests = reject, []
        return server

    def address(self, server):
        return 'http://builder:p%20%40%3A%23%25word@127.0.0.1:' + str(server.server_address[1])

    def connect(self, relay):
        stream = socket.create_connection(relay.server_address, timeout=5)
        stream.sendall(b'CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\nProxy-Authorization: spoofed\r\n\r\n')
        return stream

    def test_authenticated_connect_and_binary_tunnel(self):
        with serving(self.upstream()) as upstream, serving(proxy.Relay(self.address(upstream))) as relay:
            self.assertEqual(relay.server_address[0], '127.0.0.1')
            with self.connect(relay) as stream:
                self.assertEqual(proxy.response_head(stream)[0], 200)
                payload = bytes(range(256)); stream.sendall(payload)
                self.assertEqual(stream.recv(1024), payload)
            header = upstream.requests[0]
            self.assertIn(b'Proxy-Authorization: Basic ' + base64.b64encode(b'builder:p @:#%word'), header)
            self.assertNotIn(b'spoofed', header)

    def test_proxy_auth_failure_does_not_fall_back_to_direct_access(self):
        with serving(self.upstream(reject=True)) as upstream, serving(proxy.Relay(self.address(upstream))) as relay:
            with self.connect(relay) as stream:
                self.assertEqual(proxy.response_head(stream)[0], 502)
            self.assertEqual(len(upstream.requests), 1)

    @unittest.skipUnless(shutil.which('openssl'), 'openssl required for ephemeral test certificate')
    def test_https_proxy_checks_ca_and_hostname_and_relays_tls_records(self):
        with tempfile.TemporaryDirectory() as directory:
            cert, key = pathlib.Path(directory) / 'ca.pem', pathlib.Path(directory) / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-keyout', str(key), '-out', str(cert), '-subj', '/CN=rdf-local-proxy-test',
                            '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, timeout=15,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            upstream = TLSUpstream(('127.0.0.1', 0), Handler)
            upstream.reject, upstream.requests = False, []
            upstream.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            upstream.tls.load_cert_chain(cert, key)
            with serving(upstream), mock.patch.dict(os.environ, {'SSL_CERT_FILE': str(cert)}):
                address = self.address(upstream).replace('http:', 'https:', 1)
                with serving(proxy.Relay(address)) as relay, self.connect(relay) as stream:
                    self.assertEqual(proxy.response_head(stream)[0], 200)
                    payload = bytes(range(256)) * 512; stream.sendall(payload)
                    received = bytearray()
                    while len(received) < len(payload):
                        block = stream.recv(65536)
                        self.assertTrue(block); received.extend(block)
                    self.assertEqual(received, payload)
                with serving(proxy.Relay(address.replace('127.0.0.1', 'localhost'))) as relay:
                    with self.connect(relay) as stream, self.assertRaises(ValueError):
                        proxy.response_head(stream)
                self.assertEqual(len(upstream.requests), 1)

    def test_plain_http_reads_use_upstream_auth(self):
        with serving(self.upstream()) as upstream, serving(proxy.Relay(self.address(upstream))) as relay:
            with socket.create_connection(relay.server_address, timeout=5) as stream:
                stream.sendall(b'GET http://example.invalid/repository.xml HTTP/1.1\r\nHost: example.invalid\r\n\r\n')
                self.assertEqual(proxy.response_head(stream)[0], 200)
                self.assertEqual(stream.recv(16), b'OK')
            self.assertIn(b'GET http://example.invalid/repository.xml ', upstream.requests[0])

    def test_child_gets_only_loopback_proxy_and_credential_free_sdk_flags(self):
        with serving(self.upstream()) as upstream, tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            script = root / 'sdk.py'; output = root / 'output.json'
            script.write_text("import json,os,sys; open(os.environ['OUTPUT_FILE'],'w').write(json.dumps({'argv':sys.argv,'proxy':os.environ['HTTPS_PROXY']}))")
            env = dict(os.environ, HTTPS_PROXY=self.address(upstream), OUTPUT_FILE=str(output))
            self.assertEqual(proxy.run([sys.executable, str(script)], env=env), 0)
            data = json.loads(output.read_text())
            self.assertIn('--proxy=http', data['argv'])
            self.assertIn('--proxy_host=127.0.0.1', data['argv'])
            self.assertTrue(data['proxy'].startswith('http://127.0.0.1:'))
            self.assertNotIn('builder', json.dumps(data))
            self.assertNotIn('word', json.dumps(data))

    def test_no_proxy_preserves_direct_sdk_invocation(self):
        env = {key: value for key, value in os.environ.items() if key.lower() not in ('http_proxy', 'https_proxy')}
        self.assertEqual(proxy.run([sys.executable, '-c', 'raise SystemExit(7)'], env=env), 7)

    def test_invalid_proxy_scheme_is_rejected(self):
        with self.assertRaises(ValueError):
            proxy.Relay('file:///tmp/proxy')


if __name__ == '__main__':
    unittest.main()
