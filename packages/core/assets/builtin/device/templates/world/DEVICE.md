---
name: world
type: world
description: World clock and optional spatial reference.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare informational bounds and surfaces when known. Recommend a clock output topic, one relative-duration wait service and an optional reset service. Describe clock epoch, pacing, zero-duration barriers and reset behavior. Keep cancellation in operation metadata, not a separate public operation. Kinex automatically supplies persistent tf2 lookup; do not register a frame-graph node or lookup operation. Keep task instructions and benchmark judging outside device operations. Simulator state and measurements remain separate from Kinex frame publication.

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

Names remain device-specific. A simple world can expose `time` as
`rosgraph_msgs/msg/Clock`, `wait` as `kinex_interfaces/srv/Wait`, and `reset`
as `std_srvs/srv/Trigger`. The wait payload is `duration_s`; Kinex assigns owner
and request IDs and uses its declared cancellation endpoint automatically.
Waits share world progression; reads and transform lookup never step physics.
Reset acknowledgements contain no task or evaluator data.

For LIBERO, use `rosbridge setup` and its robot catalog as the authoritative
profile/node implementation. This generic template does not recreate simulator
endpoints or calibration. Fill operation descriptions from the exported contract.

### Profile

```yaml
name: world
type: world
loaded: false
access:
  connection:
    kind: process
description: ''
runtime:
  nodes: []
operations: {}
source: unknown
method: unknown
calibrated_at: null
bounds: null
surfaces: []
frames:
  base:
    parent: null
    translation_m: null
    rotation_xyzw: null
```

Bounds are `{min: [x,y,z], max: [x,y,z]}` in metres; null bounds impose no box,
null sides are open, and `???` means unresolved. Surfaces have a unique name,
world pose and rectangle, polygon or unbounded extent. Use only measured geometry.
