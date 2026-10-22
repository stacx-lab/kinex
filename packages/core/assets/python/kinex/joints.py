"""Joint devices: URDF command vector, limit policy and link kinematics in the device base."""

import math
from pathlib import Path

from kinex import urdf
from kinex.kinematics import DEFAULTS, Chain
from kinex.motion import flat, joint_target, pose, vector
from kinex.validation import segment

HOME_RECOVERY_TOLERANCE = math.radians(1)


class JointModel:
    """A joint device's commanded joints, in URDF document order, and its link FK/IK.

    Poses are [x, y, z, qx, qy, qz, qw] of a URDF link in <device>/base; link
    defaults to the model's tip_link.
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
        self.tip = model["tip_link"]

    def chain(self, link):
        link = link or self.tip
        if not link:
            raise ValueError("name a link; the model declares no tip_link")
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


def command(profile, args, joints):
    """Validate a timed joint buffer; strict limits reject targets outside the URDF limits."""
    if not isinstance(args, dict) or set(args) != {"actions", "duration_s"}:
        raise ValueError("joint command requires actions and duration_s")
    actions = args["actions"]
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions must be a nonempty sequence")
    for target in actions:
        joint_target(target, joints, check_limits=False)
    if profile["limits"] == "strict":
        recovery_targets(actions, joints, home_start_tolerance(profile, joints, actions[-1]))
    return segment(args, {"actions": actions})


def project_seed(value, joints):
    """Bound a solver seed without changing the measured configuration used for FK."""
    values = vector(value, len(joints), "IK seed")
    return [max(j["limits"]["min"], min(j["limits"]["max"], v)) if j["limits"] else v
            for j, v in zip(joints, values)]


def measured_positions(message, joints):
    """Order a JointState without clamping or silently accepting duplicate names."""
    if len(message.name) != len(message.position) or len(set(message.name)) != len(message.name):
        raise ValueError("joint state requires unique names and matching positions")
    positions = dict(zip(message.name, message.position))
    names = [joint["name"] for joint in joints]
    if any(name not in positions for name in names):
        raise ValueError("joint state is missing modeled joints")
    return joint_target([positions[name] for name in names], joints, check_limits=False)
