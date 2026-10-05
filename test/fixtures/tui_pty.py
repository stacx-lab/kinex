"""Run the real TUI in a sized PTY, relay output, and reap it on failure."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 100, 0, 0))
deadline = time.monotonic() + float(os.environ.get("TUI_TEST_TIMEOUT", "20"))
status = None
received = b""
keys = json.loads(os.environ.get("TUI_TEST_KEYS", "[]"))
trigger = os.environ.get("TUI_TEST_TRIGGER", "").encode()
next_key = None
started = False
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            received += chunk
        if not started and trigger in received:
            started = True
            received = b""
        if keys and started:
            wait, text = keys[0]
            if isinstance(wait, str):
                ready = wait.encode() in received
            else:
                if next_key is None:
                    next_key = time.monotonic() + wait
                ready = time.monotonic() >= next_key
            if ready:
                keys.pop(0)
                os.write(master, text.encode())
                received = b""
                next_key = None
        found, value = os.waitpid(pid, os.WNOHANG)
        if found:
            status = value
            break
    while status is None and time.monotonic() < deadline:
        found, value = os.waitpid(pid, os.WNOHANG)
        if found:
            status = value
            break
        time.sleep(0.02)
    if status is None:
        raise TimeoutError("TUI did not exit before the test deadline")
finally:
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(status))
