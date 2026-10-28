"""Bounded, session-local traffic metadata and optional HTTP text previews."""
import collections
import http.client
import json
import re
import socket
import threading
import time
import urllib.parse
import uuid

LIMIT = 200
BODY_LIMIT = 4096
MAX_CONNECTIONS = 64
SAFE_HEADERS = frozenset((
    "accept", "accept-language", "content-type", "content-length", "content-encoding",
    "cache-control", "date", "expires", "last-modified", "etag", "server", "allow", "vary",
))
PHASES = ("connect", "send", "wait", "receive")


def safe_url(raw):
    url = urllib.parse.urlsplit(raw)
    query = urllib.parse.urlencode([(key, "[redacted]") for key, _ in urllib.parse.parse_qsl(url.query, keep_blank_values=True)])
    host = url.hostname or ""
    if ":" in host:
        host = "[" + host + "]"
    if url.port:
        host += ":" + str(url.port)
    result = urllib.parse.urlunsplit((url.scheme, host, url.path, query, ""))
    return re.sub(r'[\x00-\x1f\x7f]', lambda match: '%%%02X' % ord(match.group(0)), result)[:2048]


def safe_headers(items):
    return [{"name": key, "value": re.sub(r'[\x00-\x1f\x7f]', ' ', value)[:200]} for key, value in items if key.lower() in SAFE_HEADERS][:16]


