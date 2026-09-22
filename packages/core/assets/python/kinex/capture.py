"""Camera driver output validation and encoding shared by RGB/RGBD skeletons."""

from kinex.validation import settings

import math
import uuid
from pathlib import Path


def validate(profile, sample):
    import numpy as np
    color = np.asarray(sample["color"])
    meta = profile["intrinsics"]["color"]
    if color.dtype != np.uint8 or color.shape != (meta["height"], meta["width"], 3):
        raise ValueError("color must be uint8 RGB at the profile resolution")
    stamp = sample["sample_time_s"]
    if stamp is not None and not math.isfinite(stamp):
        raise ValueError("sample_time_s must be acquisition Unix seconds or null")
    if stamp is None and not math.isfinite(sample["received_time_s"]):
        raise ValueError("unknown acquisition time requires received_time_s")
    if profile["type"] != "rgbd":
        return sample
    depth = np.asarray(sample["depth"])
    meta = profile["intrinsics"]["depth"]
    if depth.dtype != np.uint16 or depth.shape != (meta["height"], meta["width"]):
        raise ValueError("depth must be uint16 at the profile resolution")
    valid = depth != meta["invalid_value"]
    metres = depth[valid].astype(float) * meta["scale_m_per_unit"]
    limits = meta["valid_range_m"]
    if np.any((metres < limits["min"]) | (metres > limits["max"])):
        raise ValueError("driver must map out-of-range depth to invalid_value before encoding")
    stamp = sample["depth_sample_time_s"]
    if stamp is not None and not math.isfinite(stamp):
        raise ValueError("depth_sample_time_s must be acquisition Unix seconds or null")
    if stamp is None and not math.isfinite(sample["received_time_s"]):
        raise ValueError("unknown depth acquisition time requires received_time_s")
    return sample


def save(profile, sample, directory):
    import numpy as np
    from PIL import Image
    validate(profile, sample)
    out = Path(directory)
    out.mkdir(exist_ok=True)
    stamp = uuid.uuid4().hex
    color_path = out / f"color-{stamp}.png"
    Image.fromarray(sample["color"]).save(color_path)
    color = profile["intrinsics"]["color"]
    result = {"file": str(color_path), "width": color["width"], "height": color["height"],
              "sample_time_s": sample["sample_time_s"]}
    if "received_time_s" in sample:
        result["received_time_s"] = sample["received_time_s"]
    if profile["type"] != "rgbd":
        return result
    meta = profile["intrinsics"]["depth"]
    depth_path = out / f"depth-{stamp}.pgm"
    header = f'P5\n{meta["width"]} {meta["height"]}\n65535\n'.encode()
    depth_path.write_bytes(header + np.asarray(sample["depth"]).astype(">u2").tobytes())
    result.update(depth_file=str(depth_path), depth_width=meta["width"], depth_height=meta["height"],
                  depth_sample_time_s=sample["depth_sample_time_s"])
    return result
