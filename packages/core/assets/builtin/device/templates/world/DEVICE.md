---
name: world
type: world
description: World clock and optional spatial reference.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare informational bounds and surfaces when known. Supply clock and wait operations; describe clock epoch, pacing and terminal/reset behavior on those operations. Register a Kinex frame-graph node for tf2 lookup. Simulator state and measurements remain separate from Kinex frame publication.

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
name: world
type: world
loaded: false
access:
  connection:
    kind: process
intrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  frames: {}
  bounds: null
  surfaces: []
description: ""
runtime:
  nodes: []
operations: {}
```

Bounds are `{min: [x,y,z], max: [x,y,z]}` in metres; null bounds impose no box,
null sides are open, and `???` means unresolved. Surfaces have a unique name,
world pose and rectangle, polygon or unbounded extent. Use only measured geometry.
