"""Map policy end-effector actions in [-1, 1] onto gripper and suction targets: -1 releases, +1 grips."""

from kinex.validation import number, segment


def action(value):
    value = number(value, "action")
    if not -1 <= value <= 1:
        raise ValueError("end-effector actions must be in [-1, 1]: -1 releases, +1 grips")
    return value


def grip(profile, value):
    """Interpolate the grip joint from open to closed."""
    grip = profile["grip"]
    if not isinstance(grip, dict):
        raise ValueError("the gripper has no declared grip joint")
    return grip["open"] + (action(value) + 1) / 2 * (grip["closed"] - grip["open"])


def vacuum(profile, value):
    """A vacuum level from release (0) to full vacuum (1); binary devices switch on above 0."""
    value = action(value)
    if profile["vacuum"] == "binary":
        return 1.0 if value > 0 else 0.0
    if profile["vacuum"] != "proportional":
        raise ValueError("the suction device declares no vacuum control")
    return (value + 1) / 2


def command(profile, args):
    if not isinstance(args, dict) or set(args) - {"actions", "duration_s"}:
        raise ValueError("write accepts only actions and duration_s")
    actions = args.get("actions")
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions must be a nonempty sequence of numbers")
    target = grip if profile["type"] == "gripper" else vacuum
    return segment(args, {"actions": [target(profile, value) for value in actions]})
