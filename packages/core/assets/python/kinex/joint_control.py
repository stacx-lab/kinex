"""Device-independent joint models and absolute position command validation."""

import math
from pathlib import Path
from kinex.motion import joint_target, vector
from kinex.urdf import read_chain


HOME_RECOVERY_TOLERANCE = math.radians(1)


def home_start_tolerance(profile, joints, target):
    """Joint devices may recover toward declared home within an angular margin."""
    joint_target(target, joints, check_limits=False)
    intrinsics = profile["intrinsics"]
    home = intrinsics.get("home")
    if profile.get("type") != "joint" or not isinstance(home, dict):
        return 0.0
    positions = home
    if any(j["name"] not in positions or abs(q - positions[j["name"]]) > 1e-9 for j, q in zip(joints, target)):
        return 0.0
    return HOME_RECOVERY_TOLERANCE


def recovery_targets(actions, joints, tolerance):
    """Allow a bounded, inward-only prefix; the final target remains in limits."""
    joint_target(actions[-1], joints)
    previous = None
    for target in actions:
        joint_target(target, joints, check_limits=False)
        for i, (q, joint) in enumerate(zip(target, joints)):
            limits = joint["limits"]
            if limits is None:
                continue
            margin = tolerance if joint["type"] == "revolute" else 0
            low, high = limits["min"], limits["max"]
            if not low - margin <= q <= high + margin:
                raise ValueError("target outside joint limits recovery tolerance")
            if previous is not None and ((q < low and not previous[i] <= q) or (q > high and not previous[i] >= q)):
                raise ValueError("joint limits recovery must move inward")
        previous = target


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
        joint_target(target, joints, check_limits=False)
    if profile["intrinsics"]["control"].get("limit_handling") != "native":
        recovery_targets(actions, joints, home_start_tolerance(profile, joints, actions[-1]))
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
        self.history = []

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
            if self.spec.get("estimate_velocity"):
                if fresh:
                    positions = vector(state["positions"], len(self.joints), "positions")
                    self.history = (self.history + [{"timestamp": stamp, "positions": positions}])[-3:]
                within = within and len(self.history) >= 2
                for before, after in zip(self.history, self.history[1:]):
                    dt = after["timestamp"] - before["timestamp"]
                    changes = [math.atan2(math.sin(q-p), math.cos(q-p)) if j["type"] == "continuous" else q-p
                               for p, q, j in zip(before["positions"], after["positions"], self.joints)]
                    within = within and all(abs(change) / dt <= tol for change, tol in zip(changes, quiet))
            else:
                velocity = vector(state.get("velocities"), len(self.joints), "velocities")
                within = within and all(abs(v) <= tol for v, tol in zip(velocity, quiet))
        if not within:
            self.since = None
            return False
        if not fresh:
            return False
        if self.since is None:
            self.since = now
        if self.spec.get("estimate_velocity") and len(self.history) < 3:
            return False
        return now - self.since + 1e-9 >= self.spec.get("stable_s", 0)
