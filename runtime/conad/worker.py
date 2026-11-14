#!/usr/bin/env python3
"""Private SeleniumBase browser worker for Conad. Linux/macOS, Python 3.10+."""

from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import hashlib
import json
import math
import os
from pathlib import Path
import select
import signal
import socket
import stat
import sys
import tempfile
import threading
import time

from actions import dispatch
from browser import BrowserSession, launch_browser, private_directory, private_file
from model import ConadError, DeadlineExceeded, MAX_OPERATION_SECONDS, MAX_REQUEST_BYTES, PROTOCOL_VERSION, RequestContext

ACTIONS = {
    "hello", "shutdown", "status", "browser_login", "login", "store",
    "search_page", "product", "basket", "checkout_summary",
    "basket_add", "basket_update", "basket_remove", "basket_clear",
}
JSON_OUTPUT = sys.__stdout__


def emit(value):
    # Never forward browser-library output into MCP stdio or a log file.
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), file=JSON_OUTPUT, flush=True)


@contextmanager
def quiet_framework_output():
    """Suppress Python and inherited native/browser file-descriptor output."""
    global JSON_OUTPUT
    saved_out, saved_err = os.dup(1), os.dup(2)
    previous_output = JSON_OUTPUT
    safe_output = os.fdopen(os.dup(saved_out), "w", encoding="utf-8", buffering=1)
    try:
        JSON_OUTPUT = safe_output
        with open(os.devnull, "w") as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            with redirect_stdout(sink), redirect_stderr(sink):
                yield
    finally:
        # Flush buffers while descriptors still point at the sink, including
        # when a browser exception unwinds the context.
        for stream in (sys.__stdout__, sys.__stderr__):
            try:
                stream.flush()
            except (OSError, ValueError):
                pass
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
        JSON_OUTPUT = previous_output
        safe_output.close()


def profile_key(profile):
    return hashlib.sha256(str(profile.resolve()).encode()).hexdigest()


class ProfileLock:
    """Lock the profile before launching Chrome, even for different sockets."""

    def __init__(self, profile):
        self.path = profile / ".open-supermarkets-worker.lock"
        self.fd = None

    def __enter__(self):
        import fcntl
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            private_file(self.path)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise ConadError("CONAD_PROFILE_BUSY", "This Conad profile already has a browser worker. Use its socket or stop it first.") from None
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd
        return self

    def __exit__(self, *_args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


@contextmanager
def alarm(seconds):
    # A BaseException escapes broad browser-library Exception handlers. Stop
    # the worker after interrupting a CDP call rather than reuse that connection.
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = signal.getsignal(signal.SIGALRM)
    def expired(_signum, _frame):
        raise DeadlineExceeded()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(.001, seconds))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def connected(conn):
    try:
        ready, _, _ = select.select([conn], [], [], 0)
        return not ready or conn.recv(1, socket.MSG_PEEK) != b""
    except OSError:
        return False


