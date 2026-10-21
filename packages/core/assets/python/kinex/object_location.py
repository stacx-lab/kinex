"""Detection-region camera measurements, independent of SDKs and robot frames."""

import numpy as np
from PIL import Image

from kinex.camera import project, ray, read_depth
from kinex.geometry import pose_to_rt
from kinex.validation import number, vector


def select_detection(results, min_score, instance):
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


def load_mask(path, color):
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode not in ("1", "L"):
            raise ValueError("mask must be a single-channel binary or grayscale PNG")
        if image.size != (color["width"], color["height"]):
            raise ValueError("mask dimensions differ from the color image")
        mask = np.asarray(image) != 0
    if not mask.any():
        raise ValueError("detection mask is empty")
    return mask


def detection_region(detection, color):
    if "mask" in detection:
        return load_mask(detection["mask"], color), "visible_surface"
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


def _rays(stream, pixels):
    # Pinhole is vectorized; distorted cameras retain the shared calibrated solver.
    if not len(pixels):
        return np.empty((0, 3))
    if stream["distortion"]["model"] != "none":
        return np.asarray([ray(stream, u, v) for u, v in pixels])
    p = stream["projection"]
    y = (pixels[:, 1] - p["cy"]) / p["fy"]
    x = (pixels[:, 0] - p["cx"] - p["skew"] * y) / p["fx"]
    return np.column_stack((x, y, np.ones(len(pixels))))


def _central(points):
    return np.argmin(np.sum((points - np.median(points, axis=0)) ** 2, axis=1))


def locate(profile, region, *, depth_path=None, depth=None, depth_to_color=None):
    color = profile["color"]
    if depth is not None:
        if number(depth, "depth") <= 0:
            raise ValueError("depth must be positive optical Z in metres")
        pixels = np.column_stack(np.nonzero(region)[::-1])
        pixel = pixels[_central(pixels)]
        return {"point": (np.asarray(ray(color, *pixel)) * depth).tolist(), "pixel": pixel.tolist(), "depth_samples": 0}

    meta = profile["depth"]
    width, height, raw = read_depth(depth_path, meta)
    raw = np.asarray(raw).reshape(height, width)
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
    rays = _rays(meta if native else color, pixels)
    scale = distances / np.linalg.norm(rays, axis=1) if meta["quantity"] == "range" else distances
    points = rays * scale[:, None]
    if native:
        transform = depth_to_color
        if not isinstance(transform, dict) or any(transform.get(key) in (None, "???") for key in ("translation_m", "rotation_xyzw")):
            raise ValueError("native depth needs calibrated depth_to_color")
        rotation, translation = pose_to_rt({"translation": transform["translation_m"], "rotation": transform["rotation_xyzw"]})
        points = points @ np.asarray(rotation).T + translation
        keep = points[:, 2] > 0
        points, distances = points[keep], distances[keep]
        projected = np.column_stack(project(color, points.T))
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
