"""Optional camera-node adapters. SDKs are imported only in their node environment."""
import copy
import uuid
import numpy as np


class OpenCVGeometry:
    def __init__(self, stream, *, fisheye=False):
        import cv2
        self.cv, self.fisheye = cv2, fisheye
        self.descriptor = copy.deepcopy(stream)
        p, d = stream["projection"], stream["distortion"]
        expected = "opencv_fisheye" if fisheye else "opencv_brown_conrady"
        if d["model"] not in ("none", expected) or p["skew"] != 0:
            raise ValueError("OpenCV adapter requires its explicit model and zero skew")
        self.k = np.array([[p["fx"], 0, p["cx"]], [0, p["fy"], p["cy"]], [0, 0, 1]], dtype=float)
        self.d = np.zeros(4 if fisheye else 5) if d["model"] == "none" else np.array(
            d["coefficients"] if fisheye else [d[k] for k in ("k1", "k2", "p1", "p2", "k3")], dtype=float)
        if self.d.shape != (4 if fisheye else 5,) or not np.isfinite(self.d).all():
            raise ValueError("invalid OpenCV coefficients")

    def unproject(self, pixels):
        api = self.cv.fisheye if self.fisheye else self.cv
        xy = api.undistortPoints(np.array(pixels, dtype=float).reshape(-1, 1, 2), self.k, self.d).reshape(-1, 2)
        return np.column_stack((xy, np.ones(len(xy)))).tolist()

    def project(self, points):
        api = self.cv.fisheye if self.fisheye else self.cv
        pixels, _ = api.projectPoints(np.array(points, dtype=float).reshape(-1, 1, 3),
                                     np.zeros(3), np.zeros(3), self.k, self.d)
        return pixels.reshape(-1, 2).tolist()


class RealSenseGeometry:
    def __init__(self, intrinsics, frame):
        import pyrealsense2 as rs
        self.rs = rs
        self.intrinsics = rs.intrinsics()
        for key in ("width", "height", "fx", "fy", "ppx", "ppy", "model", "coeffs"):
            setattr(self.intrinsics, key, getattr(intrinsics, key))
        self.descriptor = {"width": intrinsics.width, "height": intrinsics.height, "frame": frame,
            "projection": {"model": "pinhole", "fx": intrinsics.fx, "fy": intrinsics.fy,
                           "cx": intrinsics.ppx, "cy": intrinsics.ppy, "skew": 0},
            "distortion": {"model": str(intrinsics.model), "coefficients": list(intrinsics.coeffs)}}

    def unproject(self, pixels):
        if self.intrinsics.model == self.rs.distortion.modified_brown_conrady:
            raise ValueError("RealSense SDK does not support deprojection for modified Brown")
        return [self.rs.rs2_deproject_pixel_to_point(self.intrinsics, pixel, 1) for pixel in pixels]

    def project(self, points):
        return [self.rs.rs2_project_point_to_pixel(self.intrinsics, point) for point in points]


def serve_geometry(node, profile, adapters):
    """Bind geometry/project/unproject to immutable adapters for this load.

    Reconfigure only by unloading/reloading the node. SDK reconnect handlers must
    stop publication if the stream configuration or calibration changes.
    """
    from kinex.node import json_service
    descriptors = {name: {**copy.deepcopy(adapter.descriptor), "calibration_id": uuid.uuid4().hex}
                   for name, adapter in adapters.items()}

    def convert(action, stream, calibration_id, values):
        if stream not in adapters or descriptors[stream]["calibration_id"] != calibration_id:
            raise ValueError("stale or unknown camera calibration; refresh geometry")
        size = 2 if action == "unproject" else 3
        if not isinstance(values, list) or len(values) > 8192:
            raise ValueError("geometry batch must contain at most 8192 coordinates")
        output = []
        valid, indices = [], []
        for i, value in enumerate(values):
            if not isinstance(value, list) or len(value) != size:
                raise ValueError("invalid coordinate shape")
            if any(isinstance(v, bool) or not isinstance(v, (float, int)) for v in value):
                raise ValueError("coordinates must be numbers")
            output.append(None)
            if np.isfinite(value).all() and (action == "unproject" or value[2] > 0):
                indices.append(i)
                valid.append(value)
        if valid:
            result = getattr(adapters[stream], action)(valid)
            if len(result) != len(valid):
                raise ValueError("adapter cardinality mismatch")
            for i, value in zip(indices, result):
                if value is not None and np.isfinite(value).all():
                    output[i] = value
        return {"rays" if action == "unproject" else "pixels": output}

    json_service(node, profile["operations"]["geometry"], lambda: {"streams": copy.deepcopy(descriptors)})
    json_service(node, profile["operations"]["unproject"],
                 lambda stream, calibration_id, pixels: convert("unproject", stream, calibration_id, pixels))
    json_service(node, profile["operations"]["project"],
                 lambda stream, calibration_id, points: convert("project", stream, calibration_id, points))
