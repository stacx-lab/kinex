---
name: rgb
type: rgb
description: Color camera with profile intrinsics and a calibrated optical frame.
---

## Setup

Declare color geometry (`width`, `height`, `fps`, `projection`, `distortion`);
Kinex derives `fov`. The profile is the only source of intrinsics. `frames.base`
is the optical frame (+X right, +Y down, +Z forward) and its mount. Stamp every
image at acquisition on the world clock and set `header.frame_id` to
`<device>/base`. Decide whether images are raw or rectified, and compare the
source's live calibration with the profile.

A reader subscribes to `image` and takes the next frame; snapshots and perception
tools read it this way. A live camera streams continuously. A simulator, whose world
may be paused, publishes a current frame to each new subscriber (for example on the
publisher's matched event) and declares `reliable` QoS so that frame is delivered;
reading never advances world time.

The sibling `node.py` adapts an existing ROS camera driver to this contract; copy
it into the device directory and set `SOURCE` to the driver's image topic.

### Operations

- `image` (recommended): output topic `sensor_msgs/msg/Image`, `rgb8` at the
  profile resolution, `best_effort` with depth 1 for a streaming driver. Snapshots,
  perception tools and recording subscribe to it.

### Profile

```yaml
name: rgb
type: rgb
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
