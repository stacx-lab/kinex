---
name: quadruped_base
type: quadruped_base
description: Quadruped base with SDK-backed locomotion, a minimal device state machine and device-specific operating guidance.
---

## Setup

Follow setup-device for registration, permission checks and lifecycle ownership.
Copy the sibling [driver scaffold](driver.py) into the device directory and
complete it against the available SDK. Design the public read/write interface
from Kinex conventions first: reuse the [velocity contract](../velocity/DEVICE.md)
where the operation has the same meaning. Translate SDK method names, argument
names, units and numeric IDs inside the driver. Keep it an unlocalized root;
do not invent a world pose or mount.

### Custom operating guide

**Setup can write `.kinex/devices/<name>/DEVICE.md` with a nonempty `## Use`
section explaining specific usage instructions of the base. **
The custom Use section replaces this template's Use guidance in loaded-device
context, so include the complete implemented read/write contract, state and skill
usage. Do not merely copy this template or leave SDK placeholders in Use.

Document the verified SDK/version, supported commands and their parameters, units, bounds,
state observation fields, allowed state transitions, prerequisites, completion
checks, stop behavior and errors. Include concrete read/write examples matching
the implemented driver. Keep installation steps and API research in Setup;
keep Use concise enough to inject during normal operation.

### State machine and built-in skills

A quadruped base may expose a vendor state machine and many built-in skills,
such as standing, walking, posture changes or recovery. Inspect the available SDK
and its documented APIs rather than assuming any particular state names, numeric
IDs or skills exist. SDK skills are device operations, not automatically Kinex
agent skills.

Describe the supported state machine in `intrinsics.control.device_modes`
(`control.device_modes` within intrinsics). Start with these three basic states:

- `crouched_down`: the base is crouched down and is not driving.
- `stand_still`: the base stands in place with the required balance control active.
- `drive`: the base is in its locomotion control state; actual movement follows
  the documented velocity commands, not merely selecting this state.

The starter graph is `crouched_down <-> stand_still <-> drive`. Map these logical
names to verified SDK states/APIs and validate each edge before enabling it.
Do not assume vendor names or IDs match these names, or invent feedback for a
state the SDK cannot establish. Leave unsupported mappings unresolved and report
the gap during setup.

Keep these three states as the baseline and `control.skills` empty by default.
Add new states and optional skills only when the user needs them, after verifying
SDK support, prerequisites, interruption behavior and measured completion checks.
Do not expose extra gaits, demonstrations, stunts or recovery skills merely because
the SDK provides them. Update the profile and custom Use guide together when
adding a requested state or skill.

`control.device_modes` maps each writable state name to
`{description, transitions: [allowed_next_state, ...]}`. All transition targets
must be declared states. These describe capabilities, not the live current state.
If the SDK cannot support the baseline state interface, report the missing
capability rather than silently replacing the three-state contract.

Implement `read` using available SDK state/status APIs to determine actual state,
readiness, faults and skill progress. Never infer the current state from the last
requested write or fabricate a successful transition. Preserve unknown,
transitioning and fault observations without advertising them as writable targets.
Implement state changes through `write`, validating the requested target and the
current SDK state before effects. Reject unsupported transitions; do not silently
run a chain of skills, clear faults or retry an uncertain write. Reissuing the same
target must not restart an in-progress skill at every control tick.

### Shared motion parameters

For supported velocity/posture operations, prefer
`{mode, velocity?, posture?, duration_s}`. Reuse the velocity device's
motion parameters, with `mode` as the single state/mode selector:

- `mode: "drive"` selects the drive state for motion commands. Available modes
  and transitions are declared in
  `control.device_modes`. A state-only write requests a transition; a write with
  motion parameters also requires the measured state to permit that motion.
  Validate transition prerequisites before effects; never silently chain states
  or start motion before the requested state is ready.
- `velocity` is a named-axis object using `vx`, `vy`, `vz`, `wx`, `wy`, `wz` for
  supported axes. Prefer m/s for linear axes and rad/s for angular axes. Document
  body versus heading frame. Convert native SDK units in the driver; use
  normalized inputs only when physical-unit conversion is unavailable and label
  their ranges explicitly. Do not rename equivalent axes to SDK-specific names
  such as `forward` or `turn` in the public interface.
- `posture` uses supported `height`, `roll`, `pitch`, `yaw` fields, in metres or
  radians. Document the reference and preserve posture when velocity expires.
- `duration_s` is a positive motion-command duration in seconds. On expiry,
  command zero velocity while preserving required balance/posture. Implement SDK
  streaming or a watchdog if needed; do not leave an unbounded SDK target active.

