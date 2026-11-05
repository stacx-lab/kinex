"""Write synthetic stereo calibration evidence: fisheye board images and hand-eye pairs."""
import json
from pathlib import Path
import sys

import cv2
import numpy as np

from kinex.lib.geometry import mat_to_quat


def transform(rotation, translation):
    result = np.eye(4)
    result[:3, :3], result[:3, 3] = cv2.Rodrigues(np.array(rotation, dtype=float))[0], translation
    return result


def images(directory, rng):
    matrix = np.array([[350., 0., 319.5], [0., 355., 239.5], [0., 0., 1.]])
    pixels = np.indices((480, 640))[::-1].transpose(1, 2, 0).astype(float).reshape(-1, 1, 2)
    normalized = cv2.fisheye.undistortPoints(pixels, matrix, np.zeros(4)).reshape(-1, 2)
    rays = np.column_stack((normalized, np.ones(len(normalized))))
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    texture = cv2.aruco.CharucoBoard((7, 5), .03, .0225, dictionary).generateImage((700, 500))
    for i in range(16):
        rotation = cv2.Rodrigues(rng.uniform(-.45, .45, 3))[0]
        origin = -rotation.T @ np.array([rng.uniform(-.17, -.04), rng.uniform(-.13, -.02), rng.uniform(.28, .46)])
        directions = rays @ rotation
        points = origin + directions * (-origin[2] / directions[:, 2, None])
        mapping = (points[:, :2] / .03 * 100).reshape(480, 640, 2).astype(np.float32)
        cv2.imwrite(str(directory / f"{i}.png"), cv2.remap(texture, mapping, None, cv2.INTER_LINEAR,
                                                            borderMode=cv2.BORDER_CONSTANT, borderValue=180))


def pairs(camera_in_flange, rng):
    board_in_base = transform([.1, -.2, .3], [.6, .1, .05])
    rows = []
    for _ in range(12):
        flange = transform(rng.uniform(-.7, .7, 3), rng.uniform(-.2, .2, 3) + [.4, 0, .4])
        board_in_camera = np.linalg.inv(camera_in_flange) @ np.linalg.inv(flange) @ board_in_base
        rows.append({"frame_pose": [*flange[:3, 3], *mat_to_quat(flange[:3, :3])],
                     "rvec": cv2.Rodrigues(board_in_camera[:3, :3])[0].reshape(-1).tolist(),
                     "tvec": board_in_camera[:3, 3].tolist()})
    return rows


def stereo_pairs(mode, mount, partner, board, rng, biased=False):
    """Observations of a known rig; each eye sees the board from a pose in front of it."""
    grid = np.array([[x * .03, y * .03, 0] for x in range(7) for y in range(5)]) - [.09, .06, 0]
    rows = []
    for index in range(12):
        board_in_reference = transform(rng.uniform(-.6, .6, 3), [rng.uniform(-.05, .05), rng.uniform(-.05, .05), rng.uniform(.3, .6)])
        # eye_in_hand: reference = mount^-1 pose^-1 board. eye_to_hand uses the inverse pose.
        link = board @ np.linalg.inv(board_in_reference) @ np.linalg.inv(mount)
        pose = np.linalg.inv(link) if mode == "eye_to_hand" else link
        row = {"frame_pose": [*pose[:3, 3], *mat_to_quat(pose[:3, :3])]}
        for eye, seen in (("left", board_in_reference), ("right", np.linalg.inv(partner) @ board_in_reference)):
            points = grid @ seen[:3, :3].T + seen[:3, 3]
            rays = points / points[:, 2, None]
            rays[:, :2] += rng.normal(0, 2e-4, (len(rays), 2))
            if biased and eye == "right":
                rays[:, 0] += .05 * (index % 2)
            row[eye] = {"object_points": grid.tolist(), "rays": rays.tolist()}
        rows.append(row)
    return rows


directory = Path(sys.argv[1])
rng = np.random.default_rng(7)
images(directory, rng)
(directory / "pairs.json").write_text(json.dumps(pairs(transform([0, 0, .3], [.03, -.06, .05]), rng), default=float))
rig = transform([.1, -.2, .3], [.03, -.06, .05]), transform([0, .05, 0], [.06, 0, 0]), transform([.1, .2, -.1], [.6, .1, .05])
for name, mode, biased in (("in_hand", "eye_in_hand", False), ("to_hand", "eye_to_hand", False), ("biased", "eye_in_hand", True)):
    (directory / f"stereo_{name}.json").write_text(json.dumps(stereo_pairs(mode, *rig, rng, biased), default=float))
