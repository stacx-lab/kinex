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
`<device>/base`. One source stream serves both operations.

### Operations

- `image` (recommended): output topic `sensor_msgs/msg/Image`, `rgb8` at the
  profile resolution, `best_effort` with depth 1. Recording subscribes to it.
- `capture` (recommended): service `kinex_interfaces/srv/Capture` returning the
  latest `image` without advancing world time. Snapshots and perception tools
  call it.

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
  capture:
    description: Latest image on demand without advancing world time.
    transport: service
    direction: input
    endpoint: /kinex/rgb/capture
    type: kinex_interfaces/srv/Capture
color:
  width: ???
  height: ???
  fps: ???
  projection: ???
  distortion: ???
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```
