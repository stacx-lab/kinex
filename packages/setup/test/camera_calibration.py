"""Board observations and camera solvers on synthetic stereo evidence (stereo_evidence.py)."""
import asyncio
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import kinex
from kinex.communication import ambient
from kinex.common.camera_geometry import OpenCVGeometry
from kinex.lib import calibration, images
from kinex.lib.calibration import camera
from calibration import ROOT, Workspace

URDF = '<robot name="arm"><link name="base_link"/><link name="flange"/><joint name="j" type="revolute"><parent link="base_link"/><child link="flange"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint></robot>'
# stereo_evidence.py renders its boards through this fisheye camera.
STREAM = {"width": 640, "height": 480, "projection": {"model": "pinhole", "fx": 350., "fy": 355., "cx": 319.5, "cy": 239.5, "skew": 0},
          "distortion": {"model": "opencv_fisheye", "coefficients": [0, 0, 0, 0]}}


def setUpModule():
    global EVIDENCE, directory
    directory = tempfile.TemporaryDirectory()
    EVIDENCE = Path(directory.name)
    subprocess.run([sys.executable, str(Path(__file__).with_name("stereo_evidence.py")), directory.name], check=True)


def tearDownModule():
    directory.cleanup()


def image(index):
    return str(EVIDENCE / f"{index}.png")


def millimetres(values):
    return [round(value * 1000) + 0 for value in values]


class Scope:
    """A camera node serving OpenCV fisheye geometry for every stream."""
    catalog = {"camera.geometry": {}}

    def __init__(self, streams):
        self.adapters = {name: OpenCVGeometry(STREAM, fisheye=True) for name in streams}

    def operation(self, reference, transport=None):
        return self.catalog.get(reference, {})

    async def request(self, reference, **fields):
        if reference.endswith(".geometry"):
            return {"streams": {name: {**STREAM, "frame": f"camera/{name}", "calibration_id": name} for name in self.adapters}}
        return {"rays": self.adapters[fields["stream"]].unproject(fields["pixels"])}


def arm(pose, settled=True):
    return {"device": "arm", "settled": settled, "data": {}, "kinematics": {"frame": "flange", "pose": pose}}


class Observations(Workspace):
    def observe(self, layout, samples, **options):
        self.device("camera", "rgb", layout=layout)
        run = calibration.start("calibrate-camera-extrinsics", target="camera", arm="arm")
        self.record(run, samples)
        streams = ["left", "right"] if layout == "stereo" else ["color"]
        with patch.object(images, "profile", lambda _: self.profiles["camera"]), ambient(Scope(streams)):
            return asyncio.run(camera.observations(run, "camera", 30, **options))

    def test_stereo_views_use_the_last_capture_after_a_settled_pose(self):
        def pair(left):
            return {"device": "camera", "files": {"left": image(left), "right": image(left + 1)}}
        samples = [arm([0, 0, 0, 0, 0, 0, 1]), pair(0), pair(2), arm([1, 0, 0, 0, 0, 0, 1], settled=False), pair(4),
                   arm([2, 0, 0, 0, 0, 0, 1]), {"device": "camera", "files": {"left": image(6), "right": "missing.png"}},
                   arm([3, 0, 0, 0, 0, 0, 1]), pair(8)]
        result = self.observe("stereo", samples, arm="arm", frame="flange")
        views = result["views"]
        self.assertEqual([view["samples"] for view in views], [{"camera": 2, "arm": 0}, {"camera": 8, "arm": 7}])
        self.assertEqual([view["frame_pose"][0] for view in views], [0, 3])
        self.assertEqual([item["index"] for item in result["rejected"]], [1, 3, 4, 6])
        self.assertEqual(result["calibration_id"], {"left": "left", "right": "right"})
        self.assertEqual(json.loads(Path(result["evidence"]).read_text())["views"], views)
        rays = np.asarray(views[0]["left"]["rays"])
        self.assertTrue(len(rays) >= 6 and np.allclose(rays[:, 2], 1))
        self.assertEqual(len(views[0]["left"]["object_points"]), len(rays))
        # Without an arm, every stereo capture is a view for the eye-to-eye solve.
        eyes = self.observe("stereo", [pair(0), pair(2)])["views"]
        self.assertEqual([("frame_pose" in view, view["samples"]) for view in eyes], [(False, {"camera": 0}), (False, {"camera": 1})])

    def test_single_streams_give_board_poses_in_front_of_the_camera(self):
        mono = {"device": "camera", "files": {"color": image(0)}}
        views = self.observe("mono", [arm([0, 0, 0, 0, 0, 0, 1]), mono], arm="arm", frame="flange")["views"]
        self.assertEqual(len(views), 1)
        self.assertGreater(views[0]["tvec"][2], .2)
        eye = {"device": "camera", "files": {"left": image(0), "right": image(1)}}
        left = self.observe("stereo", [arm([0, 0, 0, 0, 0, 0, 1]), eye], arm="arm", frame="flange", eye="left")["views"]
        np.testing.assert_allclose(left[0]["tvec"], views[0]["tvec"], atol=1e-9)
        with self.assertRaisesRegex(ValueError, "need arm and frame"):
            self.observe("mono", [mono])


