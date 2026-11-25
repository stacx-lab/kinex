---
name: joint
type: joint
description: Arm, hand or other mechanism whose geometry is a URDF, commanded by joint or tip pose targets.
---

## Setup

Geometry is a URDF, not profile fields. Expand the vendor's description to plain
URDF and set `model` to its path and base link. The device commands every
independent movable joint below the base link, in URDF document order; mimic joints
follow their sources. Remove links owned by other devices, such as a separately
registered gripper. Kinex publishes each link on TF as `<device>/<link>` from
`joint_state`, the base link as `<device>/base`; other devices mount on these
links, for example a gripper base on `arm:flange`. Link names must not repeat
profile frame names.

`model.tip_links` lists the links that end the kinematic chains: an arm's flange or
tool link, each fingertip of a hand, or `[]`. FK and IK default to the only tip;
with several, callers name one. `home` gives every commanded joint a position, or
is null. With `limits: strict` the node and Kinex tools reject targets outside the
URDF limits, except a bounded inward recovery toward home
(`kinex.common.joints.recovery_targets`); use `native` when the device enforces
its own limits.

Programs read the resolved tree as `profile(name)["resolved_model"]` and compute FK
and IK with `lib.kinematics.joint_model(name)`, so a device need not serve
kinematics. A controller with its own may declare `fk` or `ik` as optional
operations, such as MoveIt's `moveit_msgs/srv/GetPositionFK` and `GetPositionIK`,
stating links, frames and units in their descriptions.

Ask the user whether the device takes joint targets, pose targets or both, offering
only what its controller supports. Pose targets reuse the controller's own
Cartesian control (a vendor interface, FZI's `cartesian_motion_controller`, MoveIt
Servo) instead of Kinex IK, so reachability, singularities and workspace limits
stay with the controller: the node validates only the message, and `limits` applies
to joint targets. With both, the latest command of either kind replaces the active
one.

The sibling `node.py` adapts a ros2_control stack: a `JointTrajectoryController`
for joint targets and, for pose targets, a controller tracking one
`geometry_msgs/msg/PoseStamped` per tip link, which the node streams by
interpolating each trajectory. Copy it into the device directory, set its topic
constants and declare only the command operations the user chose. A node that
commands hardware directly still initializes its hold from the measured posture, so
a stop before the first command never moves the joints.

### Operations

- `joint_state` (recommended): output topic `sensor_msgs/msg/JointState` with every
  commanded joint in URDF units, stamped at acquisition, with velocities when
  measured.
- `joint_target` (for joint targets): input topic
  `trajectory_msgs/msg/JointTrajectory` over commanded joints, timed from receipt.
  A new trajectory replaces the active command.
- `pose_target` (for pose targets): input topic
  `trajectory_msgs/msg/MultiDOFJointTrajectory` with `header.frame_id`
  `<device>/base`, `joint_names` naming tip links once each, and in every point one
  transform per named tip (metres, unit quaternion xyzw), timed from receipt by
  strictly increasing `time_from_start`. A new trajectory replaces the active
  command. A tip whose orientation the controller does not track ignores the
  rotation; the description names such tips.
- `pose_state` (optional): output topic `sensor_msgs/msg/MultiDOFJointState` with
  the tip poses the controller reports in `<device>/base`, stamped at acquisition.
- An action (optional), where the controller serves one, such as
  `control_msgs/action/FollowJointTrajectory`: a command with an end, whose goal
  programs await through the world's waits. A newer goal or command, a stop or a
  cancel ends the active goal.
- `stop` (recommended): service `std_srvs/srv/Trigger` that ends motion and holds
  the measured posture.

Serve the command topics and `stop` through `kinex.node.command_service`. Sending a
command is not arrival: programs verify it with `joint_state` or TF.

### Profile

```yaml
name: arm
type: joint
loaded: false
description: ''
runtime:
  observation: joint_state
  nodes: [{entry: node.py, factory: create}]
operations:
  joint_state:
    description: Measured joint positions and velocities in URDF units, stamped at acquisition.
    transport: topic
    direction: output
    endpoint: /kinex/arm/joint_state
    type: sensor_msgs/msg/JointState
    qos: {depth: 1, reliability: reliable, durability: transient_local}
  joint_target:
    description: Joint trajectory over commanded joints in URDF units, timed from receipt. It replaces the active command.
    transport: topic
    direction: input
    endpoint: /kinex/arm/joint_target
    type: trajectory_msgs/msg/JointTrajectory
  pose_target:
    description: Tip link poses in arm/base, timed from receipt. It replaces the active command.
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
