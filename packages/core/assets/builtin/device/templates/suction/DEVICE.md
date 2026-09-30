---
name: suction
type: suction
description: suction control and observation contract.
---

## Setup

Follow setup-device for registration and lifecycle ownership. Load waits for
readiness; status only observes; unload stops motion and releases owned resources.
Use `???` for unresolved facts and `null` only where the schema permits it.

control declares mode:binary, distinct on_target/off_target. feedback declares positions (possibly empty), velocities, sensors, clock and aperture_model:null. stop declares behavior and affected_devices. Mount locates the suction TCP.

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
  driver:
    entry: driver.py
    actions:
    - read
    - write
    - stop
    - load
    - unload
    - status
    persistent: true
    timeout_s: 30
intrinsics:
  frames: {}
  source: unknown
  method: unknown
  calibrated_at: null
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
  mount: ???
```

## Use

`write({actions: [value, ...], duration_s})` submits a flat sequence of commands.
Use `[value]` for one command. Each value must equal `on_target` or `off_target`.
The final reference remains active after the buffer completes.
New valid writes replace pending actions without stopping. Results contain
`execution_id`, actual `elapsed_s` and measured `state`.
Use `world.wait({duration_s})` to wait for execution. Stop clears the buffer.
