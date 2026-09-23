"""Client library for kinex python tools (perception / controller).

A python tool is spawned as   <interpreter> tool.py '<json args>'   and holds a
JSON-lines dialog with the harness: one request object per stdout line, one
response object per stdin line, strictly sequential. This module owns that
protocol so tool code stays plain python:

    from kinex import args, device, call, profile, robot, finish, fail

    a = args()
    cam = profile(a["camera"])                      # parsed profile.yaml (white-box)
    frame = device(a["camera"])                     # {"data": {...}, "file": "/path.png"}
    seg = device(a["model"], "detect", image=frame["file"], prompt=a["prompt"])
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
import time

# Protocol channel: the real stdout, captured only INSIDE a tool dialog (the
# harness marks its spawns with KINEX_TOOL_DIALOG=1). Everything print()ed
# afterwards lands on stderr, so debug output can never corrupt the dialog.
# Outside a dialog (a skill script or driver importing kinex.geometry) the
# import stays side-effect-free and any protocol call raises instead.
_out = None
if os.environ.get("KINEX_TOOL_DIALOG") == "1":
    _out = os.fdopen(os.dup(sys.stdout.fileno()), "w")
    sys.stdout = sys.stderr


def _emit(payload):
    if _out is None:
        raise RuntimeError("not running inside a kinex tool dialog — the harness spawns tools with KINEX_TOOL_DIALOG=1")
    _out.write(json.dumps(payload) + "\n")
    _out.flush()


def _rpc(payload):
    _emit(payload)
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("harness closed the dialog")
    response = json.loads(line)
    if not response.get("ok", False):
        raise RuntimeError(response.get("error", "harness call failed"))
    response.pop("ok", None)
    return response


def args():
    """The tool's arguments, parsed from argv."""
    return json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}


def device(name, action="read", **kwargs):
    """Dispatch one action of a device's driver interface: returns
    {"data": {...}?, "file": "/abs/path"?}. Commands (write/stop/custom verbs on
    an actuated device) are controller-tool-only; load/unload use the separate device tool, not Python tools."""
    return _rpc({"call": "device", "device": name, "action": action, "args": kwargs})


def devices(commands):
    """Run device calls concurrently and return results in input order.

    Entries are {device, action?, args?}; action defaults to read. Reads and writes
    may be mixed. Each result reports its own success or failure. A new write
    replaces prior motion on that device; reads bypass writes. Calls do not
    promise simultaneous sampling or atomic effects across devices.
    """
    return _rpc({"call": "devices", "commands": commands})["results"]


def call(tool, **kwargs):
    """Compose another python tool; returns its result object."""
    return _rpc({"call": "tool", "name": tool, "args": kwargs})["result"]


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
    payload = dict(result or {})
    if file:
        payload["file"] = file
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

    def read(self, **kwargs):
        """One sample of what the device knows (driver "read")."""
        return device(self.name, "read", **kwargs)

    def act(self, action, **kwargs):
        """Dispatch any driver action (commands are controller-tool-only)."""
        return device(self.name, action, **kwargs)

    def pose_in(self, other, frame=None):
        """This device's pose expressed in `other`'s frame (see frames.pose)."""
        from kinex import frames

        parent = other.name if isinstance(other, Device) else other
        child = self.name if frame is None else f"{self.name}:{frame}"
        return frames.pose(child, parent)
