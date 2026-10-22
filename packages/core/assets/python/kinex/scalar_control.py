"""Map scalar end-effector actions onto device command targets."""

from kinex.validation import number, segment


def grip(profile, value):
    """A policy value in [-1, 1] interpolates the grip joint from open to closed."""
    value = number(value, "action")
    if not -1 <= value <= 1:
        raise ValueError("gripper actions must be in [-1, 1]: -1 opens, +1 closes")
    grip = profile["grip"]
    if not isinstance(grip, dict):
        raise ValueError("the gripper has no declared grip joint")
    return grip["open"] + (value + 1) / 2 * (grip["closed"] - grip["open"])


def target(control, value):
    value = number(value, "action")
    if value not in (control["off_target"], control["on_target"]):
        raise ValueError("target must equal off_target or on_target")
    return value


def command(profile, args):
    if not isinstance(args, dict) or set(args) - {"actions", "duration_s"}:
        raise ValueError("write accepts only actions and duration_s")
    actions = args.get("actions")
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions must be a nonempty sequence of numbers")
    if profile["type"] == "gripper":
        return segment(args, {"actions": [grip(profile, value) for value in actions]})
    control = profile["control"]
    if not isinstance(control, dict):
        raise ValueError("This tool has no calibrated command interface")
    return segment(args, {"actions": [target(control, value) for value in actions]})


def reading(profile, sample):
    feedback = profile["feedback"]
    result = dict(sample)
    count = len(feedback["positions"])
    for key, size in (("positions", count), ("velocities", count if feedback["velocities"] else 0)):
        values = sample[key]
        if not isinstance(values, list) or len(values) != size:
            raise ValueError(f"{key} must have {size} values in feedback channel order")
        for value in values:
            number(value, key)
    number(sample.get("timestamp"), "timestamp")
    if not isinstance(sample["faults"], list):
        raise ValueError("faults must be a list of objects with string code")
    for fault in sample["faults"]:
        if not isinstance(fault, dict) or set(fault) != {"code"} or not isinstance(fault["code"], str):
            raise ValueError("faults must be a list of objects with string code")
    sensors = feedback.get("sensors", [])
    for key in ("force_n", "pressure_pa", "object_detected"):
        value = sample.get(key)
        if key in sensors:
            if key == "object_detected" and not isinstance(value, bool):
                raise ValueError("object_detected must be boolean when supported")
            if key != "object_detected":
                number(value, key)
        if key not in sensors and value is not None:
            raise ValueError(f"{key} is unsupported by the profile")
        result[key] = value
    model = feedback.get("aperture_model")
    result["aperture_m"] = None
    if isinstance(model, dict) and model["model"] == "affine":
        if len(model["coefficients"]) != count:
            raise ValueError("aperture conversion must match feedback dimensions")
        result["aperture_m"] = max(0.0, model["offset_m"] + sum(
            a * b for a, b in zip(model["coefficients"], sample["positions"])))
    return result
