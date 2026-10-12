#!/usr/bin/env python3
"""Locate a detected object in the camera optical frame."""

from PIL import Image

from kinex import args, device, fail, finish, profile
from kinex.object_location import detection_region, locate, select_detection
from kinex.validation import number


def main():
    a = args()
    camera, model = a["camera"], a["model"]
    cam = profile(camera)
    color = cam["intrinsics"].get("color")
    if not isinstance(color, dict) or any(color.get(key) in (None, "???") for key in ("width", "height", "projection", "distortion")):
        fail(f'camera "{camera}" needs calibrated color intrinsics')
    depth = a.get("depth")
    if depth is not None and number(depth, "depth") <= 0:
        fail("depth must be positive optical Z in metres")
    if depth is None and cam["type"] != "rgbd":
        fail("provide depth in metres or use an rgbd camera")
    frame = device(camera, args={"output": "file"})
    image = frame.get("file")
    if not image:
        fail(f'camera "{camera}" returned no image file')
    with Image.open(image) as captured:
        if captured.size != (color["width"], color["height"]):
            fail("color image dimensions differ from calibration")
    depth_path = frame.get("depth_file") if depth is None else None
    if depth is None and not depth_path:
        fail(f'rgbd camera "{camera}" returned no depth_file')
    instance = a.get("instance", 0)
    min_score = a.get("min_score", 0.25)
    detected = device(model, "detect", {"image": image, "prompt": a["prompt"], "min_score": min_score, "max_results": max(10, instance + 1)})
    detection, count = select_detection(detected.get("results"), min_score, instance)
    region, reference = detection_region(detection, color)
    measurement = locate(cam, region, depth_path=depth_path, depth=depth)
    finish({
        **measurement, "frame": camera, "rotation_xyzw": None,
        "reference": reference, "mode": "depth" if depth is not None else "rgbd",
        "label": detection.get("label", a["prompt"]), "detection_score": detection["score"],
        "instance": instance, "detections": count,
        "timestamp": frame.get("timestamp"),
    }, file=detected.get("file"))


main()
