"""Finite-number checks, quaternions, poses and rigid transforms; standard library only.

A pose is [x, y, z, qx, qy, qz, qw], child in parent (p_parent = R p_child + t),
with the quaternion scalar-last. An (R, t) pair is a 3x3 row-major rotation with a
3-vector translation.
"""

import math


def number(value, name="value"):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return value


def vector(value, size, name="components"):
    if not isinstance(value, list) or len(value) != size:
        raise ValueError(f"{name} needs {size} numbers")
    for entry in value:
        number(entry, name)
    return value


def quat_to_mat(q):
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / n, y / n, z / n, w / n
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def mat_to_quat(R):
    """Stable branch-based conversion; output [qx, qy, qz, qw]."""
    trace = R[0][0] + R[1][1] + R[2][2]
    if trace > 0.0:
        s = math.sqrt(trace + 1.0) * 2.0
        q = [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s, 0.25 * s]
    elif R[0][0] > R[1][1] and R[0][0] > R[2][2]:
        s = math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]) * 2.0
        q = [0.25 * s, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s, (R[2][1] - R[1][2]) / s]
    elif R[1][1] > R[2][2]:
        s = math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]) * 2.0
        q = [(R[0][1] + R[1][0]) / s, 0.25 * s, (R[1][2] + R[2][1]) / s, (R[0][2] - R[2][0]) / s]
    else:
        s = math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]) * 2.0
        q = [(R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, 0.25 * s, (R[1][0] - R[0][1]) / s]
    n = math.sqrt(sum(v * v for v in q))
    return [v / n for v in q]


def apply_rt(rt, point):
    R, t = rt
    return [sum(R[row][col] * point[col] for col in range(3)) + t[row] for row in range(3)]


def compose_rt(a, b):
    """T_a ∘ T_b: apply b first, then a."""
    Ra, ta = a
    Rb, tb = b
    R = [[sum(Ra[i][k] * Rb[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return R, apply_rt(a, tb)


def invert_rt(rt):
    R, t = rt
    Rt = [[R[j][i] for j in range(3)] for i in range(3)]
    return Rt, [-sum(Rt[i][j] * t[j] for j in range(3)) for i in range(3)]


def pose_to_rt(pose):
    """Profile Pose dict {translation, rotation xyzw} -> (R, t)."""
    return quat_to_mat(pose["rotation"]), list(pose["translation"])


def rt_to_pose(rt):
    R, t = rt
    return {"translation": [float(v) for v in t], "rotation": mat_to_quat(R)}


def xyzq_to_rt(flat):
    """[x, y, z, qx, qy, qz, qw] (named-frame pose) -> (R, t)."""
    return quat_to_mat(flat[3:7]), list(flat[0:3])


# Four components rounded to three decimals can change the norm by up to 0.001.
QUATERNION_NORM_TOLERANCE = 1e-3


def quaternion(value, name="quaternion"):
    """Return a near-unit [qx, qy, qz, qw] quaternion scaled to unit norm."""
    vector(value, 4, name)
    norm = math.hypot(*value)
    # Compare bounds directly so the endpoints survive floating-point rounding.
    if not 1 - QUATERNION_NORM_TOLERANCE <= norm <= 1 + QUATERNION_NORM_TOLERANCE:
        raise ValueError(f"{name} requires a unit quaternion [qx, qy, qz, qw] (xyzw); got norm {norm!r} "
                         f"(norms within {QUATERNION_NORM_TOLERANCE:g} of 1 are normalized)")
    return [component / norm for component in value]


def pose(value, name="pose"):
    """Return [x, y, z, qx, qy, qz, qw] with a normalized near-unit quaternion."""
    vector(value, 7, name)
    return value[:3] + quaternion(value[3:], name)


def flat(rt):
    return list(rt[1]) + mat_to_quat(rt[0])


def pose_error(goal, current):
    relative = compose_rt(xyzq_to_rt(goal), invert_rt(xyzq_to_rt(current)))
    q = mat_to_quat(relative[0])
    return {"position_m": math.hypot(*(a - b for a, b in zip(goal[:3], current[:3]))),
            "rotation_rad": 2 * math.atan2(math.hypot(*q[:3]), abs(q[3]))}
