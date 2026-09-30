"""Opt-in preprocessing checks: run with the provisioned FastWAM interpreter."""

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT.parent / "core/assets/python"), str(ROOT / "assets/builtin/device/fastwam")]
spec = importlib.util.spec_from_file_location("fastwam_driver", ROOT / "assets/builtin/device/fastwam/driver.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class Preprocessing(unittest.TestCase):
    def test_camera_order_and_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for i, color in enumerate([(255, 0, 0), (0, 255, 0), (0, 0, 255)]):
                path = Path(directory) / f"{i}.png"
                Image.new("RGB", (640, 480), color).save(path)
                paths.append(str(path))
            libero = driver.image_array(paths[:2], "libero_uncond_2cam224")
            self.assertEqual(libero.shape, (224, 448, 3))
            np.testing.assert_array_equal(libero[0, 0], [255, 0, 0])
            np.testing.assert_array_equal(libero[-1, -1], [0, 255, 0])
            robotwin = driver.image_array(paths, "robotwin_uncond_3cam_384")
            self.assertEqual(robotwin.shape, (384, 320, 3))
            np.testing.assert_array_equal(robotwin[0, 160], [255, 0, 0])
            np.testing.assert_array_equal(robotwin[300, 0], [0, 255, 0])
            np.testing.assert_array_equal(robotwin[300, -1], [0, 0, 255])

    def test_libero_physical_units_and_gripper_sign(self):
        actions = [[2, -2, 0.5, 0.2, -0.2, 0, 0], [0, 0, 0, 0, 0, 0, 1]]
        result = driver.decode_actions(actions, "libero_uncond_2cam224")
        np.testing.assert_allclose(result[0], [0.05, -0.05, 0.025, 0.1, -0.1, 0, 1])
        self.assertEqual(result[1][-1], -1)
        robotwin = [[0.1] * 14]
        np.testing.assert_allclose(driver.decode_actions(robotwin, "robotwin_uncond_3cam_384"), robotwin)
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            driver.decode_actions([[float('nan')] * 7], "libero_uncond_2cam224")


if __name__ == "__main__":
    unittest.main()
