"""Bounded SDK hooks for a velocity device; the SDK owns balance control.

A write carries how long the command should run and reports the device time it
spent, so a command needs no separate expiry: the caller's budget is the bound.
"""

import sys
import threading

from kinex.driver_protocol import run, release
from kinex.velocity import command, reading
from kinex.validation import settings, segment_result


class Driver:
    # True when the world advances on a clock of its own, which must therefore be
    # served so something ticks while the agent thinks. False when this driver's
    # own write advances physics. Kinex never needs to know which; only a driver
    # does, which is why the profile no longer declares it.
    background_clock = True

    def __init__(self, directory):
        self.profile = settings(directory)
        self.handle = None
        self.lock = threading.RLock()
        self.error = None
        self.serving = "--serve" in sys.argv
        self.target = None

    def connect(self):
        raise NotImplementedError("Start owned control services and connect without commanding motion; roll back failed startup")

    def disconnect(self, handle):
        raise NotImplementedError("Release connection; do not disable balance control")

    def read_state(self, handle):
        raise NotImplementedError("Read body pose, velocities, height, frames and timestamp")

    def send_target(self, handle, value):
        raise NotImplementedError("Execute velocity/posture for value.for_s in the device clock; return accepted, elapsed_s, reached and state")

    def halt(self, handle, target):
        raise NotImplementedError("Apply profile stop behavior, preserving posture/balance; target is the last command or None")

    def connection(self):
        if self.handle is None:
            self.handle = self.connect()
            if self.handle is None:
                raise RuntimeError("connect must return a ready handle")
        return self.handle

    def execute(self, action, args):
        if not isinstance(args, dict) or (action != "write" and args):
            raise ValueError(f"Invalid arguments for {action}")
        with self.lock:
            if action == "unload":
                if self.handle is None and not self.serving:
                    self.connection()
                self.close(stop=True)
                return {"unloaded": True, "stopped": True, **self.profile["intrinsics"]["stop"]}
            if action == "stop":
                try:
                    self.halt(self.connection(), self.target)
                except Exception as error:
                    self.error = str(error)
                    raise
                self.error = None
                return {"stopped": True, **self.profile["intrinsics"]["stop"]}
            if self.error is not None:
                raise RuntimeError(f"Base stop failed: {self.error}")
            if action == "load":
                self.connection()
                return {"loaded": True}
            if action == "status":
                return {"connected": self.handle is not None}
            if action == "read":
                return reading(self.profile, self.read_state(self.connection()))
            if action == "write":
                value = command(self.profile, args)
                if self.background_clock and not self.serving:
                    raise ValueError("A background control clock requires --serve")
                handle = self.connection()
                self.target = value
                result = segment_result(self.send_target(handle, value))
                return {**result, "state": reading(self.profile, result["state"])}
            raise ValueError(f"Unsupported base action: {action}")

    def dispatch(self, action, args):
        try:
            return {"ok": True, **self.execute(action, args)}
        except Exception as error:
            return {"ok": False, "error": f"{type(error).__name__}: {error}"}

    def close(self, stop=None):
        with self.lock:
            handle, self.handle = self.handle, None
            target, self.target = self.target, None
            release(lambda: self.halt(handle, target) if handle is not None and (self.serving if stop is None else stop) else None,
                    lambda: self.disconnect(handle) if handle is not None else None)
            self.error = None

    def main(self):
        run(self.dispatch, self.close, serving=self.serving)
