"""Hand-eye calibration (Tsai-Lenz, NumPy only) and the joint stereo solve over board views."""
import numpy as np

from kinex.common.geometry import mat_to_quat, quat_to_mat
from kinex.lib.calibration import CalibrationError


def _skew(v):
    return np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])


def _rodrigues(v):
    theta = np.linalg.norm(v)
    if theta < 1e-12:
        return np.eye(3)
    K = _skew(np.asarray(v) / theta)
    return np.eye(3) + np.sin(theta) * K + (1 - np.cos(theta)) * (K @ K)


def _log(R):
    theta = np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))
    if theta < 1e-12:
        return np.zeros(3)
    return theta / (2 * np.sin(theta)) * np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])


def _matrix(R, t):
    T = np.eye(4)
    T[:3, :3], T[:3, 3] = R, np.asarray(t).reshape(-1)
    return T


def _link(pose, mode):
    """The link pose in the arm base; eye_to_hand uses base-in-link, so AX=XB gives camera-in-base."""
    T = _matrix(np.array(quat_to_mat(pose[3:7])), pose[:3])
    return np.linalg.inv(T) if mode == "eye_to_hand" else T


def tsai(views, mode, min_pairs=5):
    """The camera in the link (eye_in_hand) or in the arm base (eye_to_hand) from
    [{frame_pose, rvec, tvec}] views of a board fixed in the other frame."""
    if len(views) < min_pairs:
        raise CalibrationError(f"only {len(views)} pose pairs (need >= {min_pairs})")
    links = [_link(view["frame_pose"], mode) for view in views]
    boards = [_matrix(_rodrigues(view["rvec"]), view["tvec"]) for view in views]
    # Relative motions A_ij X = X B_ij between consecutive views.
    A = [np.linalg.inv(links[i + 1]) @ links[i] for i in range(len(views) - 1)]
    B = [boards[i + 1] @ np.linalg.inv(boards[i]) for i in range(len(views) - 1)]
    spread = max(float(np.degrees(np.linalg.norm(_log(a[:3, :3])))) for a in A)
    if spread < 15:
        raise CalibrationError(f"insufficient rotation diversity (max relative rotation {spread:.1f} deg; need > 15, ideally > 20)")

    def axis(R):
        p = _log(R)
        norm = np.linalg.norm(p)
        return 2 * np.sin(norm / 2) * p / norm if norm > 1e-12 else np.zeros(3)
    rows = [(_skew(axis(a[:3, :3]) + axis(b[:3, :3])), axis(b[:3, :3]) - axis(a[:3, :3])) for a, b in zip(A, B)]
    P_prime, *_ = np.linalg.lstsq(np.vstack([row for row, _ in rows]), np.concatenate([rhs for _, rhs in rows]), rcond=None)
    P = 2 * P_prime / np.sqrt(1 + P_prime @ P_prime)
    n2 = P @ P
    R = (1 - n2 / 2) * np.eye(3) + .5 * (np.outer(P, P) + np.sqrt(max(0., 4 - n2)) * _skew(P))
    t, *_ = np.linalg.lstsq(np.vstack([a[:3, :3] - np.eye(3) for a in A]), np.concatenate([R @ b[:3, 3] - a[:3, 3] for a, b in zip(A, B)]), rcond=None)
    X = _matrix(R, t)
    # The board in the fixed frame should be the same in every view.
    fixed = [link @ X @ board for link, board in zip(links, boards)]
    translations = np.array([T[:3, 3] for T in fixed])
    angles = [float(np.degrees(np.linalg.norm(_log(fixed[0][:3, :3].T @ T[:3, :3])))) for T in fixed[1:]]
    return {"translation_m": t.tolist(), "rotation_xyzw": mat_to_quat(R.tolist()), "method": "Tsai",
            "residual_rot_deg": round(float(np.mean(angles)) if angles else 0., 3),
            "residual_trans_mm": round(float(np.mean(np.linalg.norm(translations - translations.mean(axis=0), axis=1)) * 1000), 2),
            "pairs_used": len(views)}


