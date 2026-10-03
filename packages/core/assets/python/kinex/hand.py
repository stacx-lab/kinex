"""Local fingertip and grasp-center prediction from a dexterous hand profile.

Poses are [x, y, z, qx, qy, qz, qw] in the canonical hand frame. Predictions
are geometric references, not contact measurements or collision-free commands.
Measured joint-limit overshoot is preserved; validate candidate writes separately.
"""

from kinex.geometry import compose_rt, xyzq_to_rt
from kinex.joint_control import joint_model
from kinex.local_frames import fixed_transform, frame_definitions
from kinex.kinematics import Kinematics
from kinex.motion import flat, pose, vector
from kinex.validation import number


def forward(profile, positions):
    """Predict dynamic fingertip/center frame poses without device or simulator IO."""
    if profile.get("type") != "dexterous_hand":
        raise ValueError("Hand geometry requires a dexterous_hand profile")
    intrinsics = profile["intrinsics"]
    geometry = intrinsics.get("geometry")
    if not isinstance(geometry, dict) or not geometry.get("fingers"):
        raise ValueError("Hand geometry is unavailable")
    joints = joint_model(profile)["joints"]
    values = vector(positions, len(joints), "positions")
    by_name = {joint["name"]: (joint, value) for joint, value in zip(joints, values, strict=True)}
    if len(by_name) != len(joints):
        raise ValueError("Hand model requires unique joints")
    frames = frame_definitions(profile)
    for frame in (geometry["palm_frame"], geometry["reference_frame"]):
        fixed_transform(frames, frame)
    result = {}
    for finger in geometry["fingers"].values():
        names = finger["joints"]
        if len(set(names)) != len(names) or any(name not in by_name for name in names):
            raise ValueError("Finger requires unique, known model joints")
        frame = finger["tip_frame"]
        chain = Kinematics({"joints": [by_name[name][0] for name in names], "chain": finger["chain"]}, None)
        tip = chain.forward([by_name[name][1] for name in names])[0]
        result[frame] = flat(compose_rt(xyzq_to_rt(tip), xyzq_to_rt(pose(finger["tip_offset"]))))
    center = geometry["center"]
    frame = center["frame"]
    weights = center["weights"]
    if any(name not in geometry["fingers"] or number(weight) < 0 for name, weight in weights.items()):
        raise ValueError("Center weights require known fingers and nonnegative numbers")
    if abs(sum(weights.values()) - 1) > 1e-8:
        raise ValueError("Center weights must sum to one")
    rotation = pose([0, 0, 0, *center["rotation_xyzw"]])[3:]
    result[frame] = [sum(weight * result[geometry["fingers"][name]["tip_frame"]][axis]
                         for name, weight in weights.items()) for axis in range(3)] + rotation
    return result
