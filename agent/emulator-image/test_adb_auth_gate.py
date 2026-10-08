"""Exercise the real Bash gate against an untrusted TCP ADB peer.

No Android, Docker or socat is needed. The command after the gate is a real TCP
listener, so tests observe whether a management port became reachable.
"""
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import time
import unittest


HERE = Path(__file__).resolve().parent
BASH = ("C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash"))
TOKEN = bytes(range(20))
FORWARD = """
import socket, sys
with socket.socket() as listener:
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', int(sys.argv[1])))
    listener.listen(1)
    listener.settimeout(4)
    connection, _ = listener.accept()
    connection.close()
"""


def packet(command=b"AUTH", arg0=1, arg1=0, payload=TOKEN, *, length=None,
           checksum=None, magic=None):
    code = int.from_bytes(command, "little")
    return struct.pack("<6I", code, arg0, arg1,
                       len(payload) if length is None else length,
                       sum(payload) if checksum is None else checksum,
                       code ^ 0xffffffff if magic is None else magic) + payload


def receive_exact(connection, size):
    result = b""
    while len(result) < size:
        chunk = connection.recv(size - len(result))
        if not chunk:
            raise AssertionError(f"connection closed after {len(result)} of {size} bytes")
        result += chunk
    return result


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash is required")
class AuthenticationGateTest(unittest.TestCase):
    def setUp(self):
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(8)
        self.listener.settimeout(5)
        self.internal_port = self.listener.getsockname()[1]
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            self.external_port = reserve.getsockname()[1]
        self.children = []
        self.connections = []

    def tearDown(self):
        for connection in self.connections:
            connection.close()
        self.listener.close()
        for process in self.children:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=6)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=6)

    def start(self, seconds=2):
        process = subprocess.Popen([
            BASH, (HERE / "adb-auth-gate.sh").as_posix(),
            str(self.internal_port), str(seconds), "--",
            sys.executable, "-c", FORWARD, str(self.external_port),
        ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True)
        self.children.append(process)
        connection, _ = self.listener.accept()
        connection.settimeout(5)
        self.connections.append(connection)
        request = receive_exact(connection, 31)
        self.assertEqual(request, packet(b"CNXN", 0x01000000, 4096, b"host::\0"))
        return process, connection

    def assert_closed(self):
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.external_port), timeout=0.1)

    def assert_failed(self, process, message):
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 64, stdout + stderr)
        self.assertIn(message, stderr)
        self.assertNotIn("opening management transport", stdout)
        self.assert_closed()

    def test_port_opens_only_after_complete_valid_auth_challenge(self):
        process, connection = self.start()
        self.assert_closed()
        # Fragment both header and payload. A prefix spelling AUTH, and even a
        # complete header, cannot authorize the public listener on their own.
        response = packet()
        for fragment in (response[:4], response[4:24], response[24:39]):
            connection.sendall(fragment)
            time.sleep(0.05)
            self.assertIsNone(process.poll())
            self.assert_closed()
        connection.sendall(response[39:])
        deadline = time.monotonic() + 3
        while True:
            try:
                client = socket.create_connection(("127.0.0.1", self.external_port), timeout=0.1)
                client.close()
                break
            except OSError:
                if time.monotonic() >= deadline or process.poll() is not None:
                    self.fail("management port did not open after a valid AUTH challenge")
                time.sleep(0.02)
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertIn("authentication challenge verified", stdout)

    def test_unauthenticated_cnxn_is_rejected_immediately(self):
        process, connection = self.start(seconds=30)
        started = time.monotonic()
        connection.sendall(packet(b"CNXN", 0x01000000, 4096, b"device::\0"))
        self.assert_failed(process, "without authentication")
        self.assertLess(time.monotonic() - started, 3)

    def test_malformed_auth_cannot_open_management_port(self):
        cases = [
            (packet(magic=0), "invalid ADB response magic"),
            (packet(arg0=2), "expected an ADB AUTH token challenge"),
            (packet(arg1=1), "expected an ADB AUTH token challenge"),
            (packet(length=0xffffffff), "expected an ADB AUTH token challenge"),
            (packet(checksum=0), "invalid ADB AUTH token checksum"),
            (packet(b"WRTE"), "expected an ADB AUTH token challenge"),
            (packet()[:12], "truncated ADB response header"),
            (packet()[:-1], "truncated ADB AUTH token"),
        ]
        for response, message in cases:
            with self.subTest(message=message, response=response[:24].hex()):
                process, connection = self.start()
                connection.sendall(response)
                connection.shutdown(socket.SHUT_WR)
                self.assert_failed(process, message)

    def test_silent_adbd_times_out_with_management_port_closed(self):
        process, _ = self.start(seconds=2)
        self.assert_closed()
        self.assert_failed(process, "timed out after 2s")

    @unittest.skipIf(os.name == "nt", "requires POSIX SIGTERM semantics")
    def test_term_during_probe_closes_connection_without_opening_port(self):
        for phase, response in [("awaiting header", b""), ("partial header", packet()[:4]),
                                ("partial token", packet()[:30])]:
            with self.subTest(phase=phase):
                process, connection = self.start(seconds=30)
                if response:
                    connection.sendall(response)
                started = time.monotonic()
                process.terminate()
                stdout, stderr = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 143, stdout + stderr)
                connection.settimeout(0.5)
                try:
                    self.assertEqual(connection.recv(1), b"")
                except ConnectionResetError:
                    # Closing with unread partial header/token bytes may send
                    # TCP RST instead of FIN. Both prove the probe socket closed.
                    pass
                self.assertLess(time.monotonic() - started, 2)
                self.assert_closed()


if __name__ == "__main__":
    unittest.main()
