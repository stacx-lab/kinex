---
name: rgbd
type: rgbd
description: Register a RGBD camera with a fixed output profile and a source-specific driver.
---

## Setup

Load initializes the connection and any owned control/streaming service, waiting
for readiness; status only observes. Unload stops active work according to the
profile and releases every owned resource, even if a cleanup stage fails. Follow
setup-device for service ownership, partial-startup rollback and exit cleanup.

The core Use guide is automatically shown for loaded devices of this type.
Before loading, find templates/rgbd/DEVICE.md in the core Device guide roots.
The profile is a strict schema, not a place for SDK prose or arbitrary options.

### Register and provision

1. Establish the user's device name, connection/selector, SDK, active resolution
   and frame rate. Read existing source configuration first. Obtain factory
   calibration or queue the camera calibration skills; never invent values.
2. Provision the environment using the setup-device skill.
   Keep the driver and out/ images in the device directory. Use shared core Python
   unless the SDK needs a separate environment. The harness supplies its Python
   library and workspace lib/ during driver execution; for direct invocations,
   set PYTHONPATH to python.library and python.workspaceLibrary from current context.
3. Merge the starter profile below with the user's name through calib_write. Set the
   interpreter only for a separate environment, using its absolute path; omit it
   for core Python. Keep loaded false; /load controls activation.
4. Complete open_stream, grab, close_stream and introspect in driver.py.
   Read connection and active output settings using `settings(HERE)`; do not
   duplicate serials, URLs, geometry or scale as constants in driver code.
5. Validate imports, profile and driver syntax statically. After activation, introspect the active output mode and verify dimensions, colors and
   timestamps with /ping and a read. Use known target geometry for calibration.

### Fixed connection variants

Choose one object under access.connection; keys cannot be mixed:

```yaml
connection: {kind: device, path: /dev/video0}
```

Other variants are `{kind: usb, serial: <serial>}`,
`{kind: url, url: <URL>, camera: <remote camera selector>}`,
`{kind: ros, color_topic: <topic>}` (RGBD also has depth_topic), and
`{kind: mock}` for harness tests. For a single camera URL with no selector,
use the device name as camera. `???` marks an unknown required field.
Simulator camera_name belongs in the URL connection's camera selector.
SDK-specific conversion algorithms belong in the driver hooks.

### Color calibration

intrinsics.color always has width, height, fps, pixel_format: rgb8,
image_format: png, projection, distortion, and derived fov.
Use fps: null for an on-demand renderer; ??? means an unknown fixed rate.
The driver returns this exact output mode, not a preview resized by the tool.

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
output uses `{model: none}`. Brown-Conrady maps undistorted normalized
coordinates to distorted normalized coordinates; SDK inverse/modified Brown
or fisheye coefficients must not be relabeled as this model. Rectify such
streams through their SDK and report the resulting pinhole and distortion.
Common tools call kinex.camera; they never dispatch on camera vendor.

FOV is recomputed from projection, distortion and output dimensions when
profiles are read/written. It measures separation of rays through opposite
outer edges at the image midlines. For a simulator with known centered
pinhole FOV, derive fy = height / (2*tan(vertical_fov/2)), then obtain the
remaining parameters from its documented pixel convention. Do not assume
cx/cy or fx for an unknown camera. Focus, zoom, crop, rotation, resolution or
rectification changes invalidate the previous output calibration.

### Mount and calibration state

```yaml
mount:
  parent: arm
  parent_frame: flange
  translation_m: [0.04, 0, 0.02]
  rotation_xyzw: [0, 0, 0, 1]
```

This example is a fixed color-optical-frame mount. Whole mount, translation
or rotation may be `???`. See the core rgbd Use guide for axes and transform direction.
For hand-eye calibration use the actual named mounting link, not an assumed
world frame. Parent motion is resolved through the frame graph.

access/intrinsics/extrinsics carry source, method, calibrated_at. Source uses
user/calibration/introspected/default/unknown. Method uses
unknown/factory/introspection/checkerboard/charuco/hand_eye/survey/manual.
calibrated_at is an ISO UTC timestamp or null. Status is derived by calib_plan
from the actual fields rather than an independently editable flag.
calib_write kind needed records the request reason. Clear a resolved request with
needs_calibration:null; put measurement diagnostics in calibration results.

### Driver and recording

`grab` returns a dictionary containing color and its acquisition sample_time_s
in Unix seconds, plus depth and depth_sample_time_s.
Map hardware clocks to this shared timebase; cached reads retain capture time.
When the transport has no acquisition timestamp, return sample_time_s: null
(and depth_sample_time_s: null for RGBD) plus received_time_s. Never label
network receipt as sensor acquisition.
Shared kinex.capture validates array dtype/resolution and writes files.
introspect returns a patch with intrinsics.color, intrinsics.depth, and native extrinsics.depth_to_color.
Unknowns stay unknown; inspect actual stream calibration after SDK conversion.

Persistent mode avoids reopening the source and is required for driver-owned
recording. ffmpeg must be available (libx264, FFV1 for lossless depth).
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
Verify one depth using a known target distance and the declared quantity.
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
    fov: ???
  depth: ???
extrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  mount: ???
```
