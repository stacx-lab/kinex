"""Client library for kinex python tools (perception / controller).

A python tool is spawned as <interpreter> tool.py and receives {"args": {...}}
on its first stdin line. It then holds a JSON-lines dialog with the harness:
one request object per stdout line, one response object per stdin line, strictly
sequential. This module owns that
protocol so tool code stays plain python:

    from kinex import args, device, call, profile, robot, finish, fail

    a = args()
    cam = profile(a["camera"])                      # parsed profile.yaml (white-box)
    frame = device(a["camera"], args={"output": "file"})
    seg = device(a["model"], "detect", {"image": frame["file"], "prompt": a["prompt"]})
    finish({"point": [0.1, 0.2, 0.3]}, file=seg.get("file"))

On import, real stdout is captured for the protocol and sys.stdout is pointed
at stderr — stray print() calls become logging instead of protocol corruption.

Capability rules are enforced harness-side: perception tools may read devices /
profile / robot / call other perception tools; controller tools additionally
may command devices (write/stop/custom verbs on an actuated device) and call
any tool. A refused call raises RuntimeError.
"""

import json
import os
import sys

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


class RPCError(RuntimeError):
    """A device or composed-tool failure retaining its public protocol metadata."""

    def __init__(self, message, *, code=None, details=None):
        super().__init__(message)
        self.code, self.details = code, details

    def payload(self):
        return {"error": str(self),
                **({"code": self.code} if self.code is not None else {}),
                **({"details": self.details} if self.details is not None else {})}


if _out is not None:
    _previous_excepthook = sys.excepthook

    def _excepthook(kind, error, traceback):
        if isinstance(error, RPCError) and (error.code is not None or error.details is not None):
            _emit(error.payload())
        else:
            _previous_excepthook(kind, error, traceback)

    sys.excepthook = _excepthook


def _rpc(payload):
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
    if _request is not None:
        return _request["args"]
    return json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}


def _camera_data(values, data):
    if values.get("action", "read") != "read" or values.get("args", {}).get("output", "array") != "array" or "color" not in data:
        return data
    camera = profile(values["deviceID"])
    if camera["type"] in ("rgb", "rgbd"):
        from kinex.capture import arrays
        return arrays(camera, data)
    return data


def _device_result(tool, values, result):
    if tool == "device":
        return _camera_data(values, result)
    if tool == "devices":
        for value, item in zip(values["calls"], result["results"]):
            if "data" in item:
                item["data"] = _camera_data(value, item["data"])
    return result


def device(deviceID, action="read", args=None):
    """Return device data fields plus optional file; failures raise RPCError.

    Camera reads default to NumPy arrays; args.output also accepts base64 or file.
    """
    values = {"deviceID": deviceID, "action": action, "args": {} if args is None else args}
    return _device_result("device", values, _rpc({"call": "device", **values})["result"])


def devices(calls):
    """Run {deviceID, action?, args?} calls concurrently; return {"results": [...]}.

    Entries preserve input order and contain deviceID, action, ok and data/file or error.
    """
    values = {"calls": calls}
    return _device_result("devices", values, _rpc({"call": "devices", **values})["result"])


def call(tool, **kwargs):
    """Compose a Python tool or device/devices; returns its structured result."""
    result = _rpc({"call": "tool", "name": tool, "args": kwargs})["result"]
    return _device_result(tool, kwargs, result)


def inline(source, values, *, kind="perception"):
    """Call an inline lambda or main function with keyword arguments in values."""
    return _rpc({"call": "inline", "python": source, "kind": kind, "args": values})["result"]


def stop_owned():
    """Stop motion owned by this invocation and its composed tools (controllers only)."""
    _rpc({"call": "stop_owned"})


def profile(device, *, optional=False):
    """The device's parsed profile.yaml — the white-box read path for
    calibrated intrinsics/extrinsics (color projection, SI mounts, kinematics models and typed controls).
    With optional=True, an absent profile returns None; other errors still raise."""
    return _rpc({"call": "profile", "device": device, "optional": optional})["profile"]


def robot():
    """The workspace robot's workspace manifest (identity, sim block, safety)."""
    return _rpc({"call": "robot"})["robot"]


def finish(result=None, file=None):
    """End the tool successfully. `file` (an image path) is shown to the agent."""
    payload = {**(result or {}), "file": file} if file else result
    _emit({"return": payload})
    sys.exit(0)


def fail(message):
    """End the tool with an error the agent will see."""
    _emit({"error": str(message)})
    sys.exit(0)


class Device:
    """Per-device client handle: the device's profile plus its driver interface.

    Access only, no logic — cross-device computation lives in graph-level
    modules (kinex.frames for poses) that consume these handles. Future
    interaction kinds get their own modules, never methods here.
    """

    def __init__(self, name):
        self.name = name
        self._profile = None

    @property
    def profile(self):
        """The parsed profile.yaml, fetched once and cached."""
        if self._profile is None:
            self._profile = profile(self.name)
        return self._profile

    @property
    def type(self):
        return self.profile.get("type")

    def read(self, args=None):
        """One sample of what the device knows (driver "read")."""
        return device(self.name, "read", args)

    def act(self, action, args=None):
        """Dispatch any driver action (commands are controller-tool-only)."""
        return device(self.name, action, args)

    def pose_in(self, other, frame=None):
        """This device's pose expressed in `other`'s frame (see frames.pose)."""
        from kinex import frames

        parent = other.name if isinstance(other, Device) else other
        child = self.name if frame is None else f"{self.name}:{frame}"
        return frames.pose(child, parent)
