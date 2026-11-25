"""Kinex API for exec programs.

A program imports what it uses: device for a loaded device's topics, services and
actions, world for time and waits, runtime for device discovery, lib for reusable
functions, subagent for a judgment only a model can make, args for its arguments and
finish to end with its result. Programs compute with NumPy arrays, poses (pose) and
seconds (seconds); devices and finish convert them to and from ROS fields and JSON, and
plain gives the JSON form to a program that writes its own. The
host dialog carries invocation metadata, profiles, subagent calls and the result. One
execution approval covers the invocation; Python cannot change device lifecycle.
"""

import asyncio
import itertools
import json
import os
import queue
import sys
import threading

from kinex.communication import seconds
from kinex.device import device
from kinex.errors import RPCError, OperationError
from kinex.common.plain import image_file, plain
from kinex.values import pose
from kinex.world import world

# Protocol channel: the real stdout, captured only INSIDE a tool dialog (the
# harness marks its runtime process with KINEX_TOOL_DIALOG=1). Everything print()ed
# afterwards lands on stderr, so debug output can never corrupt the dialog.
# Outside a dialog (a device node or standalone script importing kinex) the
# import stays side-effect-free and any protocol call raises instead.
_out = None
_in = None
_buffer = b""
_request = None  # the runtime's startup request, then the request of the program it runs
_serve = None  # the runtime's handler of the host's own requests


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
        raise RuntimeError("missing startup request")
    _request = json.loads(line)
    if not isinstance(_request, dict):
        raise ValueError("the startup request is an object")


_write_lock = threading.Lock()


def _emit(payload):
    if _out is None:
        raise RuntimeError("not running inside exec: the host dialog is unavailable")
    line = json.dumps(plain(payload), allow_nan=False) + "\n"
    with _write_lock:
        _out.write(line)
        _out.flush()


# Calls carry an id, so a slow one, such as a subagent, does not hold back the others.
# One thread reads the host's answers and hands each to the call that waits for it.
_calls = {}
_calls_lock = threading.Lock()
_ids = itertools.count(1)


def _read():
    for line in _lines():
        answer = json.loads(line)
        if "action" in answer or "cancel" in answer:
            _serve(answer)
            continue
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
    _serve(None)


def _listen(serve):
    """Read the dialog: the host's answers go to the calls that wait for them, its requests to serve, and None
    once the host closes it."""
    global _serve
    _serve = serve
    threading.Thread(target=_read, daemon=True).start()


class _Output:
    """A program's printed text, sent through the dialog so it stays in order with the result."""

    def write(self, text):
        if text:
            _emit({"output": text})
        return len(text)

    def flush(self):
        pass


def _send(payload, deliver):
    if _out is None:
        raise RuntimeError("not running inside exec: the host dialog is unavailable")
    with _calls_lock:
        if None in _calls:
            raise RuntimeError("harness closed the dialog")
        identifier = next(_ids)
        _calls[identifier] = deliver
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


class _Finished(SystemExit):
    """finish's exit, carrying what exec returns once the program's scope is released."""

    def __init__(self, payload):
        super().__init__(0)
        self.payload = payload


def args():
    """The args this exec was given."""
    if _request is None:
        raise RuntimeError("not running inside exec")
    return _request["args"]


def finish(result=None, file=None):
    """End the program with its result; call it from main().

    result is JSON-ready data: messages, poses, arrays and times are converted. Images
    are never data: file attaches an image path or image message, or a list of them.
    """
    if _out is None:
        raise RuntimeError("not running inside exec: the host dialog is unavailable")
    files = [image_file(item) for item in ([] if file is None else file if isinstance(file, (list, tuple)) else [file])]
    if None in files:
        raise TypeError("finish file takes image paths and image messages")
    payload = {"return": plain(result), "files": files}
    json.dumps(payload, allow_nan=False)  # an unserialisable result fails here, at the call
    raise _Finished(payload)


def _shown(name, value):
    """One named item for a subagent: an image as a file, anything else as text."""
    if isinstance(value, str):
        return {"name": name, "text": value}
    image = image_file(value)
    return {"name": name, "image": image} if image else {"name": name, "text": json.dumps(plain(value), allow_nan=False)}


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
