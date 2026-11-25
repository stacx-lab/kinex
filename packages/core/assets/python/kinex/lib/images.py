"""Current camera frames, camera geometry, pixel arrays and image files.

Images stay sensor_msgs/Image messages; pass one to finish(file=...) for the model to
see it. Reading a camera never advances world time.
"""
import numpy as np

from kinex import device, profile
from kinex.common.camera import array, camera_stream, frame, project, rays, save, stereo
from kinex.common.camera import stereo_frame as read_stereo


async def camera_frame(camera, timeout_s=None, eye=None):
    """The camera's current image and its depth from the same acquisition (None without depth).

    A stereo camera needs eye="left" or eye="right"; timeout_s defaults to the image
    operation's.

    Example: image, depth = await lib.images.camera_frame("camera")
    """
    camera_stream(profile(camera), eye)
    return await frame(device(camera), timeout_s=timeout_s, eye=eye)


async def stereo_frame(camera, timeout_s=None):
    """A stereo camera's current left and right images, each with its own stamp and frame.

    A pair read does not imply hardware synchronization; compare stamps when it matters.

    Example: left, right = await lib.images.stereo_frame("camera")
    """
    camera_stream(profile(camera), "left")
    return await read_stereo(device(camera), timeout_s=timeout_s)


def image_array(image):
    """A sensor_msgs/Image's pixels as a NumPy array: HxWx3 RGB, or HxW for mono8 and 16UC1 depth.

    Example: pixels = lib.images.image_array(image)
    """
    return array(image)


def save_image(image):
    """Write a sensor_msgs/Image to a temporary PNG, keeping 16-bit depth, and return its
    path, as a model device's image input takes it.

    Example: file = lib.images.save_image(image)
    """
    return save(image)


class CameraGeometry:
    """A program's camera geometry; remote calls go to the camera's own services."""

    def __init__(self, camera, streams, remote):
        self.camera, self.streams, self.remote = camera, streams, remote

    async def _convert(self, action, stream, values):
        descriptor = self.streams[stream]
        size = 2 if action == "unproject" else 3
        values = np.asarray(values, dtype=float).reshape(-1, size)
        width = 3 if action == "unproject" else 2
        output = []
        for start in range(0, len(values), 8192):
            batch = values[start:start + 8192]
            if not np.isfinite(batch).all():
                raise ValueError("geometry inputs must be finite")
            if self.remote:
                result = await device(self.camera).service(action)(stream=stream,
                    calibration_id=descriptor["calibration_id"], **{"pixels" if action == "unproject" else "points": batch.tolist()})
                result = result["rays" if action == "unproject" else "pixels"]
            else:
                result = (rays(descriptor, *batch.T) if action == "unproject"
                          else np.column_stack(project(descriptor, batch.T))).tolist()
            if not isinstance(result, list) or len(result) != len(batch):
                raise ValueError("geometry response cardinality differs from request")
            for value in result:
                if value is None:
                    output.append([float("nan")] * width)
                    continue
                if not isinstance(value, list) or len(value) != width or not np.isfinite(value).all():
                    raise ValueError("invalid geometry response")
                if action == "unproject" and abs(value[2] - 1) > 1e-9:
                    raise ValueError("unproject must return optical rays with Z=1")
                output.append(value)
        return np.asarray(output, dtype=float).reshape(-1, width)

    async def unproject(self, pixels, stream="color"):
        return await self._convert("unproject", stream, pixels)

    async def project(self, points, stream="color"):
        return await self._convert("project", stream, points)


async def camera_geometry(camera):
    """The camera's active geometry, between pixels and optical rays; fetch it once per program.

    await geometry.unproject(pixels, stream="color") gives Nx3 optical rays (Z=1) and
    await geometry.project(points, stream="color") Nx2 pixels, NaN where invalid.
    geometry.streams maps color, depth, left or right to its descriptor.

    Example: rays = await (await lib.images.camera_geometry("camera")).unproject([[320, 240]])
    """
    record = profile(camera)
    remote = "geometry" in device(camera).operations
    if remote:
        streams = (await device(camera).service("geometry")())["streams"]
    else:
        streams = {eye: record[eye] for eye in ("left", "right")} if stereo(record) else {"color": record["color"]}
        if record.get("depth", {}).get("registration") == "native":
            streams["depth"] = record["depth"]
    for name, descriptor in streams.items():
        if name not in ("color", "depth", "left", "right") or not isinstance(descriptor, dict):
            raise ValueError("invalid geometry stream descriptor")
        for key in ("width", "height"):
            if not isinstance(descriptor.get(key), int) or descriptor[key] <= 0:
                raise ValueError("geometry requires positive stream dimensions")
        if remote:
            if not isinstance(descriptor.get("calibration_id"), str) or not descriptor["calibration_id"]:
                raise ValueError("geometry requires a calibration ID")
            if not isinstance(descriptor.get("frame"), str) or not descriptor["frame"]:
                raise ValueError("geometry requires an optical frame")
            snapshot = record.get(name, {})
            if not isinstance(snapshot, dict):
                snapshot = {}
            for key in ("width", "height", "projection", "distortion"):
                value = snapshot.get(key, "???")
                if value != "???" and descriptor.get(key, "???") != value:
                    raise ValueError(f"{name}.{key}: profile and active calibration differ; refresh profile or reload node")
        else:
            rays(descriptor, 0, 0)  # Validate the explicit pinhole fallback now.
    if "color" not in streams and not {"left", "right"} <= streams.keys():
        raise ValueError("camera geometry requires a color stream or both stereo eyes")
    return CameraGeometry(camera, streams, remote)
