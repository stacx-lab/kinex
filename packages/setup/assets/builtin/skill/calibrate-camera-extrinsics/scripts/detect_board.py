#!/usr/bin/env python3
"""Detect the calibration board in one image and solve its pose (solvePnP).

Requires the camera intrinsics (from calibrate-camera-intrinsics). Output: one
JSON object with the board pose in the CAMERA frame:

  {"ok": true, "rvec": [rx,ry,rz], "tvec": [tx,ty,tz], "reproj_px": 0.6, "corners": 31}
"""

import argparse
import json
import sys


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--profile", required=True, help="camera profile.yaml")
    parser.add_argument("--board", choices=["charuco", "checkerboard"], default="charuco")
    parser.add_argument("--squares-x", type=int, default=7)
    parser.add_argument("--squares-y", type=int, default=5)
    parser.add_argument("--square-mm", type=float, required=True)
    parser.add_argument("--marker-mm", type=float, default=None)
    parser.add_argument("--dict", dest="dictionary", default="DICT_4X4_50")
    parser.add_argument("--corners-x", type=int, default=9)
    parser.add_argument("--corners-y", type=int, default=6)
    args = parser.parse_args()

    try:
        import cv2
        import numpy as np
    except ImportError:
        fail('missing deps — python3 -m pip install "opencv-python>=4.7" numpy')

    image = cv2.imread(args.image, cv2.IMREAD_GRAYSCALE)
    if image is None:
        fail(f"could not read {args.image}")
    import yaml
    from kinex.camera import ray
    with open(args.profile) as handle:
        color = yaml.safe_load(handle)["intrinsics"]["color"]
    if (image.shape[1], image.shape[0]) != (color["width"], color["height"]):
        fail("image resolution differs from the camera profile")
    camera_matrix = np.eye(3, dtype=np.float64)
    dist = np.zeros(5, dtype=np.float64)
    square_m = args.square_mm / 1000.0

    if args.board == "charuco":
        marker_m = (args.marker_mm if args.marker_mm else args.square_mm * 0.75) / 1000.0
        dictionary = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, args.dictionary))
        board = cv2.aruco.CharucoBoard((args.squares_x, args.squares_y), square_m, marker_m, dictionary)
        charuco_corners, charuco_ids, _, _ = cv2.aruco.CharucoDetector(board).detectBoard(image)
        if charuco_ids is None or len(charuco_ids) < 6:
            fail(f"board not detected ({0 if charuco_ids is None else len(charuco_ids)} corners) — reposition and retry")
        obj, img = board.matchImagePoints(charuco_corners, charuco_ids)
    else:
        pattern = (args.corners_x, args.corners_y)
        found, corners = cv2.findChessboardCorners(image, pattern)
        if not found:
            fail("checkerboard not detected — reposition and retry")
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3)
        img = cv2.cornerSubPix(image, corners, (11, 11), (-1, -1), criteria)
        obj = np.zeros((pattern[0] * pattern[1], 1, 3), np.float32)
        obj[:, 0, :2] = np.mgrid[0 : pattern[0], 0 : pattern[1]].T.reshape(-1, 2) * square_m

    normalized = np.array([ray(color, float(u), float(v))[:2] for u, v in np.asarray(img).reshape(-1, 2)], dtype=np.float64)
    ok, rvec, tvec = cv2.solvePnP(obj, normalized, camera_matrix, dist)
    if not ok:
        fail("solvePnP failed on the detected corners")
    projected, _ = cv2.projectPoints(obj, rvec, tvec, camera_matrix, dist)
    from kinex.camera import project
    projected_pixels = np.array([project(color, [x, y, 1]) for x, y in projected.reshape(-1, 2)])
    deltas = np.asarray(img).reshape(-1, 2) - projected_pixels
    reproj = float(np.sqrt(np.mean(np.sum(deltas * deltas, axis=1))))
    print(
        json.dumps(
            {
                "ok": True,
                "rvec": [float(v) for v in rvec.reshape(-1)],
                "tvec": [float(v) for v in tvec.reshape(-1)],
                "reproj_px": reproj,
                "corners": int(len(obj)),
            }
        )
    )


if __name__ == "__main__":
    main()
