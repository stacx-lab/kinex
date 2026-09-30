#!/usr/bin/env python3
"""Fit parent<-arm rigid transform from corresponding 3D points."""
import argparse
import json

from kinex.geometry import mat_to_quat


def solve(path):
    import numpy as np

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    A = np.asarray(data.get("arm_points_m"), dtype=float)
    B = np.asarray(data.get("parent_points_m"), dtype=float)
    if A.ndim != 2 or A.shape[1:] != (3,) or B.shape != A.shape:
        raise ValueError("arm_points_m and parent_points_m must be matching Nx3 arrays")
    n = int(A.shape[0])
    if n < 3:
        raise ValueError("at least 3 point correspondences are required")
    ca, cb = A.mean(axis=0), B.mean(axis=0)
    Ac, Bc = A - ca, B - cb
    _, geom_s, _ = np.linalg.svd(Ac, full_matrices=False)
    # Non-coplanar geometry is preferred. Three points necessarily have rank <=2,
    # so they remain diagnostic-only even when non-collinear.
    scale = max(float(geom_s[0]), 1e-12)
    rank = int(np.sum(geom_s > scale * 1e-6))
    degenerate = rank < 2 or (n >= 4 and rank < 3)

    H = Ac.T @ Bc
    U, fit_s, Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    if np.linalg.det(R) < 0:
        Vt[-1, :] *= -1
        R = Vt.T @ U.T
    t = cb - R @ ca
    predicted = (R @ A.T).T + t
    residual_mm = np.linalg.norm(predicted - B, axis=1) * 1000.0
    rms_mm = float(np.sqrt(np.mean(residual_mm ** 2)))
    max_mm = float(np.max(residual_mm))
    det = float(np.linalg.det(R))
    pose = [float(x) for x in t] + mat_to_quat(R)
    quality_pass = bool(n >= 4 and not degenerate and rms_mm <= 2.0 and max_mm <= 4.0 and abs(det - 1.0) <= 0.001)
    return {
        "ok": True,
        "pose": pose,
        "translation_m": [float(x) for x in t],
        "rotation_xyzw": pose[3:],
        "rms_mm": rms_mm,
        "max_mm": max_mm,
        "per_point_mm": [float(x) for x in residual_mm],
        "n": n,
        "geometry_singular_values": [float(x) for x in geom_s],
        "fit_singular_values": [float(x) for x in fit_s],
        "geometry_rank": rank,
        "degenerate": bool(degenerate),
        "rotation_determinant": det,
        "quality_pass": quality_pass,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--points", required=True)
    args = parser.parse_args()
    try:
        return solve(args.points)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


if __name__ == "__main__":
    print(json.dumps(main()))
