"""Board observations pair retaken captures with settled arm poses and unproject through node geometry."""
import asyncio
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from kinex.helpers import camera_geometry as geometry_module
from kinex.lib.camera_geometry import OpenCVGeometry

script = Path(__file__).resolve().parents[1] / "assets/builtin/skill/calibrate-camera-extrinsics/scripts/board_observations.py"
spec = importlib.util.spec_from_file_location("board_observations", script)
board = importlib.util.module_from_spec(spec)
spec.loader.exec_module(board)

# stereo_evidence.py renders its boards through this fisheye camera.
STREAM = {"width": 640, "height": 480, "projection": {"model": "pinhole", "fx": 350., "fy": 355., "cx": 319.5, "cy": 239.5, "skew": 0},
          "distortion": {"model": "opencv_fisheye", "coefficients": [0, 0, 0, 0]}}


class Scope:
    """A camera node serving OpenCV fisheye geometry for every stream."""
    catalog = {"camera.geometry": {}}

    def __init__(self, streams):
        self.adapters = {name: OpenCVGeometry(STREAM, fisheye=True) for name in streams}

    async def request(self, reference, **fields):
        if reference.endswith(".geometry"):
            return {"streams": {name: {**STREAM, "frame": f"camera/{name}", "calibration_id": name} for name in self.adapters}}
        return {"rays": self.adapters[fields["stream"]].unproject(fields["pixels"])}


def arm(index, pose, settled=True):
    return {"index": index, "device": "arm", "settled": settled, "data": {}, "kinematics": {"frame": "flange", "pose": pose}}


class Observations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        subprocess.run([sys.executable, str(Path(__file__).with_name("stereo_evidence.py")), cls.directory.name], check=True)
        cls.image = lambda _, index: str(cls.root / f"{index}.png")

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def run_observations(self, layout, samples, *argv):
        files = self.root / "samples.json", self.root / "observations.json"
        files[0].write_text(json.dumps(samples))
        args = board.parse(["--samples", str(files[0]), "--camera", "camera", "--output", str(files[1]), "--square-mm", "30", *argv])
        camera = {"type": "rgb", "layout": layout}
        streams = ["left", "right"] if layout == "stereo" else ["color"]
        with patch.object(board, "profile", lambda _: camera), patch.object(geometry_module, "profile", lambda _: camera):
            result = asyncio.run(board.observations(Scope(streams), args))
        return result, json.loads(files[1].read_text())

    def test_stereo_views_use_the_last_capture_after_a_settled_pose(self):
        pair = lambda index, image: {"index": index, "device": "camera", "data": {"left_file": self.image(image), "right_file": self.image(image + 1)}}
        samples = [arm(0, [0, 0, 0, 0, 0, 0, 1]), pair(1, 0), pair(2, 2),
                   arm(3, [1, 0, 0, 0, 0, 0, 1], settled=False), pair(4, 4),
                   arm(5, [2, 0, 0, 0, 0, 0, 1]), {"index": 6, "device": "camera", "data": {"left_file": self.image(6), "right_file": "missing.png"}},
                   arm(7, [3, 0, 0, 0, 0, 0, 1]), pair(8, 8)]
        result, views = self.run_observations("stereo", samples, "--arm", "arm", "--frame", "flange")
        self.assertEqual([view["samples"] for view in views], [{"camera": 2, "arm": 0}, {"camera": 8, "arm": 7}])
        self.assertEqual([view["frame_pose"][0] for view in views], [0, 3])
        self.assertEqual([item["index"] for item in result["rejected"]], [1, 3, 4, 6])
        self.assertEqual(result["calibration_id"], {"left": "left", "right": "right"})
        rays = np.asarray(views[0]["left"]["rays"])
        self.assertTrue(len(rays) >= 6 and np.allclose(rays[:, 2], 1))
        self.assertEqual(len(views[0]["left"]["object_points"]), len(rays))

        # Without an arm, every stereo capture is a view for the eye-to-eye solve.
        _, eyes = self.run_observations("stereo", [pair(0, 0), pair(1, 2)])
        self.assertEqual([("frame_pose" in view, view["samples"]) for view in eyes], [(False, {"camera": 0}), (False, {"camera": 1})])

    def test_single_streams_give_board_poses_in_front_of_the_camera(self):
        mono = {"index": 1, "device": "camera", "file": self.image(0), "data": {}}
        _, views = self.run_observations("mono", [arm(0, [0, 0, 0, 0, 0, 0, 1]), mono], "--arm", "arm", "--frame", "flange")
        self.assertEqual(len(views), 1)
        self.assertGreater(views[0]["tvec"][2], .2)
        eye = {"index": 1, "device": "camera", "data": {"left_file": self.image(0), "right_file": self.image(1)}}
        _, left = self.run_observations("stereo", [arm(0, [0, 0, 0, 0, 0, 0, 1]), eye], "--arm", "arm", "--frame", "flange", "--eye", "left")
        np.testing.assert_allclose(left[0]["tvec"], views[0]["tvec"], atol=1e-9)
        with self.assertRaisesRegex(ValueError, "need --arm"):
            self.run_observations("mono", [mono])


if __name__ == "__main__":
    unittest.main()
