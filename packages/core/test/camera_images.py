"""Camera images convert ROS payloads, pair frames from topics and locate registered 16UC1 depth."""

import asyncio
import os
import unittest
from types import SimpleNamespace

import numpy as np
from PIL import Image

from kinex.lib.camera import array, frame, save
from kinex.helpers.perception import _locate as locate


def message(encoding, values, bigendian=False, pad=0):
    values = np.asarray(values)
    dtype = values.dtype.newbyteorder(">" if bigendian else "<")
    rows = values.astype(dtype).reshape(values.shape[0], -1)
    padded = np.zeros((rows.shape[0], rows.shape[1] + pad), dtype)
    padded[:, :rows.shape[1]] = rows
    return SimpleNamespace(encoding=encoding, is_bigendian=bigendian, height=values.shape[0],
                           width=values.shape[1], step=padded.strides[0], data=padded.tobytes())


class CameraImages(unittest.TestCase):
    def test_conversion_honors_stride_channel_order_and_byte_order(self):
        rgb = np.arange(12, dtype=np.uint8).reshape(2, 2, 3)
        np.testing.assert_array_equal(array(message("rgb8", rgb, pad=2)), rgb)
        np.testing.assert_array_equal(array(message("bgr8", rgb[:, :, ::-1])), rgb)
        depth = np.array([[0, 1], [256, 65535]], dtype=np.uint16)
        converted = array(message("16UC1", depth, bigendian=True))
        self.assertEqual(converted.dtype, np.dtype(np.uint16))
        np.testing.assert_array_equal(converted, depth)
        path = save(message("16UC1", depth, bigendian=True))
        try:
            with Image.open(path) as image:
                np.testing.assert_array_equal(np.asarray(image), depth)
        finally:
            os.unlink(path)

    def test_locate_uses_valid_registered_depth_in_the_region(self):
        stream = {"width": 3, "height": 3, "projection": {"fx": 1, "fy": 1, "cx": 1, "cy": 1, "skew": 0},
                  "distortion": {"model": "none"}}
        profile = {"color": stream, "depth": {**stream, "registration": "color", "quantity": "z",
                                              "scale_m_per_unit": .001, "invalid_value": 0, "reliable_range_m": None,
                                              "valid_range_m": {"min": .001, "max": 65.535}}}
        depth = np.full((3, 3), 2000, dtype=np.uint16)
        depth[0, 0] = 0
        result = locate(profile, np.ones((3, 3), dtype=bool), depth_image=message("16UC1", depth))
        self.assertEqual(result["depth_samples"], 8)
        self.assertEqual(result["pixel"], [1, 1])
        np.testing.assert_allclose(result["point"], [0, 0, 2])
        with self.assertRaisesRegex(ValueError, "16UC1"):
            locate(profile, np.ones((3, 3), dtype=bool), depth_image=message("mono8", depth.astype(np.uint8)))


def stamped(seconds):
    return SimpleNamespace(header=SimpleNamespace(stamp=SimpleNamespace(sec=seconds, nanosec=0)))


class Stream:
    def __init__(self, stamps):
        self.messages, self.closed = [stamped(s) for s in stamps], False

    async def next(self, timeout_s=None):
        if not self.messages:
            await asyncio.sleep(3600)
        return self.messages.pop(0)

    def close(self):
        self.closed = True


def scope(**streams):
    return SimpleNamespace(catalog={f"camera.{name}": {"timeout_s": 1} for name in streams},
                           subscribe=lambda reference: streams[reference.split(".", 1)[1]],
                           operation=lambda reference: {"timeout_s": 1})


class CameraFrames(unittest.IsolatedAsyncioTestCase):
    async def test_rgb_reads_one_image_and_closes_its_stream(self):
        image = Stream([4])
        self.assertEqual(await frame(scope(image=image), "camera"), (stamped(4), None))
        self.assertTrue(image.closed)

    async def test_rgbd_pairs_image_and_depth_with_equal_stamps(self):
        image, depth = Stream([1, 2, 3]), Stream([2])
        color, registered = await frame(scope(image=image, depth=depth), "camera")
        self.assertEqual((color.header.stamp.sec, registered.header.stamp.sec), (2, 2))
        self.assertTrue(image.closed and depth.closed)

    async def test_unpaired_streams_time_out_and_close(self):
        image, depth = Stream([1]), Stream([2])
        with self.assertRaises(TimeoutError):
            await frame(scope(image=image, depth=depth), "camera", timeout_s=.05)
        self.assertTrue(image.closed and depth.closed)


if __name__ == "__main__":
    unittest.main()
