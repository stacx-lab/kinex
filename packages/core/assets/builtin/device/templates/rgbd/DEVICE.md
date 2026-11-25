---
name: rgbd
type: rgbd
description: Color and depth camera with profile intrinsics and calibrated frames.
---

## Setup

Follow the rgb guide for color geometry, stamps, streaming and `frames.base`.
Declare depth geometry, `quantity` (`z` or `range`), `scale_m_per_unit`,
`invalid_value` and the valid and reliable ranges. Prefer depth registered to the
color grid (`registration: color`): same size, frame `<device>/base`. Native depth
adds its own `projection` and `distortion` and calibrated `frames.color` and
`frames.depth`; headers then use `<device>/color` and `<device>/depth`, and Kinex
resolves depth-to-color through tf2.

Depth registered to color follows the published color grid, distorted or not;
native depth uses its own reported intrinsics and distortion, served like color's.
Keep factory coefficients under the model name the vendor reports.
A node that rectifies color also provides depth registered to the rectified grid,
or declares native depth with its own geometry; never mix raw depth pixels with
rectified color.

Publish `image` and `depth` from one acquisition with the same stamp: readers pair
frames with equal stamps.

The sibling `node.py` adapts an existing ROS RGB-D driver with registered depth;
copy it into the device directory and set `COLOR` and `DEPTH` to its topics.

### Operations

- `image` (recommended): as for rgb.
- `depth` (recommended): output topic `sensor_msgs/msg/Image`, `16UC1` in units of
  `scale_m_per_unit` with `invalid_value: 0` for missing samples, stamped like its
  `image`; `best_effort` with depth 1 for a streaming driver.

### Profile

```yaml
name: rgbd
type: rgbd
loaded: false
description: ''
runtime:
  nodes: [{entry: node.py, factory: create}]
operations:
  image:
    description: rgb8 images stamped at acquisition in optical frame rgbd/base.
    transport: topic
    direction: output
    endpoint: /kinex/rgbd/image
    type: sensor_msgs/msg/Image
    qos: {depth: 1, reliability: best_effort, durability: volatile}
  depth:
    description: 16UC1 depth registered to image, in millimetres, with the image's stamp; 0 marks missing samples.
    transport: topic
    direction: output
    endpoint: /kinex/rgbd/depth
    type: sensor_msgs/msg/Image
    qos: {depth: 1, reliability: best_effort, durability: volatile}
color:
  width: ???
  height: ???
  fps: ???
  projection: ???
  distortion: ???
depth:
  registration: color
  width: ???
  height: ???
  fps: ???
  quantity: z
  scale_m_per_unit: 0.001
  invalid_value: 0
  valid_range_m: ???
  reliable_range_m: ???
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```
