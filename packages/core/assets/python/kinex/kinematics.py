"""URDF link forward kinematics and damped least-squares IK; standard library only."""

import math

from kinex.geometry import apply_rt, compose_rt, invert_rt, mat_to_quat, xyzq_to_rt
from kinex.ik_search import checkpoint, search
from kinex.motion import flat
from kinex.urdf import displacement
from kinex.validation import number

# Solver policy; the tolerances bound the verified FK residual of an accepted solution.
DEFAULTS = {"position_tolerance_m": 1e-4, "rotation_tolerance_rad": 1e-3, "max_iterations": 200, "damping": .01}


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


def reached(options, position, rotation):
    return position <= options["position_tolerance_m"] and rotation <= options["rotation_tolerance_rad"]


class Chain:
    """The URDF joints from the base link to one link."""

    def __init__(self, tree, link):
        parents = {joint["child"]: joint for joint in tree["joints"]}
        path = []
        while link != tree["base_link"]:
            if link not in parents:
                raise ValueError(f"{link!r} is not a link below {tree['base_link']!r}")
            path.append(parents[link])
            link = parents[link]["parent"]
        self.path = path[::-1]
        self.joints = [joint for joint in self.path if joint["type"] != "fixed"]

    def forward(self, positions):
        """Link pose in the base frame, with each movable joint's axis and origin there."""
        current, axes = xyzq_to_rt([0, 0, 0, 0, 0, 0, 1]), []
        for joint in self.path:
            current = compose_rt(current, xyzq_to_rt(joint["origin"]))
            if joint["type"] == "fixed":
                continue
            axes.append((apply_rt((current[0], [0, 0, 0]), joint["axis"]), list(current[1])))
            current = compose_rt(current, displacement(joint, positions[joint["name"]]))
        return current, axes

    def system(self, target, q):
        """Task-space Jacobian rows, residual and position/rotation errors at q."""
        current, axes = self.forward({joint["name"]: value for joint, value in zip(self.joints, q, strict=True)})
        current = flat(current)
        linear = [a - b for a, b in zip(target[:3], current[:3], strict=True)]
        angular = rotation_error(target, current)
        columns = [axis + [0, 0, 0] if joint["type"] == "prismatic" else
                   cross(axis, [current[i] - origin[i] for i in range(3)]) + axis
                   for joint, (axis, origin) in zip(self.joints, axes, strict=True)]
        rows = [[column[k] for column in columns] for k in range(6)]
        return rows, linear + angular, math.hypot(*linear), math.hypot(*angular)

    def attempt(self, target, options, seed, deadline, progress):
        q = list(seed)
        bounds = [(j["limits"]["min"], j["limits"]["max"]) if j["limits"] else (-math.inf, math.inf) for j in self.joints]
        steps = [(hi-lo)*0.05 if math.isfinite(hi-lo) else math.pi*0.05 for lo, hi in bounds]
        for _ in range(options["max_iterations"]):
            if not checkpoint(deadline):
                return None
            rows, residual, position, rotation = self.system(target, q)
            progress.observe(position, rotation, options)
            if reached(options, position, rotation):
                return q
            count = len(q)
            matrix = [[sum(row[i]*row[j] for row in rows) + (options["damping"]**2 if i == j else 0)
                       for j in range(count)] for i in range(count)]
            gradient = [sum(row[i]*error for row, error in zip(rows, residual, strict=True)) for i in range(count)]
            delta = solve(matrix, gradient)
            scale = max(1.0, *(abs(d)/step for d, step in zip(delta, steps, strict=True)))
            q = [max(lo, min(hi, v + d/scale)) for v, d, (lo, hi) in zip(q, delta, bounds, strict=True)]
        return None

    def ik(self, target, seed, options):
        """Positions by name of the chain joints placing the link at target, nearest the seed
        positions by name, within the search budget."""
        if not self.joints or any(joint["mimic"] for joint in self.joints):
            raise ValueError("IK requires a link reached through independent movable joints")
        iterations = options["max_iterations"]
        if isinstance(iterations, bool) or not isinstance(iterations, int) or iterations <= 0:
            raise ValueError("IK max_iterations must be a positive integer")
        for key in ("damping", "position_tolerance_m", "rotation_tolerance_rad"):
            if number(options[key], f"IK {key}") <= 0:
                raise ValueError(f"IK {key} must be positive")
        solved = search(self.joints, options, [target], [seed[joint["name"]] for joint in self.joints],
                        lambda q, deadline, progress: self.attempt(target, options, q, deadline, progress),
                        lambda q: reached(options, *self.system(target, q)[2:]))["joints"]
        return {joint["name"]: value for joint, value in zip(self.joints, solved)}
