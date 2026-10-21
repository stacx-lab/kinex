"""Locate a detected object in a stamped camera optical frame."""
from kinex import helpers, profile
from kinex.object_location import detection_region, locate, select_detection


async def main(a, io):
    from rosidl_runtime_py.convert import message_to_ordereddict
    from kinex.ros_images import save
    import os
    camera, model = a["camera"], a["model"]
    cam = profile(camera)
    color = cam["color"]
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
        relation = None
        if depth_path and cam["depth"]["registration"] == "native":
            tf = await helpers.lookup_transform(io, image.header.frame_id, capture.depth_image.header.frame_id, image.header.stamp)
            t, q = tf.transform.translation, tf.transform.rotation
            relation = {"translation_m": [t.x, t.y, t.z], "rotation_xyzw": [q.x, q.y, q.z, q.w]}
        measured = locate(cam, region, depth_path=depth_path, depth=a.get("depth"), depth_to_color=relation)
    finally:
        if depth_path:
            os.unlink(depth_path)
    return {**measured, "frame": image.header.frame_id, "reference": reference,
            "rotation_xyzw": None, "label": detection.get("label", a["prompt"]),
            "detection_score": detection["score"], "detections": count,
            "timestamp": image.header.stamp.sec + image.header.stamp.nanosec / 1e9,
            "file": save(image)}
