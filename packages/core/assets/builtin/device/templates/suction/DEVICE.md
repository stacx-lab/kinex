---
name: suction
type: suction
description: Vacuum suction tool switched on and off, or set to a vacuum level.
---

## Setup

A suction tool has no moving joints and no URDF. `frames.tcp` is the cup's contact
centre with +z as the approach direction; summarize cup size, count and material in
`description`. `vacuum` is `binary` when the device only switches vacuum on and off,
or `proportional` when it accepts a level. Policy values in [-1, 1] release at -1
and grip at +1: proportional devices take the level (v + 1) / 2, binary devices
switch on above 0.

The sibling `node.py` adapts an existing ROS vacuum driver with an on/off service
and an object-detection topic; copy it into the device directory and set its topic
constants.

### Operations

- `target` (recommended): input topic `std_msgs/msg/Float64` whose `data` is a
  vacuum level from 0 (release, venting) to 1 (full vacuum); binary devices accept
  only 0 or 1. It persists until replaced, and sending is not a grasp. Serve it with
  `stop` through `kinex.node.command_service`.
- `stop` (recommended): service `std_srvs/srv/Trigger` that ends pending
  commands and keeps the current vacuum; a stop never releases a held object.
- `grasped` (recommended): output topic `std_msgs/msg/Bool`, true while an object
  is held, for example vacuum reached or an object detected.
- `pressure` (optional): output topic `sensor_msgs/msg/FluidPressure`, absolute
  pressure in Pa stamped at acquisition; add ambient pressure to a gauge reading.

### Profile

```yaml
name: suction
type: suction
loaded: false
description: ''
runtime:
  observation: grasped
  nodes: [{entry: node.py, factory: create}]
operations:
  target:
    description: Vacuum level (data) from 0 (release) to 1 (full vacuum); binary devices accept only 0 or 1. It persists until replaced; verify the grasp with grasped.
    transport: topic
    direction: input
    endpoint: /kinex/suction/target
    type: std_msgs/msg/Float64
  stop:
    description: Stop pending commands and keep the current vacuum; a held object is never released.
    transport: service
    direction: input
    endpoint: /kinex/suction/stop
    type: std_srvs/srv/Trigger
  grasped:
    description: True while the driver detects a held object.
    transport: topic
    direction: output
    endpoint: /kinex/suction/grasped
    type: std_msgs/msg/Bool
    qos: {depth: 1, reliability: reliable, durability: transient_local}
vacuum: ???
stop: {behavior: hold, affected_devices: [suction]}
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
  tcp: {parent: "suction:base", translation_m: "???", rotation_xyzw: "???"}
```
