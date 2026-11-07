#!/usr/bin/env python3
"""Solve a rigid stereo pair: its robot mount, its eye-to-eye transform, or both.

Both eyes constrain one model, so the eye-to-eye transform does not inherit two
independent hand-eye errors. Residuals are angles between archived node-geometry
rays and predicted board directions, so any lens model works without lens equations.

--samples takes one entry per stationary view, with both eyes observing the board
(board_observations.py writes it):
  [{"frame_pose": [x,y,z,qx,qy,qz,qw],     # --frame link pose in the arm base, from FK
    "left":  {"object_points": [[X,Y,Z],...], "rays": [[x,y,1],...]},
    "right": {"object_points": [[X,Y,Z],...], "rays": [[x,y,1],...]}},
   ...]

--mode eye_in_hand: board fixed, cameras on the --frame link -> reference eye in that link.
--mode eye_to_hand: cameras fixed, board on the --frame link -> reference eye in the arm base.
--mode eyes: no robot; each view has its own board pose and frame_pose is unused.
--between holds the other eye in the reference eye fixed ({translation_m, rotation_xyzw}),
  for factory or previously solved eye-to-eye transforms; robot modes only.

Output: {"ok": true, "translation_m": [...], "rotation_xyzw": [...],      # reference eye mount (robot modes)
         "partner_translation_m": [...], "partner_rotation_xyzw": [...],  # other eye in reference eye
         "baseline_m": ..., "residual_deg": ..., "eye_residual_deg": {"left": ..., "right": ...},
         "views": [{"index": i, "left_deg": ..., "right_deg": ...}], "pairs_used": n}
"""

