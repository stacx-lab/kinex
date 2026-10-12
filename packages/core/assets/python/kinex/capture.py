"""Camera driver output validation and encoding shared by RGB/RGBD skeletons."""

from kinex.validation import settings as settings, number

import base64
import io
import secrets
from pathlib import Path


def validate(profile, sample):
    import numpy as np
    color = np.asarray(sample["color"])
    meta = profile["intrinsics"]["color"]
    if color.dtype != np.uint8 or color.shape != (meta["height"], meta["width"], 3):
        raise ValueError("color must be uint8 RGB at the profile resolution")
    number(sample.get("timestamp"), "timestamp")
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
    return sample


def output_mode(value="array"):
    if value not in ("file", "base64", "array"):
        raise ValueError("camera output must be file, base64 or array")
    return value


def save(profile, sample, directory, output="array"):
    """Array requests use base64 on the wire; the Python client decodes them."""
    import numpy as np
    from PIL import Image
    output_mode(output)
    validate(profile, sample)
    stream = io.BytesIO()
    Image.fromarray(sample["color"]).save(stream, format="PNG")
    images = {"color": stream.getvalue()}
    if profile["type"] == "rgbd":
        meta = profile["intrinsics"]["depth"]
        header = f'P5\n{meta["width"]} {meta["height"]}\n65535\n'.encode()
        images["depth"] = header + np.asarray(sample["depth"]).astype(">u2").tobytes()
    result = {"timestamp": sample["timestamp"]}
    if output != "file":
        return {**result, **{key: base64.b64encode(value).decode("ascii") for key, value in images.items()}}
    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    stamp = secrets.token_hex(8)
    for key, value in images.items():
        path = out / f"{key}-{stamp}.{'png' if key == 'color' else 'pgm'}"
        path.write_bytes(value)
        result["file" if key == "color" else "depth_file"] = str(path)
    return result


def arrays(profile, data):
    import numpy as np
    from PIL import Image
    result = dict(data)
    for key in ("color", "depth") if profile["type"] == "rgbd" else ("color",):
        raw = base64.b64decode(data[key], validate=True)
        meta = profile["intrinsics"][key]
        with Image.open(io.BytesIO(raw)) as image:
            if image.size != (meta["width"], meta["height"]):
                raise ValueError("camera dimensions differ from the profile")
            if key == "color" and (image.format != "PNG" or image.mode != "RGB"):
                raise ValueError("color must be an RGB8 PNG")
            if key == "depth" and not raw.startswith(f'P5\n{meta["width"]} {meta["height"]}\n65535\n'.encode()):
                raise ValueError("depth must be PGM16")
            result[key] = np.array(image, dtype=np.uint8 if key == "color" else np.uint16, copy=True)
    return validate(profile, result)
