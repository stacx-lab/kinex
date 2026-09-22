"""Device-independent joint models and absolute position command validation."""

from pathlib import Path
from kinex.motion import joint_target, vector
from kinex.validation import SEGMENT, segment
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
    if not isinstance(args, dict):
        raise ValueError("write arguments must be an object")
    joints = (model or joint_model(profile))["joints"]
    if set(args) - {"target", "speedFraction", *SEGMENT}:
        raise ValueError("write accepts only target, speedFraction, for_s and arrive")
    target = joint_target(args.get("target"), joints)
    speed = profile["intrinsics"]["control"]["speed"]
    if speed is None:
        if "speedFraction" in args:
            raise ValueError("speedFraction is unsupported")
        return segment(args, {"target": target})
    fraction = args.get("speedFraction", speed["default_fraction"])
    vector([fraction], 1, "speedFraction")
    if not 0 < fraction <= 1:
        raise ValueError("speedFraction must be in (0,1]")
    ceilings = [speed["max_velocity"][j["name"]] for j in joints]
    vector(ceilings, len(joints), "speed ceilings")
    if any(v <= 0 or (j["max_velocity"] is not None and v > j["max_velocity"]) for j, v in zip(joints, ceilings)):
        raise ValueError("Command speed must be positive and within model velocity limits")
    return segment(args, {"target": target, "max_velocity": [v*fraction for v in ceilings]})


class JointSamples:
    """Freshness and velocity estimates in one device's acquisition clock."""

    def __init__(self, joints, measured):
        self.joints, self.measured = joints, measured
        self.stamp, self.positions, self.velocities = None, None, None

    def sample(self, state):
        import math
        positions = vector(state.get("positions"), len(self.joints), "read.positions")
        stamp = state.get("sample_time_s")
        stamp = vector([state.get("received_time_s") if stamp is None else stamp], 1, "read timestamp")[0]
        if self.stamp is not None and stamp < self.stamp:
            raise ValueError("device sample clock moved backwards")
        if stamp == self.stamp:
            if positions != self.positions:
                raise ValueError("cached sample changed positions")
            return stamp, self.velocities, False
        velocities = vector(state.get("velocities"), len(self.joints), "read.velocities") if self.measured else None
        if not self.measured:
            vector(state.get("velocities"), 0, "unsupported read.velocities")
            if self.stamp is not None:
                delta = [math.atan2(math.sin(a-b), math.cos(a-b)) if joint["type"] == "continuous" else a-b
                         for a, b, joint in zip(positions, self.positions, self.joints)]
                velocities = [value / (stamp-self.stamp) for value in delta]
        self.stamp, self.positions, self.velocities = stamp, list(positions), velocities
        return stamp, velocities, True
