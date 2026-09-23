"""Shared JSON driver lifecycle; subclasses contain only device API adapters."""

import sys
import threading
import uuid

from pathlib import Path

from kinex.driver_protocol import run, release, check_cancelled
from kinex.joints import JointDevice, settings
from kinex.validation import number


class Driver:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.profile = settings(directory)
        self.handle = None
        self.serving = "--serve" in sys.argv
        self.recorder = None
        self._model = None
        self.sample_lock = threading.RLock()

    def connect(self):
        raise NotImplementedError("start owned control services and connect using access.connection; wait for readiness; roll back failed startup")

    def disconnect(self, handle):
        raise NotImplementedError("release controller connection and owned services, never a shared external server")

    def read_state(self, handle):
        raise NotImplementedError("read positions/velocities/efforts/faults, acquisition time and reported_pose")

    def servo(self, handle, target, period_s):
        raise NotImplementedError("Send one absolute reference for period_s; return elapsed_s and measured state. Honor SDK cadence, allow read/stop, and do not interpolate.")

    def motion_result(self, result):
        if not isinstance(result, dict) or number(result.get("elapsed_s"), "elapsed_s") < 0:
            raise ValueError("motion must report nonnegative elapsed_s")
        if not isinstance(result.get("state"), dict):
            raise ValueError("motion must report measured state")
        state = self.model().reading(result["state"])
        if state["faults"]:
            raise RuntimeError(f"joint device fault: {state['faults']}")
        return {**result, "state": state}

    def stop_motion(self, handle):
        try:
            self.halt(handle)
        except Exception as error:
            error.code = "stop_failed"
            raise

    def reference(self, handle, target, period):
        result = self.motion_result(self.servo(handle, target, period))
        if result["elapsed_s"] + 1e-8 < period:
            raise ValueError("servo returned before its action period elapsed")
        return result

    def motion(self, args):
        command = self.model().command(args)
        for_s = command.get("for_s")
        handle = self.connection()
        elapsed, completed, state = 0.0, 0, None
        stop_attempted = False

        def stop():
            nonlocal stop_attempted
            if not stop_attempted:
                stop_attempted = True
                self.stop_motion(handle)

        try:
            check_cancelled()
            period = 1 / command["freq_hz"]
            for target in command["actions"]:
                check_cancelled()
                duration = period if for_s is None else min(period, for_s - elapsed)
                if duration <= 0:
                    break
                result = self.reference(handle, target, duration)
                elapsed += result["elapsed_s"]
                state = result["state"]
                if for_s is not None and elapsed > for_s + 1e-8:
                    raise ValueError("servo exceeded sequence budget")
                if duration + 1e-8 < period:
                    break
                completed += 1
            check_cancelled()
            timeout = completed < len(command["actions"])
            stepped = self.profile["intrinsics"]["control"].get("execution", "realtime") == "stepped"
            if timeout or stepped:
                stop()
                state = self.sample()
            return {"completed_actions": completed, "elapsed_s": elapsed, "state": state,
                    "execution_id": uuid.uuid4().hex,
                    "terminated_by": "timeout" if timeout else "completed",
                    "reference_state": "stopped" if stop_attempted else "target"}
        except BaseException as error:
            error.details = {"completed_actions": completed, "elapsed_s": elapsed, "state": state}
            try:
                stop()
            except Exception as stop_error:
                stop_error.code = "stop_failed"
                stop_error.add_note(f"motion failed: {error}")
                raise stop_error from error
            raise

    def halt(self, handle):
        raise NotImplementedError("perform the declared stop behavior and scope")

    def native_fk(self, handle, joints):
        raise NotImplementedError("driver model requires SDK FK")

    def native_ik(self, handle, pose, seed):
        raise NotImplementedError("driver IK requires SDK solver")

    def connection(self):
        if self.handle is None:
            self.handle = self.connect()
            if self.handle is None:
                raise RuntimeError("connect must return a ready handle")
        return self.handle

    def model(self):
        if self._model is None:
            self._model = JointDevice(self.profile, self.directory,
                native_fk=lambda q: self.native_fk(self.connection(), q),
                native_ik=lambda p, q: self.native_ik(self.connection(), p, q))
        return self._model

    def sample(self):
        with self.sample_lock:
            return self.model().reading(self.read_state(self.connection()))

    def execute(self, action, args):
        if action == "load":
            self.connection()
            return {"loaded": True}
        if action == "unload":
            if self.handle is None and not self.serving:
                self.connection()
            self.close(stop=True)
            return {"unloaded": True}
        if action == "status":
            return {"connected": self.handle is not None}
        if action == "read":
            recorder = self.recorder
            if recorder is None:
                return self.sample()
            state = recorder.wait_latest()
            if state is None:
                raise RuntimeError("Recorder has no fresh state")
            return state
        if action == "write":
            return self.motion(args)
        if action == "stop":
            stop = self.profile["intrinsics"]["stop"]
            if self.profile["name"] not in stop["affected_devices"]:
                raise ValueError("stop scope must include this device")
            self.stop_motion(self.connection())
            return {"stopped": True, **stop}
        if action == "fk":
            if set(args) != {"joints"}:
                raise ValueError("fk requires only joints")
            return self.model().fk(args["joints"])
        if action == "ik":
            if set(args) - {"pose", "seed"} or "pose" not in args:
                raise ValueError("ik requires pose and optional seed")
            model = self.model()
            seed = args.get("seed")
            if seed is None:
                seed = model.project(self.execute("read", {})["positions"])
            return model.ik(args["pose"], seed)
        if action == "record_start":
            from kinex.stream import StateRecorder
            if not self.profile["access"]["driver"].get("persistent", True):
                raise ValueError("Recording requires a persistent driver")
            self.execute("record_stop", {})
            self.recorder = StateRecorder(self.sample, args["dir"], rate_hz=args.get("rate_hz", 50))
            self.recorder.start()
            return self.recorder.facts()
        if action == "record_stop":
            if self.recorder is None:
                return {"file": None, "rows": 0}
            recorder = self.recorder
            result = recorder.stop()
            self.recorder = None
            return result
        raise ValueError(f"Unsupported joint device action: {action}")

    def dispatch(self, action, args):
        try:
            return {"ok": True, **self.execute(action, args)}
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                    "details": getattr(exc, "details", None), "code": getattr(exc, "code", None)}

    def close(self, stop=None):
        def disconnect():
            if self.recorder is not None and self.recorder.running:
                raise RuntimeError("capture still uses the connection; process teardown is required")
            handle, self.handle = self.handle, None
            release(lambda: self.stop_motion(handle) if handle is not None and (self.serving if stop is None else stop) else None,
                    lambda: self.disconnect(handle) if handle is not None else None)
        # The sampler uses connection(); stop it before clearing that handle.
        release(lambda: self.execute("record_stop", {}), disconnect)

    def main(self):
        run(self.dispatch, self.close, serving=self.serving)
