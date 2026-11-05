"""Recover known camera models from diverse synthetic calibration views."""
import importlib.util
from pathlib import Path
import unittest

import cv2
import numpy as np

script = Path(__file__).resolve().parents[1] / "assets/builtin/skill/calibrate-camera-intrinsics/scripts/calibrate_intrinsics.py"
spec = importlib.util.spec_from_file_location("calibrate_intrinsics", script)
calibration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calibration)


def coefficients_of(distortion):
    return distortion.get("coefficients") or [distortion[key] for key in ("k1", "k2", "p1", "p2", "k3")]


class Calibration(unittest.TestCase):
    def test_recover_models_from_full_and_partial_boards(self):
        matrix = np.array([[300., 0., 319.5], [0., 310., 239.5], [0., 0., 1.]])
        board = np.zeros((54, 1, 3), np.float32)
        board[:, 0, :2] = (np.mgrid[0:9, 0:6].T.reshape(-1, 2) - [4, 2.5]) * .03
        rng = np.random.default_rng(19)
        for model, coefficients in [("opencv_fisheye", [.03, -.01, .002, -.0001]),
                                    ("opencv_brown_conrady", [.03, -.01, .001, -.002, .002])]:
            project = cv2.fisheye.projectPoints if model == "opencv_fisheye" else cv2.projectPoints
            for partial in (False, True):
                with self.subTest(model=model, partial=partial):
                    objects, images = [], []
                    for i in range(20):
                        obj = board[i % 5:] if partial else board
                        rotation = rng.uniform(-.5, .5, 3)
                        translation = np.array([rng.uniform(-.2, .2), rng.uniform(-.15, .15), rng.uniform(.4, .8)])
                        pixels, _ = project(obj, rotation, translation, matrix, np.array(coefficients))
                        objects.append(obj)
                        images.append(pixels)
                    rms, fitted, distortion, errors = calibration.solve(objects, images, (640, 480), model)
                    self.assertLess(rms, 1e-3)
                    np.testing.assert_allclose(fitted, matrix, atol=.01)
                    self.assertEqual(distortion["model"], model)
                    np.testing.assert_allclose(coefficients_of(distortion), coefficients, atol=.003)
                    self.assertEqual(len(errors), 20)

    def test_fisheye_fold_is_rejected_between_monotonic_endpoints(self):
        self.assertTrue(calibration.fisheye_monotonic([0, 0, 0, 0]))
        self.assertFalse(calibration.fisheye_monotonic([-.5, 0, 0, 0]))


if __name__ == "__main__":
    unittest.main()
