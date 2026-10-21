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

### Recommended ROS pattern

Recommend a `target` input topic (`kinex_interfaces/msg/ScalarCommand`), a `state`
output topic (`kinex_interfaces/msg/GripperState`), and a `stop` service
(`kinex_interfaces/srv/Stop`). Names are recommendations, not type requirements.
The target payload contains one scalar `target` in the profile's position or
direction units. No duration or trajectory is required. In direction mode,
zero stops integration and retains the actuator's accumulated setpoint and effort;
profile facts define the open/close signs. Do not replace that setpoint with
measured aperture. Initialize a hold from measured posture on connection/reset;
a stop before the first command must never close the fingers.

Targets remain active until replaced, stopped or reset. Successful exec completion
does not retract a target; failure cleanup stops integration without releasing.
Use the world clock and separate waits to observe progress. Opening is explicit.
Put Acquire and CommandStatus endpoints in the target's `motion` metadata;
`communication.publish` handles ownership and `communication.accepted` confirms
admission, not arrival. They need not be separate public operations.

State carries a measurement stamp, aperture in metres with a validity flag, and
faults. Never infer grasp success from aperture alone. Devices with different
native capabilities can declare their own messages and operation names; document
those actual contracts. Use the rosbridge robot catalog for reproducible LIBERO
profiles and nodes rather than reconstructing its endpoints from this template.

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
description: ''
runtime:
  nodes: []
operations: {}
source: unknown
method: unknown
calibrated_at: null
aperture_m: null
control: ???
feedback: ???
stop: ???
frames:
  base:
    parent: null
    translation_m: null
    rotation_xyzw: null
```
