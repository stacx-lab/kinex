---
name: rgb
type: rgb
description: Register a RGB camera with a fixed output profile and a source-specific ROS node.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare image dimensions, raw/rectified projection and distortion, mount and optical frame. Use CameraInfo for intrinsics and preserve image acquisition stamps. Describe encoding, optical axes and any capture behavior on the image operation.

Every profile requires a top-level `description` giving general device identity,
capabilities and limitations. Every `operations.<name>.description` explains only
that operation: inputs/outputs, units, frames, timing, preconditions and side effects.
Both descriptions are required strings; use an empty string when no text is known.
Agents retrieve them through `runtime.device(name)` and `runtime.describe("device.operation")`.

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
name: rgb
type: rgb
loaded: false
access:
  source: unknown
  method: unknown
  calibrated_at: null
  connection: ???
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
extrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  mount: ???
description: ""
runtime:
  nodes: []
operations: {}
```