import argparse
import json
import sys


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["eye_in_hand", "eye_to_hand", "eyes"], required=True)
    parser.add_argument("--samples", required=True)
    parser.add_argument("--reference", choices=["left", "right"], required=True)
    parser.add_argument("--between", help="fixed other-eye pose in the reference eye, as JSON")
    parser.add_argument("--min-pairs", type=int, default=5)
    args = parser.parse_args()
    robot = args.mode != "eyes"
    if args.between and not robot:
        fail("--between applies only to robot modes; eyes mode solves the eye-to-eye transform")

    try:
        import cv2
        import numpy as np
        from scipy.optimize import least_squares
        from scipy.spatial.transform import Rotation
    except ImportError:
        fail("Kinex Python lacks opencv-python>=4.7, numpy or scipy; add them to the Kinex Python project")

    def to_T(rotation, translation):
        T = np.eye(4)
        T[:3, :3], T[:3, 3] = rotation.as_matrix(), translation
        return T

    def from_parameters(values):
        return to_T(Rotation.from_rotvec(values[:3]), values[3:])

    def to_parameters(T):
        return np.concatenate((Rotation.from_matrix(T[:3, :3]).as_rotvec(), T[:3, 3]))

    def mean_T(transforms):
        return to_T(Rotation.from_matrix([T[:3, :3] for T in transforms]).mean(), np.mean([T[:3, 3] for T in transforms], axis=0))

    def observation(sample, eye, index):
        points = np.asarray(sample[eye]["object_points"], dtype=float)
        rays = np.asarray(sample[eye]["rays"], dtype=float)
        if points.ndim != 2 or points.shape[1] != 3 or rays.shape != points.shape or len(points) < 6:
            fail(f"sample {index} {eye}: need at least 6 matching object points and rays")
        if not np.isfinite(points).all() or not np.isfinite(rays).all() or not np.allclose(rays[:, 2], 1):
            fail(f"sample {index} {eye}: exclude invalid geometry results; rays must be finite with Z=1")
        return points, rays, rays / np.linalg.norm(rays, axis=1, keepdims=True)

    try:
        with open(args.samples) as handle:
            samples = json.load(handle)
        grippers, views = [], []
        for index, sample in enumerate(samples):
            if robot:
                pose = np.asarray(sample["frame_pose"], dtype=float)
                T = to_T(Rotation.from_quat(pose[3:7]), pose[:3])
                # Base-in-link makes the eye-to-hand equations yield a camera in the arm base.
                grippers.append(np.linalg.inv(T) if args.mode == "eye_to_hand" else T)
            views.append({eye: observation(sample, eye, index) for eye in ("left", "right")})
        fixed = None
        if args.between:
            edge = json.loads(args.between)
            fixed = to_T(Rotation.from_quat(edge["rotation_xyzw"]), np.asarray(edge["translation_m"], dtype=float))
    except (OSError, ValueError, KeyError, TypeError) as error:
        fail(f"could not read {args.samples}: {error}")
    if len(views) < args.min_pairs:
        fail(f"only {len(views)} stereo views (need >= {args.min_pairs})")

    partner = "right" if args.reference == "left" else "left"
    boards = {}
    for eye in (args.reference, partner):
        boards[eye] = []
        for view in views:
            points, rays, _ = view[eye]
            solved, rvec, tvec = cv2.solvePnP(points, rays[:, :2].copy(), np.eye(3), np.zeros(5))
            if not solved:
                fail("solvePnP failed while initializing the board poses")
            boards[eye].append(to_T(Rotation.from_rotvec(rvec.reshape(3)), tvec.reshape(3)))
    between = fixed if fixed is not None else mean_T([ref @ np.linalg.inv(other) for ref, other in zip(boards[args.reference], boards[partner])])

    if robot:
        # Initialize AX=XB from rotation axes, then the board in the fixed frame.
        motions = [(np.linalg.inv(grippers[i + 1]) @ grippers[i], boards[args.reference][i + 1] @ np.linalg.inv(boards[args.reference][i]))
                   for i in range(len(views) - 1)]
        robot_axes = np.array([Rotation.from_matrix(A[:3, :3]).as_rotvec() for A, _ in motions])
        if np.degrees(np.linalg.norm(robot_axes, axis=1).max()) < 15:
            fail("insufficient rotation diversity (need a relative rotation > 15 deg, ideally > 20)")
        rotation, _ = Rotation.align_vectors(robot_axes, [Rotation.from_matrix(B[:3, :3]).as_rotvec() for _, B in motions])
        translation, *_ = np.linalg.lstsq(np.vstack([A[:3, :3] - np.eye(3) for A, _ in motions]),
                                          np.concatenate([rotation.as_matrix() @ B[:3, 3] - A[:3, 3] for A, B in motions]), rcond=None)
        mount = to_T(rotation, translation)
        board = mean_T([gripper @ mount @ ref for gripper, ref in zip(grippers, boards[args.reference])])
        start = [to_parameters(mount), to_parameters(board)] + ([] if fixed is not None else [to_parameters(between)])
    else:
        start = [to_parameters(between)] + [to_parameters(ref) for ref in boards[args.reference]]

    def unpack(values):
        """The other eye in the reference eye, and the board in the reference eye per view."""
        if not robot:
            return from_parameters(values[:6]), [from_parameters(values[i:i + 6]) for i in range(6, len(values), 6)]
        mount, board = from_parameters(values[:6]), from_parameters(values[6:12])
        other = fixed if fixed is not None else from_parameters(values[12:18])
        return other, [np.linalg.inv(mount) @ np.linalg.inv(gripper) @ board for gripper in grippers]

    def chords(view, to_reference, other):
        result = {}
        for eye, T in ((args.reference, to_reference), (partner, np.linalg.inv(other) @ to_reference)):
            points, _, directions = view[eye]
            predicted = points @ T[:3, :3].T + T[:3, 3]
            result[eye] = predicted / np.linalg.norm(predicted, axis=1, keepdims=True) - directions
        return result

    def residuals(values):
        other, references = unpack(values)
        return np.concatenate([part.ravel() for view, reference in zip(views, references) for part in chords(view, reference, other).values()])

    # Half a degree separates ordinary corner noise from outliers on the unit sphere.
    solved = least_squares(residuals, np.concatenate(start), loss="soft_l1", f_scale=np.radians(.5), x_scale="jac", max_nfev=200)
    if not solved.success or not np.isfinite(solved.x).all():
        fail(f"optimization did not converge: {solved.message}")

    other, references = unpack(solved.x)
    angles = {"left": [], "right": []}
    per_view = []
    for index, (view, reference) in enumerate(zip(views, references)):
        row = {"index": index}
        for eye, chord in chords(view, reference, other).items():
            angle = np.degrees(2 * np.arcsin(np.clip(np.linalg.norm(chord, axis=1) / 2, 0, 1)))
            angles[eye].append(angle)
            row[f"{eye}_deg"] = round(float(np.sqrt(np.mean(angle ** 2))), 4)
        per_view.append(row)
    rms = lambda values: float(np.sqrt(np.mean(np.concatenate(values) ** 2)))
    pose = lambda values: ([float(v) for v in values[3:]], [float(v) for v in Rotation.from_rotvec(values[:3]).as_quat()])
    mount = dict(zip(("translation_m", "rotation_xyzw"), pose(solved.x[:6]))) if robot else {}
    partner_translation, partner_rotation = pose(to_parameters(other))
    print(json.dumps({
        "ok": True, **mount, "partner_translation_m": partner_translation, "partner_rotation_xyzw": partner_rotation,
        "baseline_m": float(np.linalg.norm(partner_translation)), "residual_deg": round(rms(angles["left"] + angles["right"]), 4),
        "eye_residual_deg": {eye: round(rms(values), 4) for eye, values in angles.items()},
        "views": per_view, "pairs_used": len(views),
    }))


if __name__ == "__main__":
    main()
