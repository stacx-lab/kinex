"""Calibration runs, samples and solvers for the setup procedures; each procedure's skill names its solver.

A run keeps one attempt's evidence in .kinex/calib/<id>/: start() opens one and resume()
an earlier one. await run.sample(device) appends a measured reading to its samples.json.
Solvers live in the submodules; each archives its inputs and returns a result, also saved
as the run's result-<n>.json:
  {run, procedure, operation, computation, quality, data, resolved, unresolved, proposed, evidence}
computation is succeeded, or failed with data.error; quality is passed, warning or failed.
proposed is the target's profile patch, None when quality failed: check it against the
task's accuracy, apply it with profile_write (kind device) and read it back. resolved lists
the profile facts it sets, unresolved what it cannot measure, and evidence the result's
path relative to .kinex for setup_plan record. Solvers never write profiles.
"""
import asyncio
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import kinex
from kinex.common.plain import plain


class CalibrationError(Exception):
    """A solve that ran on its evidence but could not produce a result; the run records it as failed."""

    def __init__(self, message, **details):
        super().__init__(message)
        self.details = details


def start(procedure, **roles):
    """Open a new run of a procedure with its devices bound to roles, and return it.

    run.id, run.bindings and run.directory describe the run; run.role(name) is a role's device.
    await run.sample(device, operation=None, *, frame=None, settle=False, threshold=0.005,
      stable_reads=3, timeout_s=30, note=None) appends one reading of a bound device to
      samples.json and returns it. operation defaults to runtime.observation, a camera's
      images (archived under files, an rgbd camera's equally stamped depth included) or the
      joint state. frame stores a joint device link's FK pose as kinematics {frame, pose}.
      settle waits up to timeout_s for stable_reads fresh readings, 0.3 s apart, with every
      commanded joint velocity, or a locomotion device's declared odometry axes, within
      threshold; otherwise it keeps the last reading with settled False. Sampling never
      advances world time: wait on the world first, and do not settle in a paused stepped
      world, which repeats one reading.
    run.samples(device=None) lists the samples; run.save(name, value) writes JSON evidence
      and run.archive(file) copies a file into the run, each returning the new path.

    Example: run = lib.calibration.start("calibrate-tcp-offset", arm="arm", target="gripper")
    """
    if not isinstance(procedure, str) or not procedure:
        raise ValueError("name the procedure, such as calibrate-tcp-offset")
    for role, device in roles.items():
        if not isinstance(device, str) or not device:
            raise ValueError(f"bind {role} to a device name")
    manifest = {"version": 1, "id": uuid.uuid4().hex[:8], "procedure": procedure, "bindings": roles, "created_at": _now()}
    directory = _root() / manifest["id"]
    (directory / "artifacts").mkdir(parents=True)
    _write(directory / "manifest.json", manifest)
    return Run(directory, manifest)


def resume(run):
    """The run with this ID, to add samples or solve again.

    Example: run = lib.calibration.resume("3f9c2a1b")
    """
    directory = _root() / run
    if not (directory / "manifest.json").is_file():
        raise ValueError(f"unknown calibration run {run}")
    return Run(directory, json.loads((directory / "manifest.json").read_text()))


