"""Joint devices: URDF command vector, limit policy, tip pose targets and link kinematics in the device base."""

import math
from pathlib import Path

from kinex.lib import urdf
from kinex.lib.geometry import flat, pose, slerp, vector
from kinex.lib.kinematics import DEFAULTS, Chain
from kinex.lib.urdf import joint_target

HOME_RECOVERY_TOLERANCE = math.radians(1)


class JointModel:
    """A joint device's commanded joints, in URDF document order, and its link FK/IK.

    Poses are [x, y, z, qx, qy, qz, qw] of a URDF link in <device>/base; link
    defaults to the model's only tip link.
    """

    def __init__(self, profile, directory=None):
        if profile.get("type") != "joint":
            raise ValueError("expected a joint device profile")
        model, self.tree = profile["model"], profile.get("resolved_model")
        if self.tree is None:
            if directory is None or not isinstance(model, dict) or "???" in model.values():
                raise ValueError(f"{profile.get('name', 'joint device')} has no resolved URDF model")
            self.tree = urdf.read_tree(Path(directory) / model["path"], model["base_link"])
        self.joints = urdf.commanded(self.tree)
        self.names = [joint["name"] for joint in self.joints]
        self.tips = model["tip_links"]

    def chain(self, link):
        if not link:
            if len(self.tips) != 1:
                raise ValueError(f"name a link; the model declares {len(self.tips) or 'no'} tip links")
            link = self.tips[0]
        return Chain(self.tree, link)

    def fk(self, positions, link=None):
        """Link pose at commanded joint positions; mimic joints follow their sources."""
        q = joint_target(positions, self.joints, check_limits=False)
        return flat(self.chain(link).forward(urdf.positions(self.tree, dict(zip(self.names, q))))[0])

    def ik(self, target, seed, link=None, **options):
        """Commanded positions placing link at target, nearest the seed projected into limits.

        Joints off the link's path keep their seed values. options override the
        solver tolerances, damping, max_iterations and search budget.
        """
        unknown = options.keys() - {*DEFAULTS, "budget"}
        if unknown:
            raise ValueError(f"unknown IK options: {', '.join(sorted(unknown))}")
        values = dict(zip(self.names, project_seed(seed, self.joints)))
        values.update(self.chain(link).ik(pose(target), values, {**DEFAULTS, **options}))
        return [values[name] for name in self.names]


def home_start_tolerance(profile, joints, target):
    """Strict devices may recover toward declared home within an angular margin."""
    home = profile.get("home")
    if not isinstance(home, dict) or any(j["name"] not in home or abs(q - home[j["name"]]) > 1e-9 for j, q in zip(joints, target)):
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


def command(profile, actions, joints):
    """Validate a sequence of joint targets; strict limits reject targets outside the URDF limits."""
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions must be a nonempty sequence")
    for target in actions:
        joint_target(target, joints, check_limits=False)
    if profile["limits"] == "strict":
        recovery_targets(actions, joints, home_start_tolerance(profile, joints, actions[-1]))
    return actions


def project_seed(value, joints):
    """Bound a solver seed without changing the measured configuration used for FK."""
    values = vector(value, len(joints), "IK seed")
    return [max(j["limits"]["min"], min(j["limits"]["max"], v)) if j["limits"] else v
            for j, v in zip(joints, values)]


def pose_command(profile, trajectory, position_only=()):
    """Validate a MultiDOFJointTrajectory of tip link poses in <device>/base.

    Returns [(time_s, {tip: pose})] in point order, with poses
    [x, y, z, qx, qy, qz, qw] normalized, or [x, y, z] for position_only tips,
    whose rotation is ignored. time_from_start increases strictly from receipt.
    """
    frame = f"{profile['name']}/base"
    if trajectory.header.frame_id != frame:
        raise ValueError(f"pose targets must be expressed in {frame}")
    names = list(trajectory.joint_names)
    if not names or len(set(names)) != len(names) or not set(names) <= set(profile["model"]["tip_links"]):
        raise ValueError("pose targets must name tip links once each")
    points = trajectory.points
    times = [point.time_from_start.sec + point.time_from_start.nanosec * 1e-9 for point in points]
    if not points or times[0] < 0 or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("pose targets need points whose time_from_start increases strictly from receipt")
    plan = []
    for time_s, point in zip(times, points):
        if len(point.transforms) != len(names):
            raise ValueError("every point needs one transform per named tip")
        poses = {}
        for name, transform in zip(names, point.transforms):
            t, q = transform.translation, transform.rotation
            position = vector([t.x, t.y, t.z], 3, f"{name} translation")
            poses[name] = position if name in position_only else pose(position + [q.x, q.y, q.z, q.w], f"{name} pose")
        plan.append((time_s, poses))
    return plan


def pose_at(start, plan, elapsed):
    """Tip poses elapsed seconds into a pose_command plan, interpolated from start.

    start maps every planned tip to its full pose at receipt. Positions move
    linearly and rotations by slerp; position-only tips keep their rotation.
    """
    before, previous = 0.0, dict(start)
    for time_s, poses in plan:
        targets = {tip: value if len(value) == 7 else value + previous[tip][3:] for tip, value in poses.items()}
        if elapsed < time_s:
            s = (elapsed - before) / (time_s - before)
            return {tip: [a + s * (b - a) for a, b in zip(previous[tip][:3], target[:3])]
                    + slerp(previous[tip][3:], target[3:], s) for tip, target in targets.items()}
        before, previous = time_s, {**previous, **targets}
    return previous
