"""Locate a detected object in a stamped camera optical frame."""
from kinex import profile
from kinex.object_location import detection_region, locate, select_detection


async def main(a, io):
    from rosidl_runtime_py.convert import message_to_ordereddict
    from kinex.ros_images import save
    import os
    camera, model = a["camera"], a["model"]
    cam = profile(camera)
    color = cam["intrinsics"]["color"]
    capture = await io.request(f"{camera}.capture")
    image = capture.image
    if (image.width, image.height) != (color["width"], color["height"]):
        raise ValueError("image dimensions differ from calibration")
    detected = await io.request(f"{model}.detect", image=image, prompt=a["prompt"],
                                min_score=a.get("min_score", .25), max_results=max(10, a.get("instance", 0) + 1))
    detection, count = select_detection(message_to_ordereddict(detected)["results"], a.get("min_score", .25), a.get("instance", 0))
    region, reference = detection_region(detection, color)
    depth_path = None
    if a.get("depth") is None:
        if not hasattr(capture, "depth_image"):
            raise ValueError("capture must include depth_image, or supply optical depth in metres")
        depth_path = save(capture.depth_image)
    try:
        measured = locate(cam, region, depth_path=depth_path, depth=a.get("depth"))
    finally:
        if depth_path:
            os.unlink(depth_path)
    return {**measured, "frame": image.header.frame_id, "reference": reference,
            "rotation_xyzw": None, "label": detection.get("label", a["prompt"]),
            "detection_score": detection["score"], "detections": count,
            "timestamp": image.header.stamp.sec + image.header.stamp.nanosec / 1e9,
            "file": save(image)}
