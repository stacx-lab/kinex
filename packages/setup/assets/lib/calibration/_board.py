"""Calibration-board detection and the pairing of camera captures with arm poses."""
import os

import numpy as np


def detector(board, square_mm, squares, marker_mm, dictionary, corners):
    """A function from a grayscale image to (object points Nx1x3, pixels Nx1x2) in float32,
    or the reason the board was not found. square_mm and marker_mm are measured prints."""
    import cv2
    square = square_mm / 1000
    if board == "charuco":
        if not hasattr(cv2.aruco, dictionary):
            raise ValueError(f"unknown aruco dictionary {dictionary}")
        target = cv2.aruco.CharucoBoard(tuple(squares), square, (marker_mm or square_mm * .75) / 1000,
                                        cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, dictionary)))
        charuco = cv2.aruco.CharucoDetector(target)

        def detect(image):
            found, ids, _, _ = charuco.detectBoard(image)
            if ids is None or len(ids) < 6:
                return f"board not detected ({0 if ids is None else len(ids)} corners)"
            points, pixels = target.matchImagePoints(found, ids)
            if points is None or len(points) < 6:
                return "fewer than 6 corners matched the board"
            return points.astype(np.float32), pixels.astype(np.float32)
        return detect
    if board != "checkerboard":
        raise ValueError("board is charuco or checkerboard")
    template = np.zeros((corners[0] * corners[1], 1, 3), np.float32)
    template[:, 0, :2] = np.mgrid[0:corners[0], 0:corners[1]].T.reshape(-1, 2) * square
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3)

    def detect(image):
        found, pixels = cv2.findChessboardCorners(image, tuple(corners))
        if not found:
            return "checkerboard not detected"
        return template.copy(), cv2.cornerSubPix(image, pixels, (11, 11), (-1, -1), criteria)
    return detect


def pair(samples, camera, arm, frame):
    """(camera sample, arm sample or None) per view, plus rejections. Without an arm every
    camera sample is a view; otherwise the last capture after a settled arm pose is."""
    if arm is None:
        return [(sample, None) for sample in samples if sample["device"] == camera], []
    views, rejected = [], []
    posed = view = None
    for sample in samples:
        if sample["device"] == arm:
            if view is not None:
                views.append((view, posed))
            view = posed = None
            if sample.get("kinematics", {}).get("frame") != frame:
                rejected.append({"index": sample["index"], "reason": f"arm sample has no {frame} pose"})
            elif sample.get("settled") is False:
                rejected.append({"index": sample["index"], "reason": "arm did not settle"})
            else:
                posed = sample
        elif sample["device"] == camera:
            if posed is None:
                rejected.append({"index": sample["index"], "reason": "no settled arm sample before this capture"})
                continue
            if view is not None:
                rejected.append({"index": view["index"], "reason": "replaced by a retake"})
            view = sample
    if view is not None:
        views.append((view, posed))
    return views, rejected


async def observe(geometry, detect, file, stream):
    """Object points and valid optical rays of the board in one image, or a rejection reason."""
    import cv2
    image = cv2.imread(file, cv2.IMREAD_GRAYSCALE) if file and os.path.isfile(file) else None
    if image is None:
        return "no readable image"
    descriptor = geometry.streams[stream]
    if (image.shape[1], image.shape[0]) != (descriptor["width"], descriptor["height"]):
        return "image size differs from the active geometry"
    found = detect(image)
    if isinstance(found, str):
        return found
    points, pixels = (value.reshape(-1, value.shape[-1]).astype(float) for value in found)
    rays = await geometry.unproject(pixels, stream)
    keep = np.isfinite(rays).all(axis=1)
    if keep.sum() < 6:
        return "fewer than 6 corners have valid rays"
    return {"object_points": points[keep].tolist(), "rays": rays[keep].tolist()}


def board_pose(observation):
    """The board pose in the camera from rays, which are pinhole coordinates at unit focal length."""
    import cv2
    points, rays = np.asarray(observation["object_points"]), np.asarray(observation["rays"])
    solved, rvec, tvec = cv2.solvePnP(points, rays[:, :2].copy(), np.eye(3), np.zeros(5))
    return {"rvec": rvec.reshape(3).tolist(), "tvec": tvec.reshape(3).tolist()} if solved else "solvePnP failed"
