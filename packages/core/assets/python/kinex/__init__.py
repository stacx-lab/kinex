"""Kinex invocation API for exec scripts and Python tools.

Use communication() for async pub/sub and request/response, runtime for discovery
and helpers for reusable functions. The host dialog carries invocation metadata,
profiles and selected results. One execution approval covers the invocation;
Python calls cannot change device lifecycle.
"""

import json
import os
import sys
import threading
import traceback
from kinex.communication import communication
from kinex.errors import RPCError, OperationError
from kinex.lib.plain import plain

_rpc_lock = threading.Lock()

# Protocol channel: the real stdout, captured only INSIDE a tool dialog (the
# harness marks its spawns with KINEX_TOOL_DIALOG=1). Everything print()ed
# afterwards lands on stderr, so debug output can never corrupt the dialog.
# Outside a dialog (a device node or skill script importing kinex.lib) the
# import stays side-effect-free and any protocol call raises instead.
_out = None
_in = None
_request = None
if os.environ.get("KINEX_TOOL_DIALOG") == "1":
    os.environ.pop("KINEX_TOOL_DIALOG")
    _out = os.fdopen(os.dup(sys.stdout.fileno()), "w")
    _in = os.fdopen(os.dup(sys.stdin.fileno()), "r")
    sys.stdout = sys.stderr
    # Consume startup before any RPC reads stdin, even if args() is never called.
    line = _in.readline()
    if not line:
        raise RuntimeError("missing tool startup request")
    _request = json.loads(line)
    if not isinstance(_request, dict) or not isinstance(_request.get("args"), dict):
        raise ValueError("tool startup request requires object args")


def _emit(payload):
    if _out is None:
        raise RuntimeError("not running inside a kinex tool dialog — the harness spawns tools with KINEX_TOOL_DIALOG=1")
    _out.write(json.dumps(plain(payload), allow_nan=False) + "\n")
    _out.flush()


if _out is not None:
    # Uncaught exceptions travel through the dialog once, leaving stderr to printed output.
    def _excepthook(kind, error, trace):
        if isinstance(error, RPCError) and (error.code is not None or error.details is not None):
            _emit(error.payload())
        else:
            _emit({"error": "".join(traceback.format_exception(kind, error, trace)).rstrip()})

    sys.excepthook = _excepthook


def _rpc(payload):
    with _rpc_lock:
        _emit(payload)
        line = _in.readline()
    if not line:
        raise RuntimeError("harness closed the dialog")
    response = json.loads(line)
    if not response.get("ok", False):
        raise RPCError(response.get("error", "harness call failed"),
                       code=response.get("code"), details=response.get("details"))
    response.pop("ok", None)
    return response


def args():
    """The tool's arguments from its startup request."""
    if _request is None:
        raise RuntimeError("not running inside a kinex tool dialog")
    return _request["args"]


def profile(device, *, optional=False):
    """The device's parsed profile.yaml — the white-box read path for top-level
    calibrated facts (color projection, frames, URDF model and typed device facts).
    With optional=True, an absent profile returns None; other errors still raise."""
    return _rpc({"call": "profile", "device": device, "optional": optional})["profile"]


def robot():
    """The workspace robot's workspace manifest (identity and safety)."""
    return _rpc({"call": "robot"})["robot"]


def finish(result=None, file=None):
    """End successfully with JSON-ready data; ROS messages and NumPy values are converted.

    `file` is an image path or ordered list of image paths; images are never data.
    """
    result = plain(result)
    payload = {**(result or {}), "file": file} if file else result
    _emit({"return": payload})
    sys.exit(0)


def fail(message):
    """End the tool with an error the agent will see."""
    _emit({"error": str(message)})
    sys.exit(0)
