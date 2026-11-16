---
name: joint
type: joint
description: Arm, hand or other mechanism whose geometry is a URDF, commanded by joint or tip pose targets.
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

`model.tip_links` lists the links that end the device's kinematic chains: an arm's
flange or tool link, or each fingertip of a hand; use `[]` when there are none.
FK and IK default to the only tip; with several, callers name the link.
`home` gives every commanded joint a position, or is null. With `limits: strict`,
the node and Kinex tools reject targets outside the URDF limits, allowing only a
bounded inward recovery toward home (`kinex.lib.joints.recovery_targets`); use
`native` when the device enforces or clamps its own limits and targets may reach
them.

Agents read the resolved tree as `profile(name)["resolved_model"]` and compute
FK and IK from it with `helpers.joint_model(name)`, so a device need not serve
kinematics. A controller with its own kinematics may declare `fk` or `ik` as
ordinary optional operations, for example MoveIt's
`moveit_msgs/srv/GetPositionFK` and `GetPositionIK`, stating links, frames and
units in their descriptions.

Ask the user whether the device takes joint targets, pose targets or both,
offering only what its controller supports. Joint targets command the joints
through `joint_target`. Pose targets command tip links through `pose_target`,
reusing the controller's own Cartesian control, such as a vendor interface, FZI's
`cartesian_motion_controller` or MoveIt Servo, instead of Kinex IK. A pose target
is a tip link's pose in `<device>/base`; a tip whose orientation the controller does
not track takes the same message and ignores its rotation, and the operation
description names such tips. A device that takes both serves both operations, and
the latest command of either kind replaces the active one. Reachability,
singularities and workspace limits stay with the controller: the node validates
only the message, and `limits` applies to joint targets.

The sibling `node.py` adapts a ros2_control stack: a `JointTrajectoryController`
for joint targets and, for pose targets, a controller tracking one
`geometry_msgs/msg/PoseStamped` per tip link in the URDF base link, which it
streams by interpolating each trajectory. Copy it with `links.py` into the device
directory, set its topic constants and declare only the command operations the
user chose. A node that commands hardware directly must still initialize its hold
from measured posture, so a stop before the first command never moves the joints.

### Operations

- `joint_state` (recommended): output topic `sensor_msgs/msg/JointState` with
  every commanded joint in URDF units, stamped at acquisition, with velocities
  when measured; Kinex publishes the links from it.
- `joint_target` (for joint targets): input topic
  `trajectory_msgs/msg/JointTrajectory` over commanded joints, timed from receipt.
  A new trajectory replaces the active command; sending is not arrival. Serve it
  with `stop` through `kinex.node.command_service`.
- `pose_target` (for pose targets): input topic
  `trajectory_msgs/msg/MultiDOFJointTrajectory` whose `header.frame_id` is
  `<device>/base`, whose `joint_names` name tip links once each, and whose points
  carry one transform per named tip in metres with a unit quaternion (xyzw), timed
  from receipt by strictly increasing `time_from_start`. A new trajectory replaces
  the active command; sending is not arrival. Serve it with `stop` through
  `kinex.node.command_service`.
- `pose_state` (optional): output topic `sensor_msgs/msg/MultiDOFJointState` with
  the tip poses the controller reports in `<device>/base`, stamped at acquisition.
  TF links from `joint_state` remain the measured geometry.
- `stop` (recommended): service `std_srvs/srv/Trigger` that ends motion and
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
    description: Joint trajectory over commanded joints in URDF units, timed from receipt. A new trajectory replaces the active command; verify arrival with joint_state.
    transport: topic
    direction: input
    endpoint: /kinex/arm/joint_target
    type: trajectory_msgs/msg/JointTrajectory
  pose_target:
    description: Tip link poses in arm/base, timed from receipt. A new trajectory replaces the active command; verify arrival on TF.
    transport: topic
    direction: input
    endpoint: /kinex/arm/pose_target
    type: trajectory_msgs/msg/MultiDOFJointTrajectory
  stop:
    description: Stop motion and hold the measured posture.
    transport: service
    direction: input
    endpoint: /kinex/arm/stop
    type: std_srvs/srv/Trigger
model: {format: urdf, path: ???, base_link: ???, tip_links: ???}
home: ???
limits: strict
stop: {behavior: hold, affected_devices: [arm]}
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```
