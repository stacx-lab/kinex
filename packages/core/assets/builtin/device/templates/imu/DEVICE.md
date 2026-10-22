---
name: imu
type: imu
description: Inertial measurements with explicit acceleration quantity, measured axes, optional orientation reference and magnetic field.
---

## Setup

Declare `measurement`: `angular_velocity`, `linear_acceleration` with its
`quantity` (`specific_force` includes gravity, `gravity_removed` excludes it),
`orientation` with its `reference`, and optional `magnetic_field`; use `null` for
channels the device does not provide. Each vector channel lists its `axes`,
optional `range` and `resolution`, and `bias`. `frames.base` is the measurement
frame and its mount. Record `sample_rate_hz` when known.

The node subtracts the profile `bias` from every published sample, so readings
are calibrated and consumers never correct them. Record zero bias until
calibrated; a bias calibration averages readings in a known static state and
adds the residual to it. Never remove gravity, tare or reset orientation
implicitly.

The sibling `node.py` adapts an existing ROS IMU driver to this contract; copy it
into the device directory and set `SOURCE`, and `MAGNETIC` when measured.

### Operations

- `imu` (recommended): output topic `sensor_msgs/msg/Imu` in rad/s and m/s² in
  `<device>/base`, with orientation mapping that frame into the declared
  reference, stamped at acquisition on the world clock. A channel the device does
  not provide has covariance `[0] = -1` (REP-145) and NaN values; unmeasured axes
  are NaN, and unknown covariance is all zeros. Use `best_effort` with depth 1.
  Recording and snapshots read it through `runtime.observation`.
- `magnetic_field` (optional): output topic `sensor_msgs/msg/MagneticField` in
  tesla in `<device>/base`, bias-corrected, only when the device measures it.

### Profile

```yaml
name: imu
type: imu
loaded: false
description: ''
runtime:
  observation: imu
  nodes: [{entry: node.py, factory: create}]
operations:
  imu:
    description: Bias-corrected angular velocity (rad/s) and acceleration (m/s^2) in imu/base with orientation in its declared reference; unprovided channels have covariance[0] = -1 and NaN values.
    transport: topic
    direction: output
    endpoint: /kinex/imu/imu
    type: sensor_msgs/msg/Imu
    qos: {depth: 1, reliability: best_effort, durability: volatile}
measurement:
  angular_velocity: ???
  linear_acceleration: ???
  orientation: ???
  magnetic_field: null
sample_rate_hz: null
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```
