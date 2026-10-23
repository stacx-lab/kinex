---
name: gripper
type: gripper
description: Gripper whose geometry is a URDF and whose grip is one actuated joint.
---

## Setup

Geometry lives in a URDF, not in profile fields. Use the vendor's description
(expand xacro to plain URDF) or adapt the sibling `gripper.urdf`, and set `model`
to its path and base link. The sibling `links.py` node publishes every link below
the base link on TF as `<device>/<link>`, with the base link as `<device>/base`
and mimic joints derived from measured ones. Give each finger pad or tip its own link, adding
fixed links when the vendor URDF lacks them, so contact points can be queried;
link names must not repeat profile frame names. Agents read the resolved tree as
`profile(name)["resolved_model"]` and live geometry through tf2.

`grip` names the actuated, non-mimic URDF joint with its `open` and `closed`
positions in that joint's units; policy values in [-1, 1] interpolate between
them. `frames.tcp` is the grasp point, with +z as the approach direction.
Summarize finger shape and conventions in `description`; numbers stay in the URDF.

The sibling `node.py` adapts an existing ROS gripper driver to this contract;
copy it with `links.py` and the URDF into the device directory and set its topic
constants. A node that commands hardware directly must still initialize its hold
from measured posture, so a stop before the first command never closes the fingers.

### Operations

- `joint_state` (recommended): output topic `sensor_msgs/msg/JointState` with at
  least the grip joint in URDF units, stamped at acquisition; Kinex publishes the
  links from it.
- `target` (recommended): input topic `std_msgs/msg/Float64` whose `data` is a grip
  joint position between open and closed. It persists until replaced or stopped,
  and sending is not arrival. Serve it with `stop` through
  `kinex.node.command_service`.
- `stop` (recommended): service `std_srvs/srv/Trigger` that holds the measured
  posture; a stop never opens or closes the fingers.
- `grasped` (optional): output topic `std_msgs/msg/Bool`, true while the driver
  detects a held object, for example fingers stalled short of closed.

### Profile

```yaml
name: gripper
type: gripper
loaded: false
description: ''
runtime:
  observation: joint_state
  nodes: [{entry: node.py, factory: create}, {entry: links.py, factory: create}]
operations:
  joint_state:
    description: Measured grip joint positions in URDF units, stamped at acquisition; Kinex publishes the URDF links from them.
    transport: topic
    direction: output
    endpoint: /kinex/gripper/joint_state
    type: sensor_msgs/msg/JointState
    qos: {depth: 1, reliability: reliable, durability: transient_local}
  target:
    description: Grip joint position (data) between open and closed in URDF units. It persists until replaced or stopped; verify arrival with joint_state.
    transport: topic
    direction: input
    endpoint: /kinex/gripper/target
    type: std_msgs/msg/Float64
  stop:
    description: Stop motion and hold the measured posture; the fingers neither open nor close.
    transport: service
    direction: input
    endpoint: /kinex/gripper/stop
    type: std_srvs/srv/Trigger
model: {format: urdf, path: ???, base_link: ???}
grip: ???
stop: {behavior: hold, affected_devices: [gripper]}
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
  tcp: {parent: "gripper:base", translation_m: null, rotation_xyzw: null}
```