def stereo(views, mode, reference, between=None, min_pairs=5):
    """A rigid stereo pair: its mount (robot modes), its eye-to-eye transform, or both.

    views hold {frame_pose?, left: {object_points, rays}, right: {...}}. Both eyes constrain
    one model, so the eye-to-eye transform does not inherit two independent hand-eye errors.
    Residuals are angles between observed rays and predicted board directions, so any lens
    model works. mode "eyes" has no robot: every view has its own board pose. between holds
    the other eye in the reference eye as {translation_m, rotation_xyzw}; robot modes only.
    """
    from scipy.optimize import least_squares
    from scipy.spatial.transform import Rotation
    robot = mode != "eyes"
    if between is not None and not robot:
        raise ValueError("a known eye-to-eye transform applies only to robot modes")

    def T(rotation, translation):
        return _matrix(rotation.as_matrix(), translation)

    def unpack6(values):
        return T(Rotation.from_rotvec(values[:3]), values[3:])

    def pack6(M):
        return np.concatenate((Rotation.from_matrix(M[:3, :3]).as_rotvec(), M[:3, 3]))

    def mean(transforms):
        return T(Rotation.from_matrix([M[:3, :3] for M in transforms]).mean(), np.mean([M[:3, 3] for M in transforms], axis=0))

    def observation(view, eye, index):
        points, rays = np.asarray(view[eye]["object_points"], dtype=float), np.asarray(view[eye]["rays"], dtype=float)
        if points.ndim != 2 or points.shape[1] != 3 or rays.shape != points.shape or len(points) < 6:
            raise ValueError(f"view {index} {eye}: need at least 6 matching object points and rays")
        if not np.isfinite(points).all() or not np.isfinite(rays).all() or not np.allclose(rays[:, 2], 1):
            raise ValueError(f"view {index} {eye}: exclude invalid geometry results; rays must be finite with Z=1")
        return points, rays, rays / np.linalg.norm(rays, axis=1, keepdims=True)

    links = [_link(view["frame_pose"], mode) for view in views] if robot else []
    seen = [{eye: observation(view, eye, index) for eye in ("left", "right")} for index, view in enumerate(views)]
    fixed = None if between is None else T(Rotation.from_quat(between["rotation_xyzw"]), np.asarray(between["translation_m"], dtype=float))
    if len(seen) < min_pairs:
        raise CalibrationError(f"only {len(seen)} stereo views (need >= {min_pairs})")
    partner = "right" if reference == "left" else "left"
    import cv2
    boards = {}
    for eye in (reference, partner):
        boards[eye] = []
        for view in seen:
            points, rays, _ = view[eye]
            solved, rvec, tvec = cv2.solvePnP(points, rays[:, :2].copy(), np.eye(3), np.zeros(5))
            if not solved:
                raise CalibrationError("solvePnP failed while initializing the board poses")
            boards[eye].append(T(Rotation.from_rotvec(rvec.reshape(3)), tvec.reshape(3)))
    other = fixed if fixed is not None else mean([ref @ np.linalg.inv(o) for ref, o in zip(boards[reference], boards[partner])])
    if robot:
        # Initialize AX=XB from rotation axes, then the board in the fixed frame.
        motions = [(np.linalg.inv(links[i + 1]) @ links[i], boards[reference][i + 1] @ np.linalg.inv(boards[reference][i])) for i in range(len(seen) - 1)]
        axes = np.array([Rotation.from_matrix(a[:3, :3]).as_rotvec() for a, _ in motions])
        if np.degrees(np.linalg.norm(axes, axis=1).max()) < 15:
            raise CalibrationError("insufficient rotation diversity (need a relative rotation > 15 deg, ideally > 20)")
        rotation, _ = Rotation.align_vectors(axes, [Rotation.from_matrix(b[:3, :3]).as_rotvec() for _, b in motions])
        translation, *_ = np.linalg.lstsq(np.vstack([a[:3, :3] - np.eye(3) for a, _ in motions]),
                                          np.concatenate([rotation.as_matrix() @ b[:3, 3] - a[:3, 3] for a, b in motions]), rcond=None)
        mount = T(rotation, translation)
        board = mean([link @ mount @ ref for link, ref in zip(links, boards[reference])])
        start = [pack6(mount), pack6(board)] + ([] if fixed is not None else [pack6(other)])
    else:
        start = [pack6(other)] + [pack6(ref) for ref in boards[reference]]

    def unpack(values):
        """The other eye in the reference eye, and the board in the reference eye per view."""
        if not robot:
            return unpack6(values[:6]), [unpack6(values[i:i + 6]) for i in range(6, len(values), 6)]
        mount, board = unpack6(values[:6]), unpack6(values[6:12])
        return (fixed if fixed is not None else unpack6(values[12:18])), [np.linalg.inv(mount) @ np.linalg.inv(link) @ board for link in links]

    def chords(view, to_reference, other):
        result = {}
        for eye, M in ((reference, to_reference), (partner, np.linalg.inv(other) @ to_reference)):
            points, _, directions = view[eye]
            predicted = points @ M[:3, :3].T + M[:3, 3]
            result[eye] = predicted / np.linalg.norm(predicted, axis=1, keepdims=True) - directions
        return result

    def residuals(values):
        other, references = unpack(values)
        return np.concatenate([part.ravel() for view, ref in zip(seen, references) for part in chords(view, ref, other).values()])

    # Half a degree separates ordinary corner noise from outliers on the unit sphere.
    solved = least_squares(residuals, np.concatenate(start), loss="soft_l1", f_scale=np.radians(.5), x_scale="jac", max_nfev=200)
    if not solved.success or not np.isfinite(solved.x).all():
        raise CalibrationError(f"optimization did not converge: {solved.message}")
    other, references = unpack(solved.x)
    angles, per_view = {"left": [], "right": []}, []
    for index, (view, ref) in enumerate(zip(seen, references)):
        row = {"index": index}
        for eye, chord in chords(view, ref, other).items():
            angle = np.degrees(2 * np.arcsin(np.clip(np.linalg.norm(chord, axis=1) / 2, 0, 1)))
            angles[eye].append(angle)
            row[f"{eye}_deg"] = round(float(np.sqrt(np.mean(angle ** 2))), 4)
        per_view.append(row)

    def rms(values):
        return float(np.sqrt(np.mean(np.concatenate(values) ** 2)))

    def written(values):
        return [float(v) for v in values[3:]], [float(v) for v in Rotation.from_rotvec(values[:3]).as_quat()]
    mount = dict(zip(("translation_m", "rotation_xyzw"), written(solved.x[:6]))) if robot else {}
    partner_translation, partner_rotation = written(pack6(other))
    return {**mount, "partner_translation_m": partner_translation, "partner_rotation_xyzw": partner_rotation,
            "baseline_m": float(np.linalg.norm(partner_translation)), "residual_deg": round(rms(angles["left"] + angles["right"]), 4),
            "eye_residual_deg": {eye: round(rms(values), 4) for eye, values in angles.items()}, "views": per_view, "pairs_used": len(seen)}
