"""Invocation-owned camera geometry; all remote calls use the caller's communication scope."""
import numpy as np
from kinex import profile
from kinex.lib.camera import rays, project


class CameraGeometry:
    def __init__(self, io, camera, streams, remote):
        self.io, self.camera, self.streams, self.remote = io, camera, streams, remote

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
                result = await self.io.request(f"{self.camera}.{action}", stream=stream,
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


async def camera_geometry(io, camera):
    """Fetch once per invocation, before acquisition; reuse for all point batches.

    Streams cannot change calibration while loaded. Reload after reconfiguration.
    """
    record = profile(camera)
    remote = f"{camera}.geometry" in io.catalog
    if remote:
        streams = (await io.request(f"{camera}.geometry"))["streams"]
    else:
        streams = {"color": record["color"]}
        if record.get("depth", {}).get("registration") == "native":
            streams["depth"] = record["depth"]
    for name, descriptor in streams.items():
        if name not in ("color", "depth") or not isinstance(descriptor, dict):
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
    if "color" not in streams:
        raise ValueError("camera geometry requires color stream")
    return CameraGeometry(io, camera, streams, remote)
