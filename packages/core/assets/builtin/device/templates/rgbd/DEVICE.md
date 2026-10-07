---
name: rgbd
type: rgbd
description: Register a RGBD camera with a fixed output profile and a source-specific driver.
---

## Setup

Follow setup-device for provisioning, profile writes, lifecycle and activation.

### Register and provision

1. Establish the user's device name, connection/selector, SDK, active resolution
   and frame rate. Read existing source configuration first. Obtain factory
   calibration or queue the camera calibration skills; never invent values.
2. Copy driver.py into the device directory and fill the starter profile below.
   Keep captured images in its out/ directory.
3. Complete open_stream, grab, close_stream and introspect in driver.py.
   Read connection and output settings with `settings(HERE)`; keep SDK-specific
   conversions in these hooks.
4. After static checks and authorized activation, introspect the active output
   mode and verify dimensions, colors and timestamps with /ping and a read.
   Verify depth against a known target distance using the declared quantity.

### Fixed connection variants

Choose one object under access.connection; keys cannot be mixed:

```yaml
connection: {kind: device, path: /dev/video0}
```

Other variants are `{kind: usb, serial: <serial>}`,
`{kind: url, url: <URL>, camera: <remote camera selector>}`,
`{kind: ros, color_topic: <topic>, depth_topic: <topic>}`, and
`{kind: mock}` for harness tests. For a single camera URL with no selector,
use the device name as camera. `???` marks an unknown required field.
Simulator camera_name belongs in the URL connection's camera selector.

### Color calibration

Fill intrinsics.color for the driver's full output mode.
Use fps: null for an on-demand renderer; ??? means an unknown fixed rate.

```yaml
projection:
  model: pinhole
  fx: 600
  fy: 600
  cx: 319.5
  cy: 239.5
  skew: 0
distortion:
  model: opencv_brown_conrady
  k1: 0.01
  k2: 0
  p1: 0
  p2: 0
  k3: 0
```

These are illustrative values only. Use `projection: ???` or
`distortion: ???` until the complete model is known. Known distortion-free
output uses `{model: none}`. Use `opencv_brown_conrady` only for compatible
coefficients. For other SDK distortion models, rectify through the SDK and
report the rectified calibration.

Focus, zoom, crop, rotation, resolution or rectification changes invalidate
the previous output calibration.

### Mount and calibration state

```yaml
mount:
  parent: arm
  parent_frame: flange
  translation_m: [0.04, 0, 0.02]
  rotation_xyzw: [0, 0, 0, 1]
```

This example is a fixed color-optical-frame mount. Whole mount, translation
or rotation may be `???`. See Use below for optical axes.
For hand-eye calibration use the actual named mounting link, not an assumed
world frame. Parent motion is resolved through the frame graph.

For access/intrinsics/extrinsics, source uses
user/calibration/introspected/default/unknown; method uses
unknown/factory/introspection/checkerboard/charuco/hand_eye/survey/manual;
calibrated_at is an ISO UTC timestamp or null. Put measurement diagnostics in
calibration results.

### Driver and recording

`grab` returns uint8 RGB color and uint16 depth with one finite numeric
`timestamp`: the later color/depth acquisition time in seconds, using a shared
clock. Use receipt time when acquisition time is unavailable; cached frames
retain their original timestamp.

Serialize SDK acquisition and copy reused buffers for a consistent snapshot.
Shared kinex.capture validates dtype/resolution and encodes file, array or
base64 output without changing source/server transport. File paths identify
immutable per-response artifacts; arrays cross JSON as encoded images and are
decoded in the Python client.
introspect returns a patch with intrinsics.color, intrinsics.depth, and
extrinsics.depth_to_color for native depth, reflecting calibration after SDK
conversion.

Persistent mode avoids reopening the source and is required for driver-owned
recording. Finish recorder shutdown before disconnecting the source.
ffmpeg must be available (libx264, FFV1 for lossless depth).
Capture rate_hz and playback fps are separate recording settings. Recording
previews may be resized; the profile describes original sensor output.

### Depth calibration and output

A color-registered depth block has this exact shape (values are examples):

```yaml
depth:
  registration: color
  width: 640
  height: 480
  fps: 30
  pixel_format: uint16
  image_format: pgm16_be
  quantity: z
  scale_m_per_unit: 0.001
  invalid_value: 0
  valid_range_m: {min: 0.001, max: 65.535}
  reliable_range_m: ???
```

For native depth use registration: native and add projection and distortion
with the same fixed schemas as color. Add extrinsics.depth_to_color:
`{translation_m: [...], rotation_xyzw: [...]}` or `???` until measured.
The common tool registers native samples into color with a nearest-Z buffer.
Color-registered depth must have the color dimensions and must express z/range
in the color optical frame; a pixel warp alone does not guarantee this.

Scale is for the RETURNED integer representation. Read native scale from the
SDK; if the driver converts metres to millimetres, output scale is 0.001.
Convert simulator nonlinear buffers using live clipping parameters in the
source hook. Map background, nonfinite values and out-of-valid-range samples
to invalid_value before uint16 conversion; never allow wraparound or clipping
to turn invalid depths into plausible measurements. Define valid_range_m
within the representation's capacity. Do not confuse it with reliable_range_m,
which comes from measurement or a specification and can remain unknown.
The driver read does not duplicate scale: tools read scale_m_per_unit from
the profile. Recording metadata may copy it for standalone playback.

### Profile

```yaml
name: rgbd
type: rgbd
loaded: false
access:
  source: unknown
  method: unknown
  calibrated_at: null
  connection: ???
  driver:
    entry: driver.py
    actions:
    - read
    - load
    - unload
    - status
    - introspect
    - record_start
    - record_stop
    persistent: true
    timeout_s: 30
intrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  color:
    width: ???
    height: ???
    fps: ???
    pixel_format: rgb8
    image_format: png
    projection: ???
    distortion: ???
  depth: ???
extrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  mount: ???
```

## Use

`read()` returns `file` (RGB8 PNG), `depth_file` (uint16 PGM16) and one
`timestamp` for the pair: the later acquisition/fallback receipt time.
Images are saved, not attached; inspect RGB with the host file-reading tool.
Dimensions and calibration come from the profile.

Python tools may request `output="array"` for NumPy `color`/`depth`, or
`"base64"` for PNG/PGM16 strings. These are programmatic formats, not model image
input. File output is the default.

Optical axes are X right, Y down, Z forward; (0,0) is the top-left pixel center.
Mount places the color frame. Depth metres = raw * scale_m_per_unit;
`quantity` selects optical Z or ray range. Reject `invalid_value` and samples
outside `valid_range_m`.
Color-registered depth shares the color grid; native depth uses its own
calibration and `depth_to_color`. Use `kinex.camera`; never infer scale or registration.
