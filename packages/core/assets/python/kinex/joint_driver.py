"""Shared JSON driver lifecycle; subclasses contain only device API adapters."""

import sys
import threading
from pathlib import Path

from kinex.driver_protocol import run, release
from kinex.joints import JointDevice, settings
from kinex.validation import segment_result


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

    def send_target(self, handle, command):
        # Check kinex.driver_protocol.check_cancelled() between native steps;
        # read_state and halt must remain usable while this hook waits.
        raise NotImplementedError("Execute the target for command.for_s in the device clock; honor arrive and max_velocity; return accepted, elapsed_s, reached and state")

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
            command = self.model().command(args)
            result = segment_result(self.send_target(self.connection(), command))
            return {**result, "state": self.model().reading(result["state"])}
        if action == "stop":
            stop = self.profile["intrinsics"]["stop"]
            if self.profile["name"] not in stop["affected_devices"]:
                raise ValueError("stop scope must include this device")
            self.halt(self.connection())
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
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def close(self, stop=None):
        def disconnect():
            if self.recorder is not None and self.recorder.running:
                raise RuntimeError("capture still uses the connection; process teardown is required")
            handle, self.handle = self.handle, None
            release(lambda: self.halt(handle) if handle is not None and (self.serving if stop is None else stop) else None,
                    lambda: self.disconnect(handle) if handle is not None else None)
        # The sampler uses connection(); stop it before clearing that handle.
        release(lambda: self.execute("record_stop", {}), disconnect)

    def main(self):
        run(self.dispatch, self.close, serving=self.serving)
