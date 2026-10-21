---
name: suction
type: suction
description: suction control and observation contract.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare control ranges, pressure/contact feedback support and stop scope. Describe vacuum polarity, units and release/hold behavior on their operations. Unsupported measurements remain unavailable.

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
name: suction
type: suction
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
control: ???
feedback: ???
stop: ???
frames:
  base:
    parent: null
    translation_m: null
    rotation_xyzw: null
```
