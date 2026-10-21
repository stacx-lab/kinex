---
name: rgbd
type: rgbd
description: Register a RGBD camera with a fixed output profile and a source-specific ROS node.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare color and depth calibration, depth scale and registration. Native depth requires named `frames.color` and `frames.depth`, with an explicit parent and calibrated transform between them; color-registered depth must share the color grid. Describe units, invalid values and encoding on the depth operation. Preserve acquisition stamps and set image/CameraInfo header.frame_id to the corresponding ROS frame ID. Use tf2 for depth-to-color lookup; keep camera projection parameters in color/depth.

Every profile requires a top-level `description` giving general device identity,
capabilities and limitations. Every `operations.<name>.description` explains only
that operation: inputs/outputs, units, frames, timing, preconditions and side effects.
Both descriptions are required strings; use an empty string when no text is known.
Read device and operation descriptions directly from `profile.yaml`.

Start from the profile below, select the typed facts and fill unknowns from
documentation or calibration. Use `???` for unresolved facts and `null` only where
allowed. Add actual topic/service operations and their descriptions; an empty
operations mapping is an unfinished setup, not an implicit type interface.
Register owned factories as `runtime.nodes: [{entry: node.py, factory: create}]`.
For externally managed nodes use `runtime.nodes: []` and their real endpoints.
Nodes inherit Kinex Python unless a separate SDK requires an interpreter override.
The old sibling driver scaffolds are unsupported by the runtime; implement ROS
node factories or bind to existing ROS nodes.

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
description: ''
runtime:
  nodes: []
operations: {}
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
frames:
  base:
    parent: null
    translation_m: null
    rotation_xyzw: null
```
