"""Rigid mounts fitted from matching points: an arm on its parent, or a second arm on the first."""
import numpy as np

from kinex.common.geometry import mat_to_quat
from kinex.lib.calibration import _frames


def fit_mount(run, arm_points_m, parent_points_m, parent_frame):
    """The bound target arm's base in parent_frame of the bound parent, from matching points.

    The points are Nx3 metres of the same physical points in the arm base and in the parent
    frame, in the same order: at least 4 well-spread, noncoplanar points. Passes with RMS
    <= 2 mm, maximum residual <= 4 mm, nondegenerate geometry and a proper rotation; proposes
    the target's frames.base.

    Example: result = lib.calibration.rigid.fit_mount(run, arm_points, parent_points, "base")
    """
    return _fit(run, "fit-mount", arm_points_m, parent_points_m, f"{run.role('parent')}:{parent_frame}")


def fit_dual(run, anchor_points_m, second_points_m):
    """The bound second arm's base in the bound anchor arm's base, from shared touched points.

    The points are Nx3 metres of the same fiducials in each arm's base frame, in the same
    order, with the same minimum and quality gates as fit_mount.

    Example: result = lib.calibration.rigid.fit_dual(run, anchor_points, second_points)
    """
    return _fit(run, "fit-dual", second_points_m, anchor_points_m, f"{run.role('anchor')}:base")


def _fit(run, operation, source, target, parent):
    """The target<-source rigid transform of corresponding points, as the run's result."""
    A, B = np.asarray(source, dtype=float), np.asarray(target, dtype=float)
    if A.ndim != 2 or A.shape[1:] != (3,) or B.shape != A.shape or len(A) < 3:
        raise ValueError("points must be matching Nx3 arrays of at least 3 points")
    run.save(f"{operation}-points", {"source_m": A, "target_m": B, "parent": parent})

    def solve():
        n = len(A)
        ca, cb = A.mean(axis=0), B.mean(axis=0)
        _, geometry, _ = np.linalg.svd(A - ca, full_matrices=False)
        # Three points are at most rank 2, so they stay diagnostic even when non-collinear.
        rank = int(np.sum(geometry > max(float(geometry[0]), 1e-12) * 1e-6))
        degenerate = rank < 2 or (n >= 4 and rank < 3)
        U, fit, Vt = np.linalg.svd((A - ca).T @ (B - cb))
        R = Vt.T @ U.T
        if np.linalg.det(R) < 0:
            Vt[-1, :] *= -1
            R = Vt.T @ U.T
        t = cb - R @ ca
        residual_mm = np.linalg.norm(A @ R.T + t - B, axis=1) * 1000
        rms_mm, max_mm, det = float(np.sqrt(np.mean(residual_mm ** 2))), float(residual_mm.max()), float(np.linalg.det(R))
        return {"translation_m": t.tolist(), "rotation_xyzw": mat_to_quat(R.tolist()), "rms_mm": rms_mm, "max_mm": max_mm,
                "per_point_mm": residual_mm.tolist(), "n": n, "geometry_singular_values": geometry.tolist(),
                "fit_singular_values": fit.tolist(), "geometry_rank": rank, "degenerate": degenerate, "rotation_determinant": det,
                "quality_pass": n >= 4 and not degenerate and rms_mm <= 2 and max_mm <= 4 and abs(det - 1) <= 1e-3}

    return run._solve(operation, solve, lambda data: "passed" if data["quality_pass"] else "failed",
                      lambda data: _frames("survey", {"base": {"parent": parent, "translation_m": data["translation_m"],
                                                               "rotation_xyzw": data["rotation_xyzw"]}}))
