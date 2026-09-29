"""Position-control math. Physical units: metres, radians, quaternion xyzw.

Joint targets and arrival checks; no device I/O or controller loops.
"""

from kinex.validation import vector

import math

from kinex.geometry import compose_rt, invert_rt, mat_to_quat, xyzq_to_rt


# Rounding each component to d decimals moves the norm by at most 10**-d, so
# goals written to two or more decimals pass; zero, Euler angles and other
# rotations that are not quaternions remain rejected.
QUATERNION_NORM_TOLERANCE = 1e-2


def quaternion(value, name="quaternion"):
    """Return a near-unit quaternion [qx, qy, qz, qw] scaled to unit norm."""
    vector(value, 4, name)
    norm = math.hypot(*value)
    if abs(norm - 1) > QUATERNION_NORM_TOLERANCE:
        raise ValueError(f"{name} requires a unit quaternion [qx, qy, qz, qw] (xyzw); got norm {norm:.6g} "
                         f"(norms within {QUATERNION_NORM_TOLERANCE:g} of 1 are normalized)")
    return [v / norm for v in value]


def pose(value, name="pose"):
    """Return [x, y, z, qx, qy, qz, qw] with its near-unit quaternion normalized."""
    vector(value, 7, name)
    return value[:3] + quaternion(value[3:], name)


def flat(rt):
    return list(rt[1]) + mat_to_quat(rt[0])


def pose_error(goal, current):
    relative = compose_rt(xyzq_to_rt(goal), invert_rt(xyzq_to_rt(current)))
    q = mat_to_quat(relative[0])
    return {"position_m": math.hypot(*(a - b for a, b in zip(goal[:3], current[:3]))),
            "rotation_rad": 2 * math.atan2(math.hypot(*q[:3]), abs(q[3]))}


def joint_target(value, joints, *, check_limits=True):
    if not joints:
        raise ValueError("joint metadata is required")
    vector(value, len(joints), "joint target")
    for position, joint in zip(value, joints):
        limits = joint.get("limits")
        if check_limits and limits is not None and not limits["min"] <= position <= limits["max"]:
            raise ValueError(f"target outside joint limits: {joint['name']}")
    return value