def error_kind(error):
    if isinstance(error, socket.gaierror):
        return "dns"
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(error, ConnectionRefusedError):
        return "refused"
    if isinstance(error, (http.client.IncompleteRead, EOFError)):
        return "incomplete"
    if isinstance(error, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
        return "reset"
    if isinstance(error, (ValueError, http.client.HTTPException)):
        return "protocol"
    return "io"


class BodyPreview:
    def __init__(self, enabled, content_type="", content_encoding=""):
        self.data = bytearray()
        self.total = 0
        self.mime = content_type.split(";")[0].strip().lower()
        text = self.mime.startswith("text/") or self.mime in (
            "application/json", "application/xml", "application/x-www-form-urlencoded",
            "application/javascript", "application/problem+json",
        ) or self.mime.endswith(("+json", "+xml"))
        self.reason = "disabled" if not enabled else "encoded" if content_encoding and content_encoding != "identity" else "binary" if not text else None

    def add(self, data):
        self.total += len(data)
        if self.reason is None:
            if any(value < 32 and value not in (9, 10, 13) for value in data):
                self.reason = 'binary'
                self.data.clear()
            else:
                self.data.extend(data[:max(0, BODY_LIMIT - len(self.data))])

    def snapshot(self):
        text = self.data.decode('utf-8', errors='replace') if self.reason is None else None
        rendered = text.encode('utf-8') if text is not None else b''
        if len(rendered) > BODY_LIMIT:
            text = rendered[:BODY_LIMIT].decode('utf-8', errors='ignore')
        return {"text": text,
                "mimeType": self.mime, "truncated": (self.total > len(self.data) or len(rendered) > BODY_LIMIT) if self.reason is None else False,
                "reason": self.reason, "capturedBytes": len(self.data), "limit": BODY_LIMIT}


class Capture:
    def __init__(self):
        self.lock = threading.RLock()
        self.entries = collections.deque(maxlen=LIMIT)
        self.sequence = 0
        self.active = 0
        self.recording = False
        self.finalizing = False
        self.started = None
        self.stopped = None
        self.stop_reason = None
        self.capture_id = None
        self.pcap_requested = False
        self.pcap_state = "none"
        self.bodies = False
        self.total = 0
        self.evicted = 0
        self.rejected = 0

    def start(self, pcap=False, bodies=False):
        with self.lock:
            if self.recording or self.finalizing or self.pcap_state == "error":
                raise ValueError("busy")
            self.clear()
            self.recording = True
            self.started = time.time()
            self.stopped = None
            self.stop_reason = None
            self.capture_id = uuid.uuid4().hex
            self.pcap_requested = pcap
            self.pcap_state = "starting" if pcap else "none"
            self.bodies = bodies

    def clear(self):
        with self.lock:
            self.entries.clear()
            self.total = self.evicted = self.rejected = 0

    def stop(self, reason="manual"):
        with self.lock:
            if self.recording:
                self.recording = False
                self.stopped = time.time()
                self.stop_reason = reason
                for item in self.entries:
                    if item['outcome'] in ('pending', 'open'):
                        self.finish(item, outcome='stopped')
            if self.pcap_state in ("starting", "recording", "error"):
                self.pcap_state = "finalizing"
                self.finalizing = True

    def pcap_result(self, state):
        with self.lock:
            self.pcap_state = state
            self.finalizing = state == "finalizing"

    def connection(self, change=0, rejected=False):
        with self.lock:
            self.active = max(0, self.active + change)
            if rejected:
                self.rejected += 1

    def event(self, method, url):
        with self.lock:
            if not self.recording:
                return None
            self.sequence += 1
            self.total += 1
            if len(self.entries) == LIMIT:
                self.evicted += 1
            now = time.monotonic()
            item = {"id": self.sequence, "captureId": self.capture_id, "method": method, "url": safe_url(url),
                    "startedAt": time.time(), "status": None, "statusSource": None,
                    "outcome": "pending", "phase": "connect", "errorKind": None, "errorPhase": None,
                    "durationMs": None, "bytes": 0, "bytesSent": 0, "bytesReceived": 0,
                    "requestHeaders": [], "responseHeaders": [],
                    "_start": now, "_phaseAt": now, "_timings": {name: 0 for name in PHASES},
                    "_bodies": self.bodies}
            self.entries.append(item)
            return item

    def change(self, item, **values):
        if item is not None:
            with self.lock:
                if self.recording and item.get('captureId') == self.capture_id and not item.get('_frozen'):
                    item.update(values)

    def phase(self, item, phase):
        if item is not None:
            with self.lock:
                if item.get('_frozen') or item.get('captureId') != self.capture_id:
                    return
                now = time.monotonic()
                previous = item["phase"]
                if previous in PHASES:
                    item["_timings"][previous] += (now - item["_phaseAt"]) * 1000
                item.update(phase=phase, _phaseAt=now)

    def progress(self, item, direction, data, preview=None):
        if item is not None:
            with self.lock:
                if item.get('_frozen') or not self.recording or item.get('captureId') != self.capture_id:
                    return
                item[direction] += len(data)
                item["bytes"] = item["bytesSent"] + item["bytesReceived"]
                if preview is not None:
                    preview.add(data)
                    item["requestBody" if direction == "bytesSent" else "responseBody"] = preview.snapshot()

    def finish(self, item, error=None, outcome=None):
        if item is not None:
            with self.lock:
                if item.get('_frozen') or item.get('captureId') != self.capture_id:
                    return
                phase = item["phase"]
                if error is not None:
                    item.update(outcome="error", errorKind=error_kind(error), errorPhase=phase)
                else:
                    item["outcome"] = outcome or "complete"
                self.phase(item, "done")
                item["durationMs"] = round((time.monotonic() - item["_start"]) * 1000, 3)
                item['_frozen'] = True

    def snapshot(self, pcap_bytes=0, include_entries=True):
        with self.lock:
            now = time.monotonic()
            rows = []
            for item in self.entries if include_entries else ():
                row = {key: value for key, value in item.items() if not key.startswith("_")}
                row["timings"] = dict(item["_timings"])
                if item["phase"] in PHASES:
                    row["timings"][item["phase"]] += (now - item["_phaseAt"]) * 1000
                row["timings"] = {key: round(value, 3) for key, value in row["timings"].items()}
                row["elapsedMs"] = item["durationMs"] if item["durationMs"] is not None else round((now - item["_start"]) * 1000, 3)
                rows.append(row)
            return {"available": True, "protocolVersion": 3, "recording": self.recording, "finalizing": self.finalizing,
                    "proxyActive": True, "captureId": self.capture_id, "startedAt": self.started, "stoppedAt": self.stopped,
                    "stopReason": self.stop_reason, "captureBodies": self.bodies,
                    "pcapRequested": self.pcap_requested, "pcapState": self.pcap_state, "pcapBytes": pcap_bytes,
                    "limit": LIMIT, "totalCaptured": self.total, "evicted": self.evicted,
                    "rejectedConnections": self.rejected, "activeConnections": self.active, "connectionLimit": MAX_CONNECTIONS,
                    "entries": rows}
