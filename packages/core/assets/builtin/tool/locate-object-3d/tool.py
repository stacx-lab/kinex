"""Locate a detected object in a stamped camera optical frame."""
from kinex import helpers, profile
from kinex.camera import save
from kinex.object_location import detection_region, locate, select_detection


async def depth_to_color(io, image, depth_image):
    tf = await helpers.lookup_transform(io, image.header.frame_id, depth_image.header.frame_id, image.header.stamp)
    t, q = tf.transform.translation, tf.transform.rotation
    return {"translation_m": [t.x, t.y, t.z], "rotation_xyzw": [q.x, q.y, q.z, q.w]}


async def main(a, io):
    camera, model, depth = a["camera"], a["model"], a.get("depth")
    cam = profile(camera)
    color = cam["color"]
    capture = await io.request(f"{camera}.capture")
    image = capture.image
    if (image.width, image.height) != (color["width"], color["height"]):
        raise ValueError("image dimensions differ from calibration")
    if depth is None and not hasattr(capture, "depth_image"):
        raise ValueError("capture has no depth_image; supply optical depth in metres")
    file = save(image)
    detected = await io.request(f"{model}.detect", image=file, prompt=a["prompt"],
                                min_score=a.get("min_score", .25), max_results=max(10, a.get("instance", 0) + 1))
    detection, count = select_detection(detected["results"], a.get("min_score", .25), a.get("instance", 0))
    region, reference = detection_region(detection, color)
    if depth is not None:
        measured = locate(cam, region, depth=depth)
    else:
        relation = (await depth_to_color(io, image, capture.depth_image)
                    if cam["depth"]["registration"] == "native" else None)
        measured = locate(cam, region, depth_image=capture.depth_image, depth_to_color=relation)
    return {**measured, "frame": image.header.frame_id, "reference": reference,
            "rotation_xyzw": None, "label": detection.get("label", a["prompt"]),
            "detection_score": detection["score"], "detections": count,
            "timestamp": image.header.stamp.sec + image.header.stamp.nanosec / 1e9,
            "file": file}
