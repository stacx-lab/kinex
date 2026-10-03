"""Velocity driver lifecycle and asynchronous reference execution."""

import sys
import threading

from kinex.buffer import Buffer

from kinex.driver_protocol import run, release, check_cancelled
from kinex.velocity import command, reading
from kinex.validation import settings


class Driver:
    def __init__(self, directory):
        self.profile = settings(directory)
        self.handle = None
        self.lock = threading.RLock()
        self.error = None
        self.serving = "--serve" in sys.argv
        self.target = None
        self.buffer = None

    def command(self, args):
        return command(self.profile, args)

    def reading(self, state):
        return reading(self.profile, state)

    def references(self, value):
        return [value]

    def connect(self):
        raise NotImplementedError("Start owned control services and connect without commanding motion; roll back failed startup")

    def disconnect(self, handle):
        raise NotImplementedError("Release connection; do not disable balance control")

    def read_state(self, handle):
        raise NotImplementedError("Read velocities, optional body measurements/local frames, faults and timestamp")

    @property
    def period_s(self):
        raise NotImplementedError("Return the hardware control period")

    def set_target(self, handle, value):
        raise NotImplementedError("Set velocity/posture without waiting")

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
        if action == "unload":
            if self.handle is None and not self.serving:
                self.connection()
            self.close(stop=True)
            return {"unloaded": True, "stopped": True, **self.profile["intrinsics"]["stop"]}
        if action == "stop":
            try:
                if self.buffer is not None:
                    self.buffer.stop()
                else:
                    self.halt(self.connection(), self.target)
            except Exception as error:
                self.error = str(error)
                raise
            self.error = None
            return {"stopped": True, **self.profile["intrinsics"]["stop"]}
        if self.error is not None and action == "write":
            raise RuntimeError(f"Base stop failed: {self.error}")
        if action == "load":
            self.connection()
            return {"loaded": True}
        if action == "status":
            return {"connected": self.handle is not None}
        if action == "read":
            state = self.reading(self.read_state(self.connection()))
            if self.buffer is not None and self.buffer.error:
                state["faults"].append({"code": "buffer_failed"})
            return state
        if action == "write":
            if not self.serving:
                raise ValueError("local buffers require a persistent driver")
            value = self.command(args)
            handle = self.connection()
            references = self.references(value)
            if self.buffer is None:
                self.buffer = Buffer(self.period_s, lambda target: self.set_target(handle, target),
                                     lambda: self.halt(handle, self.target), expire=self.profile["type"] == "velocity")
            with self.buffer.condition:
                check_cancelled()
                identity = self.buffer.submit(references, value["duration_s"])
                self.target = value
            return self.buffer.result(identity, lambda: self.execute("read", {}))
        raise ValueError(f"Unsupported base action: {action}")

    def dispatch(self, action, args):
        try:
            return {"ok": True, **self.execute(action, args)}
        except Exception as error:
            return {"ok": False, "error": f"{type(error).__name__}: {error}",
                    "code": getattr(error, "code", None),
                    "details": getattr(error, "details", None)}

    def close(self, stop=None):
        with self.lock:
            if self.buffer is not None:
                self.buffer.close()
                self.buffer = None
            handle, self.handle = self.handle, None
            target, self.target = self.target, None
            release(lambda: self.halt(handle, target) if handle is not None and (self.serving if stop is None else stop) else None,
                    lambda: self.disconnect(handle) if handle is not None else None)
            self.error = None

    def main(self):
        run(self.dispatch, self.close, serving=self.serving)
