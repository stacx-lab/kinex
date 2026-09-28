---
name: calibrate-camera-intrinsics
description: Measure a camera's focal length, principal point and distortion from photos of a printed ChArUco/checkerboard target. Use for a queued intrinsics item on an rgb/rgbd device.
resolves: intrinsics:rgb,intrinsics:rgbd
---

# Camera intrinsics calibration (ChArUco / checkerboard)

Fills `intrinsics:<camera>` (width/height, fx/fy, cx/cy, distortion) from 15–25 photos of a
printed target. On an rgbd device this is the COLOR pinhole (`intrinsics.color`); prefer the
vendor SDK's factory intrinsics when it reports them, and always take the depth block
(`intrinsics.depth`: scale/range/alignment) from the SDK — never from a board.

In the examples, `<core-python>` is `python.executable` from context; set `PYTHONPATH` to `python.library` for the command.

## 0. Preconditions

- `access:<camera>` done (you need frames from it).
- Use Kinex core Python (`"<core-python>"`); verify `import cv2, numpy`
  and `cv2.aruco`. Keep one OpenCV distribution in that environment.
- A printed target. Offer `"<core-python>" scripts/generate_board.py --out board.png` (ChArUco 7x5,
  30 mm squares, DICT_4X4_50; `--board checkerboard` for a plain 9x6). Printed FLAT at 100%
  on rigid backing — then the user MUST measure one printed square with a ruler: printers
  rescale, and a wrong square size silently corrupts every downstream calibration. Use the
  measured size in every command below.

## 1. Capture 15–25 frames

Per frame: the user places the board, you read the camera with the device tool and keep the
returned image path. Coach diversity — the solver needs it:
- near and far (target filling ~30% to ~80% of the frame);
- tilted up to ±40° in both axes (foreshortening constrains focal length);
- pushed into all four image corners (constrains distortion);
- fully visible and sharp every time (no motion blur, no glare).

## 2. Solve

    "<core-python>" scripts/calibrate_intrinsics.py --images 'FRAMES_DIR/*.png' \
      --board charuco --squares-x 7 --squares-y 5 --square-mm <MEASURED> --dict DICT_4X4_50

Checkerboard: `--board checkerboard --corners-x 9 --corners-y 6 --square-mm <MEASURED>`
(inner corners). `--marker-mm` defaults to 0.75 × the square — pass it only when measured.

The result contains width, height, projection (model/fx/fy/cx/cy/skew),
distortion (model/k1/k2/p1/p2/k3), rms_px and detection diagnostics.

`ok: false` names what failed (too few detections, board mismatch, unreadable images):
fix and recapture.

## 3. Quality gate

- rms_px < 0.5: good.
- 0.5–1.0: acceptable; tell the user the residual.
- > 1.0 or fewer than 10 frames used: do NOT persist — diagnose (blur? glare? wrong
  --square-mm? board not flat?), recapture the views named in coverage_warnings, re-solve.

## 4. Persist and verify

Clear needs_calibration explicitly with null only when the complete item is resolved.
Use calib_write replace for complete sections when switching strict variants.

Persist width, height, projection and distortion under intrinsics.color,
retaining the active fps/pixel_format/image_format from the camera setup.
Set intrinsics.source to calibration, method to charuco/checkerboard, and
calibrated_at to the current ISO UTC time. The schema derives color.fov.
Store RMS and coverage diagnostics in the calibration result, not the profile.

Re-run `calib_plan` and confirm `intrinsics:<camera>` is done; on failure persist nothing
and update the marker (`calib_write kind=needed`) with what blocked you.
