"""Kinex invocation API for exec.

Use io for async pub/sub and request/response, runtime for device discovery, lib for
reusable programs and subagent for a judgment only a model can make; exec returns what
the invoked code returns. The host dialog carries invocation metadata, profiles, subagent
calls and that result. One execution approval covers
the invocation; Python calls cannot change device lifecycle.
"""

import asyncio
import itertools
import json
import os
import queue
import sys
import threading
import traceback
from pathlib import Path

from kinex.communication import communication, io
from kinex.errors import RPCError, OperationError
from kinex.common.plain import IMAGES, plain

# Protocol channel: the real stdout, captured only INSIDE a tool dialog (the
# harness marks exec processes with KINEX_TOOL_DIALOG=1). Everything print()ed
# afterwards lands on stderr, so debug output can never corrupt the dialog.
# Outside a dialog (a device node or standalone script importing kinex) the
# import stays side-effect-free and any protocol call raises instead.
_out = None
_in = None
_buffer = b""
_request = None


def _lines():
    """The host's lines. The descriptor is read directly: a buffered file held by the
    reading thread could not be closed when the interpreter exits."""
    global _buffer
    while True:
        while b"\n" in _buffer:
            line, _, _buffer = _buffer.partition(b"\n")
            yield line
        chunk = os.read(_in, 65536)
        if not chunk:
            return
        _buffer += chunk


if os.environ.get("KINEX_TOOL_DIALOG") == "1":
    os.environ.pop("KINEX_TOOL_DIALOG")
    _out = os.fdopen(os.dup(sys.stdout.fileno()), "w")
    _in = os.dup(sys.stdin.fileno())
    sys.stdout = sys.stderr
    # Consume startup before any call reads the dialog.
    line = next(_lines(), None)
    if not line:
        raise RuntimeError("missing exec startup request")
    _request = json.loads(line)
    if not isinstance(_request, dict) or not isinstance(_request.get("args"), dict):
        raise ValueError("exec startup request requires object args")


_write_lock = threading.Lock()


def _emit(payload):
    if _out is None:
        raise RuntimeError("not running inside exec: the host dialog is unavailable")
    line = json.dumps(plain(payload), allow_nan=False) + "\n"
    with _write_lock:
        _out.write(line)
        _out.flush()


if _out is not None:
    # Uncaught exceptions travel through the dialog once, leaving stderr to printed output.
    def _excepthook(kind, error, trace):
        if isinstance(error, RPCError) and (error.code is not None or error.details is not None):
            _emit(error.payload())
        else:
            _emit({"error": "".join(traceback.format_exception(kind, error, trace)).rstrip()})

    sys.excepthook = _excepthook


# Calls carry an id, so a slow one, such as a subagent, does not hold back the others.
# One thread reads the host's answers and hands each to the call that waits for it.
_calls = {}
_calls_lock = threading.Lock()
_ids = itertools.count(1)
_reading = False


def _read():
    for line in _lines():
        answer = json.loads(line)
        with _calls_lock:
            deliver = _calls.pop(answer.pop("id", None), None)
        if deliver:
            deliver(answer)
    with _calls_lock:
        waiting = list(_calls.values())
        _calls.clear()
        _calls[None] = None  # marks the dialog closed
    for deliver in waiting:
        deliver(None)


def _send(payload, deliver):
    global _reading
    if _out is None:
        raise RuntimeError("not running inside exec: the host dialog is unavailable")
    with _calls_lock:
        if None in _calls:
            raise RuntimeError("harness closed the dialog")
        identifier = next(_ids)
        _calls[identifier] = deliver
        if not _reading:
            _reading = True
            threading.Thread(target=_read, daemon=True).start()
    _emit({**payload, "id": identifier})


def _answer(response):
    if response is None:
        raise RuntimeError("harness closed the dialog")
    if not response.get("ok", False):
        raise RPCError(response.get("error", "harness call failed"),
                       code=response.get("code"), details=response.get("details"))
    response.pop("ok", None)
    return response


def _rpc(payload):
    answers = queue.SimpleQueue()
    _send(payload, answers.put)
    return _answer(answers.get())


async def _call(payload):
    """A host call that leaves the event loop free while the host works."""
    loop = asyncio.get_running_loop()
    answer = loop.create_future()
    _send(payload, lambda response: loop.call_soon_threadsafe(lambda: answer.done() or answer.set_result(response)))
    return _answer(await answer)


def profile(device, *, optional=False):
    """The device's parsed profile.yaml — the white-box read path for top-level
    calibrated facts (color projection, frames, URDF model and typed device facts).
    With optional=True, an absent profile returns None; other errors still raise."""
    return _rpc({"call": "profile", "device": device, "optional": optional})["profile"]


def robot():
    """The workspace robot's workspace manifest (identity and keep-out zones)."""
    return _rpc({"call": "robot"})["robot"]


def _shown(name, value):
    """One named item for a subagent: an image as a file, anything else as text."""
    kind = f"{type(value).__module__.split('.')[0]}/{type(value).__name__}" if hasattr(value, "get_fields_and_field_types") else None
    if kind in IMAGES or isinstance(value, Path):
        files = []
        plain(value, files)
        return {"name": name, "image": files[0]}
    return {"name": name, "text": value if isinstance(value, str) else json.dumps(plain(value, []), allow_nan=False)}


async def subagent(instruction, *, show=None, model=None, thinking=None, timeout_s=60):
    """Ask a model for a judgment and return its reply as text.

    The subagent sees only the instruction and the named items in show: a camera image
    message or an image Path is shown as an image, anything else as text. It has no
    tools and no memory of other calls, so say exactly what form the reply must take
    and parse it here; the reply is model output, so check it before acting on it.
    model and thinking override the configured subagent for this call. Call it where
    the robot is at rest: the program waits for the reply, the robot does not.

    Example: reply = await subagent("Is the mug upright? Answer yes or no.", show={"wrist": image})
    """
    request = {"call": "subagent", "instruction": instruction, "show": [_shown(name, value) for name, value in (show or {}).items()],
               "model": model, "thinking": thinking, "timeout_s": timeout_s}
    return (await _call(request))["text"]
