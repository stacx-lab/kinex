"""Driver-local serial-chain FK and damped least-squares IK; standard library only."""

import math

from kinex.geometry import apply_rt, compose_rt, invert_rt, mat_to_quat, xyzq_to_rt
from kinex.ik_search import checkpoint, search
from kinex.motion import flat, pose as validate_pose, vector
from kinex.validation import number


def cross(a, b):
    return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]


def rotation_error(target, current):
    q = mat_to_quat(compose_rt(xyzq_to_rt(target), invert_rt(xyzq_to_rt(current)))[0])
    length = math.hypot(*q[:3])
    if length < 1e-12:
        return [0.0]*3
    angle = 2*math.atan2(length, abs(q[3])) * (1 if q[3] >= 0 else -1)
    return [v*angle/length for v in q[:3]]


def solve(matrix, value):
    """Solve the small positive-definite damped task-space system."""
    rows = [list(row) + [v] for row, v in zip(matrix, value, strict=True)]
    for i in range(len(rows)):
        pivot = max(range(i, len(rows)), key=lambda j: abs(rows[j][i]))
        rows[i], rows[pivot] = rows[pivot], rows[i]
        scale = rows[i][i]
        rows[i] = [v/scale for v in rows[i]]
        for j in range(len(rows)):
            if j != i:
                factor = rows[j][i]
                rows[j] = [a - factor*b for a, b in zip(rows[j], rows[i], strict=True)]
    return [row[-1] for row in rows]


class Kinematics:
    def __init__(self, model, ik):
        self.joints = model["joints"]
        self.chain = model["chain"]
        self.options = ik
        indexes = [link["joint"] for link in self.chain if "joint" in link]
        if indexes != list(range(len(self.joints))) or not self.joints:
            raise ValueError("Kinematic chain must follow the declared joint order")
        for link in self.chain:
            validate_pose(link["origin"])
            if "joint" in link:
                axis = vector(link["axis"], 3, "joint axis")
                vector(link["anchor"], 3, "joint anchor")
                vector([link["reference"]], 1, "joint reference")
                if abs(math.hypot(*axis) - 1) > 1e-5:
                    raise ValueError("Joint axis must have unit length")
        if any(j["type"] not in {"revolute", "continuous", "prismatic"} for j in self.joints):
            raise ValueError("Kinematics supports scalar rotational and prismatic joints")
        self.lower = [(j.get("limits") or {}).get("min", -math.inf) for j in self.joints]
        self.upper = [(j.get("limits") or {}).get("max", math.inf) for j in self.joints]

    def project(self, joints):
        return [max(lo, min(hi, q)) for q, lo, hi in
                zip(vector(joints, len(self.joints), "joints"), self.lower, self.upper, strict=True)]

    def validate(self, joints):
        q = vector(joints, len(self.joints), "joints")
        if q != self.project(q):
            raise ValueError("Joint configuration outside device limits")
        return q

    def forward(self, joints):
        current, axes = xyzq_to_rt([0, 0, 0, 0, 0, 0, 1]), []
        for link in self.chain:
            current = compose_rt(current, xyzq_to_rt(link["origin"]))
            if "joint" not in link:
                continue
            index, axis, anchor = link["joint"], link["axis"], link["anchor"]
            axes.append((apply_rt((current[0], [0, 0, 0]), axis), apply_rt(current, anchor)))
            value = joints[index] - link["reference"]
            if self.joints[index]["type"] == "prismatic":
                current = compose_rt(current, xyzq_to_rt([v*value for v in axis] + [0, 0, 0, 1]))
                continue
            rotation = xyzq_to_rt([0, 0, 0] + [v*math.sin(value/2) for v in axis] + [math.cos(value/2)])
            moved = apply_rt(rotation, anchor)
            current = compose_rt(current, (rotation[0], [a-b for a, b in zip(anchor, moved)]))
        return flat(current), axes

    def fk(self, joints):
        return {"pose": self.forward(self.validate(joints))[0]}

    def ik(self, pose, seed):
        target = validate_pose(pose)
        return solve_tasks(self.joints, self.options,
                           [(self, list(range(len(self.joints))), target[:3], target[3:])], self.validate(seed))


def solve_tasks(joints, options, tasks, seed):
    """Bounded DLS search over simultaneous tasks and shared joint variables."""
    from kinex.motion import joint_target

    seed = joint_target(seed, joints)
    iterations = options["max_iterations"]
    if isinstance(iterations, bool) or not isinstance(iterations, int) or iterations <= 0:
        raise ValueError("IK max_iterations must be a positive integer")
    for key in ("damping", "position_tolerance_m", "rotation_tolerance_rad"):
        if number(options[key], f"IK {key}") <= 0:
            raise ValueError(f"IK {key} must be positive")
    targets = []
    for _, indexes, position, orientation in tasks:
        vector(position, 3, "IK position")
        if orientation is not None:
            validate_pose([*position, *orientation])
        targets.append([indexes, position, orientation])

    def verify(q):
        _, _, position, rotation = task_system(tasks, q, len(joints))
        return reached(options, position, rotation)

    return search(joints, options, targets, seed,
                  lambda q, deadline, progress: solve_attempt(joints, options, tasks, q, deadline, progress), verify)


def task_system(tasks, q, count):
    rows, residual = [], []
    position_error, rotation_error_rad = 0.0, 0.0
    for chain, indexes, position, orientation in tasks:
        current, axes = chain.forward([q[i] for i in indexes])
        linear = [a - b for a, b in zip(position, current[:3], strict=True)]
        angular = rotation_error([*position, *orientation], current) if orientation is not None else []
        position_error = max(position_error, math.hypot(*linear))
        rotation_error_rad = max(rotation_error_rad, math.hypot(*angular))
        columns = [axis + [0, 0, 0] if joint["type"] == "prismatic" else
                   cross(axis, [current[i] - anchor[i] for i in range(3)]) + axis
                   for joint, (axis, anchor) in zip(chain.joints, axes, strict=True)]
        for component in range(len(linear + angular)):
            row = [0.0] * count
            for index, column in zip(indexes, columns, strict=True):
                row[index] = column[component]
            rows.append(row)
        residual.extend(linear + angular)
    return rows, residual, position_error, rotation_error_rad


def reached(options, position, rotation):
    return position <= options["position_tolerance_m"] and rotation <= options["rotation_tolerance_rad"]


def solve_attempt(joints, options, tasks, seed, deadline, progress):
    q = list(seed)
    bounds = [(j["limits"]["min"], j["limits"]["max"]) if j["limits"] else (-math.inf, math.inf) for j in joints]
    count = len(joints)
    for _ in range(options["max_iterations"]):
        if not checkpoint(deadline):
            return None
        rows, residual, position, rotation = task_system(tasks, q, count)
        progress.observe(position, rotation, options)
        if reached(options, position, rotation):
            return q
        matrix = [[sum(row[i]*row[j] for row in rows) + (options["damping"]**2 if i == j else 0)
                   for j in range(count)] for i in range(count)]
        gradient = [sum(row[i]*error for row, error in zip(rows, residual, strict=True)) for i in range(count)]
        delta = solve(matrix, gradient)
        steps = [(hi-lo)*0.05 if math.isfinite(hi-lo) else math.pi*0.05 for lo, hi in bounds]
        scale = max(1.0, *(abs(d)/step for d, step in zip(delta, steps, strict=True)))
        q = [max(lo, min(hi, v + d/scale)) for v, d, (lo, hi) in zip(q, delta, bounds, strict=True)]
    return None
