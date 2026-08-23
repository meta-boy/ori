#!/usr/bin/env python3
"""Prove websockify serves a real WebSocket by completing an RFC 6455 upgrade.

Used by scripts/golden-clone-check.sh against the sandbox's own loopback:
browser <-> websockify(127.0.0.1:6080) <-> x11vnc(127.0.0.1:5900). websockify
only answers the upgrade (HTTP 101) AFTER it has connected to the VNC backend,
so a correct handshake here proves X -> x11vnc -> websockify end to end.

Exit 0 on a complete handshake with a matching Sec-WebSocket-Accept, else 1.
Retries briefly so a freshly-booted sandbox whose desktop is still starting
passes.
"""

import base64
import hashlib
import os
import socket
import sys
import time

HOST = "127.0.0.1"
PORT = 6080
PATH = "/websockify"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
RETRIES = 20
RETRY_DELAY = 1.0


def attempt():
    key = base64.b64encode(os.urandom(16)).decode()
    accept = base64.b64encode(
        hashlib.sha1((key + GUID).encode()).digest()
    ).decode()
    req = (
        f"GET {PATH} HTTP/1.1\r\n"
        f"Host: {HOST}:{PORT}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    try:
        s = socket.create_connection((HOST, PORT), timeout=5)
        s.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
        s.close()
    except OSError:
        return False, "connect failed"

    text = resp.decode(errors="replace")
    status = text.split("\r\n", 1)[0]
    return (
        status.startswith("HTTP/1.1 101")
        and f"Sec-WebSocket-Accept: {accept}" in text,
        status.strip(),
    )


last_status = "no attempt"
for _ in range(RETRIES):
    ok, last_status = attempt()
    if ok:
        print(f"websocket-handshake OK ({last_status})")
        sys.exit(0)
    time.sleep(RETRY_DELAY)

print(f"websocket-handshake FAIL (last status: {last_status})")
sys.exit(1)