For example, when the base supports these axes:
`write({mode:"drive", velocity:{vx:0.05, vy:0, wz:0}, duration_s:0.5})`.
Do not expose unsupported axes or invent bounds. Define required axes and known
limits in `control.write`; document units and frames in the custom Use guide.
State-only writes remain `{mode:"stand_still"}` without artificial motion
fields. Optional skills may have their own parameters when no common operation
fits, but reuse common names and units wherever their meanings match.

For equivalent readback, use `velocities`, `height_m`, `frame_poses`, `faults` and
`timestamp` as in velocity devices. Document the velocity vector's component order
and frame; report measured m/s and rad/s. Omit unsupported optional measurements
rather than inventing zero feedback. State readback remains `mode`.

Declare the resulting write argument shape in `control.write`, using the profile's
closed schema vocabulary: object `properties` and `required`; string `enum`;
number/integer bounds; boolean; nested arrays/objects and nullable values. Core
validates that contract before dispatch. Include top-level `mode` for a
state request when supported; use the shared parameters above for motion and add
only necessary extensions for skills. `control.skills` maps the exposed skills to their
purposes. Constrain selectors and parameter bounds in `control.write` as well;
the skill descriptions do not themselves validate a write. The driver must
validate again, including cross-field constraints and live SDK prerequisites.
Motion writes follow the common duration semantics; state transitions and discrete
skills need not pretend to be velocity commands. Enforce each operation's required
fields and reject invalid mixtures in the driver before effects.

Reads and the measured `state` in write results include `timestamp` and `faults`
(`[{code: string}]`). When a state machine is declared, include `mode`:
the observed SDK state name or null when unknown. Observed transient/fault states
may be outside the writable catalog. Additional observations and optional read
selectors should reuse Kinex conventions where possible and must be documented in
the custom Use guide.

A write submits the selected SDK operation and returns `{execution_id, state}`
without waiting for physical completion. The driver owns cancellation, replacement
and any streaming/watchdog needed by that SDK. Repeated requests must not restart
an identical active skill. Verify actual state on subsequent reads; surface
background failures. Reject unsupported state edges before issuing SDK calls.
If already at a requested state, do not repeat the transition. Do not combine a
state switch and motion/skill invocation unless the driver explicitly implements
and validates that combination. Stop must interrupt the accepted operation.

Keep lifecycle separate: load only connects and waits for service readiness;
read/status only observe. Neither may stand up, switch controller state or launch
a skill. Stop interrupts owned motion while preserving the SDK's required balance
or posture control. Unload releases owned resources without terminating borrowed
services. Verify transitions, repeated targets, failed writes, cancellation and
stop with a mock SDK before authorized hardware checks.

This starter declares only the baseline state-selection write. During setup,
complete the verified SDK mappings and extend `control.write` with the arguments
needed for basic driving. Keep additional states and optional skills out until
the user needs them. The starter graph is a provisioning target, not evidence
that the SDK or hardware has been verified.

### Profile

```yaml
name: quadruped_base
type: quadruped_base
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
        transitions: [stand_still]
      stand_still:
        description: Standing in place with balance control active.
        transitions: [crouched_down, drive]
      drive:
        description: Locomotion control enabled; movement uses velocity commands.
        transitions: [stand_still]
    skills: {}
    write:
      type: object
      properties:
        mode:
          type: string
          enum: [crouched_down, stand_still, drive]
      required: [mode]
  stop: ???
extrinsics:
  source: unknown
```

## Use

The baseline states are `crouched_down`, `stand_still` and `drive`, connected
through `stand_still`. Selecting `drive` enables locomotion control; it does not
itself request movement. Additional states and optional SDK skills are available
only after setup for a user's need; do not assume they exist.

Read the device's custom Use guide for its verified state machine and SDK skills.
Read measured state before selecting a supported transition; use write to request
it and subsequent reads to verify completion. Acceptance is not arrival. Use only
the minimal states and skills declared for this device; do not guess vendor IDs.

Use the instance's documented write parameters and only the skills listed in
`control.skills`; `control.write` defines the accepted argument schema. Read SDK
feedback to verify progress and completion. Timestamp and faults accompany
observations; a state machine also reports measured `mode`, or null when
unknown. Use explicit frame estimates for base-to-world relationships.
Stop on faults or unexpected motion; do not automatically clear faults or invoke
recovery skills. Load, read and status do not request physical state transitions.

For supported motion use `{mode:"drive", velocity:{vx, vy, wz}, duration_s}` with
the declared axes, units and frame; optional posture uses height/roll/pitch/yaw.
Velocity expires to zero while balance/posture remains active. `mode` is
the single state/mode selector; omit motion fields for a state-only transition.
The driver verifies state readiness before motion. Equivalent readback uses
velocity-device field names and measured units. Consult the custom Use guide for
supported fields and user-requested skill extensions.
