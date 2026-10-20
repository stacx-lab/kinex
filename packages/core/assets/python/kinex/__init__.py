"""Kinex invocation helpers.

Use communication() for async pub/sub and request/response. The host dialog
carries invocation metadata, profiles and selected results. The synchronous dialog helpers below
call explicitly declared operations. One execution approval covers the
invocation; Python calls cannot change device lifecycle.
"""

import json
import os
import sys
import threading
from kinex.communication import communication
from kinex.errors import RPCError, OperationError

_rpc_lock = threading.Lock()

# Protocol channel: the real stdout, captured only INSIDE a tool dialog (the
# harness marks its spawns with KINEX_TOOL_DIALOG=1). Everything print()ed
# afterwards lands on stderr, so debug output can never corrupt the dialog.
# Outside a dialog (a skill script or driver importing kinex.geometry) the
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
    _out.write(json.dumps(payload) + "\n")
    _out.flush()




if _out is not None:
    _previous_excepthook = sys.excepthook

    def _excepthook(kind, error, traceback):
        if isinstance(error, RPCError) and (error.code is not None or error.details is not None):
            _emit(error.payload())
        else:
            _previous_excepthook(kind, error, traceback)

    sys.excepthook = _excepthook


def _rpc_unlocked(payload):
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


def _rpc(payload):
    with _rpc_lock:
        return _rpc_unlocked(payload)


def args():
    """The tool's arguments from its startup request."""
    if _request is not None:
        return _request["args"]
    return json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}


def device(deviceID, action, args=None):
    """Call an explicitly declared operation; return fields and optional file."""
    values = {"deviceID": deviceID, "action": action, "args": {} if args is None else args}
    return _rpc({"call": "device", **values})["result"]


def devices(calls):
    """Run {deviceID, action, args?} calls concurrently; return {"results": [...]}.

    Entries preserve input order and contain deviceID, action, ok and data/file or error.
    """
    values = {"calls": calls}
    return _rpc({"call": "devices", **values})["result"]


def call(tool, **kwargs):
    """Compose a Python tool or device/devices: call("servo", **params), not call("servo", params)."""
    result = _rpc({"call": "tool", "name": tool, "args": kwargs})["result"]
    return result


def inline(source, values):
    """Call an inline lambda or main function with keyword arguments in values."""
    return _rpc({"call": "inline", "python": source, "args": values})["result"]


def stop_owned():
    """Stop motion owned by this invocation and its composed tools."""
    _rpc({"call": "stop_owned"})


def profile(device, *, optional=False):
    """The device's parsed profile.yaml — the white-box read path for
    calibrated intrinsics/extrinsics (color projection, SI mounts, kinematics models and typed controls).
    With optional=True, an absent profile returns None; other errors still raise."""
    return _rpc({"call": "profile", "device": device, "optional": optional})["profile"]


def robot():
    """The workspace robot's workspace manifest (identity and safety)."""
    return _rpc({"call": "robot"})["robot"]


def finish(result=None, file=None):
    """End successfully; `file` is an image path or ordered list of image paths."""
    payload = {**(result or {}), "file": file} if file else result
    _emit({"return": payload})
    sys.exit(0)


def fail(message):
    """End the tool with an error the agent will see."""
    _emit({"error": str(message)})
    sys.exit(0)