def read_request(conn):
    conn.settimeout(5)
    data = bytearray()
    while b"\n" not in data:
        part = conn.recv(min(4096, MAX_REQUEST_BYTES + 1 - len(data)))
        if not part:
            raise ConadError("CONAD_INVALID_INPUT", "The Conad worker received an incomplete request.")
        data.extend(part)
        if len(data) > MAX_REQUEST_BYTES:
            raise ConadError("CONAD_INVALID_INPUT", "The Conad worker request is too large.")
    if data.count(b"\n") != 1 or data[-1:] != b"\n":
        raise ConadError("CONAD_INVALID_INPUT", "Only one Conad operation is allowed per connection.")
    try:
        request = json.loads(data.decode("utf-8"), parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise ConadError("CONAD_INVALID_INPUT", "The Conad worker request is not valid JSON.") from None
    if not isinstance(request, dict) or not isinstance(request.get("action"), str) or request["action"] not in ACTIONS or not isinstance(request.get("args"), dict):
        raise ConadError("CONAD_INVALID_INPUT", "The Conad worker request has an invalid action or arguments.")
    return request


def handle_connection(conn, session, key):
    """Return True when the connection must be discarded with its browser."""
    context = None
    stop = False
    operation_started = False
    response = {"protocol_version": PROTOCOL_VERSION, "profile_key": key}
    try:
        request = read_request(conn)
        if request.get("protocol_version") != PROTOCOL_VERSION or request.get("profile_key") != key:
            raise ConadError("CONAD_PROFILE_MISMATCH", "Conad worker protocol/profile does not match the configured client.")
        deadline = request.get("deadline_ms")
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline):
            raise ConadError("CONAD_INVALID_INPUT", "A bounded Conad operation deadline is required.")
        remaining = min(MAX_OPERATION_SECONDS, deadline / 1000 - time.time())
        context = RequestContext(time.monotonic() + max(0, remaining), lambda: connected(conn))
        context.check()
        action = request["action"]
        if action == "hello":
            result = {"engine": "seleniumbase", "pid": os.getpid()}
        elif action == "shutdown":
            result, stop = {"closed": True}, True
        else:
            session.context = context
            with alarm(remaining):
                operation_started = True
                result = dispatch(session, action, request["args"])
                context.check()
        response.update(ok=True, data=result)
    except DeadlineExceeded:
        stop = operation_started
        response.update(ok=False, error={"code": "CONAD_TIMEOUT", "message": "Conad browser operation expired or was disconnected. Read the basket before retrying a write.", "mutation_may_have_applied": bool(context and context.mutation_started)})
    except ConadError as error:
        response.update(ok=False, error={"code": error.code, "message": error.safe_message, "mutation_may_have_applied": bool(context and context.mutation_started)})
    except Exception:
        response.update(ok=False, error={"code": "CONAD_BROWSER_ERROR", "message": "Conad browser operation failed. Inspect the visible browser and read the basket before retrying.", "mutation_may_have_applied": bool(context and context.mutation_started)})
    finally:
        request = None  # Do not retain credential arguments between requests.
    try:
        try:
            payload = json.dumps(response, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            response.update(ok=False, error={"code": "CONAD_PROTOCOL_ERROR", "message": "Conad returned non-serializable browser data.", "mutation_may_have_applied": bool(context and context.mutation_started)})
            response.pop("data", None)
            payload = json.dumps(response, allow_nan=False)
        conn.sendall((payload + "\n").encode())
    except (OSError, ValueError):
        # A caller disconnect must never crash the daemon or replay its write.
        pass
    return stop


def serve(session, socket_path, key, idle_seconds):
    if socket_path.exists() or socket_path.is_symlink():
        info = socket_path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ConadError("CONAD_PROFILE_ERROR", "Refusing to replace an untrusted Conad socket path.")
        # ProfileLock proves no other worker for this profile can own it.
        # Also probe the socket: never unlink an active different worker.
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(.2)
            probe.connect(str(socket_path))
        except (ConnectionRefusedError, FileNotFoundError):
            socket_path.unlink(missing_ok=True)
        else:
            raise ConadError("CONAD_PROFILE_BUSY", "The configured Conad socket is already active.")
        finally:
            probe.close()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    bound = False
    try:
        server.bind(str(socket_path))
        bound = True
        socket_path.chmod(0o600)
        server.listen(16)
        server.settimeout(idle_seconds)
        emit({"event": "ready", "protocol_version": PROTOCOL_VERSION, "profile_key": key})
        while True:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                break
            with conn:
                if handle_connection(conn, session, key):
                    break
    finally:
        server.close()
        if bound:
            socket_path.unlink(missing_ok=True)


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        raise ConadError("CONAD_INVALID_INPUT", "Invalid Conad worker arguments; use --help.")


def parse_args():
    parser = SafeParser(description=__doc__)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--reuse-profile", action="store_true")
    parser.add_argument("--binary", default=os.environ.get("CONAD_BROWSER_EXECUTABLE"))
    parser.add_argument("--socket", type=Path)
    parser.add_argument("--idle-timeout", type=int, default=900)
    return parser.parse_args()


def main(args):
    if os.name != "posix":
        raise ConadError("CONAD_PLATFORM_UNSUPPORTED", "The Conad SeleniumBase worker requires Unix sockets and a visible Linux/macOS browser.")
    if not 60 <= args.idle_timeout <= 86_400:
        raise ConadError("CONAD_INVALID_INPUT", "Conad idle timeout must be between 60 and 86400 seconds.")
    profile = private_directory(args.profile or Path(tempfile.mkdtemp(prefix="conad-profile-")))
    if not args.reuse_profile and any(profile.iterdir()):
        raise ConadError("CONAD_PROFILE_ERROR", "The profile is not empty. Use a new dedicated profile or explicitly opt into --reuse-profile.")
    socket_path = args.socket.expanduser().absolute() if args.socket else None
    if socket_path:
        private_directory(socket_path.parent)
        if len(os.fsencode(socket_path)) > 100:
            raise ConadError("CONAD_PROFILE_ERROR", "The Conad Unix socket path is too long; choose a shorter private runtime directory.")
    with ProfileLock(profile):
        with launch_browser(profile, args.binary) as driver:
            session = BrowserSession(driver, profile, os.environ.get("CONAD_REMEMBER_SESSION", "true") != "false")
            with alarm(60):
                session.open("/home")
                session.reject_cookies()
                session.state()  # Validate/bind the account before accepting work.
            if socket_path:
                serve(session, socket_path, profile_key(profile), args.idle_timeout)
            else:
                emit({"event": "login", **session.prepare_login()})
                for line in sys.stdin:
                    session.context = RequestContext(time.monotonic() + MAX_OPERATION_SECONDS)
                    try:
                        command = json.loads(line)
                        if command.get("action") == "quit":
                            break
                        if command.get("action") == "status":
                            emit(session.state())
                        elif command.get("action") == "submit_login":
                            emit(session.submit_login())
                        else:
                            emit({"error": "Use status, submit_login or quit."})
                    except Exception:
                        emit({"error": "Browser action failed; inspect the visible browser.", "interaction_required": True})
                    command = None
    return 0


def entrypoint():
    def terminate(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    try:
        args = parse_args()
        # Framework output can contain form values or page source on failure.
        with quiet_framework_output():
            return main(args)
    except KeyboardInterrupt:
        return 130
    except (ConadError, DeadlineExceeded) as error:
        emit({"event": "error", "code": getattr(error, "code", "CONAD_TIMEOUT"), "message": getattr(error, "safe_message", "Conad browser startup timed out.")})
        return 1
    except Exception:
        emit({"event": "error", "code": "CONAD_STARTUP_FAILED", "message": "Could not start Conad SeleniumBase. Check Python dependencies, Chrome, display and profile permissions."})
        return 1


if __name__ == "__main__":
    raise SystemExit(entrypoint())
