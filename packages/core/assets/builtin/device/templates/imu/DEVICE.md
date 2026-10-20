---
name: imu
type: imu
description: Inertial measurements with explicit acceleration quantity, measured axes, optional orientation reference and magnetic field. Typed profile facts and ROS operations.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare supported measurement channels, units, axes, reference frames and gravity convention. Preserve unavailable values and covariance. Record calibration bias and measurement frame relationships.

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
name: imu
type: imu
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
  measurement:
    angular_velocity: ???
    linear_acceleration: ???
    orientation: ???
    magnetic_field: null
  sample_rate_hz: null
extrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  mount:
    parent: ???
    parent_frame: ???
    translation_m: ???
    rotation_xyzw: ???
description: ""
runtime:
  nodes: []
operations: {}
```
