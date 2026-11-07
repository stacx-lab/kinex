---
name: locomotion
type: locomotion
description: Mobile base, quadruped or humanoid moved by body velocity, posture and mode commands.
---

## Setup

A locomotion device moves its body: a wheeled base, a quadruped or a humanoid's
walking controller. `frames.base` is the body frame, normally an unlocalized root;
odometry never establishes a global pose. Raw leg joints are not part of this
type: register them as a separate joint device, never loaded while the locomotion
controller owns the legs.

`velocity` declares the commandable body axes (`vx`, `vy`, `vz` in m/s, `wx`, `wy`,
`wz` in rad/s) with `units: si`, or `normalized` when the controller takes [-1, 1]
of its range. `posture` declares body offsets from the nominal stance (`height` in
m, `roll`, `pitch`, `yaw` in rad), or is null. Each axis has `{min, max}` bounds
including zero, or null when unbounded. With `limits: strict` the node rejects
commands outside them; use `native` when the controller saturates them itself.

`modes` is the controller's state machine. Each mode names the operations it
`accepts` and the modes it can be commanded to through `transitions`. A device also
reports modes it enters on its own, such as after a fall; declare them, and list
them in no transitions if they cannot be requested. Make a mode for anything that
changes what the body accepts or how it behaves, and an operation for a setting
within a mode. A wheeled base has one mode:

```yaml
modes:
  drive: {description: Drives on velocity commands., accepts: [velocity], transitions: []}
```

A quadruped such as a Unitree Go2 might declare:

```yaml
modes:
  standing: {description: Standing balanced; walks on velocity and adjusts posture., accepts: [velocity, posture, gait], transitions: [crouched]}
  crouched: {description: Lying down with legs folded; motors hold the body., accepts: [], transitions: [standing]}
  recovering: {description: Getting up after a fall; accepts nothing until standing., accepts: [], transitions: []}
```

Expose only the actions a task needs; never expose actions that drop the body,
such as motor damping, or acrobatics unless the user asks. The sibling `node.py`
adapts a driver with velocity, pose and odometry topics, a mode topic and a
service per mode; copy it into the device directory and set its constants.

### Operations

- `velocity` (recommended): input topic `geometry_msgs/msg/Twist` in base axes.
  The body follows the latest twist and stops when none arrives within the
  watchdog timeout its description states, so callers re-send to keep moving.
- `posture` (optional): input topic `geometry_msgs/msg/Pose`, a body offset from
  the nominal stance (`position.z` height, orientation roll, pitch, yaw); it
  persists until replaced.
- `mode_target` (recommended with more than one mode): input topic
  `std_msgs/msg/String` whose `data` names a declared transition target. Sending
  is not arrival; wait until `mode` reports it.
- `mode` (recommended with more than one mode): output topic `std_msgs/msg/String`,
  `transient_local`, the last declared mode reached.
- `odometry` (recommended): output topic `nav_msgs/msg/Odometry` with measured
  twist in `<device>/base` and a dead-reckoned pose in `<device>/odom` that drifts.
- `stop` (recommended): service `std_srvs/srv/Trigger` that sends zero
  velocity and keeps the mode and posture; it never sits, lies down or powers off.
- Mode-specific inputs (optional): any other operation a mode accepts. Inputs that
  move the body are `std_msgs/msg/String` topics carrying JSON; others may be
  services. The description is the whole contract.

Serve the inputs with `stop` through `kinex.node.command_service`. The node
rejects an operation the current mode does not accept and a transition it does
not list.

### Profile

```yaml
name: base
type: locomotion
loaded: false
description: ''
runtime:
  observation: odometry
  nodes: [{entry: node.py, factory: create}]
operations:
  velocity:
    description: Body velocity in base axes. The body follows the latest twist and stops 0.5 s of world time after the last one, so re-send to keep moving; verify with odometry.
    transport: topic
    direction: input
    endpoint: /kinex/base/velocity
    type: geometry_msgs/msg/Twist
  posture:
    description: Body offset from the nominal stance, height in position.z and attitude in orientation; it persists until replaced.
    transport: topic
    direction: input
    endpoint: /kinex/base/posture
    type: geometry_msgs/msg/Pose
  mode_target:
    description: Request a declared transition from the current mode, naming the target in data; wait until mode reports it.
    transport: topic
    direction: input
    endpoint: /kinex/base/mode_target
    type: std_msgs/msg/String
  mode:
    description: The last declared mode the body reached.
    transport: topic
    direction: output
    endpoint: /kinex/base/mode
    type: std_msgs/msg/String
    qos: {depth: 1, reliability: reliable, durability: transient_local}
  odometry:
    description: Measured body twist in base/base and a drifting dead-reckoned pose in base/odom; never a global pose.
    transport: topic
    direction: output
    endpoint: /kinex/base/odometry
    type: nav_msgs/msg/Odometry
    qos: {depth: 1, reliability: reliable, durability: transient_local}
  stop:
    description: Send zero velocity and keep the mode and posture.
    transport: service
    direction: input
    endpoint: /kinex/base/stop
    type: std_srvs/srv/Trigger
velocity: ???
posture: ???
modes: ???
limits: strict
stop: {behavior: hold, affected_devices: [base]}
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```
