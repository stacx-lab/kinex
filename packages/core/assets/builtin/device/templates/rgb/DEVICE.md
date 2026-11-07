---
name: rgb
type: rgb
description: Color camera with profile intrinsics and a calibrated optical frame.
---

## Setup

Set `layout: mono` for one color stream or `layout: stereo` for a pair (below).
Declare color geometry (`width`, `height`, `fps`, `projection`, `distortion`);
For undistorted pinhole streams Kinex derives `fov`. SDKs may own active calibration. `frames.base`
is the optical frame (+X right, +Y down, +Z forward) and its mount. Stamp every
image at acquisition on the world clock and set `header.frame_id` to
`<device>/base`. Decide whether images are raw or rectified, and compare the
source's live calibration with the profile.

Distortion metadata accepts arbitrary model names and JSON parameters. SDK-owned
calibration does not need to be duplicated; use geometry service descriptors.
See [camera geometry](geometry.md) for services, adapters and calibration ownership.
Raw images remain unchanged for model consumers. Publish `rgb8`; a node adapting a
`mono8` source (for example an infrared stereo pair) replicates it to three channels.

A reader subscribes to `image` and takes the next frame; snapshots and perception
tools read it this way. A live camera streams continuously. A simulator, whose world
may be paused, publishes a current frame to each new subscriber (for example on the
publisher's matched event) and declares `reliable` QoS so that frame is delivered;
reading never advances world time.

The sibling `node.py` adapts an existing ROS camera driver to this contract; copy
it into the device directory and map each image operation to the driver's topic in
`SOURCES`.

### Stereo

A stereo camera whose SDK publishes depth registered to one eye is an `rgbd` device
with that eye as `color`; perception then measures depth directly. A raw pair is one
`rgb` device with `layout: stereo`. Declare `left` and `right` geometry instead of
`color`, publish `left_image` and `right_image` instead of `image`, and declare
`frames.left` and `frames.right` as the optical frames, setting each `header.frame_id`
to `<device>/left` or `<device>/right`. Eyes may differ in resolution. Frames chain
`base` -> reference eye -> other eye: the reference eye's parent is `<device>:base` and
the other eye's parent is the reference eye. `frames.base` carries the robot mount and
may be placed anywhere convenient, including at the reference eye.

Stamp each image at its own acquisition on the world clock. A paired read does not
imply hardware synchronization: consumers compare stamps. Serve geometry with
`left` and `right` streams. `node.py` maps `left_image` and `right_image` in `SOURCES`.
Record a factory eye-to-eye transform from the SDK as the other eye's frame; it is
calibrated otherwise.

### Operations

- `image` (recommended): output topic `sensor_msgs/msg/Image`, `rgb8` at the
  profile resolution, `best_effort` with depth 1 for a streaming driver. Snapshots,
  perception tools and recording subscribe to it.

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
