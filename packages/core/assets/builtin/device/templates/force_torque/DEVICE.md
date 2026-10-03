---
name: force_torque
type: force_torque
description: Force-only, torque-only or combined load measurements with explicit quantity, target, axes and reference frame. Optional for task readiness.
---

## Setup

Load initializes the connection and any owned control/streaming service, waiting
for readiness; status only observes. Unload stops active work according to the
profile and releases every owned resource, even if a cleanup stage fails. Follow
setup-device for service ownership, partial-startup rollback and exit cleanup.

Copy the starter profile below under the user's device name. Determine which physical
quantity is returned, the receiving body/frame, measured axes and torque
reference point. Consult templates/force_torque/DEVICE.md in the core Device guide roots for the runtime contract. A foot contact
sensor can provide contact_normal force on x/y/z with torque:null; a shaft torque
sensor can provide transmitted torque on z with force:null.

Record the connection using its fixed transport variant. Provision using
the setup-device skill, then complete the driver's connect,
disconnect and read_wrench hooks. Keep all assets inside the device directory.
The adapter returns SI axis maps in the declared frame. It must not subtract the
profile bias, manufacture unmeasured axes, or automatically zero on connection.

Record the rigid measurement frame using translation_m/rotation_xyzw, and the
load target using device/frame identifiers. Ranges and resolutions may be null
when unavailable; required unknown facts remain ???. Record source, method and
calibrated_at for each section. Keep loaded:false until the user loads it.

After load, verify channel availability and sign under a known applied load,
then compare magnitude with the reference. A stationary loaded sensor need not
read zero. Bias calibration is an explicit measurement and profile update.

### Adapter and field reference

A force_torque device measures force, torque, or both. Its contract carries no
physical/estimated/simulated origin flag. It is read-only and optional for task
readiness. All profile objects are closed; identifiers and transport addresses
are strings, but no notes, instructions or arbitrary configuration are accepted.

Intrinsics:
- measurement.quantity: transmitted (load through a mechanical connection),
  external (external load), contact_normal (normal contact contributions only),
  contact_total (normal and tangential contact contributions), or actuation
  (load applied by an actuator). These describe the returned physical quantity.
- measurement.target: {device, frame}, the body receiving the positive load.
- measurement.force and measurement.torque: null when unsupported, ??? when
  unresolved, or {axes, range, resolution, bias}.
- axes: a nonempty unique subset of x/y/z. Each map accepts only those axes.
- range: null (ratings unavailable) or {axis: {min, max}} for each declared axis.
- resolution: null (unavailable) or a positive number for each declared axis.
- bias: one finite number per declared axis, or ??? until established. Zero is
  an explicit no-additional-offset declaration. Force units are N; torque N·m.
- sample_rate_hz: positive number or null when unavailable. Not a pacing command.

The measurement frame is placed by extrinsics.mount with parent, parent_frame,
translation_m and a unit rotation_xyzw. Torque is about that frame's origin.
Forces follow positive axes; torques use the right-hand rule. Target and mount
references need not be the same (e.g. a flange-mounted sensor measuring a tool).
Neither reference requires a connection to world.

Each section carries source (user, calibration, introspected, default, unknown), method (unknown, factory, introspection, manual,
bias, survey), calibrated_at (UTC ISO timestamp or null), and an optional
needs_calibration reason, cleared explicitly with needs_calibration:null.
Access.connection is tcp{host,port}, url{url,device}, serial{path,baud_rate}, or
ros{state_topic}. The driver uses the usual entry/interpreter/persistent/timeout_s
fields, with actions read/load/unload/status.

Driver read returns force and torque as axis maps or null, in SI units and the
measurement frame. A supported zero measurement is a numeric zero, not null.
Missing, extra, or nonfinite axes are rejected. timestamp is finite acquisition time in seconds, falling back to receipt time;
cached readings retain their original timestamp.
Drivers adapt native coordinates/units/signs but do NOT apply profile bias.
The harness subtracts bias once, before tools and recorder receive the reading.
Out-of-range measurements are not clamped. The declared range is a rating, not
a motion limit. No automatic tare on connect/load/read. Explicit bias calibration
adds the mean corrected reading to the existing bias, under a known reference
load; do not erase real gravity/contact loads by assuming every idle value is zero.

kinex.force_torque.read(name) returns corrected readings. Its transform helper
conservatively requires all three axes for rotations. Translating a torque origin
also requires all three force axes; unknown force is never zero-filled. Common
geometry lives in tools/helpers, not device-specific instructions.

### Profile

```yaml
name: force_torque
type: force_torque
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
    actions:
    - read
    - load
    - unload
    - status
intrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  measurement:
    quantity: ???
    target:
      device: ???
      frame: ???
    force: ???
    torque: ???
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

## Use

Read-only. `read()` returns force (N) and torque (N·m) as declared axis maps,
or null when unsupported, plus timestamp. Unknown axes are never zero-filled.
`measurement.quantity` identifies the load kind; `measurement.target` receives
the positive load.

Vectors use the mounted measurement frame; torque is right-handed about its
origin. Bias is already subtracted once. Do not subtract it again or tare away
real loads. Range is a rating, not a clamp. `kinex.force_torque` handles
transforms; shifting torque origin also requires force measurements.
