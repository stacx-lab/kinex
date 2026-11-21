"""Brown-Conrady and OpenCV fisheye intrinsics from board detections."""
import re

import numpy as np


def fisheye_monotonic(coefficients):
    """Whether distorted radius grows with angle, so every ray has one pixel radius."""
    theta2 = np.linspace(0, (np.pi / 2) ** 2, 4097)
    return bool((np.polynomial.polynomial.polyval(theta2, [1, *[(2 * i + 3) * k for i, k in enumerate(coefficients)]]) > 0).all())


def solve(object_points, image_points, size, model, min_frames=1):
    """(rms, camera matrix, distortion, per-view RMS, kept view positions) for one stream.

    The fisheye solver names an ill-conditioned view; it is dropped and the rest re-solved.
    """
    import cv2
    kept = list(range(len(object_points)))
    while True:
        try:
            return (*fit([object_points[i] for i in kept], [image_points[i] for i in kept], size, model), kept)
        except cv2.error as error:
            match = re.search(r"Ill-conditioned matrix for input array (\d+)", str(error))
            if model != "opencv_fisheye" or not match or len(kept) <= min_frames:
                raise
            del kept[int(match.group(1))]


def fit(object_points, image_points, size, model):
    """(rms, camera matrix, distortion, per-view RMS) for one stream."""
    import cv2
    if model == "opencv_fisheye":
        # The fisheye API needs float64 Nx1x3 and Nx1x2 views.
        object_points = [np.asarray(p, dtype=np.float64).reshape(-1, 1, 3) for p in object_points]
        image_points = [np.asarray(p, dtype=np.float64).reshape(-1, 1, 2) for p in image_points]
        flags = cv2.fisheye.CALIB_RECOMPUTE_EXTRINSIC | cv2.fisheye.CALIB_CHECK_COND | cv2.fisheye.CALIB_FIX_SKEW
        rms, matrix, dist, rvecs, tvecs = cv2.fisheye.calibrate(
            object_points, image_points, size, None, None, flags=flags,
            criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-8))
        project = cv2.fisheye.projectPoints
        coefficients = [float(value) for value in dist.reshape(-1)]
        distortion = {"model": model, "coefficients": coefficients}
    else:
        rms, matrix, dist, rvecs, tvecs = cv2.calibrateCamera(object_points, image_points, size, None, None)
        project = cv2.projectPoints
        distortion = {"model": model, **dict(zip(("k1", "k2", "p1", "p2", "k3"), map(float, dist.reshape(-1)[:5])))}
    errors = []
    for obj, img, rvec, tvec in zip(object_points, image_points, rvecs, tvecs):
        projected, _ = project(obj, rvec, tvec, matrix, dist)
        deltas = img.reshape(-1, 2) - projected.reshape(-1, 2)
        errors.append(float(np.sqrt(np.mean(np.sum(deltas * deltas, axis=1)))))
    if not all(np.isfinite(value).all() for value in (rms, matrix, dist, errors)):
        raise ValueError("calibration returned non-finite parameters or errors")
    if model == "opencv_fisheye" and not fisheye_monotonic(coefficients):
        raise ValueError("fisheye distortion folds within the forward hemisphere")
    return float(rms), matrix, distortion, errors


def coverage(image_points, size):
    """A warning for each image quadrant without a detected corner."""
    quadrants = [0, 0, 0, 0]
    for points in image_points:
        for x, y in np.asarray(points).reshape(-1, 2):
            quadrants[(2 if y > size[1] / 2 else 0) + (1 if x > size[0] / 2 else 0)] += 1
    return [f"no samples in the {name} quadrant; distortion is unconstrained there"
            for name, count in zip(("top-left", "top-right", "bottom-left", "bottom-right"), quadrants) if count == 0]
