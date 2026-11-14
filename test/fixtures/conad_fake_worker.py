#!/usr/bin/env python3
"""Selenium-free process fixture used only by the Node IPC lifecycle tests."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import time

# The client invokes a Python executable with: -u /packed/runtime/worker.py ...
assert sys.argv[1] == "-u"
runtime = Path(sys.argv[2])
for name in ("worker.py", "browser.py", "actions.py", "model.py", "requirements.txt"):
    assert (runtime.parent / name).is_file(), name
parser = argparse.ArgumentParser()
parser.add_argument("--profile", type=Path, required=True)
parser.add_argument("--socket", type=Path, required=True)
parser.add_argument("--reuse-profile", action="store_true")
parser.add_argument("--binary")
args = parser.parse_args(sys.argv[3:])
args.profile.mkdir(parents=True, exist_ok=True, mode=0o700)
key = hashlib.sha256(str(args.profile.resolve()).encode()).hexdigest()
count_file = args.profile / "launch-count"
count_file.write_text(str(int(count_file.read_text()) + 1 if count_file.exists() else 1))
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(str(args.socket))
args.socket.chmod(0o600)
server.listen(16)
print(json.dumps({"event": "ready", "protocol_version": 1, "profile_key": key}), flush=True)
writes = 0
try:
    while True:
        conn, _ = server.accept()
        with conn:
            data = b""
            while not data.endswith(b"\n"):
                data += conn.recv(4096)
            request = json.loads(data)
            action = request["action"]
            if action == "basket_add":
                writes += 1
                conn.close()  # Uncertain write: never replay automatically.
                continue
            result = {"engine": "seleniumbase", "pid": os.getpid(), "writes": writes}
            packet = {"protocol_version": 1, "profile_key": key, "ok": True, "data": result}
            try:
                if action == "product":
                    for char in (json.dumps(packet) + "\n"):
                        conn.sendall(char.encode())
                        time.sleep(.05)
                else:
                    conn.sendall((json.dumps(packet) + "\n").encode())
            except OSError:
                pass
            if action == "shutdown":
                break
finally:
    server.close()
    args.socket.unlink(missing_ok=True)
