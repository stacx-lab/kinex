"""Stereo reads keep each eye's stamp and frame; localization uses the selected eye's geometry."""
import asyncio
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

from kinex.helpers import camera_geometry as geometry_module, images, perception
from kinex.lib.camera import frame, stereo_frame


def image(sec, frame_id, width=4, height=2):
    return NS(header=NS(stamp=NS(sec=sec, nanosec=0), frame_id=frame_id), encoding="rgb8", is_bigendian=False,
              width=width, height=height, step=width * 3, data=bytes(width * height * 3))


class Stream:
    def __init__(self, messages):
        self.messages, self.closed = list(messages), False

    async def next(self, timeout_s=None):
        if not self.messages:
            await asyncio.sleep(3600)
        return self.messages.pop(0)

    def close(self):
        self.closed = True


class Scope:
    def __init__(self, **streams):
        self.streams = streams
        self.requests = []
        self.catalog = {f"camera.{name}": {} for name in streams}

    def subscribe(self, reference):
        return self.streams[reference.split(".", 1)[1]]

    def operation(self, reference):
        return {"timeout_s": 5}

    async def request(self, reference, **fields):
        self.requests.append((reference, fields))
        if reference.endswith(".detect"):
            return {"results": [{"box": [0, 0, 4, 2], "score": .9, "label": "mug"}]}
        if reference.endswith(".geometry"):
            pinhole = {"model": "pinhole", "fx": 1, "fy": 1, "cx": 0, "cy": 0, "skew": 0}
            streams = {eye: {"width": 4, "height": 2, "frame": f"camera/{eye}", "calibration_id": eye,
                             "projection": pinhole, "distortion": {"model": "opencv_fisheye", "coefficients": [0, 0, 0, 0]}}
                       for eye in ("left", "right")}
            return {"streams": streams}
        return {"rays": [[float(u), float(v), 1.] for u, v in fields["pixels"]]}


STEREO = {"type": "rgb", "layout": "stereo", "left": {"width": 4, "height": 2}, "right": {"width": 4, "height": 2}}


class StereoFrames(unittest.IsolatedAsyncioTestCase):
    async def test_pair_keeps_each_stamp_and_closes_streams(self):
        left, right = Stream([image(1, "camera/left")]), Stream([image(2, "camera/right")])
        pair = await stereo_frame(Scope(left_image=left, right_image=right), "camera")
        self.assertEqual([item.header.frame_id for item in pair], ["camera/left", "camera/right"])
        self.assertEqual([item.header.stamp.sec for item in pair], [1, 2])
        self.assertTrue(left.closed and right.closed)

    async def test_single_read_selects_an_eye(self):
        scope = Scope(left_image=Stream([]), right_image=Stream([image(3, "camera/right")]))
        self.assertEqual((await frame(scope, "camera", eye="right"))[0].header.frame_id, "camera/right")
        with patch.object(images, "profile", lambda _: STEREO):
            with self.assertRaisesRegex(ValueError, "eye is required"):
                await images.camera_frame(scope, "camera")

    async def test_snapshot_returns_both_eyes_and_the_later_stamp(self):
        msg = ModuleType("sensor_msgs.msg")
        msg.Image, msg.JointState = NS, type("JointState", (), {})
        ros = {"sensor_msgs": ModuleType("sensor_msgs"), "sensor_msgs.msg": msg}
        scope = Scope(left_image=Stream([image(1, "camera/left")]), right_image=Stream([image(2, "camera/right")]))
        with patch.dict(sys.modules, ros), patch.dict(sys.modules, {"rclpy": ModuleType("rclpy")}):
            from kinex.host.device import DeviceHost
            host = DeviceHost()
            host.io, host.profile = scope, {**STEREO, "name": "camera", "runtime": {}, "operations": {}}
            sample = await host.run("$sample", {})
        self.assertNotEqual(sample["left_file"], sample["right_file"])
        self.assertEqual((sample["left_frame_id"], sample["right_frame_id"]), ("camera/left", "camera/right"))
        self.assertEqual((sample["left_timestamp"], sample["right_timestamp"], sample["timestamp"]), (1, 2, 2))
        self.assertNotIn("file", sample)
        for key in ("left_file", "right_file"):
            Path(sample[key]).unlink()


class StereoLocate(unittest.IsolatedAsyncioTestCase):
    def scope(self):
        scope = Scope(left_image=Stream([image(1, "camera/left")]), right_image=Stream([image(2, "camera/right")]))
        scope.catalog["camera.geometry"] = {}
        return scope

    async def test_locate_uses_the_selected_eye_stream(self):
        scope = self.scope()
        with patch.object(perception, "profile", lambda _: STEREO), patch.object(geometry_module, "profile", lambda _: STEREO):
            located = await perception.locate_object_3d(scope, "camera", "model", "mug", depth=2, eye="right")
        Path(located["file"]).unlink()
        self.assertEqual(located["frame"], "camera/right")
        unproject = next(fields for reference, fields in scope.requests if reference == "camera.unproject")
        self.assertEqual((unproject["stream"], unproject["calibration_id"]), ("right", "right"))
        self.assertEqual(located["point"][2], 2)

    async def test_eye_must_match_the_camera(self):
        with patch.object(perception, "profile", lambda _: STEREO):
            with self.assertRaisesRegex(ValueError, "eye is required"):
                await perception.locate_object_3d(self.scope(), "camera", "model", "mug", depth=2)
        with patch.object(perception, "profile", lambda _: {"type": "rgb", "layout": "mono", "color": {}}):
            with self.assertRaisesRegex(ValueError, "eye is required"):
                await perception.locate_object_3d(self.scope(), "camera", "model", "mug", depth=2, eye="left")


if __name__ == "__main__":
    unittest.main()
