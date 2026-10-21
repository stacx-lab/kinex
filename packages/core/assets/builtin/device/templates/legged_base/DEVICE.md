---
name: legged_base
type: legged_base
description: Legged base with SDK-backed locomotion, a minimal device state machine and device-specific operating guidance.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare verified modes, SDK skills, command dimensions and stop scope. Preserve free-form device capabilities in the device description and each command convention in its operation description. Do not infer localization or stability from commanded motion.

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
name: legged_base
type: legged_base
loaded: false
access:
  source: unknown
  connection: ???
description: ''
runtime:
  nodes: []
operations: {}
source: unknown
method: unknown
calibrated_at: null
control:
  device_modes:
    crouched_down:
      description: Crouched down; not driving.
      transitions:
      - drive
    drive:
      description: Locomotion control enabled; movement uses velocity commands.
      transitions:
      - crouched_down
  skills: {}
  write:
    type: object
    properties:
      mode:
        type: string
        enum:
        - drive
        - crouched_down
      velocity:
        type: object
        properties:
          vx:
            type: number
          vy:
            type: number
          wz:
            type: number
        required:
        - vx
        - vy
        - wz
      posture:
        type: object
        properties:
          pitch:
            type: number
          height:
            type: number
        required:
        - pitch
        - height
      duration_s:
        type: number
        minimum: 0.1
    required:
    - mode
stop: ???
frames:
  base:
    parent: null
    translation_m: null
    rotation_xyzw: null
```