class Run:
    """One attempt's evidence directory; see start()."""

    def __init__(self, directory, manifest):
        self.directory = Path(directory)
        self.id, self.procedure, self.bindings = manifest["id"], manifest["procedure"], manifest["bindings"]

    def __repr__(self):
        return f"Run({self.id!r}, {self.procedure!r}, {self.bindings!r})"

    def role(self, name):
        if name not in self.bindings:
            raise ValueError(f"run {self.id} binds no {name}; start a run with {name}=<device>")
        return self.bindings[name]

    def samples(self, device=None):
        file = self.directory / "samples.json"
        samples = json.loads(file.read_text()) if file.is_file() else []
        return [sample for sample in samples if device is None or sample["device"] == device]

    def archive(self, file):
        target = self._artifact(Path(file).suffix)
        shutil.copyfile(file, target)
        return str(target)

    def save(self, name, value):
        file = self._next(name)
        _write(file, value)
        return str(file)

    async def sample(self, device, operation=None, *, frame=None, settle=False, threshold=0.005,
                     stable_reads=3, timeout_s=30, note=None):
        if device not in self.bindings.values():
            raise ValueError(f"{device} is not bound in run {self.id}: {self.bindings}")
        profile = kinex.profile(device)
        model = _model(profile, frame)
        operation = operation or (profile.get("runtime") or {}).get("observation")
        sample = {"device": device, "recorded_at": _now()}
        if operation is None and profile["type"] in ("rgb", "rgbd"):
            if settle:
                raise ValueError("a camera has no velocity feedback to settle on")
            sample.update(await self._images(profile))
        else:
            operation = operation or _observation(profile)
            message, settled = await _read(kinex.device(device).topic(operation), _motion(profile) if settle else None,
                                           threshold, stable_reads, timeout_s)
            sample.update(operation=operation, data=plain(message), **({"settled": settled} if settle else {}))
            if model:
                sample["kinematics"] = {"frame": frame, "pose": plain(model.fk(_positions(message, model.names), frame))}
        if note:
            sample["note"] = note
        samples = self.samples()
        sample = {"index": len(samples), **sample}
        _write(self.directory / "samples.json", [*samples, sample])
        return sample

    async def _images(self, profile):
        from kinex.common.camera import frame, stereo, stereo_frame
        name = profile["name"]
        if stereo(profile):
            images = dict(zip(("left", "right"), await stereo_frame(kinex.device(name))))
        else:
            image, depth = await frame(kinex.device(name))
            images = {"color": image, **({"depth": depth} if depth is not None else {})}
        files = {stream: self._keep(message) for stream, message in images.items()}
        stamps = {stream: kinex.seconds(message) for stream, message in images.items()}
        return {"operation": "images", "files": files, "data": {"timestamp": max(stamps.values()), "stamps": stamps,
                "frames": {stream: message.header.frame_id for stream, message in images.items()}}}

    def _keep(self, image):
        from kinex.common.camera import save
        target = self._artifact(".png")
        shutil.move(save(image), target)
        return str(target)

    def _artifact(self, suffix):
        return self.directory / "artifacts" / f"{uuid.uuid4().hex[:8]}{suffix}"

    def _next(self, name):
        index = len(list(self.directory.glob(f"{name}-*.json")))
        while (self.directory / f"{name}-{index}.json").exists():
            index += 1
        return self.directory / f"{name}-{index}.json"

    def _solve(self, operation, solve, quality, facts=None, unresolved=()):
        """Run a solve and keep its result. A CalibrationError fails the computation;
        facts(data) gives the target's (method, patch, resolved pointers) to propose."""
        try:
            data = solve()
        except CalibrationError as error:
            data = {"error": str(error), **error.details}
        failed = "error" in data
        assessed = "failed" if failed else quality(data)
        target = self.bindings.get("target", self.bindings.get("second"))
        method, patch, resolved = facts(data) if facts and target and assessed != "failed" else (None, None, [])
        now = _now()
        result = {
            "run": self.id, "procedure": self.procedure, "operation": operation,
            "computation": "failed" if failed else "succeeded", "quality": assessed, "data": data,
            "resolved": [{"device": target, "pointer": pointer, "value": value} for pointer, value in resolved],
            "unresolved": list(unresolved),
            "proposed": None if patch is None else {"name": target, "source": "calibration", "method": method, "calibrated_at": now, **patch},
            "created_at": now,
        }
        file = self._next("result")
        _write(file, result)
        _write(self.directory / "result.json", result)
        return {**result, "evidence": str(file.relative_to(self.directory.parent.parent))}


