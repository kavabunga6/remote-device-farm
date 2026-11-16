import base64
import contextlib
import concurrent.futures
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
    request_queue_size = 128


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

    def test_catalog_burst_keeps_48_parallel_manifest_connections_alive(self):
        barrier = threading.Barrier(48)
        with serving(self.upstream()) as upstream, serving(proxy.Relay(self.address(upstream))) as relay:
            def fetch(_):
                with self.connect(relay) as stream:
                    self.assertEqual(proxy.response_head(stream)[0], 200)
                    barrier.wait(timeout=10)
                    stream.sendall(b'manifest'); self.assertEqual(stream.recv(8), b'manifest')
            with concurrent.futures.ThreadPoolExecutor(max_workers=48) as workers:
                list(workers.map(fetch, range(48)))
            self.assertEqual(len(upstream.requests), 48)

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

    def test_no_proxy_http_reads_go_direct_without_leaking_proxy_credentials(self):
        with serving(self.upstream()) as upstream, serving(self.upstream()) as origin:
            with serving(proxy.Relay(self.address(upstream), '127.0.0.1')) as relay:
                with socket.create_connection(relay.server_address, timeout=5) as stream:
                    url = 'http://127.0.0.1:' + str(origin.server_address[1]) + '/repository.xml?version=1'
                    stream.sendall(('GET ' + url + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: spoofed\r\n\r\n').encode())
                    self.assertEqual(proxy.response_head(stream)[0], 200)
                    self.assertEqual(stream.recv(16), b'OK')
            self.assertEqual(upstream.requests, [])
            self.assertTrue(origin.requests[0].startswith(b'GET /repository.xml?version=1 '))
            self.assertNotIn(b'Proxy-Authorization', origin.requests[0])

    def test_no_proxy_connect_matches_subdomains_but_not_hostname_suffix_lookalikes(self):
        with serving(self.upstream()) as upstream, serving(self.upstream()) as origin:
            create_connection = socket.create_connection
            def connect(address, *args, **kwargs):
                return create_connection(origin.server_address if address == ('cdn.example.com', 443) else address, *args, **kwargs)
            with serving(proxy.Relay(self.address(upstream), 'example.com')) as relay, mock.patch.object(proxy.socket, 'create_connection', side_effect=connect):
                for hostname in ['cdn.example.com', 'badexample.com']:
                    with create_connection(relay.server_address, timeout=5) as stream:
                        stream.sendall(('CONNECT ' + hostname + ':443 HTTP/1.1\r\nHost: ' + hostname + '\r\n\r\n').encode())
                        self.assertEqual(proxy.response_head(stream)[0], 200)
                        if hostname == 'cdn.example.com':
                            stream.sendall(b'GET / HTTP/1.1\r\nHost: cdn.example.com\r\n\r\n')
                            self.assertEqual(proxy.response_head(stream)[0], 200)
                        else:
                            stream.sendall(b'echo'); self.assertEqual(stream.recv(4), b'echo')
            self.assertEqual(len(upstream.requests), 1)
            self.assertIn(b'badexample.com:443', upstream.requests[0])
            self.assertNotIn(b'Proxy-Authorization', origin.requests[0])

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

    def test_ip_exclusions_match_addresses_instead_of_hostname_suffixes(self):
        with proxy.Relay('http://proxy.example', '127.0.0.1,::1,example.com') as relay:
            self.assertTrue(relay.bypass('127.0.0.1'))
            self.assertTrue(relay.bypass('0:0:0:0:0:0:0:1'))
            self.assertTrue(relay.bypass('cdn.example.com'))
            self.assertFalse(relay.bypass('foo.127.0.0.1'))
            self.assertFalse(relay.bypass('badexample.com'))

    @unittest.skipUnless(shutil.which('sh'), 'POSIX shell required for APT adapter')
    def test_apt_bypass_uses_domain_boundaries_exact_ips_and_all_hosts(self):
        helper = pathlib.Path(__file__).with_name('apt-proxy.sh')
        env = dict(os.environ, HTTP_PROXY='http://builder:fixture@proxy.example:3128', RDF_NO_PROXY='example.com,127.0.0.1,::1')
        cases = [('http://example.com/file', True), ('https://cdn.example.com/file', True),
                 ('http://badexample.com/file', False), ('http://127.0.0.1/file', True),
                 ('http://foo.127.0.0.1/file', False), ('http://[::1]/file', True), ('http://[::2]/file', False)]
        for uri, direct in cases:
            value = subprocess.check_output(['sh', str(helper), uri], env=env, text=True).strip()
            self.assertEqual(value, 'DIRECT' if direct else env['HTTP_PROXY'], uri)
        env['RDF_NO_PROXY'] = '*'
        self.assertEqual(subprocess.check_output(['sh', str(helper), 'https://other.example/file'], env=env, text=True).strip(), 'DIRECT')


if __name__ == '__main__':
    unittest.main()
