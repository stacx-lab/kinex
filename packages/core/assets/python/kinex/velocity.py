"""Velocity/posture commands and measured state, independent of morphology."""

import math

from kinex.validation import SEGMENT, number, segment, vector

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
    if not isinstance(args, dict) or set(args) - {"mode", "velocity", "posture", *SEGMENT}:
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
            raise ValueError(f"{channel} requires its declared axes")
        result[channel] = {}
        for component in components:
            axis = component["axis"]
            value = number(target[axis])
            low, high = number(component["bounds"]["min"]), number(component["bounds"]["max"])
            if not low < high or not low <= value <= high:
                raise ValueError(f"{channel}.{axis} exceeds bounds")
            if channel == "velocity":
                units = "m/s" if axis.startswith("v") else "rad/s"
                if axis not in AXES or not low <= 0 <= high or component["units"] not in {units, "normalized"}:
                    raise ValueError("Invalid velocity capability")
            if channel == "posture":
                units = "m" if axis == "height" else "rad"
                if axis not in POSTURE_AXES or component["units"] != units or (axis == "height" and low <= 0):
                    raise ValueError("Invalid posture capability")
            result[channel][axis] = value
    return segment(args, result)


def reading(profile, sample):
    facts = intrinsics(profile)
    result = {**sample, **feedback_reading(facts["feedback"], sample)}
    frames = sample.get("frame_poses", {})
    dynamic = {name for name, pose in facts.get("frames", {}).items() if pose is None}
    if not isinstance(frames, dict) or set(frames) != dynamic:
        raise ValueError("frame_poses must match declared frames")
    for value in frames.values():
        pose = vector(value, 7)
        if abs(math.hypot(*pose[3:]) - 1) > 1e-6:
            raise ValueError("Unit quaternion xyzw required")
    return {**result, "frame_poses": frames}


def feedback_reading(feedback, sample):
    if "pose" not in sample:
        raise ValueError("pose is required (null when unlocalized)")
    components = feedback["velocity_components"]
    if not isinstance(components, list) or any(c not in AXES for c in components) or len(set(components)) != len(components):
        raise ValueError("Measured components are unresolved or invalid")
    if feedback["velocity_frame"] == "???" or (feedback["velocity_frame"] is None) != (not components):
        raise ValueError("Measured velocity frame does not match components")
    velocities = vector(sample.get("velocities"), len(components))
    pose = sample.get("pose")
    if feedback["pose_frame"] == "???":
        raise ValueError("Pose frame is unresolved")
    if feedback["pose_frame"] is None:
        if pose is not None:
            raise ValueError("Undeclared pose feedback")
    else:
        if not isinstance(pose, dict) or set(pose) != {"translation_m", "rotation_xyzw"}:
            raise ValueError("Expected a structured base pose")
        vector(pose["translation_m"], 3)
        q = vector(pose["rotation_xyzw"], 4)
        if not math.isclose(sum(v * v for v in q), 1, abs_tol=1e-6):
            raise ValueError("Pose quaternion must have unit norm")
    faults = sample.get("faults")
    if not isinstance(faults, list) or any(not isinstance(f, dict) or set(f) != {"code"} or not isinstance(f["code"], str) for f in faults):
        raise ValueError("faults must be [{code: string}]")
    if feedback["clock"] not in {"unix", "monotonic", "simulation"}:
        raise ValueError("Measurement clock is unresolved")
    if "sample_time_s" not in sample:
        raise ValueError("sample_time_s is required (null when unknown)")
    timestamp = sample["sample_time_s"]
    result = {"pose": pose, "velocities": velocities, "faults": faults, "sample_time_s": timestamp}
    if timestamp is not None:
        number(timestamp)
        return result
    result["received_time_s"] = number(sample.get("received_time_s"))
    return result
