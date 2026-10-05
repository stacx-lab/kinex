#!/usr/bin/env python3
"""Solve camera intrinsics from calibration-target images (cv2.calibrateCamera).

Input: a glob of images of a ChArUco board or checkerboard with KNOWN printed
square size (measure it — printers rescale). Output: one JSON object on stdout:

  {"ok": true, "width": ..., "height": ...,
   "projection": {model,fx,fy,cx,cy,skew}, "distortion": {model,k1,k2,p1,p2,k3}, "rms_px": ..., "frames_used": n,
   "frames_rejected": m, "per_frame_errors": [...], "coverage_warnings": [...]}
"""

import argparse
import glob
import json
import sys


def fail(message: str, **extra) -> None:
    print(json.dumps({"ok": False, "error": message, **extra}))
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", required=True, help="glob, e.g. 'frames/*.png'")
    parser.add_argument("--board", choices=["charuco", "checkerboard"], default="charuco")
    parser.add_argument("--squares-x", type=int, default=7)
    parser.add_argument("--squares-y", type=int, default=5)
    parser.add_argument("--square-mm", type=float, required=True, help="MEASURED printed square size")
    parser.add_argument("--marker-mm", type=float, default=None, help="charuco marker side (measured)")
    parser.add_argument("--dict", dest="dictionary", default="DICT_4X4_50")
    parser.add_argument("--corners-x", type=int, default=9, help="checkerboard inner corners")
    parser.add_argument("--corners-y", type=int, default=6)
    parser.add_argument("--min-frames", type=int, default=10)
    args = parser.parse_args()

    try:
        import cv2
        import numpy as np
    except ImportError:
        fail('missing deps in the selected interpreter — for core Python use uv add --project <python.project> "opencv-python>=4.7" numpy')

    paths = sorted(glob.glob(args.images))
    if not paths:
        fail(f"no images match {args.images}")

    square_m = args.square_mm / 1000.0
    size = None
    object_points, image_points = [], []
    rejected = 0

    if args.board == "charuco":
        marker_m = (args.marker_mm if args.marker_mm else args.square_mm * 0.75) / 1000.0
        try:
            dictionary = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, args.dictionary))
        except AttributeError:
            fail(f"unknown aruco dictionary {args.dictionary}")
        board = cv2.aruco.CharucoBoard((args.squares_x, args.squares_y), square_m, marker_m, dictionary)
        detector = cv2.aruco.CharucoDetector(board)
        for path in paths:
            image = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            if image is None:
                rejected += 1
                continue
            if size is None:
                size = (image.shape[1], image.shape[0])
            elif (image.shape[1], image.shape[0]) != size:
                fail(f"{path} has a different resolution than the first frame — calibrate one stream at a time")
            charuco_corners, charuco_ids, _, _ = detector.detectBoard(image)
            if charuco_ids is None or len(charuco_ids) < 6:
                rejected += 1
                continue
            obj, img = board.matchImagePoints(charuco_corners, charuco_ids)
            if obj is None or len(obj) < 6:
                rejected += 1
                continue
            object_points.append(obj)
            image_points.append(img)
    else:
        pattern = (args.corners_x, args.corners_y)
        template = np.zeros((pattern[0] * pattern[1], 1, 3), np.float32)
        grid = np.mgrid[0 : pattern[0], 0 : pattern[1]].T.reshape(-1, 2)
        template[:, 0, :2] = grid * square_m
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3)
        for path in paths:
            image = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            if image is None:
                rejected += 1
                continue
            if size is None:
                size = (image.shape[1], image.shape[0])
            found, corners = cv2.findChessboardCorners(image, pattern)
            if not found:
                rejected += 1
                continue
            corners = cv2.cornerSubPix(image, corners, (11, 11), (-1, -1), criteria)
            object_points.append(template.copy())
            image_points.append(corners)

    if len(object_points) < args.min_frames:
        fail(
            f"only {len(object_points)} usable detections out of {len(paths)} images (need >= {args.min_frames}) — "
            "recapture with the board sharp, fully visible, and matching the declared geometry",
            frames_used=len(object_points),
            frames_rejected=rejected,
        )

    rms, camera_matrix, dist, rvecs, tvecs = cv2.calibrateCamera(object_points, image_points, size, None, None)

    per_frame = []
    for i in range(len(object_points)):
        projected, _ = cv2.projectPoints(object_points[i], rvecs[i], tvecs[i], camera_matrix, dist)
        deltas = image_points[i].reshape(-1, 2) - projected.reshape(-1, 2)
        per_frame.append(float(np.sqrt(np.mean(np.sum(deltas * deltas, axis=1)))))

    # Coverage: warn when no detections land in a quadrant of the image.
    warnings = []
    quadrants = [0, 0, 0, 0]
    for pts in image_points:
        for pt in pts.reshape(-1, 2):
            quadrants[(2 if pt[1] > size[1] / 2 else 0) + (1 if pt[0] > size[0] / 2 else 0)] += 1
    names = ["top-left", "top-right", "bottom-left", "bottom-right"]
    for name, count in zip(names, quadrants):
        if count == 0:
            warnings.append(f"no samples in the {name} quadrant — distortion is unconstrained there")

    print(
        json.dumps(
            {
                "ok": True,
                "width": size[0],
                "height": size[1],
                "projection": {"model": "pinhole", "fx": float(camera_matrix[0, 0]),
                               "fy": float(camera_matrix[1, 1]), "cx": float(camera_matrix[0, 2]),
                               "cy": float(camera_matrix[1, 2]), "skew": 0.0},
                "distortion": {"model": "opencv_brown_conrady",
                               **dict(zip(("k1", "k2", "p1", "p2", "k3"), map(float, dist.reshape(-1)[:5])))},
                "rms_px": float(rms),
                "frames_used": len(object_points),
                "frames_rejected": rejected,
                "per_frame_errors": [round(v, 3) for v in per_frame],
                "coverage_warnings": warnings,
            }
        )
    )


if __name__ == "__main__":
    main()
