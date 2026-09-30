---
name: imu
type: imu
description: Inertial measurements with explicit acceleration quantity, measured axes, optional orientation reference and magnetic field. Fixed profile and read-only driver.
---

## Setup

Load initializes the connection and any owned control/streaming service, waiting
for readiness; status only observes. Unload stops active work according to the
profile and releases every owned resource, even if a cleanup stage fails. Follow
setup-device for service ownership, partial-startup rollback and exit cleanup.

Copy the starter profile below under the user's chosen device name. Determine which channels
are actually returned and whether acceleration is specific_force or
gravity_removed. Record unsupported channels as null and unresolved facts as ???.
Do not infer attitude, magnetic field, position or velocity from the device type.
The starter profile is below. See templates/imu/DEVICE.md in the core Device
guide roots for the runtime contract.

Record the connection with its closed transport variant. Provision using
the setup-device skill, and complete connect, disconnect
and read_sample in driver.py. Drivers return SI axis maps and unit xyzw
orientation, without applying profile bias or automatically zeroing/referencing.
The harness handles channel validation and bias subtraction for every consumer.

Record the measurement location and axes using extrinsics.mount. If orientation
is available, declare its actual reference. Startup-relative attitude is not an
absolute world attitude. Unknown range/resolution/sample rate may remain null;
record provenance using source/method/calibrated_at. Keep loaded:false until load.

After activation, verify a known stationary pose and then a known rotation. Gyroscope readings
should be near zero at rest. Specific force should oppose gravity; it is only
approximately [0,0,9.81] when +Z points up. gravity_removed should be near zero.
Never treat the stationary gravity contribution as a bias to zero away. Preserve
the known mounting offset; rotating vectors alone does not relocate acceleration.

### Adapter and field reference

An imu device provides angular velocity, linear acceleration and optionally
orientation or magnetic field. Profiles describe returned measurements, with
no origin flag, backend clock, notes, instructions or arbitrary configuration.
All objects are closed. Device/frame identifiers and addresses are strings.
The device is read-only and optional for task readiness; it does not require world.

Intrinsics.measurement has exactly four channel fields:
- angular_velocity: {axes, range, resolution, bias}, null, or ???; units rad/s.
- linear_acceleration: the same channel plus quantity: specific_force or
  gravity_removed; units m/s².
- magnetic_field: the same axis channel, null, or ???; units T; defaults to null.
- orientation: {reference}, null, or ???. Output is a unit quaternion [x,y,z,w]
  placing the IMU measurement frame in the declared reference frame.
At least one of angular_velocity, linear_acceleration or orientation is required.
Null means unsupported; ??? means unresolved; measured zero is a numeric zero.

An axis channel declares a nonempty unique subset of x/y/z. Its maps contain
exactly those keys. range is null (rating unavailable), or {axis: {min,max}} with
min < max; resolution is null or one positive value per axis; bias is one finite
number per axis or ???. Bias values use the same units and frame as the reading.
Zero bias explicitly means no additional correction. Ratings never clamp samples.
sample_rate_hz is a positive number or null when unavailable, not a pacing command.

Acceleration quantity:
- specific_force is accelerometer specific force (a - g): zero in freefall,
  about g opposite gravity when stationary. +Z must point up for stationary
  readings to be approximately [0,0,9.81]. Gravity is not sensor bias.
- gravity_removed is motion acceleration with gravity effects already removed;
  stationary readings are approximately zero.
The common read path preserves this distinction; it never silently removes gravity.

Orientation reference is one of these closed variants:
- {kind: frame, frame: <frame-ref>}: the named reference, e.g. odom. The name must
  identify the reference actually used by the device; do not relabel it as world.
- {kind: startup}: the orientation reference at sensor startup. Reopening a
  transport/read does not implicitly reset it; readings from different reference
  epochs cannot be compared as though their reference were unchanged.
- {kind: gravity_aligned, heading: relative}: reference +Z up; +X is the initial
  horizontal heading, +Y completes the right-handed frame. No absolute yaw claim.
- {kind: gravity_aligned, heading: magnetic_north | true_north}: ENU relative to
  magnetic/true north respectively (+X east, +Y north, +Z up).
No Euler angles, convention strings, or unmeasured orientation are accepted.

Extrinsics.mount uses parent, parent_frame, translation_m and unit rotation_xyzw.
It places the IMU measurement frame in its parent. All measured vectors are
expressed in that IMU frame; acceleration is measured at that frame's origin.
Changing vector coordinates does not change the acceleration measurement point.
Moving acceleration to a body origin requires rotational-motion terms; mount
translation alone is insufficient. Fusion, integration and gravity compensation
belong to explicit common tools and do not expose simulator ground truth.

Every section has source (user, calibration, introspected,
default, unknown), method (unknown, factory, introspection, manual, bias, survey),
calibrated_at (UTC ISO timestamp or null) and an optional needs_calibration reason
(cleared explicitly with needs_calibration:null). Access.connection is
one of tcp{host,port}, url{url,device}, serial{path,baud_rate}, ros{state_topic}.
Driver fields are entry/interpreter/persistent/timeout_s/actions; only
read/load/unload/status are supported.

Driver read always returns all four channel keys: vector axis maps, orientation
quaternion, or null as declared. Each vector contains only the measured axes.
Optional sample_time_s is an acquisition timestamp or null if unavailable; do
not fabricate it from a polling time. Drivers adapt native units/axes and the
stated acceleration quantity, but do NOT subtract the profile bias. Dispatch
validates values and subtracts bias exactly once before tools and recording.
kinex.imu.read(name) uses that corrected read path and checks the device type.
No automatic zeroing or reference reset on connect/load/read. Establish any
additional bias under a known physical reference, retaining the expected gravity
contribution for specific force; use explicit zero bias to collect initially
uncorrected samples, then write the measured offsets to the profile.

### Profile

```yaml
name: imu
type: imu
loaded: false
access:
  source: unknown
  method: unknown
  calibrated_at: null
  connection: ???
  driver:
    entry: driver.py
    persistent: true
    timeout_s: 30
    actions: [read, load, unload, status]
intrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  measurement:
    angular_velocity: ???
    linear_acceleration: ???
    orientation: ???
    magnetic_field: null
  sample_rate_hz: null
extrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  mount:
    parent: ???
    parent_frame: ???
    translation_m: ???
    rotation_xyzw: ???
```
