#!/usr/bin/env python3
"""Hand-eye calibration (Tsai-Lenz, pure numpy — no cv2 dependency; OpenCV 5
dropped cv2.calibrateHandEye) over collected pose pairs.

--samples takes the merged pairs file (pairs.json — NOT calib_sample's own
samples.json, which holds raw readings):
  [{"frame_pose": [x,y,z,qx,qy,qz,qw],   # gripper/flange pose in BASE, from a device read
    "rvec": [...], "tvec": [...]},        # board pose in CAMERA frame (detect_board.py)
   ...]

--mode eye_in_hand: camera rides on the flange, board fixed → camera-in-flange.
--mode eye_to_hand: camera fixed, board rides on the gripper → camera-in-base
  (implemented by feeding the INVERTED flange poses to the same AX=XB solver).

Output: {"ok": true, "translation_m": [x,y,z], "rotation_xyzw": [qx,qy,qz,qw], "parent_frame": "flange"|"base",
         "method": "Tsai", "residual_rot_deg": ..., "residual_trans_mm": ..., "pairs_used": n}
"""

import argparse
import json
import sys

from kinex.geometry import mat_to_quat, quat_to_mat


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["eye_in_hand", "eye_to_hand"], required=True)
    parser.add_argument("--samples", required=True)
    parser.add_argument("--device", required=True, help="Canonical joint device frame")
    parser.add_argument("--frame", default="flange", help="Declared moving frame in each sample")
    parser.add_argument("--min-pairs", type=int, default=5)
    args = parser.parse_args()

    try:
        import numpy as np
    except ImportError:
        fail("missing deps in the selected interpreter — for core Python use uv add --project <python.project> numpy")

    def skew(v):
        return np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])

    def rodrigues(v):
        theta = np.linalg.norm(v)
        if theta < 1e-12:
            return np.eye(3)
        k = np.asarray(v) / theta
        K = skew(k)
        return np.eye(3) + np.sin(theta) * K + (1 - np.cos(theta)) * (K @ K)

    def log_rot(R):
        theta = np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))
        if theta < 1e-12:
            return np.zeros(3)
        return theta / (2 * np.sin(theta)) * np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])

    def to_T(R, t):
        T = np.eye(4)
        T[:3, :3], T[:3, 3] = R, np.asarray(t).reshape(-1)
        return T

    try:
        samples = json.load(open(args.samples))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"could not read {args.samples}: {error}")
    if len(samples) < args.min_pairs:
        fail(f"only {len(samples)} pose pairs (need >= {args.min_pairs})")

    grippers, targets = [], []
    for sample in samples:
        pose = sample["frame_pose"]
        T = to_T(np.array(quat_to_mat(pose[3:7])), pose[0:3])
        if args.mode == "eye_to_hand":
            # AX=XB solves camera-in-gripper; feeding base-in-flange (the
            # inverse gripper poses) makes the same equation yield camera-in-base.
            T = np.linalg.inv(T)
        grippers.append(T)
        targets.append(to_T(rodrigues(sample["rvec"]), sample["tvec"]))

    # Relative motions A_ij X = X B_ij between consecutive samples.
    A_list, B_list = [], []
    for i in range(len(samples) - 1):
        A_list.append(np.linalg.inv(grippers[i + 1]) @ grippers[i])
        B_list.append(targets[i + 1] @ np.linalg.inv(targets[i]))

    # Rotation diversity check: near-parallel relative rotations are degenerate.
    max_angle = max(float(np.degrees(np.linalg.norm(log_rot(A[:3, :3])))) for A in A_list)
    if max_angle < 15:
        fail(f"insufficient rotation diversity (max relative rotation {max_angle:.1f} deg — need > 15, ideally > 20)")

    # Tsai-Lenz: rotation from stacked skew(Pa+Pb) x = Pb - Pa.
    S_rows, s_rhs = [], []
    for A, B in zip(A_list, B_list):
        pa, pb = log_rot(A[:3, :3]), log_rot(B[:3, :3])
        Pa = 2 * np.sin(np.linalg.norm(pa) / 2) * (pa / np.linalg.norm(pa)) if np.linalg.norm(pa) > 1e-12 else np.zeros(3)
        Pb = 2 * np.sin(np.linalg.norm(pb) / 2) * (pb / np.linalg.norm(pb)) if np.linalg.norm(pb) > 1e-12 else np.zeros(3)
        S_rows.append(skew(Pa + Pb))
        s_rhs.append(Pb - Pa)
    P_prime, *_ = np.linalg.lstsq(np.vstack(S_rows), np.concatenate(s_rhs), rcond=None)
    P = 2 * P_prime / np.sqrt(1 + np.dot(P_prime, P_prime))
    n2 = np.dot(P, P)
    R_x = (1 - n2 / 2) * np.eye(3) + 0.5 * (np.outer(P, P) + np.sqrt(max(0.0, 4 - n2)) * skew(P))

    # Translation from stacked (Ra - I) t = Rx tb - ta.
    T_rows, t_rhs = [], []
    for A, B in zip(A_list, B_list):
        T_rows.append(A[:3, :3] - np.eye(3))
        t_rhs.append(R_x @ B[:3, 3] - A[:3, 3])
    t_x, *_ = np.linalg.lstsq(np.vstack(T_rows), np.concatenate(t_rhs), rcond=None)
    X = to_T(R_x, t_x)

    # Residual: gripper_i @ X @ target_i (the board in base) should be constant.
    boards = [grippers[i] @ X @ targets[i] for i in range(len(samples))]
    translations = np.array([b[:3, 3] for b in boards])
    trans_residual_mm = float(np.mean(np.linalg.norm(translations - translations.mean(axis=0), axis=1)) * 1000)
    reference = boards[0][:3, :3]
    angles = [float(np.degrees(np.linalg.norm(log_rot(reference.T @ b[:3, :3])))) for b in boards[1:]]
    rot_residual_deg = float(np.mean(angles)) if angles else 0.0

    print(
        json.dumps(
            {
                "ok": True,
                "translation_m": [float(v) for v in t_x],
                "rotation_xyzw": mat_to_quat(R_x),
                "parent_frame": args.frame if args.mode == "eye_in_hand" else args.device,
                "method": "Tsai",
                "residual_rot_deg": round(rot_residual_deg, 3),
                "residual_trans_mm": round(trans_residual_mm, 2),
                "pairs_used": len(samples),
            }
        )
    )


if __name__ == "__main__":
    main()