def _frames(method, edges):
    """Facts for proposed frame edges; an edge with an unknown translation resolves nothing."""
    resolved = [(f"/frames/{name}/{field}", value) for name, edge in edges.items() if edge["translation_m"] != "???"
                for field, value in edge.items()]
    return method, {"frames": edges}, resolved


def _root():
    workspace = os.environ.get("KINEX_WORKSPACE")
    if not workspace:
        raise RuntimeError("calibration runs live in the workspace: call this inside exec")
    return Path(workspace) / "calib"


def _now():
    return datetime.now(timezone.utc).isoformat()


def _write(file, value):
    temporary = file.with_name(f"{file.name}.{uuid.uuid4().hex[:8]}.tmp")
    temporary.write_text(json.dumps(plain(value), indent=2, allow_nan=False) + "\n")
    os.replace(temporary, file)


def _model(profile, frame):
    if frame is None:
        return None
    links = (profile.get("resolved_model") or {}).get("links", [])
    if profile["type"] != "joint" or frame not in links:
        raise ValueError(f"frame must name a URDF link of joint device {profile['name']}")
    from kinex.lib.kinematics import JointModel
    return JointModel(profile)


def _observation(profile):
    """The joint state, image or clock a device publishes, as host snapshots read it."""
    types = ("sensor_msgs/msg/JointState", "sensor_msgs/msg/Image", "rosgraph_msgs/msg/Clock")
    for name, operation in profile.get("operations", {}).items():
        if operation["direction"] == "output" and operation["type"] in types:
            return name
    raise ValueError(f"name the operation to sample, or declare runtime.observation for {profile['name']}")


def _positions(message, names):
    measured = dict(zip(message.name, message.position))
    missing = [name for name in names if name not in measured]
    if missing:
        raise ValueError(f"the joint state lacks {', '.join(missing)}")
    return [measured[name] for name in names]


TWIST = {"vx": ("linear", "x"), "vy": ("linear", "y"), "vz": ("linear", "z"),
         "wx": ("angular", "x"), "wy": ("angular", "y"), "wz": ("angular", "z")}


def _motion(profile):
    """The velocities settling watches: a joint device's commanded joints, or a locomotion
    device's declared axes on the odometry its runtime.observation names."""
    if profile["type"] == "locomotion":
        velocity = profile.get("velocity")
        axes = [TWIST[axis] for axis in (velocity.get("axes", {}) if isinstance(velocity, dict) else {}) if axis in TWIST]
        if not axes:
            raise ValueError("settling requires declared velocity axes")
        return lambda message: [getattr(getattr(message.twist.twist, part), axis) for part, axis in axes]
    if profile["type"] != "joint":
        raise ValueError("settling requires measured velocities: a joint device or locomotion odometry")
    from kinex.lib.kinematics import JointModel
    names = JointModel(profile).names

    def joints(message):
        measured = dict(zip(message.name, message.velocity))
        for name in names:
            if name not in measured:
                raise ValueError(f"settling requires a measured velocity for {name}")
        return [measured[name] for name in names]
    return joints


# Settling checks the newest reading this often, so stable reads span a real interval.
SETTLE_INTERVAL_S = .3


async def _read(stream, motion, threshold, stable_reads, timeout_s):
    """The topic's next message, or with motion the newest once stable_reads fresh stamps settled."""
    message = await stream.next()
    if motion is None:
        return message, None
    loop = asyncio.get_running_loop()
    deadline, stable, last = loop.time() + timeout_s, 0, float("-inf")
    while True:
        stamp = kinex.seconds(message)
        if stamp < last:
            raise RuntimeError("sample clock moved backwards")
        if stamp > last:
            stable = stable + 1 if all(abs(value) <= threshold for value in motion(message)) else 0
            last = stamp
        if stable >= stable_reads:
            return message, True
        if loop.time() >= deadline:
            return message, False
        await asyncio.sleep(min(SETTLE_INTERVAL_S, deadline - loop.time()))
        message = stream.latest or message
