#!/usr/bin/env python3
"""Map shared Kinex motion parameters and declared extensions to the legged SDK."""
from pathlib import Path

from kinex.driver_protocol import run, release, check_cancelled
from kinex.validation import settings, segment


class LeggedDriver:
    def __init__(self, directory):
        self.profile = settings(directory)
        self.handle = None
        self.stop_error = None

    def connect(self):
        raise NotImplementedError("Connect without motion; await readiness and roll back partial startup")

    def disconnect(self, handle):
        raise NotImplementedError("Release owned resources; never terminate borrowed services")

    def read(self, args):
        raise NotImplementedError("Validate read arguments; query SDK state/skill APIs; return timestamp, faults and measured mode when declared")

    def write(self, args):
        raise NotImplementedError("Validate control.write; reject unknown/undeclared current modes and disallowed transitions; require positive duration_s for velocity/posture and omit motion fields when changing modes; recheck live state before effects; use mode as the single selector with velocity/posture/duration_s; map to SDK motion with expiry to zero; handle skills without restarting active requests; return execution_id and measured state")

    def stop(self):
        raise NotImplementedError("Stop cancellable SDK motion; preserve required balance; report stop limits and failures")

    def execute(self, action, args):
        if not isinstance(args, dict):
            raise ValueError("arguments must be an object")
        if action in ("load", "unload", "status", "stop") and args:
            raise ValueError(f"{action} accepts no arguments")
        if action == "load":
            if self.handle is None:
                self.handle = self.connect()
                if self.handle is None:
                    raise RuntimeError("connect must return a ready SDK handle")
            return {"loaded": True}
        if action == "status":
            return {"connected": self.handle is not None}
        if action == "unload":
            self.close()
            return {"unloaded": True}
        if self.handle is None:
            raise RuntimeError("device is not loaded")
        check_cancelled()
        if action == "read":
            return self.read(args)
        if action == "write":
            if self.stop_error is not None:
                raise RuntimeError(f"stop failed; recover before writing: {self.stop_error}")
            if "velocity" in args or "posture" in args:
                args = segment(args, args)
            return self.write(args)
        if action == "stop":
            return self.stop_owned()
        raise ValueError(f"unsupported action: {action}")

    def dispatch(self, action, args):
        try:
            return {"ok": True, **self.execute(action, args)}
        except Exception as error:
            return {"ok": False, "error": f"{type(error).__name__}: {error}",
                    "code": getattr(error, "code", None), "details": getattr(error, "details", None)}

    def stop_owned(self):
        try:
            result = self.stop()
        except Exception as error:
            self.stop_error = str(error)
            error.code = "stop_failed"
            error.details = {"effects": "unknown"}
            raise
        self.stop_error = None
        return result

    def close(self):
        handle = self.handle
        if handle is None:
            return
        def disconnect():
            self.disconnect(handle)
            self.handle = None
        release(self.stop_owned, disconnect)


if __name__ == "__main__":
    driver = LeggedDriver(Path(__file__).parent)
    run(driver.dispatch, driver.close)
