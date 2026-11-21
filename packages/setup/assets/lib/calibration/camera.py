"""Camera intrinsics and mounts from calibration-board views.

Capture views with run.sample(camera), after run.sample(arm, frame=...) at each pose for a
mount. Board options, shared by observations and intrinsics: board "charuco" (squares
(columns, rows), marker_mm defaulting to 3/4 of square_mm, dictionary) or "checkerboard"
(corners, the inner corner counts). square_mm and marker_mm are measured on the print, not
nominal. A stereo camera's frames chain base -> reference eye -> other eye, the reference
being the eye whose parent is <camera>:base; proposals never discard a known edge, so apply
each accepted one before the next solve.
"""
import kinex
from kinex.lib.calibration import CalibrationError, _frames
from kinex.lib.calibration import _board, _hand_eye, _intrinsics
from kinex.values import components, pose

LENS_MODELS = ("opencv_brown_conrady", "opencv_fisheye")
BOARD = {"board": "charuco", "squares": (7, 5), "marker_mm": None, "dictionary": "DICT_4X4_50", "corners": (9, 6)}


async def observations(run, camera, square_mm, *, arm=None, frame=None, eye=None, **board):
    """Board observations in the run's captures, for extrinsics, stereo_extrinsics and eye_to_eye.

    With arm and frame, each arm sample's frame pose pairs with the last camera capture after
    it, so a retake replaces the earlier one; an arm sample that failed to settle is rejected
    with its captures. Corners are unprojected through the camera's active geometry, so any
    lens model works. A stereo camera observes both eyes, or one with eye; without an arm
    every capture is a view, for eye_to_eye. Returns {views, rejected, calibration_id,
    evidence}; keep the rejections and calibration IDs as evidence.

    Example: seen = await lib.calibration.camera.observations(run, "camera", 30, arm="arm", frame="flange")
    """
    from kinex.common.camera import camera_stream, stereo
    from kinex.lib.images import camera_geometry
    profile = kinex.profile(camera)
    streams = ["left", "right"] if stereo(profile) and eye is None else [camera_stream(profile, eye)]
    if len(streams) == 1 and arm is None:
        raise ValueError("single-stream observations need arm and frame for hand-eye calibration")
    if (arm is None) != (frame is None):
        raise ValueError("arm and frame go together")
    views, rejected = _board.pair(run.samples(), camera, arm, frame)
    geometry = await camera_geometry(camera)
    detect = _board.detector(square_mm=square_mm, **{**BOARD, **board})
    entries = []
    for sample, posed in views:
        seen = {stream: await _board.observe(geometry, detect, sample.get("files", {}).get(stream), stream) for stream in streams}
        if len(streams) == 1:
            seen = {stream: _board.board_pose(value) if isinstance(value, dict) else value for stream, value in seen.items()}
        failed = [f"{stream}: {value}" for stream, value in seen.items() if isinstance(value, str)]
        if failed:
            rejected.append({"index": sample["index"], "reason": "; ".join(failed)})
            continue
        entry = {"samples": {"camera": sample["index"], **({"arm": posed["index"]} if posed else {})},
                 **({"frame_pose": posed["kinematics"]["pose"]} if posed else {})}
        entries.append({**entry, **(seen[streams[0]] if len(streams) == 1 else seen)})
    result = {"views": entries, "rejected": sorted(rejected, key=lambda item: item["index"]),
              "calibration_id": {stream: geometry.streams[stream].get("calibration_id") for stream in streams}}
    return {**result, "evidence": run.save("observations", result)}


