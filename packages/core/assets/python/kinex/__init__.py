"""Kinex invocation API for exec.

Use io for async pub/sub and request/response, runtime for device discovery and lib
for reusable programs; exec returns what the invoked code returns. The host dialog
carries invocation metadata, profiles and that result. One execution approval covers
the invocation; Python calls cannot change device lifecycle.
"""

import json
import os
import sys
import threading
import traceback
from kinex.communication import communication, io
from kinex.errors import RPCError, OperationError
from kinex.common.plain import plain

_rpc_lock = threading.Lock()

# Protocol channel: the real stdout, captured only INSIDE a tool dialog (the
# harness marks exec processes with KINEX_TOOL_DIALOG=1). Everything print()ed
# afterwards lands on stderr, so debug output can never corrupt the dialog.
# Outside a dialog (a device node or standalone script importing kinex) the
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
        raise RuntimeError("missing exec startup request")
    _request = json.loads(line)
    if not isinstance(_request, dict) or not isinstance(_request.get("args"), dict):
        raise ValueError("exec startup request requires object args")


def _emit(payload):
    if _out is None:
        raise RuntimeError("not running inside exec: the host dialog is unavailable")
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


def profile(device, *, optional=False):
    """The device's parsed profile.yaml — the white-box read path for top-level
    calibrated facts (color projection, frames, URDF model and typed device facts).
    With optional=True, an absent profile returns None; other errors still raise."""
    return _rpc({"call": "profile", "device": device, "optional": optional})["profile"]


def robot():
    """The workspace robot's workspace manifest (identity and keep-out zones)."""
    return _rpc({"call": "robot"})["robot"]
