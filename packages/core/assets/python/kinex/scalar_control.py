"""Profile-driven command and feedback handling for fixed end-effector contracts."""

from kinex.validation import number, segment

import math


def command(profile, args):
    if not isinstance(args, dict) or set(args) - {"actions", "speedFraction", "duration_s"}:
        raise ValueError("write accepts only actions, speedFraction, duration_s")
    actions = args.get("actions")
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions must be a nonempty sequence of numbers")
    control = profile["intrinsics"]["control"]
    if not isinstance(control, dict) or control["mode"] == "none":
        raise ValueError("This tool has no calibrated command interface")
    result = segment(args, {"actions": [target(control, value) for value in actions]})
    speed = control.get("speed") if control["mode"] == "position" else None
    if speed is None:
        if "speedFraction" in args:
            raise ValueError("speedFraction is unsupported")
        return result
    if not isinstance(speed, dict):
        raise ValueError("Speed support has not been calibrated")
    fraction = number(args.get("speedFraction", speed["default_fraction"]), "speedFraction")
    if not 0 < fraction <= 1:
        raise ValueError("speedFraction must be in (0,1]")
    limits = speed["native_bounds"]
    native = limits["max"] * fraction
    if speed["native_resolution"] is not None:
        native = round(native / speed["native_resolution"]) * speed["native_resolution"]
    return {**result, "native_speed": max(limits["min"], min(limits["max"], native))}


def target(control, value):
    value = number(value, "action")
    if control["mode"] == "binary":
        if value not in (control["off_target"], control["on_target"]):
            raise ValueError("target must equal off_target or on_target")
        return value
    if control["mode"] == "direction":
        if not -1 <= value <= 1:
            raise ValueError("direction target must be in [-1, 1]")
        return 0 if value == 0 else math.copysign(1, value)
    if control["mode"] != "position":
        raise ValueError("Unknown end-effector control mode")
    bounds = control["bounds"]
    if not bounds["min"] <= value <= bounds["max"]:
        raise ValueError("target exceeds profile command bounds")
    resolution = control["resolution"]
    if resolution is not None:
        value = round(value / resolution) * resolution
    if not bounds["min"] <= value <= bounds["max"]:
        raise ValueError("quantized target exceeds profile command bounds")
    return value


def reading(profile, sample):
    feedback = profile["intrinsics"]["feedback"]
    count = len(feedback["positions"])
    result = dict(sample)
    for key, size in (("positions", count), ("velocities", count if feedback["velocities"] else 0)):
        values = sample[key]
        if not isinstance(values, list) or len(values) != size:
            raise ValueError(f"{key} must have {size} values in feedback channel order")
        for value in values:
            number(value, key)
    if sample["sample_time_s"] is None:
        number(sample["received_time_s"], "received_time_s")
    else:
        number(sample["sample_time_s"], "sample_time_s")
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
        # Physical opening cannot be negative (soft contact can slightly overlap).
        result["aperture_m"] = max(0.0, model["offset_m"] + sum(a * b for a, b in zip(model["coefficients"], sample["positions"])))
    return result


def stopped(profile):
    stop = profile["intrinsics"]["stop"]
    if not isinstance(stop, dict) or stop["behavior"] == "none":
        raise ValueError("This tool has no calibrated stop interface")
    return {"stopped": True, "behavior": stop["behavior"], "affected_devices": stop["affected_devices"]}
