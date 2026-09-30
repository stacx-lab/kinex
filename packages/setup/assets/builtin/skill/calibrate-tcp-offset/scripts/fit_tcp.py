#!/usr/bin/env python3
"""Pivot / touch-point TCP fit.

Every sample is a base→flange pose with the (unknown) tool tip on the SAME
fixed point p:  R_i @ t + o_i = p  for all i. Subtracting pairs eliminates p:
(R_i − R_j) t = o_j − o_i — stacked into one linear least-squares solve for the
flange-local tip translation t.

--samples takes the calib_sample records file (calib/<routine>/samples.json):
each record's data.frame_poses[frame] is the flange pose [x,y,z,qx,qy,qz,qw], NO TCP applied.
Output: {"ok": true, "tcp_translation_m": [x,y,z], "fixed_point_m": [x,y,z],
         "residual_mm": ..., "per_sample_mm": [...], "n": ...}
"""

import argparse
import itertools
import json
import sys

from kinex.geometry import quat_to_mat
from kinex.motion import pose as validate_pose


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def pose_of(sample, frame):
    data = sample.get("data") or {}
    if sample.get("settled") is False:
        fail("sample was not settled")
    try:
        return validate_pose(data.get("frame_poses", {}).get(frame), f"data.frame_poses.{frame}")
    except ValueError as error:
        fail(str(error))



def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", required=True)
    parser.add_argument("--frame", default="flange", help="Declared device frame to fit")
    parser.add_argument("--min-samples", type=int, default=4)
    args = parser.parse_args()

    try:
        import numpy as np
    except ImportError:
        fail("missing deps in the selected interpreter — for core Python use uv add --project <python.project> numpy")

    try:
        samples = json.load(open(args.samples))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"could not read {args.samples}: {error}")
    if len(samples) < args.min_samples:
        fail(f"only {len(samples)} samples (need >= {args.min_samples}, 6-8 recommended)")

    poses = [pose_of(s, args.frame) for s in samples]
    rotations = [np.array(quat_to_mat(pose[3:7])) for pose in poses]
    origins = [np.array(pose[0:3], dtype=np.float64) for pose in poses]

    # Orientation diversity check.
    max_angle = 0.0
    for i, j in itertools.combinations(range(len(rotations)), 2):
        relative = rotations[i].T @ rotations[j]
        angle = float(np.degrees(np.arccos(np.clip((np.trace(relative) - 1) / 2, -1, 1))))
        max_angle = max(max_angle, angle)
    if max_angle < 15:
        fail(f"insufficient orientation diversity (max pairwise rotation {max_angle:.1f} deg — vary the approach angles)")

    rows, rhs = [], []
    for i, j in itertools.combinations(range(len(samples)), 2):
        rows.append(rotations[i] - rotations[j])
        rhs.append(origins[j] - origins[i])
    stacked_rows = np.vstack(rows)
    stacked_rhs = np.concatenate(rhs)
    if np.linalg.matrix_rank(stacked_rows) < 3:
        fail("unobservable TCP offset: vary orientation about more than one axis")
    tcp, *_ = np.linalg.lstsq(stacked_rows, stacked_rhs, rcond=None)

    points = np.array([rotations[i] @ tcp + origins[i] for i in range(len(samples))])
    fixed_point = points.mean(axis=0)
    per_sample = np.linalg.norm(points - fixed_point, axis=1) * 1000

    print(
        json.dumps(
            {
                "ok": True,
                "tcp_translation_m": [float(v) for v in tcp],
                "fixed_point_m": [float(v) for v in fixed_point],
                "residual_mm": round(float(per_sample.mean()), 3),
                "per_sample_mm": [round(float(v), 3) for v in per_sample],
                "n": len(samples),
            }
        )
    )


if __name__ == "__main__":
    main()
