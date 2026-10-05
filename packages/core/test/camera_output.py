"""Camera output modes preserve pixels, timestamps and buffer ownership."""

import base64
import tempfile
import unittest
from pathlib import Path

import numpy as np

from kinex.capture import arrays, output_mode, save

PROFILE = {
    "type": "rgbd",
    "intrinsics": {
        "color": {"width": 2, "height": 2},
        "depth": {"width": 2, "height": 2, "invalid_value": 0,
                  "scale_m_per_unit": 0.001, "valid_range_m": {"min": 0.001, "max": 65.535}},
    },
}


class CameraOutput(unittest.TestCase):
    def test_modes_preserve_rgb_depth_and_timestamp(self):
        sample = {"timestamp": 12.5, "color": np.arange(12, dtype=np.uint8).reshape(2, 2, 3),
                  "depth": np.array([[0, 1], [256, 65535]], dtype=np.uint16)}
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "images"
            encoded = save(PROFILE, sample, out, "base64")
            wire = save(PROFILE, sample, out, "array")
            self.assertFalse(out.exists())
            self.assertEqual(encoded, wire)
            decoded = arrays(PROFILE, wire)
            files = save(PROFILE, sample, out)
            self.assertEqual(files["timestamp"], decoded["timestamp"])
            for key, file_key in (("color", "file"), ("depth", "depth_file")):
                self.assertEqual(base64.b64decode(encoded[key]), Path(files[file_key]).read_bytes())
                np.testing.assert_array_equal(decoded[key], sample[key])
                self.assertEqual(decoded[key].dtype, sample[key].dtype)
                self.assertTrue(decoded[key].flags.owndata)
                self.assertTrue(decoded[key].flags.writeable)
                decoded[key].fill(0)
                self.assertTrue(sample[key].any())
            rgb = {**PROFILE, "type": "rgb"}
            self.assertNotIn("depth", save(rgb, sample, out, "base64"))

    def test_invalid_modes_and_corrupt_images_fail(self):
        for mode in (None, "bytes", 1, []):
            with self.assertRaises(ValueError):
                output_mode(mode)
        with self.assertRaises(ValueError):
            arrays(PROFILE, {"timestamp": 1, "color": "!"})


if __name__ == "__main__":
    unittest.main()
