#!/usr/bin/env python3
"""Turn calib_sample captures into board observations for calib_compute.

Run through exec: file=<this skill>/scripts/board_observations.py, argv=[...]. At each
pose, sample the arm with --frame, then the camera; the last camera sample before the
next arm sample is the view, so a retake replaces the earlier capture. Arm samples that
did not settle are rejected. Detected corners are unprojected through the camera's
active geometry, so any lens model works.

--output receives one entry per usable view, each with its sample indices:
  mono, or one stereo eye with --eye: {"frame_pose": [x,y,z,qx,qy,qz,qw], "rvec", "tvec"}
  stereo: {"frame_pose"?, "left": {"object_points", "rays"}, "right": {...}}
Without --arm every stereo camera sample is a view without frame_pose (camera-eye-to-eye).
finish() returns {output, views, rejected, calibration_id}.
"""
import argparse
import asyncio
import json
import os

import numpy as np

from kinex import communication, finish, profile
from kinex.helpers.camera_geometry import camera_geometry
from kinex.lib.camera import camera_stream, stereo


def parse(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", required=True, help="calib_sample samples.json of the capture run")
    parser.add_argument("--camera", required=True)
    parser.add_argument("--eye", choices=["left", "right"], help="observe one eye of a stereo camera")
    parser.add_argument("--arm", help="joint device whose samples carry --frame poses")
    parser.add_argument("--frame", help="URDF link the arm samples were recorded with")
    parser.add_argument("--output", required=True)
    parser.add_argument("--board", choices=["charuco", "checkerboard"], default="charuco")
    parser.add_argument("--squares-x", type=int, default=7)
    parser.add_argument("--squares-y", type=int, default=5)
    parser.add_argument("--square-mm", type=float, required=True, help="MEASURED printed square size")
    parser.add_argument("--marker-mm", type=float, default=None, help="charuco marker side (measured)")
    parser.add_argument("--dict", dest="dictionary", default="DICT_4X4_50")
    parser.add_argument("--corners-x", type=int, default=9, help="checkerboard inner corners")
    parser.add_argument("--corners-y", type=int, default=6)
    args = parser.parse_args(argv)
    if (args.arm is None) != (args.frame is None):
        parser.error("--arm and --frame go together")
    return args


def detector(args):
    """A function from a grayscale image to (object points Nx3, pixels Nx2) or a rejection reason."""
    import cv2
    square = args.square_mm / 1000
    if args.board == "charuco":
        marker = (args.marker_mm or args.square_mm * .75) / 1000
        dictionary = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, args.dictionary))
        board = cv2.aruco.CharucoBoard((args.squares_x, args.squares_y), square, marker, dictionary)
        charuco = cv2.aruco.CharucoDetector(board)

        def detect(image):
            corners, ids, _, _ = charuco.detectBoard(image)
            if ids is None or len(ids) < 6:
                return f"board not detected ({0 if ids is None else len(ids)} corners)"
            points, pixels = board.matchImagePoints(corners, ids)
            return points.reshape(-1, 3).astype(float), pixels.reshape(-1, 2).astype(float)
        return detect
    pattern = (args.corners_x, args.corners_y)
    template = np.zeros((pattern[0] * pattern[1], 3))
    template[:, :2] = np.mgrid[0:pattern[0], 0:pattern[1]].T.reshape(-1, 2) * square
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-3)

    def detect(image):
        found, corners = cv2.findChessboardCorners(image, pattern)
        if not found:
            return "checkerboard not detected"
        return template, cv2.cornerSubPix(image, corners, (11, 11), (-1, -1), criteria).reshape(-1, 2).astype(float)
    return detect


def pair(samples, camera, arm, frame):
    """(camera sample, arm sample or None) per view, plus rejections."""
    if arm is None:
        return [(sample, None) for sample in samples if sample["device"] == camera], []
    views, rejected = [], []
    posed = view = None

    def close():
        if view is not None:
            views.append((view, posed))
    for sample in samples:
        if sample["device"] == arm:
            close()
            view, posed = None, None
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
    close()
    return views, rejected


async def observe(geometry, detect, file, stream):
    """Object points and valid optical rays of the board in one image, or a rejection reason."""
    import cv2
    image = cv2.imread(file, cv2.IMREAD_GRAYSCALE) if os.path.isfile(file) else None
    if image is None:
        return "unreadable image"
    descriptor = geometry.streams[stream]
    if (image.shape[1], image.shape[0]) != (descriptor["width"], descriptor["height"]):
        return "image size differs from the active geometry"
    found = detect(image)
    if isinstance(found, str):
        return found
    points, pixels = found
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


async def observations(io, args):
    camera = profile(args.camera)
    streams = ["left", "right"] if stereo(camera) and args.eye is None else [camera_stream(camera, args.eye)]
    if len(streams) == 1 and args.arm is None:
        raise ValueError("single-stream observations need --arm and --frame for hand-eye calibration")
    with open(args.samples) as handle:
        views, rejected = pair(json.load(handle), args.camera, args.arm, args.frame)
    geometry = await camera_geometry(io, args.camera)
    detect = detector(args)
    entries = []
    for sample, arm in views:
        files = {stream: sample.get("file") if stream == "color" else sample["data"].get(f"{stream}_file") for stream in streams}
        seen = {stream: await observe(geometry, detect, file, stream) if file else "no image" for stream, file in files.items()}
        if len(streams) == 1:
            seen = {stream: board_pose(value) if isinstance(value, dict) else value for stream, value in seen.items()}
        failed = [f"{stream}: {value}" for stream, value in seen.items() if isinstance(value, str)]
        if failed:
            rejected.append({"index": sample["index"], "reason": "; ".join(failed)})
            continue
        entry = {"samples": {"camera": sample["index"], **({"arm": arm["index"]} if arm else {})},
                 **({"frame_pose": arm["kinematics"]["pose"]} if arm else {})}
        entries.append({**entry, **(seen[streams[0]] if len(streams) == 1 else seen)})
    with open(args.output, "w") as handle:
        json.dump(entries, handle)
    return {"output": args.output, "views": len(entries), "rejected": sorted(rejected, key=lambda item: item["index"]),
            "calibration_id": {stream: geometry.streams[stream].get("calibration_id") for stream in streams}}


async def main():
    args = parse()
    async with communication() as io:
        result = await observations(io, args)
    finish(result)


if __name__ == "__main__":
    asyncio.run(main())
