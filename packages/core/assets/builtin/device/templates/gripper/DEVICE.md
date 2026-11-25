---
name: gripper
type: gripper
description: Gripper whose geometry is a URDF and whose grip is one actuated joint.
---

## Setup

Geometry is a URDF, not profile fields. Expand the vendor's description to plain
URDF, or adapt the sibling `gripper.urdf`, and set `model` to its path and base
link. Kinex publishes each link below the base link on TF as `<device>/<link>` from
`joint_state`, mimic joints included, the base link as `<device>/base`. Give each
finger pad or tip its own link, adding fixed links the vendor URDF lacks, so
contact points can be queried; link names must not repeat profile frame names.

`grip` names the actuated, non-mimic URDF joint with its `open` and `closed`
positions in that joint's units. `frames.tcp` is the grasp point, with +z as the
approach direction. Summarize finger shape and conventions in `description`;
numbers stay in the URDF.

The sibling `node.py` adapts an existing ROS gripper driver; copy it with the URDF
into the device directory and set its topic constants. A node that commands
hardware directly still initializes its hold from the measured posture, so a stop
before the first command never closes the fingers; after a command, its hold is
the last applied grip target.

### Operations

- `joint_state` (recommended): output topic `sensor_msgs/msg/JointState` with at
  least the grip joint in URDF units, stamped at acquisition.
- `target` (recommended): input topic `std_msgs/msg/Float64` whose `data` is a grip
  joint position between open and closed. It persists until replaced or stopped.
- `stop` (recommended): service `std_srvs/srv/Trigger` that keeps the active grip
  target with its grip force, so a held object stays gripped and fingers still
  travelling finish the commanded grip; it never replaces the target with the
  measured position. An open target releases.
- `grasped` (optional): output topic `std_msgs/msg/Bool`, true while the driver
  detects a held object, for example fingers stalled short of closed.

Serve `target` and `stop` through `kinex.node.command_service`. Sending a target is
not arrival: programs verify it with `joint_state`.

### Profile

```yaml
name: gripper
type: gripper
loaded: false
description: ''
runtime:
  observation: joint_state
  nodes: [{entry: node.py, factory: create}]
operations:
  joint_state:
    description: Measured grip joint position in URDF units, stamped at acquisition.
    transport: topic
    direction: output
    endpoint: /kinex/gripper/joint_state
    type: sensor_msgs/msg/JointState
    qos: {depth: 1, reliability: reliable, durability: transient_local}
  target:
    description: Grip joint position (data) between open and closed in URDF units. It persists until replaced or stopped.
    transport: topic
    direction: input
    endpoint: /kinex/gripper/target
    type: std_msgs/msg/Float64
  stop:
    description: Keep the active grip target, so a held object stays gripped; before the first command, hold the measured opening. An open target releases.
    transport: service
    direction: input
    endpoint: /kinex/gripper/stop
    type: std_srvs/srv/Trigger
model: {format: urdf, path: ???, base_link: ???}
grip: ???
stop: {behavior: hold, affected_devices: [gripper]}
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
  tcp: {parent: "gripper:base", translation_m: "???", rotation_xyzw: "???"}
```
