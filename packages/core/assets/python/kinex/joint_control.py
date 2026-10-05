"""Device-independent joint models and absolute position command validation."""

import math
from pathlib import Path
from kinex.motion import joint_target, vector
from kinex.urdf import read_chain


def joint_model(profile, directory=None):
    if profile.get("resolved_model") is not None:
        return profile["resolved_model"]
    model = profile["intrinsics"]["model"]
    if not isinstance(model, dict):
        raise ValueError("Joint model must be resolved")
    if model["format"] == "urdf":
        if directory is None:
            raise ValueError("URDF requires its device directory or harness-resolved model")
        path = Path(directory) / model["path"]
        return read_chain(path, model["base_link"], model["tip_link"])
    return {"joints": model["joints"], "chain": model.get("chain")}


def command(profile, args, model=None):
    from kinex.validation import segment
    if not isinstance(args, dict):
        raise ValueError("joint command must be an object")
    joints = (model or joint_model(profile))["joints"]
    if set(args) != {"actions", "duration_s"}:
        raise ValueError("write requires actions and duration_s")
    actions = args["actions"]
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions must be a nonempty sequence")
    for target in actions:
        joint_target(target, joints, check_limits=profile["intrinsics"]["control"].get("limit_handling") != "native")
    return segment(args, {"actions": actions})


def project_seed(value, joints):
    """Bound a solver seed without changing the measured configuration used for FK."""
    values = vector(value, len(joints), "IK seed")
    return [max(j["limits"]["min"], min(j["limits"]["max"], v)) if j["limits"] else v
            for j, v in zip(joints, values)]


class Arrival:
    """Gate evidence on device timestamps; optionally time stability in world seconds."""

    def __init__(self, joints, target, spec):
        self.joints, self.target, self.spec = joints, target, spec
        self.since = None
        self.stamp = None

    def sample(self, state, *, time_s=None):
        stamp = vector([state.get("timestamp")], 1, "timestamp")[0]
        now = stamp if time_s is None else vector([time_s], 1, "time_s")[0]
        if self.stamp is not None and stamp < self.stamp:
            raise ValueError("device sample clock moved backwards")
        fresh = self.stamp is None or stamp > self.stamp
        self.stamp = stamp
        errors = [math.atan2(math.sin(q-t), math.cos(q-t)) if j["type"] == "continuous" else q-t
                  for q, t, j in zip(state["positions"], self.target, self.joints)]
        within = all(abs(e) <= tol for e, tol in zip(errors, self.spec["joint_tolerance"]))
        quiet = self.spec.get("quiet_velocity")
        if quiet is not None:
            velocity = vector(state.get("velocities"), len(self.joints), "velocities")
            within = within and all(abs(v) <= tol for v, tol in zip(velocity, quiet))
        if not within:
            self.since = None
            return False
        if not fresh:
            return False
        if self.since is None:
            self.since = now
        return now - self.since + 1e-9 >= self.spec.get("stable_s", 0)
