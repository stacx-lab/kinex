"""Object perception: locate detected objects in a stamped camera optical frame."""

import numpy as np
from PIL import Image

from kinex import profile
from kinex.communication import seconds
from kinex.lib.camera import array, frame, project, ray, rays, save
from kinex.helpers.camera_geometry import camera_geometry
from kinex.lib.geometry import number, vector, xyzq_to_rt


async def locate_object_3d(io, camera, model, prompt, depth=None, min_score=.25, instance=0):
    """Locate a detected object in the camera optical frame (+X right, +Y down, +Z forward).

    camera is an rgb or rgbd device with calibrated color intrinsics; model serves a
    Json detect taking an image path, prompt, min_score and max_results and returning
    results with box, score, label and an optional mask. Samples depth inside a
    supplied mask, otherwise the central half of the box; depth gives an explicit
    optical Z in metres instead of RGBD depth. instance indexes detections sorted by
    descending score. Returns point (metres), pixel, depth_samples, reference
    (visible_surface or box_region), frame, label, detection_score, detections,
    timestamp and the image file; rotation_xyzw is None.

    Example: await helpers.locate_object_3d(io, "camera", "detector", "red mug")
    """
    cam = profile(camera)
    geometry = await camera_geometry(io, camera)
    color = geometry.streams["color"]
    cam = {**cam, "color": color}
    if cam.get("depth", {}).get("registration") == "native" and "depth" in geometry.streams:
        cam["depth"] = {**cam["depth"], **geometry.streams["depth"]}
    image, depth_image = await frame(io, camera)
    if geometry.remote and image.header.frame_id != color["frame"]:
        raise ValueError("image optical frame differs from active geometry")
    if depth_image is not None and cam["depth"]["registration"] == "native" and geometry.remote:
        if depth_image.header.frame_id != geometry.streams["depth"]["frame"]:
            raise ValueError("depth optical frame differs from active geometry")
    if (image.width, image.height) != (color["width"], color["height"]):
        raise ValueError("image dimensions differ from calibration")
    if depth is None and depth_image is None:
        raise ValueError("camera has no depth; supply optical depth in metres")
    file = save(image)
    detected = await io.request(f"{model}.detect", image=file, prompt=prompt,
                                min_score=min_score, max_results=max(10, instance + 1))
    detection, count = _select_detection(detected["results"], min_score, instance)
    region, reference = _detection_region(detection, color)
    if depth is not None:
        measured = await _locate(cam, region, depth=depth, geometry=geometry)
    else:
        relation = (await _depth_to_color(io, image, depth_image)
                    if cam["depth"]["registration"] == "native" else None)
        measured = await _locate(cam, region, depth_image=depth_image, depth_to_color=relation, geometry=geometry)
    return {**measured, "frame": image.header.frame_id, "reference": reference,
            "rotation_xyzw": None, "label": detection.get("label", prompt),
            "detection_score": detection["score"], "detections": count,
            "timestamp": seconds(image.header.stamp),
            "file": file}


async def _depth_to_color(io, image, depth_image):
    """The depth-to-color optical transform at the image stamp as (R, t)."""
    from kinex.helpers.frames import lookup_transform
    tf = await lookup_transform(io, image.header.frame_id, depth_image.header.frame_id, image.header.stamp)
    t, q = tf.transform.translation, tf.transform.rotation
    return xyzq_to_rt([t.x, t.y, t.z, q.x, q.y, q.z, q.w])


def _select_detection(results, min_score, instance):
    if not isinstance(results, list):
        raise ValueError("detect must return a results array")
    for result in results:
        if not isinstance(result, dict):
            raise ValueError("each detection must be an object")
        x1, y1, x2, y2 = vector(result.get("box"), 4, "detection box")
        if x1 >= x2 or y1 >= y2:
            raise ValueError("detection box must have positive width and height")
        if "mask" in result and (not isinstance(result["mask"], str) or not result["mask"]):
            raise ValueError("mask must be a PNG path when supplied")
        if not 0 <= number(result.get("score"), "detection score") <= 1:
            raise ValueError("detection score must be in [0, 1]")
    matches = sorted((item for item in results if item["score"] >= min_score), key=lambda item: -item["score"])
    if instance >= len(matches):
        raise ValueError(f"instance {instance} unavailable: {len(matches)} detections meet min_score {min_score}")
    return matches[instance], len(matches)


def _load_mask(path, color):
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode not in ("1", "L"):
            raise ValueError("mask must be a single-channel binary or grayscale PNG")
        if image.size != (color["width"], color["height"]):
            raise ValueError("mask dimensions differ from the color image")
        mask = np.asarray(image) != 0
    if not mask.any():
        raise ValueError("detection mask is empty")
    return mask