class Stereo(Workspace):
    def setUp(self):
        super().setUp()
        self.joint("arm", URDF)
        self.device("mono", "rgb", layout="mono")

    def pair(self, left="pair:base", right="pair:left"):
        unknown = {"translation_m": "???", "rotation_xyzw": "???"}
        self.device("pair", "rgb", layout="stereo", left="???", right="???",
                    frames={"base": ROOT, "left": {"parent": left, **unknown}, "right": {"parent": right, **unknown}})

    def test_each_eye_solves_alone_and_its_proposals_fit_the_profile(self):
        self.pair()
        run = calibration.start("calibrate-camera-intrinsics", target="pair")
        captures = [image(index) for index in range(16)]
        self.record(run, [{"device": "arm", "data": {}}, *({"device": "pair", "files": {"left": file, "right": file}} for file in captures)])
        with self.assertRaisesRegex(ValueError, "eye is required"):
            camera.intrinsics(run, 30, model="opencv_fisheye")
        mono = calibration.start("calibrate-camera-intrinsics", target="mono")
        with self.assertRaisesRegex(ValueError, "eye is required"):
            camera.intrinsics(mono, 30, eye="left", images=captures, model="opencv_fisheye")
        with self.assertRaisesRegex(ValueError, "choose model"):
            camera.intrinsics(run, 30, eye="left")
        solved = camera.intrinsics(run, 30, eye="left", model="opencv_fisheye")
        self.assertNotEqual(solved["quality"], "failed", solved["data"])
        self.assertEqual(solved["data"]["frames_used"], 16)
        self.assertTrue(all(fact["pointer"].startswith("/left/") for fact in solved["resolved"]))
        self.apply(solved)
        # The profile now supplies the lens model; the other eye still needs one.
        self.assertEqual(camera.intrinsics(run, 30, eye="left")["data"]["distortion"]["model"], "opencv_fisheye")
        with self.assertRaisesRegex(ValueError, "choose model"):
            camera.intrinsics(run, 30, eye="right")
        right = camera.intrinsics(run, 30, eye="right", model="opencv_fisheye", images=captures)
        self.assertTrue(all(fact["pointer"].startswith("/right/") for fact in right["resolved"]))
        # Images from outside the run are archived as the solve's inputs.
        self.assertEqual(len(list((run.directory / "artifacts").iterdir())), len(captures))

        pairs = json.loads((EVIDENCE / "pairs.json").read_text())
        hand_eye = calibration.start("calibrate-camera-extrinsics", target="pair", arm="arm")
        with self.assertRaisesRegex(ValueError, "eye is required"):
            camera.extrinsics(hand_eye, pairs, "eye_in_hand", "flange")
        mounted = camera.extrinsics(hand_eye, pairs, "eye_in_hand", "flange", eye="right")
        self.assertEqual(mounted["quality"], "passed", mounted["data"])
        self.assertTrue(all(fact["pointer"].split("/")[2] in ("base", "right") for fact in mounted["resolved"]))
        self.apply(mounted)
        profile = self.profiles["pair"]
        self.assertEqual(len(profile["left"]["distortion"]["coefficients"]), 4)
        geometry = OpenCVGeometry(profile["left"], fisheye=True)
        np.testing.assert_allclose(geometry.project(geometry.unproject([[400., 300.]])), [[400, 300]], atol=1e-3)
        self.assertEqual(profile["right"], "???")
        self.assertEqual(profile["frames"]["base"]["parent"], "arm:flange")
        self.assertEqual(millimetres(profile["frames"]["base"]["translation_m"]), [30, -60, 50])
        self.assertEqual(profile["frames"]["right"], {"parent": "pair:base", "translation_m": [0, 0, 0], "rotation_xyzw": [0, 0, 0, 1]})
        self.assertEqual(profile["frames"]["left"], {"parent": "pair:right", "translation_m": "???", "rotation_xyzw": "???"})

        # The second eye is placed relative to the reference and leaves the measured base alone.
        second = camera.extrinsics(hand_eye, pairs, "eye_in_hand", "flange", eye="left")["proposed"]["frames"]
        self.assertEqual(list(second), ["left"])
        self.assertEqual((second["left"]["parent"], millimetres(second["left"]["translation_m"])), ("pair:right", [0, 0, 0]))
        # A known eye-to-eye transform, here a factory baseline, places base from either eye.
        profile["frames"]["left"] = {"parent": "pair:right", "translation_m": [.06, 0, 0], "rotation_xyzw": [0, 0, 0, 1]}
        factory = camera.extrinsics(hand_eye, pairs, "eye_in_hand", "flange", eye="left")["proposed"]["frames"]
        self.assertNotIn("left", factory)
        self.assertEqual((factory["base"]["parent"], millimetres(factory["base"]["translation_m"])), ("arm:flange", [-27, -78, 50]))

    def test_joint_stereo_solve_recovers_the_mount_and_eye_to_eye_transform(self):
        self.pair()
        views = {name: json.loads((EVIDENCE / f"stereo_{name}.json").read_text()) for name in ("in_hand", "to_hand", "biased")}
        mono = calibration.start("calibrate-camera-extrinsics", target="mono", arm="arm")
        with self.assertRaisesRegex(ValueError, "not a stereo rgb camera"):
            camera.stereo_extrinsics(mono, views["in_hand"], "eye_in_hand", "flange")
        armless = calibration.start("calibrate-camera-extrinsics", target="pair")
        with self.assertRaisesRegex(ValueError, "binds no arm"):
            camera.stereo_extrinsics(armless, views["in_hand"], "eye_in_hand", "flange")
        run = calibration.start("calibrate-camera-extrinsics", target="pair", arm="arm")
        for name, mode, parent in (("in_hand", "eye_in_hand", "arm:flange"), ("to_hand", "eye_to_hand", "arm:base")):
            value = camera.stereo_extrinsics(run, views[name], mode, "flange")
            self.assertEqual(value["quality"], "passed", value["data"])
            self.assertEqual(value["proposed"]["frames"]["base"]["parent"], parent)
            self.assertEqual(millimetres(value["data"]["translation_m"]), [30, -60, 50])
            self.assertEqual(millimetres(value["data"]["partner_translation_m"]), [60, 0, 0])
            self.assertAlmostEqual(value["data"]["baseline_m"], .06, delta=1e-3)
            self.apply(value)
        frames = self.profiles["pair"]["frames"]
        self.assertEqual(frames["left"], {"parent": "pair:base", "translation_m": [0, 0, 0], "rotation_xyzw": [0, 0, 0, 1]})
        self.assertEqual((frames["right"]["parent"], millimetres(frames["right"]["translation_m"])), ("pair:left", [60, 0, 0]))

        # keep holds the known eye-to-eye transform and solves only the mount.
        kept = camera.stereo_extrinsics(run, views["in_hand"], "eye_in_hand", "flange", eye_to_eye="keep")
        self.assertEqual(kept["quality"], "passed", kept["data"])
        self.assertEqual(millimetres(kept["data"]["translation_m"]), [30, -60, 50])
        self.assertEqual(millimetres(kept["data"]["partner_translation_m"]), millimetres(frames["right"]["translation_m"]))
        self.assertNotIn("right", kept["proposed"]["frames"])
        with self.assertRaisesRegex(ValueError, "only when solving"):
            camera.stereo_extrinsics(run, views["in_hand"], "eye_in_hand", "flange", eye_to_eye="keep", nominal_baseline_m=.06)

        # The profile's chain names the reference; with right as reference the transform inverts.
        self.pair(left="pair:right", right="pair:base")
        swapped = camera.stereo_extrinsics(run, views["in_hand"], "eye_in_hand", "flange", nominal_baseline_m=.06)
        self.assertLess(swapped["data"]["baseline_error_m"], 1e-3)
        self.assertEqual((swapped["proposed"]["frames"]["left"]["parent"], swapped["proposed"]["frames"]["right"]["parent"]), ("pair:right", "pair:base"))

        biased = camera.stereo_extrinsics(run, views["biased"], "eye_in_hand", "flange")
        self.assertEqual((biased["quality"], biased["proposed"]), ("failed", None))

        # Without a robot, paired views of a still board measure only the eye-to-eye transform.
        eyes = calibration.start("calibrate-camera-extrinsics", target="pair")
        measured = camera.eye_to_eye(eyes, views["to_hand"], nominal_baseline_m=.06)
        self.assertEqual(measured["quality"], "passed", measured["data"])
        self.assertNotIn("translation_m", measured["data"])
        self.assertEqual((measured["proposed"]["method"], list(measured["proposed"]["frames"])), ("stereo", ["left"]))
        self.assertEqual(measured["proposed"]["frames"]["left"]["parent"], "pair:right")
        self.assertAlmostEqual(measured["data"]["baseline_m"], .06, delta=1e-3)
        # A solved baseline that disagrees with the nominal one fails.
        self.assertEqual(camera.eye_to_eye(eyes, views["to_hand"], nominal_baseline_m=.08)["quality"], "failed")


if __name__ == "__main__":
    unittest.main()
