"""Profile-driven command and feedback handling for fixed end-effector contracts."""

from kinex.validation import number, segment, segment_result
from kinex.driver_protocol import check_cancelled

import math


def command(profile, args):
    if "actions" in args:
        if set(args) - {"actions", "freq_hz", "for_s"}:
            raise ValueError("buffered write accepts actions, freq_hz and optional for_s")
        frequency = number(args.get("freq_hz"), "freq_hz")
        if frequency <= 0:
            raise ValueError("freq_hz must be positive")
        if not isinstance(args["actions"], list) or not args["actions"]:
            raise ValueError("actions must be a nonempty sequence")
        actions = [command(profile, {"target": target, "for_s": 1 / frequency})["target"] for target in args["actions"]]
        if "for_s" in args and number(args["for_s"], "for_s") <= 0:
            raise ValueError("for_s must be positive")
        return {**args, "actions": actions}
    if set(args) - {"target", "speedFraction", "for_s"}:
        raise ValueError("write accepts only target, speedFraction, for_s")
    control = profile["intrinsics"]["control"]
    if not isinstance(control, dict) or control["mode"] == "none":
        raise ValueError("This tool has no calibrated command interface")
    target = args.get("target")
    if not isinstance(target, list) or len(target) != 1:
        raise ValueError("target must contain exactly one command value")
    value = number(target[0], "target")
    if control["mode"] == "binary":
        if value not in (control["off_target"], control["on_target"]):
            raise ValueError("target must equal off_target or on_target")
        if "speedFraction" in args:
            raise ValueError("speedFraction is unsupported")
        return segment(args, {"target": [value]})
    if control["mode"] == "direction":
        if not -1 <= value <= 1:
            raise ValueError("direction target must be in [-1, 1]")
        if "speedFraction" in args:
            raise ValueError("speedFraction is unsupported")
        return segment(args, {"target": [0 if value == 0 else math.copysign(1, value)]})
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
    speed = control["speed"]
    if speed is None:
        if "speedFraction" in args:
            raise ValueError("speedFraction is unsupported")
        return segment(args, {"target": [value]})
    if not isinstance(speed, dict):
        raise ValueError("Speed support has not been calibrated")
    fraction = number(args.get("speedFraction", speed["default_fraction"]), "speedFraction")
    if not 0 < fraction <= 1:
        raise ValueError("speedFraction must be in (0,1]")
    limits = speed["native_bounds"]
    native = limits["max"] * fraction
    if speed["native_resolution"] is not None:
        native = round(native / speed["native_resolution"]) * speed["native_resolution"]
    return segment(args, {"target": [value], "native_speed": max(limits["min"], min(limits["max"], native))})


def write_buffer(profile, value, send, halt):
    """Execute a validated end-effector buffer beside the vendor SDK."""
    period = 1 / value["freq_hz"]
    budget = value.get("for_s", len(value["actions"]) * period)
    elapsed, completed, state = 0.0, 0, None
    try:
        for target in value["actions"]:
            check_cancelled()
            duration = min(period, budget - elapsed)
            if duration <= 0:
                break
            result = segment_result(send(command(profile, {"target": target, "for_s": duration})))
            state = reading(profile, result["state"])
            elapsed += result["elapsed_s"]
            if state["faults"] or elapsed > budget + 1e-8 or result["elapsed_s"] < duration - 1e-8:
                raise RuntimeError("invalid or faulted buffer execution")
            if duration < period - 1e-8:
                break
            completed += 1
        check_cancelled()
        timeout = completed < len(value["actions"])
        if timeout:
            halt()
        return {"completed_actions": completed, "elapsed_s": elapsed, "state": state,
                "terminated_by": "timeout" if timeout else "completed"}
    except BaseException:
        halt()
        raise


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
