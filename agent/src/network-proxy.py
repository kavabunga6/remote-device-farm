"""Session-local HTTP inspector. HTTPS is tunneled without certificate changes."""
import base64
import collections
import http.client
import http.server
import json
import os
import select
import socket
import socketserver
import sys
import subprocess
import threading
import time
import urllib.parse
import urllib.request

ROOT = "/rdf-network"
PROXY_PORT = 18888
CONTROL_PORT = 18889
LIMIT = 200
lock = threading.RLock()
slots = threading.BoundedSemaphore(16)
entries = collections.deque(maxlen=LIMIT)
recording = True
finalizing = False
started = time.time()
sequence = 0
proxy = None


def safe_url(raw):
    url = urllib.parse.urlsplit(raw)
    query = urllib.parse.urlencode([(key, "[redacted]") for key, _ in urllib.parse.parse_qsl(url.query, keep_blank_values=True)])
    host = url.hostname or ""
    if url.port:
        host += ":" + str(url.port)
    return urllib.parse.urlunsplit((url.scheme, host, url.path, query, ""))[:2048]


def headers(items):
    return [{"name": key, "value": value[:200]} for key, value in items
            if key.lower() in ("content-type", "content-length")][:4]


def event(method, url):
    global sequence
    with lock:
        if not recording:
            return None
        sequence += 1
        item = {"id": sequence, "method": method, "url": safe_url(url), "startedAt": time.time(),
                "status": None, "durationMs": None, "bytes": 0, "requestHeaders": [], "responseHeaders": []}
        entries.append(item)
        return item


def status():
    with lock:
        return {"available": True, "recording": recording, "finalizing": finalizing, "proxyActive": True, "startedAt": started,
                "limit": LIMIT, "entries": list(entries), "pcapBytes": os.path.getsize(ROOT + "/capture.pcap")
                if os.path.isfile(ROOT + "/capture.pcap") else 0}


class Threaded(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def process_request(self, request, client_address):
        if not slots.acquire(False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            slots.release()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def record(self, item, start, code, count):
        if item is not None:
            with lock:
                item.update(status=code, durationMs=round((time.monotonic() - start) * 1000), bytes=count)

    def do_CONNECT(self):
        remote = None
        item = None
        start = time.monotonic()
        count = 0
        code = 502
        try:
            target = urllib.parse.urlsplit("//" + self.path)
            if not target.hostname or target.username or target.password or target.path or not target.port:
                raise ValueError("authority")
            item = event("CONNECT", "https://" + self.path)
            remote = socket.create_connection((target.hostname, target.port), timeout=10)
            self.send_response(200)
            self.end_headers()
            code = 200
            self.connection.setblocking(False)
            remote.setblocking(False)
            if item is not None:
                with lock:
                    item["status"] = 200
            while True:
                ready, _, _ = select.select([self.connection, remote], [], [], 30)
                if not ready:
                    break
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    destination = remote if source is self.connection else self.connection
                    destination.settimeout(10)
                    destination.sendall(data)
                    destination.setblocking(False)
                    count += len(data)
        except (OSError, ValueError):
            if code != 200:
                self.send_error(502)
        finally:
            self.close_connection = True
            if remote:
                remote.close()
            self.record(item, start, code, count)

    def forward(self):
        connection = None
        item = None
        start = time.monotonic()
        code = 502
        count = 0
        try:
            target = urllib.parse.urlsplit(self.path)
            if target.scheme != "http" or not target.hostname or target.username or target.password:
                raise ValueError("url")
            item = event(self.command, self.path)
            if item is not None:
                item["requestHeaders"] = headers(self.headers.items())
            connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=15)
            connection.putrequest(self.command, urllib.parse.urlunsplit(("", "", target.path or "/", target.query, "")), skip_host=True, skip_accept_encoding=True)
            hop = {"connection", "proxy-connection", "proxy-authorization", "keep-alive", "upgrade"}
            hop.update(part.strip().lower() for part in self.headers.get("Connection", "").split(","))
            for key, value in self.headers.items():
                if key.lower() not in hop:
                    connection.putheader(key, value)
            connection.putheader("Connection", "close")
            connection.endheaders()
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                while True:
                    line = self.rfile.readline(128)
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
                                break
                        break
                    remaining = length
                    while remaining:
                        data = self.rfile.read(min(65536, remaining))
                        if not data:
                            raise ValueError("body")
                        connection.send(data)
                        remaining -= len(data)
                    if self.rfile.read(2) != b"\r\n":
                        raise ValueError("chunk")
                    connection.send(b"\r\n")
                    if not length:
                        break
            else:
                remaining = int(self.headers.get("Content-Length", "0"))
                if remaining < 0:
                    raise ValueError("length")
                while remaining:
                    data = self.rfile.read(min(65536, remaining))
                    if not data:
                        raise ValueError("body")
                    connection.send(data)
                    remaining -= len(data)
            response = connection.getresponse()
            code = response.status
            if item is not None:
                item["responseHeaders"] = headers(response.getheaders())
                item["status"] = code
            self.send_response(code)
            for key, value in response.getheaders():
                if key.lower() not in ("connection", "transfer-encoding", "keep-alive", "proxy-authenticate", "upgrade"):
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                data = response.read(65536)
                if not data:
                    break
                count += len(data)
                self.wfile.write(data)
        except (OSError, ValueError, http.client.HTTPException):
            if code == 502:
                self.send_error(502)
        finally:
            self.close_connection = True
            if connection:
                connection.close()
            self.record(item, start, code, count)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = forward


def watchdog():
    global recording, finalizing
    while True:
        time.sleep(1)
        with lock:
            size = os.path.getsize(ROOT + "/capture.pcap") if os.path.isfile(ROOT + "/capture.pcap") else 0
            if not recording or (time.time() - started < 600 and size < 30 * 1024 * 1024):
                continue
            recording = False
            finalizing = True
        env = dict(os.environ, EMU_CMD="network capture stop", EMU_CONSOLE_PORTS="5556 5554", EMU_TIMEOUT_SECONDS="8")
        try:
            subprocess.run(["sh", ROOT + "/console.sh"], env=env, timeout=10, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            with lock:
                finalizing = False


class Control(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def do_GET(self):
        global recording, started
        op = self.path
        with lock:
            if op == "/stop":
                recording = False
            elif op == "/start":
                if finalizing:
                    self.send_error(409)
                    return
                recording = True
                started = time.time()
                entries.clear()
            elif op == "/clear":
                entries.clear()
            elif op != "/status":
                self.send_error(404)
                return
            data = json.dumps(status(), ensure_ascii=True).encode()
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
    elif len(sys.argv) > 1 and sys.argv[1] == "pcap":
        offset = int(sys.argv[2])
        if offset < 0 or offset > 40 * 1024 * 1024:
            raise ValueError("offset")
        with open(ROOT + "/capture.pcap", "rb") as file:
            size = os.fstat(file.fileno()).st_size
            file.seek(offset)
            data = file.read(256 * 1024)
        print(json.dumps({"contentBase64": base64.b64encode(data).decode(), "offset": offset, "size": size}))
    else:
        action = sys.argv[1] if len(sys.argv) > 1 else "status"
        if action not in ("status", "start", "stop", "clear"):
            raise ValueError("action")
        with urllib.request.urlopen("http://127.0.0.1:%d/%s" % (CONTROL_PORT, action), timeout=5) as response:
            sys.stdout.write(response.read(1024 * 1024).decode())
