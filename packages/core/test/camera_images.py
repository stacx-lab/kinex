"""Camera images convert ROS payloads and locate registered 16UC1 depth."""

import os
import unittest
from types import SimpleNamespace

import numpy as np
from PIL import Image

from kinex.camera import array, save
from kinex.object_location import locate


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


if __name__ == "__main__":
    unittest.main()
