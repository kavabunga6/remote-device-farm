#!/usr/bin/env python3
"""Run sdkmanager through a loopback relay; upstream credentials stay out of Java argv."""
import base64
import contextlib
import http.server
import ipaddress
import os
import select
import socket
import ssl
import subprocess
import sys
import threading
import urllib.parse


MAX_HEADERS = 32768
HOP_HEADERS = {'connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'upgrade'}


def response_head(stream):
    data = bytearray()
    while not data.endswith(b'\r\n\r\n'):
        block = stream.recv(1)
        if not block or len(data) >= MAX_HEADERS:
            raise ValueError('proxy_response_invalid')
        data.extend(block)
    parts = data.split(b'\r\n', 1)[0].split(b' ', 2)
    if len(parts) < 2 or not parts[1].isdigit():
        raise ValueError('proxy_response_invalid')
    return int(parts[1]), bytes(data)


class Relay(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 128

    def __init__(self, address, no_proxy=''):
        self.proxy = urllib.parse.urlsplit(address)
        if self.proxy.scheme not in ('http', 'https') or not self.proxy.hostname or self.proxy.path not in ('', '/') or self.proxy.query or self.proxy.fragment:
            raise ValueError('proxy_invalid')
        self.port = self.proxy.port or (443 if self.proxy.scheme == 'https' else 80)
        user, password = (urllib.parse.unquote(part or '') for part in (self.proxy.username, self.proxy.password))
        if any(ord(char) < 32 or ord(char) == 127 for char in user + password) or ':' in user:
            raise ValueError('proxy_invalid')
        self.authorization = ('Basic ' + base64.b64encode((user + ':' + password).encode()).decode()) if user else None
        self.excluded = [host.strip().lower().lstrip('.').rstrip('.').strip('[]') for host in no_proxy.split(',') if host.strip()]
        self.excluded_ips, self.excluded_domains = set(), set()
        for host in self.excluded:
            try:
                self.excluded_ips.add(str(ipaddress.ip_address(host)))
            except ValueError:
                self.excluded_domains.add(host)
        self.slots = threading.BoundedSemaphore(64)
        super().__init__(('127.0.0.1', 0), Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # Never print a request or credentials in a traceback.

    @contextlib.contextmanager
    def upstream(self):
        stream = socket.create_connection((self.proxy.hostname, self.port), timeout=30)
        try:
            if self.proxy.scheme == 'https':
                stream = ssl.create_default_context().wrap_socket(stream, server_hostname=self.proxy.hostname)
            yield stream
        finally:
            stream.close()

    def bypass(self, hostname):
        if '*' in self.excluded_domains:
            return True
        host = hostname.lower().rstrip('.')
        try:
            host = str(ipaddress.ip_address(host))
            return host in self.excluded_ips
        except ValueError:
            return any(host == entry or host.endswith('.' + entry) for entry in self.excluded_domains)

    @contextlib.contextmanager
    def destination(self, hostname, port):
        if self.bypass(hostname):
            with socket.create_connection((hostname, port), timeout=30) as stream:
                yield stream, True
        else:
            with self.upstream() as stream:
                yield stream, False


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def send_upstream(self, stream, method, target, headers, direct=False):
        lines = [method + ' ' + target + ' HTTP/1.1', *headers, 'Connection: close']
        if self.server.authorization and not direct:
            lines.append('Proxy-Authorization: ' + self.server.authorization)
        stream.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1'))

    def do_CONNECT(self):
        try:
            target = urllib.parse.urlsplit('http://' + self.path)
            if not target.hostname or target.port not in (80, 443) or target.username or target.password or target.path or target.query or target.fragment:
                raise ValueError('proxy_target_invalid')
            with self.server.destination(target.hostname, target.port) as (upstream, direct):
                if not direct:
                    self.send_upstream(upstream, 'CONNECT', self.path, ['Host: ' + self.path])
                    status, _ = response_head(upstream)
                    if status != 200:
                        self.send_error(502, 'proxy_connect_failed')
                        return
                self.send_response(200, 'Connection established'); self.end_headers()
                self.close_connection = True
                while True:
                    buffered = isinstance(upstream, ssl.SSLSocket) and upstream.pending()
                    readable, _, _ = select.select([self.connection, upstream], [], [], 0 if buffered else 1)
                    if buffered and upstream not in readable:
                        readable.append(upstream)
                    for incoming in readable:
                        data = incoming.recv(65536)
                        if not data:
                            return
                        (upstream if incoming is self.connection else self.connection).sendall(data)
        except (OSError, ValueError):
            self.close_connection = True

    def do_GET(self):
        self.forward_read()

    def do_HEAD(self):
        self.forward_read()

    def forward_read(self):
        try:
            target = urllib.parse.urlsplit(self.path)
            if target.scheme != 'http' or not target.hostname or target.username or target.password or target.fragment or int(self.headers.get('Content-Length', '0')) != 0:
                raise ValueError('proxy_target_invalid')
            headers = [name + ': ' + value for name, value in self.headers.items() if name.lower() not in HOP_HEADERS]
            with self.server.destination(target.hostname, target.port or 80) as (upstream, direct):
                path = urllib.parse.urlunsplit(('', '', target.path or '/', target.query, '')) if direct else self.path
                self.send_upstream(upstream, self.command, path, headers, direct=direct)
                status, head = response_head(upstream)
                if status == 407:
                    self.send_error(502, 'proxy_auth_failed')
                    return
                self.connection.sendall(head)
                while True:
                    data = upstream.recv(65536)
                    if not data:
                        break
                    self.connection.sendall(data)
        except (OSError, ValueError):
            pass
        self.close_connection = True


def run(argv, env=None):
    env = dict(os.environ if env is None else env)
    address = env.get('HTTPS_PROXY') or env.get('https_proxy') or env.get('HTTP_PROXY') or env.get('http_proxy')
    if not address:
        return subprocess.call(argv, env=env)
    with Relay(address, env.get('NO_PROXY') or env.get('no_proxy') or '') as relay:
        thread = threading.Thread(target=relay.serve_forever, daemon=True); thread.start()
        local = 'http://127.0.0.1:' + str(relay.server_port)
        for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
            env[key] = local
        try:
            return subprocess.call([*argv, '--proxy=http', '--proxy_host=127.0.0.1', '--proxy_port=' + str(relay.server_port)], env=env)
        finally:
            relay.shutdown(); thread.join()


if __name__ == '__main__':
    try:
        sys.exit(run(sys.argv[1:]))
    except (OSError, ValueError):
        print('proxy_failed', file=sys.stderr)
        sys.exit(64)