def intrinsics(run, square_mm, *, eye=None, model=None, images=None, **board):
    """The bound target camera's projection and distortion from board views.

    images defaults to the run's captures of the target, of eye for a stereo camera; pass a
    subset to exclude captures. model defaults to the stream's current distortion model:
    choose opencv_brown_conrady, or opencv_fisheye for fisheye lenses, whose coefficients
    [k1, k2, k3, k4] suit OpenCVGeometry(stream, fisheye=True). Needs 10 usable views; RMS
    < 0.5 px passes, up to 1 px or an uncovered image quadrant warns, beyond fails. Proposes
    the stream's width, height, projection and distortion; depth facts are not measured.

    Example: result = lib.calibration.camera.intrinsics(run, 30, model="opencv_brown_conrady")
    """
    import cv2
    target = run.role("target")
    stream = _stream(target, eye)
    model = model or _lens(target, stream)
    if model not in LENS_MODELS:
        raise ValueError(f"model is one of {', '.join(LENS_MODELS)}")
    if images is None:
        images = [sample["files"][stream] for sample in run.samples(target) if stream in sample.get("files", {})]
        if not images:
            raise ValueError(f"run {run.id} has no {stream} captures of {target}; sample the camera or pass images")
    else:
        images = [file if str(file).startswith(str(run.directory)) else run.archive(file) for file in images]
    detect = _board.detector(square_mm=square_mm, **{**BOARD, **board})

    def solve():
        size, objects, pixels, used, rejected = None, [], [], [], []
        for index, file in enumerate(images):
            image = cv2.imread(str(file), cv2.IMREAD_GRAYSCALE)
            if image is None:
                rejected.append({"index": index, "reason": "unreadable image"})
                continue
            if size is None:
                size = (image.shape[1], image.shape[0])
            elif (image.shape[1], image.shape[0]) != size:
                raise CalibrationError(f"image {index} has a different resolution than the first; calibrate one stream at a time")
            found = detect(image)
            if isinstance(found, str):
                rejected.append({"index": index, "reason": found})
                continue
            objects.append(found[0])
            pixels.append(found[1])
            used.append(index)
        if len(objects) < 10:
            raise CalibrationError(f"only {len(objects)} usable detections out of {len(images)} images (need >= 10); recapture with the "
                                   "board sharp, fully visible and matching the declared geometry", frames_used=len(objects), rejected=rejected)
        try:
            rms, matrix, distortion, errors, kept = _intrinsics.solve(objects, pixels, size, model, 10)
        except (cv2.error, ValueError) as error:
            raise CalibrationError(f"{model} calibration failed: {error}", rejected=rejected) from None
        rejected += [{"index": index, "reason": "ill-conditioned view"} for position, index in enumerate(used) if position not in kept]
        return {"width": size[0], "height": size[1], "distortion": distortion, "rms_px": rms, "frames_used": len(kept),
                "projection": {"model": "pinhole", "fx": float(matrix[0, 0]), "fy": float(matrix[1, 1]),
                               "cx": float(matrix[0, 2]), "cy": float(matrix[1, 2]), "skew": 0.},
                "frames": [{"index": used[position], "error_px": round(error, 3)} for position, error in zip(kept, errors)],
                "rejected": sorted(rejected, key=lambda item: item["index"]),
                "coverage_warnings": _intrinsics.coverage([pixels[position] for position in kept], size)}

    def quality(data):
        if data["rms_px"] > 1 or data["frames_used"] < 10:
            return "failed"
        return "warning" if data["rms_px"] >= .5 or data["coverage_warnings"] else "passed"

    def facts(data):
        fields = {key: data[key] for key in ("width", "height", "projection", "distortion")}
        return board.get("board", BOARD["board"]), {stream: fields}, [(f"/{stream}/{key}", value) for key, value in fields.items()]

    return run._solve("camera-intrinsics", solve, quality, facts)


def extrinsics(run, observations, mode, frame, *, eye=None):
    """The bound target camera's mount from board views paired with poses of the bound arm (Tsai).

    mode eye_in_hand: the camera rides on frame and the board is fixed; eye_to_hand: the
    camera is fixed and the board rides on frame, giving the mount in the arm base. A stereo
    camera solves one eye: the proposal places base when that eye's chain to base is known,
    else the other eye relative to the measured reference. Needs 5 views; passes with
    rotation residual <= 2 deg and translation <= 10 mm. The mount is camera-in-parent.

    Example: result = lib.calibration.camera.extrinsics(run, seen, "eye_in_hand", "flange")
    """
    _stream(run.role("target"), eye)
    parent = _parent(run, mode, frame)
    views = _views(observations)

    def facts(data):
        solved = {"parent": parent, "translation_m": data["translation_m"], "rotation_xyzw": data["rotation_xyzw"]}
        return _frames("hand_eye", _place(run, eye, solved) if eye else {"base": solved})

    def quality(data):
        return "passed" if data["pairs_used"] >= 5 and data["residual_rot_deg"] <= 2 and data["residual_trans_mm"] <= 10 else "failed"

    return run._solve("camera-extrinsics", lambda: _hand_eye.tsai(views, mode), quality, facts)


def stereo_extrinsics(run, observations, mode, frame, *, eye_to_eye="solve", nominal_baseline_m=None):
    """The bound stereo target's mount on the bound arm, with both eyes constraining one model.

    eye_to_eye "keep" holds the profile's known transform between the eyes and solves the
    mount; "solve" measures both. Views need both eyes on the board. Needs 5 views; passes
    with RMS angular residual <= 0.5 deg and, with nominal_baseline_m (solve only), a solved
    baseline within 5% of it (at least 2 mm). Inspect the per-view residuals.

    Example: result = lib.calibration.camera.stereo_extrinsics(run, seen, "eye_in_hand", "flange", eye_to_eye="keep")
    """
    target, reference, other, edges = _stereo_target(run)
    parent = _parent(run, mode, frame)
    if eye_to_eye not in ("keep", "solve"):
        raise ValueError("eye_to_eye is keep or solve")
    if eye_to_eye == "keep" and nominal_baseline_m is not None:
        raise ValueError("nominal_baseline_m applies only when solving the eye-to-eye transform")
    between = edges.get(other) if eye_to_eye == "keep" else None
    if eye_to_eye == "keep" and _edge(between) is None:
        raise ValueError(f"eye_to_eye keep needs a known frames.{other}; solve it, or use eye_to_eye solve")
    views = _views(observations)

    def facts(data):
        placed = _place(run, reference, {"parent": parent, "translation_m": data["translation_m"], "rotation_xyzw": data["rotation_xyzw"]})
        partner = {"parent": f"{target}:{reference}", "translation_m": data["partner_translation_m"], "rotation_xyzw": data["partner_rotation_xyzw"]}
        return _frames("hand_eye", {**placed, other: partner} if eye_to_eye == "solve" else placed)

    return run._solve("camera-stereo-extrinsics", lambda: _baseline(_hand_eye.stereo(views, mode, reference, between), nominal_baseline_m),
                      _stereo_quality, facts)


