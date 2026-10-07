---
name: legged_base
type: legged_base
description: Legged base with SDK-backed locomotion, a minimal device state machine and device-specific operating guidance.
---

## Setup

Follow setup-device for registration, permission checks and lifecycle ownership.
Copy the sibling [driver scaffold](driver.py) into the device directory and
complete it against the available SDK. Design the public read/write interface
from Kinex conventions first: reuse the [velocity contract](../velocity/DEVICE.md)
where the operation has the same meaning. Translate SDK method names, argument
names, units and numeric IDs inside the driver. Keep it an unlocalized root;
do not invent a world pose or mount.

### Custom operating guide and device modes

Only devices of type `legged_base` may have a custom per-device `DEVICE.md`.
For this type, setup must write `.kinex/devices/<name>/DEVICE.md` with a nonempty
`## Use` section explaining the base's verified operating interface and special
movement. Do not apply this custom-guide requirement to any other device type.

Document supported modes and their acceptable parameters, units, bounds,
state observation fields, allowed state transitions, prerequisites, completion
checks, stop behavior and errors. Include concrete read/write examples matching
the implemented driver. Keep Use concise enough to inject during normal operation.

### Device modes and control

Map SDK states to `control.device_modes`, starting with `crouched_down` and `drive`.
`control.write` defines accepted arguments; `mode` selects the destination.
Drivers check the measured mode's `transitions` before changing modes and reject
writes in unknown or undeclared modes.

### Response behavior and warmup

Legged devices may need longer to build velocity. Use the device's verified
operating range to choose an adequate speed and duration; 0.2 m/s for 1 s is an
example to verify during setup, not a universal device default.
Follow the velocity guide's [response behavior procedure](../velocity/DEVICE.md#response-behavior).

### Profile

```yaml
name: legged_base
type: legged_base
loaded: false
access:
  source: unknown
  connection: ???
  driver:
    entry: driver.py
    actions: [read, write, stop, load, unload, status]
    persistent: true
    timeout_s: 30
intrinsics:
  frames: {}
  source: unknown
  method: unknown
  calibrated_at: null
  control:
    device_modes:
      crouched_down:
        description: Crouched down; not driving.
        transitions: [drive]
      drive:
        description: Locomotion control enabled; movement uses velocity commands.
        transitions: [crouched_down]
    skills: {}
    write:
      type: object
      properties:
        mode:
          type: string
          enum: [drive, crouched_down]
        velocity:
          type: object
          properties:
            vx:
              type: number
            vy:
              type: number
            wz:
              type: number
          required: [vx, vy, wz]
        posture:
          type: object
          properties:
            pitch:
              type: number
            height:
              type: number
          required: [pitch, height]
        duration_s:
          type: number
          minimum: 0.1
      required: [mode]
  stop: ???
extrinsics:
  source: unknown
```

## Use

The baseline states are `crouched_down` and `drive`.
Selecting `drive` enables locomotion control. Additional states and optional SDK skills are available only after setup for a user's need; do not assume they exist.

Read the device's custom Use guide for its verified state machine and SDK skills.
Read measured state before selecting a supported transition; use write to request
it and subsequent reads to verify completion. Acceptance is not arrival. Use only
the minimal states and skills declared for this device; do not guess vendor IDs.

`control.write` defines the accepted argument schema. Read SDK
feedback to verify progress and completion. Timestamp and faults accompany
observations; a state machine also reports measured `mode`, or null when
unknown. Use explicit frame estimates for base-to-world relationships.
Stop on faults or unexpected motion; do not automatically clear faults or invoke
recovery skills. Load, read and status do not request physical state transitions.
Stand/crouch transitions may continue after stop; consult the custom Use guide
and verify completion through measured state.

For supported motion use `{mode:"drive", velocity:{vx, vy, wz}, duration_s}` with
the declared axes, units and frame; optional posture uses pitch/height.
Velocity expires to zero while balance/posture remains active. `mode` is
the single state/mode selector; omit motion fields when changing modes.
Motion requires positive `duration_s`.
Consult `control.device_modes.<mode>.response` and the custom Use guide for
measured response and warmup; use feedback to verify actual motion.
The driver verifies state readiness before motion. Equivalent readback uses
velocity-device field names and measured units. Consult the custom Use guide for
supported fields and user-requested skill extensions.
