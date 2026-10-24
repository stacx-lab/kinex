---
name: calibrate-gripper-grip
description: Establish a gripper's grip joint and its open and closed positions when a task needs grip commands or policy grip values.
---

# Calibrate gripper grip

Bind `target` to the gripper. `grip` names the actuated, non-mimic URDF joint and
its `open` and `closed` positions in that joint's units; policy values in
[-1, 1] interpolate between them, and the node rejects targets outside them.

Prefer vendor documentation of the commanded open and closed positions. Otherwise
run `calib_compute operation:urdf-introspect` to read the URDF's movable joints
and their limits; the joint limits bound the range but may exceed what the
hardware commands. Choose the joint the vendor driver actually commands; mimic
joints follow it.

To measure, load the gripper with nothing between the fingers. Open and then
close it fully through the vendor's own interface or by hand, since `target`
already requires a valid grip. Record each end with `calib_sample` after its
`joint_state` stops changing, and take `open` and `closed` from the grip joint's
measured positions. A closed position may be negative or larger than open;
preserve the measured direction.

Apply `grip` with `profile_write`, unload and reload the gripper, then command a
mid-range `target` and verify the measured grip joint and the finger links on
TF. Archive the source or samples as evidence.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.
