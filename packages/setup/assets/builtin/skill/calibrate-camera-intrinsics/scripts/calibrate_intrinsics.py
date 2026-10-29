#!/usr/bin/env python3
"""Solve camera intrinsics from calibration-target images (cv2.calibrateCamera).

Input: ordered images of a ChArUco board or checkerboard with KNOWN printed square
size (measure it — printers rescale). Output: one JSON object on stdout, where
index is a position in --images:

  {"ok": true, "width": ..., "height": ...,
   "projection": {model,fx,fy,cx,cy,skew}, "distortion": {model,k1,k2,p1,p2,k3}, "rms_px": ...,
   "frames_used": n, "frames": [{index, error_px}], "rejected": [{index, reason}], "coverage_warnings": [...]}
"""

import argparse
import json
import sys


def fail(message: str, **extra) -> None:
    print(json.dumps({"ok": False, "error": message, **extra}))
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", nargs="+", required=True, help="image files in capture order")
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
        fail("Kinex Python lacks opencv-python>=4.7 or numpy; add them to the Kinex Python project")

    square_m = args.square_mm / 1000.0
    if args.board == "charuco":
        marker_m = (args.marker_mm if args.marker_mm else args.square_mm * 0.75) / 1000.0
        try:
            dictionary = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, args.dictionary))
        except AttributeError:
            fail(f"unknown aruco dictionary {args.dictionary}")
        board = cv2.aruco.CharucoBoard((args.squares_x, args.squares_y), square_m, marker_m, dictionary)
        detector = cv2.aruco.CharucoDetector(board)

        def detect(image):
            corners, ids, _, _ = detector.detectBoard(image)
            if ids is None or len(ids) < 6:
                return "fewer than 6 ChArUco corners detected"
            obj, img = board.matchImagePoints(corners, ids)
            if obj is None or len(obj) < 6:
                return "fewer than 6 ChArUco corners matched the board"
            return obj, img
    else:
        pattern = (args.corners_x, args.corners_y)
        template = np.zeros((pattern[0] * pattern[1], 1, 3), np.float32)
        template[:, 0, :2] = np.mgrid[0 : pattern[0], 0 : pattern[1]].T.reshape(-1, 2) * square_m
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3)

        def detect(image):
            found, corners = cv2.findChessboardCorners(image, pattern)
            if not found:
                return "checkerboard not found"
            return template.copy(), cv2.cornerSubPix(image, corners, (11, 11), (-1, -1), criteria)

    size = None
    object_points, image_points, used, rejected = [], [], [], []
    for index, path in enumerate(args.images):
        image = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if image is None:
            rejected.append({"index": index, "reason": "unreadable image"})
            continue
        if size is None:
            size = (image.shape[1], image.shape[0])
        elif (image.shape[1], image.shape[0]) != size:
            fail(f"image {index} has a different resolution than the first image — calibrate one stream at a time")
        points = detect(image)
        if isinstance(points, str):
            rejected.append({"index": index, "reason": points})
            continue
        object_points.append(points[0])
        image_points.append(points[1])
        used.append(index)

    if len(object_points) < args.min_frames:
        fail(
            f"only {len(object_points)} usable detections out of {len(args.images)} images (need >= {args.min_frames}) — "
            "recapture with the board sharp, fully visible, and matching the declared geometry",
            frames_used=len(object_points),
            rejected=rejected,
        )

    rms, camera_matrix, dist, rvecs, tvecs = cv2.calibrateCamera(object_points, image_points, size, None, None)

    frames = []
    for index, obj, img, rvec, tvec in zip(used, object_points, image_points, rvecs, tvecs):
        projected, _ = cv2.projectPoints(obj, rvec, tvec, camera_matrix, dist)
        deltas = img.reshape(-1, 2) - projected.reshape(-1, 2)
        frames.append({"index": index, "error_px": round(float(np.sqrt(np.mean(np.sum(deltas * deltas, axis=1)))), 3)})

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
                "frames_used": len(frames),
                "frames": frames,
                "rejected": rejected,
                "coverage_warnings": warnings,
            }
        )
    )


if __name__ == "__main__":
    main()
