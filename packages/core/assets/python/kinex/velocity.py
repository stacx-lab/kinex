"""Velocity/posture commands and measured state, independent of morphology."""

import math

from kinex.validation import number, segment, vector

AXES = ("vx", "vy", "vz", "wx", "wy", "wz")
POSTURE_AXES = ("height", "roll", "pitch", "yaw")


def intrinsics(profile):
    if profile.get("type") != "velocity":
        raise ValueError("Expected a velocity device")
    return profile["intrinsics"]


def command(profile, args):
    control = intrinsics(profile)["control"]
    if not isinstance(control, dict) or control.get("mode") != "motion":
        raise ValueError("Base control is unresolved")
    if not isinstance(args, dict) or set(args) - {"mode", "velocity", "posture", "duration_s"}:
        raise ValueError("Expected mode with velocity and/or posture")
    name = args.get("mode")
    if not isinstance(name, str) or name not in control["modes"]:
        raise ValueError("Unsupported base controller mode")
    mode = control["modes"][name]
    result = {"mode": name}
    for channel in ("velocity", "posture"):
        capabilities = mode[channel]
        if capabilities is None:
            if channel in args:
                raise ValueError(f"{channel} is unsupported in this mode")
            continue
        target = args.get(channel)
        components = capabilities["components"]
        axes = {c["axis"] for c in components}
        if not isinstance(target, dict) or set(target) != axes:
            example = {c["axis"]: 0 for c in components}
            raise ValueError(f"{channel} requires named axes, for example {example}; arrays are unsupported")
        result[channel] = {}
        for component in components:
            axis = component["axis"]
            value = number(target[axis])
            bounds = component["bounds"]
            if bounds is not None:
                low, high = number(bounds["min"]), number(bounds["max"])
                if not low < high:
                    raise ValueError("Invalid command bounds")
                if control.get("limit_handling") != "native" and not low <= value <= high:
                    raise ValueError(f"{channel}.{axis} exceeds bounds")
            if channel == "velocity":
                units = "m/s" if axis.startswith("v") else "rad/s"
                if axis not in AXES or component["units"] not in {units, "normalized"} or (bounds is not None and not low <= 0 <= high):
                    raise ValueError("Invalid velocity capability")
            if channel == "posture":
                units = "m" if axis == "height" else "rad"
                if axis not in POSTURE_AXES or component["units"] != units or (bounds is not None and axis == "height" and low <= 0):
                    raise ValueError("Invalid posture capability")
            result[channel][axis] = value
    return segment(args, result)


def reading(profile, sample):
    facts = intrinsics(profile)
    result = {**sample, **feedback_reading(facts["feedback"], sample)}
    frames = sample.get("frame_poses", {})
    dynamic = {name for name, frame in facts.get("frames", {}).items()
               if frame["translation_m"] is None or frame["rotation_xyzw"] is None}
    if not isinstance(frames, dict) or not set(frames) <= dynamic:
        raise ValueError("frame_poses must match declared frames")
    for value in frames.values():
        pose = vector(value, 7)
        if abs(math.hypot(*pose[3:]) - 1) > 1e-6:
            raise ValueError("Unit quaternion xyzw required")
    if not frames:
        result.pop("frame_poses", None)
    return result


def feedback_reading(feedback, sample):
    if "pose" in sample:
        raise ValueError("velocity readings cannot contain global pose; use explicit frame estimates")
    if "pose_frame" in feedback:
        raise ValueError("velocity feedback cannot declare pose_frame")
    if "height_m" in sample:
        number(sample["height_m"], "height_m")
    components = feedback["velocity_components"]
    if not isinstance(components, list) or any(c not in AXES for c in components) or len(set(components)) != len(components):
        raise ValueError("Measured components are unresolved or invalid")
    if feedback["velocity_frame"] == "???" or (feedback["velocity_frame"] is None) != (not components):
        raise ValueError("Measured velocity frame does not match components")
    velocities = vector(sample.get("velocities"), len(components))
    faults = sample.get("faults")
    if not isinstance(faults, list) or any(not isinstance(f, dict) or set(f) != {"code"} or not isinstance(f["code"], str) for f in faults):
        raise ValueError("faults must be [{code: string}]")
    return {"velocities": velocities, "faults": faults,
            "timestamp": number(sample.get("timestamp"), "timestamp")}
