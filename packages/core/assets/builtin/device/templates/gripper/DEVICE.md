---
name: gripper
type: gripper
description: gripper control and observation contract.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare position or direction control facts, verified open/close endpoints, physical aperture bounds, stop scope, geometry and local TCP frames. Describe finger shape and limitations in device description. Put command units, endpoint signs, timing and hold semantics in each command operation description. Measured aperture does not establish grasp success.

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
name: gripper
type: gripper
loaded: false
access:
  source: unknown
  method: unknown
  calibrated_at: null
  connection: ???
intrinsics:
  frames: {}
  source: unknown
  method: unknown
  calibrated_at: null
  aperture_m: null
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
  mount: ???
description: ""
runtime:
  nodes: []
operations: {}
```
