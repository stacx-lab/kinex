"""Tool-tip translation from pivot touches of one fixed point."""
import itertools

import numpy as np

import kinex
from kinex.common.geometry import quat_to_mat
from kinex.lib.calibration import CalibrationError


def fit(run, frame):
    """The bound target tool's frames.tcp translation in its base, from the run's arm samples.

    Take each sample with run.sample(arm, frame=frame) while the tip rests on the same fixed
    point at another orientation: at least 4, spanning more than 15 degrees about more than
    one axis. The target needs a known mount in that link. Mean residual < 5 mm passes,
    5-10 mm warns and > 10 mm fails. Pivoting measures no rotation: the proposal keeps the
    known tcp rotation, or ???.

    Example: result = lib.calibration.tcp.fit(run, "flange")
    """
    arm, target = run.role("arm"), run.role("target")
    tool = kinex.profile(target)
    mount, tcp = tool["frames"].get("base", {}), tool["frames"].get("tcp")
    if mount.get("parent") != f"{arm}:{frame}" or not all(isinstance(mount.get(key), list) for key in ("translation_m", "rotation_xyzw")):
        raise ValueError(f"TCP fitting requires a known mount of {target} in {arm}:{frame}")
    if tcp and tcp["parent"] != f"{target}:base":
        raise ValueError("TCP fitting requires tcp to be relative to the end-effector base")
    samples = run.samples(arm)

    def solve():
        if len(samples) < 4:
            raise CalibrationError(f"only {len(samples)} samples (need >= 4, 6-8 recommended)")
        for sample in samples:
            if sample.get("settled") is False:
                raise CalibrationError(f"sample {sample['index']} was not settled")
            if sample.get("kinematics", {}).get("frame") != frame:
                raise CalibrationError(f"sample {sample['index']} has no {frame} pose")
        poses = [sample["kinematics"]["pose"] for sample in samples]
        rotations = [np.array(quat_to_mat(pose[3:])) for pose in poses]
        origins = [np.array(pose[:3]) for pose in poses]
        pairs = list(itertools.combinations(range(len(poses)), 2))
        spread = max(np.degrees(np.arccos(np.clip((np.trace(rotations[i].T @ rotations[j]) - 1) / 2, -1, 1))) for i, j in pairs)
        if spread < 15:
            raise CalibrationError(f"insufficient orientation diversity (max pairwise rotation {spread:.1f} deg); vary the approach angles")
        # Every touch puts the tip on one point p: R_i t + o_i = p, so (R_i - R_j) t = o_j - o_i.
        rows = np.vstack([rotations[i] - rotations[j] for i, j in pairs])
        if np.linalg.matrix_rank(rows) < 3:
            raise CalibrationError("unobservable TCP offset: vary orientation about more than one axis")
        tip, *_ = np.linalg.lstsq(rows, np.concatenate([origins[j] - origins[i] for i, j in pairs]), rcond=None)
        points = np.array([rotation @ tip + origin for rotation, origin in zip(rotations, origins)])
        fixed = points.mean(axis=0)
        residual = np.linalg.norm(points - fixed, axis=1) * 1000
        in_base = np.array(quat_to_mat(mount["rotation_xyzw"])).T @ (tip - mount["translation_m"])
        return {"tcp_translation_m": in_base.tolist(), "fixed_point_m": fixed.tolist(), "residual_mm": round(float(residual.mean()), 3),
                "per_sample_mm": [round(float(value), 3) for value in residual], "n": len(samples)}

    def quality(data):
        return "failed" if data["n"] < 4 or data["residual_mm"] > 10 else "passed" if data["residual_mm"] < 5 else "warning"

    def facts(data):
        edge = {"parent": f"{target}:base", "translation_m": data["tcp_translation_m"], "rotation_xyzw": tcp["rotation_xyzw"] if tcp else "???"}
        return "tcp_pivot", {"frames": {"tcp": edge}}, [("/frames/tcp/translation_m", edge["translation_m"])]

    return run._solve("fit-tcp", solve, quality, facts, ["TCP orientation is not measured by pivot calibration"])
