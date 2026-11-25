---
name: rgb
type: rgb
description: Color camera with profile intrinsics and a calibrated optical frame.
---

## Setup

Set `layout: mono` for one color stream or `layout: stereo` for a pair (below).
Declare color geometry (`width`, `height`, `fps`, `projection`, `distortion`); for
an undistorted pinhole stream Kinex derives `fov`. `frames.base` is the optical
frame (+X right, +Y down, +Z forward) and its mount. Stamp every image at
acquisition on the world clock and set `header.frame_id` to `<device>/base`.
Decide whether images are raw or rectified, and compare the source's live
calibration with the profile.

Distortion metadata accepts any model name and JSON parameters. A camera whose SDK
owns its calibration serves it through geometry services instead of duplicating it
in the profile; see [camera geometry](geometry.md). Publish `rgb8`, with pixels
unchanged for model consumers; a node adapting a `mono8` source, such as an
infrared stereo pair, replicates it to three channels.

Readers subscribe to `image` and take the next frame, so a loaded camera streams
continuously. Where world time rests between waits, as in a stepped simulator, the
camera declares `reliable` QoS, sends its current frame to each new subscriber (for
example on the publisher's matched event) and repeats it at a short interval, about
0.2 s, while subscribed: DDS can deliver the first before the reader has discovered
the publisher. Reading never advances world time.

The sibling `node.py` adapts an existing ROS camera driver; copy it into the device
directory and map each image operation to the driver's topic in `SOURCES`.

### Stereo

A stereo camera whose SDK publishes depth registered to one eye is an `rgbd` device
with that eye as `color`. A raw pair is one `rgb` device with `layout: stereo`:
declare `left` and `right` geometry instead of `color`, publish `left_image` and
`right_image` instead of `image`, and declare `frames.left` and `frames.right` as
the optical frames, with `header.frame_id` `<device>/left` or `<device>/right`.
Eyes may differ in resolution. Frames chain `base` -> reference eye -> other eye:
the reference eye's parent is `<device>:base` and the other eye's parent is the
reference eye. `frames.base` carries the robot mount and may sit anywhere
convenient, including at the reference eye. Record a factory eye-to-eye transform
from the SDK as the other eye's frame; it is calibrated otherwise.

Stamp each image at its own acquisition. A paired read does not imply hardware
synchronization: consumers compare stamps. Geometry services serve `left` and
`right` streams, and `node.py` maps `left_image` and `right_image` in `SOURCES`.

### Operations

- `image` (recommended): output topic `sensor_msgs/msg/Image`, `rgb8` at the
  profile resolution; `best_effort` with depth 1 for a streaming driver.

### Profile

```yaml
name: rgb
type: rgb
layout: mono
loaded: false
description: ''
runtime:
  nodes: [{entry: node.py, factory: create}]
operations:
  image:
    description: rgb8 images stamped at acquisition in optical frame rgb/base.
    transport: topic
    direction: output
    endpoint: /kinex/rgb/image
    type: sensor_msgs/msg/Image
    qos: {depth: 1, reliability: best_effort, durability: volatile}
color:
  width: ???
  height: ???
  fps: ???
  projection: ???
  distortion: ???
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```

A stereo profile:

```yaml
name: rgb
type: rgb
layout: stereo
loaded: false
description: ''
runtime:
  nodes: [{entry: node.py, factory: create}]
left: {width: ???, height: ???, fps: ???, projection: ???, distortion: ???}
right: {width: ???, height: ???, fps: ???, projection: ???, distortion: ???}
operations:
  left_image:
    description: rgb8 images stamped at acquisition in optical frame rgb/left.
    transport: topic
    direction: output
    endpoint: /kinex/rgb/left/image
    type: sensor_msgs/msg/Image
    qos: {depth: 1, reliability: best_effort, durability: volatile}
  right_image:
    description: rgb8 images stamped at acquisition in optical frame rgb/right.
    transport: topic
    direction: output
    endpoint: /kinex/rgb/right/image
    type: sensor_msgs/msg/Image
    qos: {depth: 1, reliability: best_effort, durability: volatile}
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
  left: {parent: rgb:base, translation_m: ???, rotation_xyzw: ???}
  right: {parent: rgb:left, translation_m: ???, rotation_xyzw: ???}
```
