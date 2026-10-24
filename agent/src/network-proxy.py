"""Session-local HTTP inspector. HTTPS is tunneled without certificate changes."""
import hashlib
import http.client
import http.server
import json
import os
import select
import socket
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from network_capture import BodyPreview, Capture, MAX_CONNECTIONS

ROOT = "/rdf-network"
RUNTIME_VERSION = hashlib.sha256(b"".join(open(os.path.join(ROOT, name), "rb").read() for name in ("proxy.py", "network_capture.py", "console.sh"))).hexdigest() if __name__ == "__main__" else "test"
PROXY_PORT = 18888
CONTROL_PORT = 18889
MAX_STATUS_BYTES = 8 * 1024 * 1024
capture = Capture()
slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
proxy = None


def status(summary=False):
    return dict(capture.snapshot(0, include_entries=not summary), runtimeVersion=RUNTIME_VERSION)


class Threaded(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    request_queue_size = MAX_CONNECTIONS

    def process_request(self, request, client_address):
        if not slots.acquire(False):
            capture.connection(rejected=True)
            try:
                request.settimeout(.1)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 1\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        capture.connection(1)
        try:
            super().process_request(request, client_address)
        except BaseException:
            capture.connection(-1)
            slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            capture.connection(-1)
            slots.release()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def do_CONNECT(self):
        remote = None
        item = None
        error = None
        connected = False
        try:
            target = urllib.parse.urlsplit("//" + self.path)
            if not target.hostname or target.username or target.password or target.path or not target.port:
                raise ValueError("authority")
            item = capture.event("CONNECT", "https://" + self.path)
            remote = socket.create_connection((target.hostname, target.port), timeout=15)
            self.send_response(200)
            self.end_headers()
            connected = True
            capture.change(item, status=200, statusSource="proxy", outcome="open")
            capture.phase(item, "tunnel")
            self.connection.setblocking(False)
            remote.setblocking(False)
            readers = {self.connection, remote}
            while readers:
                # Idle tunnels remain open. Bounded slots and explicit overload reporting
                # limit resources without silently terminating healthy connections.
                ready, _, _ = select.select(list(readers), [], [], 1)
                for source in ready:
                    data = source.recv(65536)
                    destination = remote if source is self.connection else self.connection
                    if not data:
                        readers.discard(source)
                        try:
                            destination.shutdown(socket.SHUT_WR)
                        except OSError:
                            pass
                        continue
                    direction = "bytesSent" if source is self.connection else "bytesReceived"
                    capture.progress(item, direction, data)
                    destination.settimeout(15)
                    destination.sendall(data)
                    destination.setblocking(False)
        except (OSError, ValueError) as cause:
            error = cause
            if not connected:
                capture.change(item, status=502, statusSource="proxy")
                try:
                    self.send_error(502)
                except OSError:
                    pass
        finally:
            self.close_connection = True
            if remote:
                remote.close()
            capture.finish(item, error)

    def forward(self):
        connection = None
        response = None
        item = None
        error = None
        headers_sent = False
        try:
            target = urllib.parse.urlsplit(self.path)
            if target.scheme != "http" or not target.hostname or target.username or target.password:
                raise ValueError("url")
            item = capture.event(self.command, self.path)
            from network_capture import safe_headers
            capture.change(item, requestHeaders=safe_headers(self.headers.items()))
            request_body = BodyPreview(bool(item and item["_bodies"]), self.headers.get("Content-Type", ""), self.headers.get("Content-Encoding", ""))
            capture.change(item, requestBody=request_body.snapshot())
            connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=15)
            connection.connect()
            capture.phase(item, "send")
            connection.putrequest(self.command, urllib.parse.urlunsplit(("", "", target.path or "/", target.query, "")), skip_host=True, skip_accept_encoding=True)
            hop = {"connection", "proxy-connection", "proxy-authorization", "keep-alive", "upgrade"}
            hop.update(part.strip().lower() for part in self.headers.get("Connection", "").split(","))
            for key, value in self.headers.items():
                if key.lower() not in hop:
                    connection.putheader(key, value)
            connection.putheader("Connection", "close")
            connection.endheaders()
            self.forward_body(connection, item, request_body)
            capture.phase(item, "wait")
            response = connection.getresponse()
            capture.change(item, responseHeaders=safe_headers(response.getheaders()), status=response.status, statusSource="upstream")
            capture.phase(item, "receive")
            response_body = BodyPreview(bool(item and item["_bodies"]), response.getheader("Content-Type", ""), response.getheader("Content-Encoding", ""))
            capture.change(item, responseBody=response_body.snapshot())
            self.send_response(response.status)
            response_hop = {"connection", "transfer-encoding", "keep-alive", "proxy-authenticate", "upgrade"}
            response_hop.update(part.strip().lower() for part in response.getheader("Connection", "").split(","))
            for key, value in response.getheaders():
                if key.lower() not in response_hop:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            headers_sent = True
            while True:
                data = response.read1(65536)
                if not data:
                    if response.length:
                        raise http.client.IncompleteRead(b"", response.length)
                    break
                capture.progress(item, "bytesReceived", data, response_body)
                self.wfile.write(data)
        except (OSError, ValueError, EOFError, http.client.HTTPException) as cause:
            error = cause
            if isinstance(cause, http.client.IncompleteRead) and response is not None and cause.partial:
                capture.progress(item, "bytesReceived", cause.partial, response_body)
                try:
                    self.wfile.write(cause.partial)
                except OSError:
                    pass
            if not headers_sent:
                if item is None or item["statusSource"] is None:
                    capture.change(item, status=502, statusSource="proxy")
                try:
                    self.send_error(502)
                except OSError:
                    pass
        finally:
            self.close_connection = True
            if connection:
                connection.close()
            capture.finish(item, error)

    def forward_body(self, connection, item, preview):
        def send(data):
            capture.progress(item, "bytesSent", data, preview)
            connection.send(data)
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                line = self.rfile.readline(128)
                if not line.endswith(b"\r\n"):
                    raise ValueError("chunk")
                length = int(line.split(b";")[0], 16)
                if length < 0 or length > 16 * 1024 * 1024:
                    raise ValueError("chunk")
                connection.send(("%x\r\n" % length).encode())
                if not length:
                    trailer_bytes = 0
                    while True:
                        trailer = self.rfile.readline(2048)
                        trailer_bytes += len(trailer)
                        if not trailer or trailer_bytes > 16384 or not trailer.endswith(b"\r\n"):
                            raise ValueError("trailer")
                        connection.send(trailer)
                        if trailer == b"\r\n":
                            return
                remaining = length
                while remaining:
                    data = self.rfile.read(min(65536, remaining))
                    if not data:
                        raise EOFError("body")
                    send(data)
                    remaining -= len(data)
                if self.rfile.read(2) != b"\r\n":
                    raise ValueError("chunk")
                connection.send(b"\r\n")
        else:
            remaining = int(self.headers.get("Content-Length", "0"))
            if remaining < 0:
                raise ValueError("length")
            while remaining:
                data = self.rfile.read(min(65536, remaining))
                if not data:
                    raise EOFError("body")
                send(data)
                remaining -= len(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = forward


def stop_pcap():
    # The controller's isolated packet worker enforces its own size/time limits.
    capture.pcap_result("stopped")


def watchdog():
    while True:
        time.sleep(1)
        state = status(summary=True)
        if not state["recording"]:
            continue
        reason = "time_limit" if time.time() - state["startedAt"] >= 600 else "size_limit" if state["pcapBytes"] >= 30 * 1024 * 1024 else None
        if reason:
            capture.stop(reason)
            if capture.finalizing:
                stop_pcap()


class Control(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        op = parsed.path
        args = urllib.parse.parse_qs(parsed.query)
        try:
            if op == "/stop":
                reason = args.get("reason", ["manual"])[0]
                if reason not in ("manual", "time_limit", "size_limit", "recovery", "start_failed"):
                    raise ValueError("reason")
                capture.stop(reason)
            elif op == "/start":
                pcap = args.get("pcap", ["0"])[0]
                bodies = args.get("bodies", ["0"])[0]
                if pcap not in ("0", "1") or bodies not in ("0", "1"):
                    raise ValueError("flags")
                capture.start(pcap == "1", bodies == "1")
            elif op in ("/pcap-recording", "/pcap-stopped", "/pcap-error"):
                capture.pcap_result(op.removeprefix("/pcap-"))
            elif op == "/clear":
                if capture.recording or capture.finalizing:
                    raise ValueError("busy")
                capture.clear()
            elif op == "/shutdown":
                if capture.recording or capture.finalizing or capture.pcap_state == "error" or capture.active:
                    raise ValueError("busy")
                threading.Thread(target=admin.shutdown, daemon=True).start()
            elif op not in ('/status', '/summary'):
                self.send_error(404)
                return
        except ValueError:
            self.send_error(409)
            return
        data = json.dumps(status(summary=op == '/summary'), ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        proxy = Threaded(("127.0.0.1", PROXY_PORT), Handler)
        admin = http.server.HTTPServer(("127.0.0.1", CONTROL_PORT), Control)
        threading.Thread(target=watchdog, daemon=True).start()
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        admin.serve_forever()
    else:
        action = sys.argv[1] if len(sys.argv) > 1 else "status"
        if action not in ("status", "summary", "start", "stop", "clear", "pcap-recording", "pcap-stopped", "pcap-error", "shutdown"):
            raise ValueError("action")
        query = ""
        if action == "start":
            query = "?" + urllib.parse.urlencode({"pcap": sys.argv[2], "bodies": sys.argv[3]})
        elif action == "stop" and len(sys.argv) > 2:
            query = "?" + urllib.parse.urlencode({"reason": sys.argv[2]})
        with urllib.request.urlopen("http://127.0.0.1:%d/%s%s" % (CONTROL_PORT, action, query), timeout=5) as response:
            data = response.read(MAX_STATUS_BYTES + 1)
            if len(data) > MAX_STATUS_BYTES:
                raise ValueError("status_size")
            sys.stdout.write(data.decode("utf-8"))