def _detection_region(detection, color):
    if "mask" in detection:
        return _load_mask(detection["mask"], color), "visible_surface"
    # Integer pixel centers in the central half of the clipped box.
    bounds = np.asarray(detection["box"]).reshape(2, 2)
    bounds = np.clip(bounds, 0, [color["width"], color["height"]])
    inset = (bounds[1] - bounds[0]) / 4
    start, stop = np.ceil([bounds[0] + inset, bounds[1] - inset]).astype(int)
    region = np.zeros((color["height"], color["width"]), dtype=bool)
    region[start[1]:stop[1], start[0]:stop[0]] = True
    if not region.any():
        raise ValueError("detection box has no eligible image pixels")
    return region, "box_region"


def _central(points):
    return np.argmin(np.sum((points - np.median(points, axis=0)) ** 2, axis=1))


async def _locate(camera, region, *, depth_image=None, depth=None, depth_to_color=None, geometry=None):
    color = camera["color"]
    if depth is not None:
        if number(depth, "depth") <= 0:
            raise ValueError("depth must be positive optical Z in metres")
        pixels = np.column_stack(np.nonzero(region)[::-1])
        directions = await geometry.unproject(pixels) if geometry else rays(color, *pixels.T)
        keep = np.isfinite(directions).all(axis=1)
        pixels, directions = pixels[keep], directions[keep]
        if not len(pixels):
            raise ValueError("no usable camera geometry")
        index = _central(pixels)
        pixel = pixels[index]
        return {"point": (directions[index] * depth).tolist(), "pixel": pixel.tolist(), "depth_samples": 0}

    meta = camera["depth"]
    if depth_image.encoding != "16UC1":
        raise ValueError("depth_image must be 16UC1")
    raw = array(depth_image)
    if raw.shape != (meta["height"], meta["width"]):
        raise ValueError("depth dimensions differ from the profile")
    distances = raw.astype(float) * meta["scale_m_per_unit"]
    limits = meta["valid_range_m"]
    valid = (raw != meta["invalid_value"]) & (distances > 0) & (distances >= limits["min"]) & (distances <= limits["max"])
    native = meta["registration"] == "native"
    if not native:
        if valid.shape != region.shape:
            raise ValueError("registered depth dimensions differ from the color image")
        valid &= region
    y, x = np.nonzero(valid)
    distances = distances[y, x]
    pixels = np.column_stack((x, y))
    directions = (await geometry.unproject(pixels, "depth" if native else "color") if geometry
                  else rays(meta if native else color, x, y).reshape(-1, 3))
    keep = np.isfinite(directions).all(axis=1)
    directions, distances, pixels = directions[keep], distances[keep], pixels[keep]
    scale = distances / np.linalg.norm(directions, axis=1) if meta["quantity"] == "range" else distances
    points = directions * scale[:, None]
    if native:
        rotation, translation = depth_to_color
        points = points @ np.asarray(rotation).T + translation
        keep = points[:, 2] > 0
        points, distances = points[keep], distances[keep]
        projected = await geometry.project(points) if geometry else np.column_stack(project(color, points.T))
        keep = np.isfinite(projected).all(axis=1) & (projected >= 0).all(axis=1) & (projected < [color["width"], color["height"]]).all(axis=1)
        points, distances, pixels = points[keep], distances[keep], np.rint(projected[keep]).astype(int)
        keep = (pixels < [color["width"], color["height"]]).all(axis=1)
        points, distances, pixels = points[keep], distances[keep], pixels[keep]
        keep = region[pixels[:, 1], pixels[:, 0]]
        points, distances, pixels = points[keep], distances[keep], pixels[keep]
        # Keep the nearest surface when native samples project to the same color pixel.
        keys = pixels[:, 1] * color["width"] + pixels[:, 0]
        order = np.lexsort((points[:, 2], keys))
        _, first = np.unique(keys[order], return_index=True)
        keep = order[first]
        points, distances, pixels = points[keep], distances[keep], pixels[keep]
    if not len(points):
        raise ValueError("depth hole: no valid depth inside the detection region")
    index = _central(points)
    result = {"point": points[index].tolist(), "pixel": pixels[index].tolist(), "depth_samples": len(points)}
    reliable = meta["reliable_range_m"]
    if isinstance(reliable, dict) and not reliable["min"] <= distances[index] <= reliable["max"]:
        result["depth_warning"] = "depth is outside the camera's reliable range"
    return result
