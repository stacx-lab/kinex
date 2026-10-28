---
name: force_torque
type: force_torque
description: Force-only, torque-only or combined load measurements with explicit quantity, target, axes and reference frame. Optional for task readiness.
---

## Setup

Declare `measurement`: the measured `quantity`, the `target` device and frame the
wrench acts on, and for each measured channel its `axes`, optional `range` and
`resolution`, and `bias`. `frames.base` is the measurement frame and its mount;
torque is about its origin. Record `sample_rate_hz` when known.

The node subtracts the profile `bias` from every published sample, so `wrench`
is calibrated and consumers never correct it. Record zero bias until calibrated;
a bias calibration averages `wrench` with no load and adds that mean to it.

The sibling `node.py` adapts an existing ROS F/T driver to this contract; copy it
into the device directory and set `SOURCE` to the driver's wrench topic.

### Operations

- `wrench` (recommended): output topic `geometry_msgs/msg/WrenchStamped` in N and
  N·m, expressed in `<device>/base`, signed as acting on the target and stamped
  at acquisition on the world clock. Unmeasured axes are NaN, never 0. Use
  `best_effort` with depth 1. Recording and snapshots read it through
  `runtime.observation`.
- `zero` (optional): service `std_srvs/srv/Trigger` that re-zeros at the current
  load, so later readings are relative to it. Call it only without contact. The
  offset lasts until unload and never changes the profile.

### Profile

```yaml
name: force_torque
type: force_torque
loaded: false
description: ''
runtime:
  observation: wrench
  nodes: [{entry: node.py, factory: create}]
operations:
  wrench:
    description: Bias-corrected wrench in N and N·m in force_torque/base, torque about its origin, acting on the measurement target; unmeasured axes are NaN.
    transport: topic
    direction: output
    endpoint: /kinex/force_torque/wrench
    type: geometry_msgs/msg/WrenchStamped
    qos: {depth: 1, reliability: best_effort, durability: volatile}
measurement:
  quantity: ???
  target: {device: ???, frame: ???}
  force: ???
  torque: ???
sample_rate_hz: ???
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```

Unknown sample rates, channel ranges and resolutions use ???. Null means explicitly absent or inapplicable. Optional specifications do not require calibration unless the task needs them.
