"""JSON-lines driver runner; device adapters own actions and resource cleanup."""

import contextlib
from concurrent.futures import ThreadPoolExecutor, wait
import json
import os
import signal
import threading
import sys


@contextlib.contextmanager
def protocol_output():
    # In-memory streams also support testing adapters without opening hardware.
    original = sys.stdout
    try:
        descriptor = original.fileno()
    except (AttributeError, OSError):
        with contextlib.redirect_stdout(sys.stderr):
            yield original
        return
    original.flush()
    with os.fdopen(os.dup(descriptor), "w") as output:
        os.dup2(sys.stderr.fileno(), descriptor)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                yield output
        finally:
            os.dup2(output.fileno(), descriptor)


def release(*actions):
    """Attempt every cleanup stage and report all failures."""
    errors = []
    for action in actions:
        try:
            action()
        except Exception as error:
            errors.append(error)
    if errors:
        raise ExceptionGroup("cleanup failed: " + "; ".join(map(str, errors)), errors)


@contextlib.contextmanager
def termination():
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    def stop(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise SystemExit(128 + signum)
    previous = signal.signal(signal.SIGTERM, stop)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


_operation = threading.local()


def cancellation():
    """SDK write hooks must check this event between bounded native operations.

    Stop sets it before calling the driver's halt hook. Do not hold a lock
    needed by read/halt while waiting for motion completion.
    """
    return getattr(_operation, "cancel", None)


def check_cancelled():
    event = cancellation()
    if event is not None and event.is_set():
        raise InterruptedError("device operation interrupted by stop")


def run(dispatch, cleanup, *, serving=None):
    """Serve correlated requests; observations and stop never enter the write queue.

    Lifecycle fences all resource users. Capture has its own ordered queue.
    One-shot clients retain the argv protocol and release temporary resources.
    """
    persistent = "--serve" in sys.argv if serving is None else serving
    ready = False
    fault = None
    stop_tail = None
    output_lock = threading.Lock()
    writes = []
    pending = set()
    pools = {}
    with protocol_output() as output, termination():
        def respond(action, args):
            nonlocal ready, fault
            try:
                if not isinstance(action, str) or not isinstance(args, dict):
                    raise ValueError("Expected action and object args")
                if action in {"load", "unload", "status"} and args:
                    raise ValueError(f"{action} accepts no arguments")
                if persistent and not ready and action not in {"load", "unload", "status"}:
                    raise RuntimeError("device is inactive; load it before operations")
                if fault is not None and action not in {"read", "status", "fk", "ik", "load", "unload", "stop", "record_start", "record_stop"}:
                    raise RuntimeError(f"Stop failed; reload required: {fault}")
                check_cancelled()
                result = dispatch(action, args)
                check_cancelled()
                if action == "load":
                    ready = result.get("ok") is True
                    if ready:
                        fault = None
                    if not ready:
                        try:
                            cleanup()
                        except Exception as error:
                            result["error"] = f"{result.get('error', 'load failed')}; {error}"
                if action == "stop" and result.get("ok") is not True:
                    fault = result.get("error", "stop failed")
                if action == "unload":
                    ready = False
                return result
            except Exception as error:
                if action == "stop":
                    fault = str(error)
                return {"ok": False, "error": f"{type(error).__name__}: {error}"}

        def send(request, cancel=None, predecessor=None):
            if predecessor is not None:
                predecessor.result()
            _operation.cancel = cancel
            try:
                result = respond(request["action"], request.get("args", {}))
                with output_lock:
                    output.write(json.dumps({**result, "id": request["id"]}, allow_nan=False) + "\n")
                    output.flush()
            finally:
                _operation.cancel = None

        try:
            if not persistent:
                action = sys.argv[1] if len(sys.argv) > 1 else "read"
                args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
                output.write(json.dumps(respond(action, args), allow_nan=False) + "\n")
                output.flush()
                return
            pools = {name: ThreadPoolExecutor(max_workers=count, thread_name_prefix=name)
                     for name, count in (("read", 8), ("write", 1), ("capture", 1), ("stop", 1))}
            for line in sys.stdin:
                request = json.loads(line)
                if not isinstance(request.get("id"), str):
                    raise ValueError("persistent requests require a string id; migrate the caller")
                if request.get("interrupt") is True:
                    for _, event in writes:
                        event.set()
                    with output_lock:
                        output.write(json.dumps({"id": request["id"], "ok": True}) + "\n")
                        output.flush()
                    continue
                action = request["action"]
                pending = {future for future in pending if not future.done()}
                writes = [(future, event) for future, event in writes if not future.done()]
                if action in {"stop", "unload"}:
                    for _, event in writes:
                        event.set()
                if action in {"load", "unload"}:
                    wait(pending)
                    send(request)
                    continue
                kind = ("read" if action in {"read", "status", "fk", "ik"} else
                        "capture" if action in {"record_start", "record_stop"} else
                        "stop" if action == "stop" else "write")
                event = threading.Event() if kind == "write" else None
                future = pools[kind].submit(send, request, event, stop_tail if kind == "write" else None)
                if kind == "stop":
                    stop_tail = future
                pending.add(future)
                if event is not None:
                    writes.append((future, event))
        finally:
            for _, event in writes:
                event.set()
            if persistent and ready and any(not future.done() for future, _ in writes):
                # Halt before waiting for SDK readers/writers to drain. An abort
                # must not postpone the physical stop until worker-thread exit.
                result = respond("stop", {})
                if result.get("ok") is not True:
                    print(f"Driver exit stop failed: {result}", file=sys.stderr)
            # Native hooks cooperate with cancellation; the owning process helper
            # enforces the final bound if a third-party SDK does not return.
            for pool in pools.values():
                pool.shutdown(wait=True, cancel_futures=True)
            cleanup()
