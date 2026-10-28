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
    parser.add_argument("--profile", required=True, help="camera stream dimensions")
    parser.add_argument("--rays", help="archived unproject response rays for detected corners")
    parser.add_argument("--projected", help="archived projected pixels for fitted camera points")
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
        fail("Kinex Python lacks opencv-python>=4.7 or numpy; add them to the Kinex Python project")

    image = cv2.imread(args.image, cv2.IMREAD_GRAYSCALE)
    if image is None:
        fail(f"could not read {args.image}")
    import yaml
    with open(args.profile) as handle:
        color = yaml.safe_load(handle)["color"]
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

    pixels = np.asarray(img).reshape(-1, 2)
    if not args.rays:
        print(json.dumps({"pixels": pixels.tolist(), "object_points": obj.reshape(-1, 3).tolist()}))
        return
    with open(args.rays) as handle:
        directions = np.asarray(json.load(handle)["rays"], dtype=float)
    if directions.shape != (len(pixels), 3) or not np.isfinite(directions).all() or not np.allclose(directions[:, 2], 1):
        fail("archived rays must match every detected corner and have Z=1")
    ok, rvec, tvec = cv2.solvePnP(obj, directions[:, :2].copy(), camera_matrix, dist)
    if not ok:
        fail("solvePnP failed on the detected corners")
    camera_points = obj.reshape(-1, 3) @ cv2.Rodrigues(rvec)[0].T + tvec.reshape(3)
    if not args.projected:
        print(json.dumps({"camera_points": camera_points.tolist(), "rvec": rvec.flatten().tolist(), "tvec": tvec.flatten().tolist()}))
        return
    with open(args.projected) as handle:
        projected_pixels = np.asarray(json.load(handle)["pixels"], dtype=float)
    if projected_pixels.shape != pixels.shape or not np.isfinite(projected_pixels).all():
        fail("archived projection must match every detected corner")
    reproj = float(np.sqrt(np.mean(np.sum((pixels - projected_pixels)**2, axis=1))))
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