def eye_to_eye(run, observations, *, nominal_baseline_m=None):
    """The bound stereo target's other eye in its reference eye, from paired views without an arm.

    Hold the board still at each capture, as for intrinsics; there is no hand-eye error.
    Same gates as stereo_extrinsics.

    Example: result = lib.calibration.camera.eye_to_eye(run, seen, nominal_baseline_m=0.06)
    """
    target, reference, other, _ = _stereo_target(run)
    views = _views(observations)

    def facts(data):
        return _frames("stereo", {other: {"parent": f"{target}:{reference}", "translation_m": data["partner_translation_m"],
                                          "rotation_xyzw": data["partner_rotation_xyzw"]}})

    return run._solve("camera-eye-to-eye", lambda: _baseline(_hand_eye.stereo(views, "eyes", reference), nominal_baseline_m),
                      _stereo_quality, facts)


def _views(observations):
    return observations["views"] if isinstance(observations, dict) else observations


def _parent(run, mode, frame):
    """The solved mount's parent: the arm's link for eye_in_hand, its base for eye_to_hand."""
    if mode not in ("eye_in_hand", "eye_to_hand"):
        raise ValueError("mode is eye_in_hand or eye_to_hand")
    return f"{run.role('arm')}:{'base' if mode == 'eye_to_hand' else frame}"


def _stream(target, eye):
    """The calibrated stream: color, or a stereo camera's eye, which it requires."""
    from kinex.common.camera import camera_stream
    return camera_stream(kinex.profile(target), eye)


def _lens(target, stream):
    """The stream's current OpenCV distortion model."""
    descriptor = kinex.profile(target).get(stream)
    distortion = descriptor.get("distortion") if isinstance(descriptor, dict) else None
    model = distortion.get("model") if isinstance(distortion, dict) else None
    if model not in LENS_MODELS:
        raise ValueError("choose model: opencv_brown_conrady, or opencv_fisheye for fisheye lenses")
    return model


def _stereo_target(run):
    """The bound stereo target, its reference and other eye, and its frames."""
    target = run.role("target")
    profile = kinex.profile(target)
    if profile["type"] != "rgb" or profile.get("layout") != "stereo":
        raise ValueError(f"{target} is not a stereo rgb camera")
    reference = "left" if profile["frames"].get("left", {}).get("parent") == f"{target}:base" else "right"
    return target, reference, "right" if reference == "left" else "left", profile["frames"]


def _edge(edge):
    """A frame edge's transform when both parts are known; None for ??? or a root."""
    if not isinstance(edge, dict) or not all(isinstance(edge.get(key), list) for key in ("translation_m", "rotation_xyzw")):
        return None
    return pose([*edge["translation_m"], *edge["rotation_xyzw"]])


def _written(transform):
    values = components(transform).tolist()
    return {"translation_m": values[:3], "rotation_xyzw": values[3:]}


def _place(run, eye, solved):
    """Frame edges placing one solved eye mount in the stereo chain without discarding a known edge."""
    target, reference, other, edges = _stereo_target(run)
    measured, known, identity = _edge(solved), _edge(edges.get(reference)), pose([0, 0, 0, 0, 0, 0, 1])
    start = identity if known is None else known
    edge = _edge(edges.get(eye))
    path = start if eye == reference else None if edge is None else start * edge
    if path is not None:
        # The eye's chain is known: the solve places base, writing an unknown reference as identity.
        return {"base": {"parent": solved["parent"], **_written(measured * path.inv())},
                reference: {"parent": f"{target}:base", **_written(start)}}
    base = _edge(edges.get("base"))
    if base is None:
        return {"base": {"parent": solved["parent"], **_written(measured)}, eye: {"parent": f"{target}:base", **_written(identity)},
                reference: {"parent": f"{target}:{eye}", "translation_m": "???", "rotation_xyzw": "???"}}
    if edges["base"]["parent"] != solved["parent"]:
        raise ValueError(f"{target} is mounted on {edges['base']['parent']}; solve {eye} in that frame")
    if known is None:
        raise ValueError(f"frames.{reference} is unknown; calibrate the reference eye first")
    return {other: {"parent": f"{target}:{reference}", **_written((base * known).inv() * measured)}}


def _baseline(data, nominal):
    """A solved eye-to-eye baseline must match the nominal one within 5% (at least 2 mm)."""
    if nominal is None:
        return data
    return {**data, "baseline_error_m": abs(data["baseline_m"] - nominal), "baseline_tolerance_m": max(.002, .05 * nominal)}


def _stereo_quality(data):
    baseline = "baseline_error_m" not in data or data["baseline_error_m"] <= data["baseline_tolerance_m"]
    return "passed" if data["pairs_used"] >= 5 and data["residual_deg"] <= .5 and baseline else "failed"
