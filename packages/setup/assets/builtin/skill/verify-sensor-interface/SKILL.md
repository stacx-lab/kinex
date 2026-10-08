---
name: verify-sensor-interface
description: Verify a camera, IMU or force-torque sensor's live interface from fresh samples without commanding motion.
---

# Verify sensor interface

Bind `sensor` to the rgb, rgbd, imu or force_torque device. Read its type guide
and the device's own guide (resolve the bundle name in Device guide roots).
Prepare the driver and load it explicitly through core lifecycle. Sensor
inspection never commands motion or changes device settings.

Resolve the selected profile's `access.driver.entry` relative to the device
directory. Its containing directory is the selected driver generation; use that
directory's `check.sh` when present. If it also contains `stack.sh`, first run
`bash "<generation>/stack.sh" status` through host bash and continue only when it
exits 0. Then run `bash "<generation>/check.sh"` (add `--introspect`
for cameras so the active output mode is compared with the declared
intrinsics). Before camera introspection, establish whether each stream is raw
or rectified from its ROS interface documentation and declare
`driver.color_image_space` (and `driver.depth_image_space` for native depth with
its own CameraInfo) in the bundle. Unknown image space remains incomplete.
It prints `ok` or `FAIL <check>: expected X measured Y` lines and
writes `<device dir>/verify/measurements.json`. Pass that file unchanged to
`calib_compute operation:verify-checks`; do not re-derive or relax its checks.
Report a failed check by name with the bundle guide's troubleshooting entry.

Without a checker beside the selected driver, take fresh reads through the core
`device` tool (or `calib_sample` for an archived artifact) and author the named
checks in the format described by `calib_compute`: `rate:<source>` as a shortfall from
timestamps across at least two reads (expected 0, measured
`max(0, min_hz - hz)`, tolerance 0, units Hz); for cameras `resolution`
comparing the exact width, height and pixel format of the returned image with
`intrinsics.color` (and depth), and `camera_info` comparing the exact projection
source and frame reported by the interface with the profile; for an IMU or
force-torque sensor the exact axes and units of the returned sample. Name only
the checks the task needs in `required_checks`; every check cites its reference.

Fix only proven mismatches by changing facts and rerunning `setup.sh` or by
restarting the stack with `stack.sh`; never edit a bundle's generated files or
driver. Apply introspected intrinsics through `profile_write` only when the
interface reports them. A camera profile mismatch makes `check.sh --introspect`
fail and leaves the observed fields in `profile.patch.json`; apply those fields,
reload, and rerun the check before recording a passing result. Record only the
resolved plan node with the numbered result evidence and return to the task.

See [procedure.json](procedure.json) for roles and computations.
