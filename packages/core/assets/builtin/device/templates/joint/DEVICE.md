---
name: joint
type: joint
description: Joint-controlled arm, hand or other mechanism whose geometry is a URDF.
---

## Setup

Geometry lives in a URDF, not in profile fields. Use the vendor's description
(expand xacro to plain URDF) and set `model` to its path and base link. The device
commands every independent movable joint below the base link in URDF document
order; mimic joints follow their sources. Remove links owned by other devices,
such as a separately registered gripper, so the tree holds only this device.
The sibling `links.py` node publishes every link on TF as `<device>/<link>`, with
the base link as `<device>/base`; other devices mount on these links, for example
a gripper base on `arm:flange`. Link names must not repeat profile frame names.

`model.tip_link` names the end-effector link that FK, IK and Cartesian policies
use by default; set it to null for trees without one, such as a dexterous hand.
`home` gives every commanded joint a position, or is null. With `limits: strict`,
the node and Kinex tools reject targets outside the URDF limits, allowing only a
bounded inward recovery toward home (`kinex.joints.recovery_targets`); use
`native` when the device enforces or clamps its own limits and targets may reach
them.

Agents read the resolved tree as `profile(name)["resolved_model"]` and compute
FK and IK from it with `helpers.joint_model(name)`, so a device need not serve
kinematics. A controller with its own kinematics may still declare `fk` or `ik`
as ordinary optional operations, for example MoveIt's
`moveit_msgs/srv/GetPositionFK` and `GetPositionIK`, stating links, frames and
units in their descriptions.

The sibling `node.py` adapts a ros2_control `JointTrajectoryController`; copy it
with `links.py` into the device directory and set its topic constants. A node
that commands hardware directly must still initialize its hold from measured
posture, so a stop before the first command never moves the joints.

### Operations

- `joint_state` (recommended): output topic `sensor_msgs/msg/JointState` with
  every commanded joint in URDF units, stamped at acquisition, with velocities
  when measured; Kinex publishes the links from it.
- `joint_target` (recommended): managed input topic
  `kinex_interfaces/msg/TrajectoryCommand` whose `trajectory` is a
  `trajectory_msgs/msg/JointTrajectory` over commanded joints, timed from
  acceptance. A new command replaces the active trajectory; acceptance is not
  arrival. Serve acquire, owner-scoped stop and command status with
  `kinex.ownership.motion_service`.
- `stop` (recommended): service `kinex_interfaces/srv/Stop` that ends motion and
  holds the measured posture.

### Profile

```yaml
name: arm
type: joint
loaded: false
description: ''
runtime:
  observation: joint_state
  nodes: [{entry: node.py, factory: create}, {entry: links.py, factory: create}]
operations:
  joint_state:
    description: Measured joint positions and velocities in URDF units, stamped at acquisition; Kinex publishes the URDF links from them.
    transport: topic
    direction: output
    endpoint: /kinex/arm/joint_state
    type: sensor_msgs/msg/JointState
    qos: {depth: 1, reliability: reliable, durability: transient_local}
  joint_target:
    description: Joint trajectory over commanded joints in URDF units, timed from acceptance. A new command replaces the active one; acceptance is not arrival, so verify joint_state.
    transport: topic
    direction: input
    endpoint: /kinex/arm/joint_target
    type: kinex_interfaces/msg/TrajectoryCommand
    motion: {acquire: /kinex/arm/acquire, stop: /kinex/arm/stop, status: /kinex/arm/command_status}
  stop:
    description: Stop pending motion and hold the measured posture. An empty owner stops unconditionally.
    transport: service
    direction: input
    endpoint: /kinex/arm/stop
    type: kinex_interfaces/srv/Stop
model: {format: urdf, path: ???, base_link: ???, tip_link: ???}
home: ???
limits: strict
stop: {behavior: hold, affected_devices: [arm]}
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```
