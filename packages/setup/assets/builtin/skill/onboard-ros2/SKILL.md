---
name: onboard-ros2
description: Register or repair ROS 2 hardware integrations using reusable packages, staged device bundles and measured interface checks.
---

# Onboard ROS 2 hardware

Supported ROS baseline: Jazzy on Ubuntu 24.04 with its system Python 3.12.
Use that interpreter for ROS adapters; older ROS distributions and Python 3.10
are unsupported.

Use for new or replaced hardware integrations during `/onboarding` or `/register`.
Preserve working integrations unless replacement is part of the task. Prefer a
compatible ROS package; use a direct vendor SDK only for a concrete unsupported
capability/version or the user's explicit choice. A missing Kinex bundle is
configuration work, not a reason to bypass ROS. Core's `setup-device` supplies the
generic profile, driver, permission and lifecycle contracts.

1. Inspect the selected device guide and existing profiles, hardware/host facts,
   ROS packages and setup plan. Check actual commands, measured feedback and stop
   behavior against the device's Use contract. Batch material missing facts.
2. Read [dependencies](references/dependencies.md) before package installation or
   source builds. Reuse installed driver packages and assets across devices, then
   apt binaries; record the evidenced reason for any source/SDK fallback.
3. Select or author the minimal bundle using the setup-owned `kinex_ros` helpers.
   Read [bundles](references/bundles.md) for the entrypoint and generation contract.
   Follow the returned dependency needs and resume the same provisioning command.
4. Read the completed `profile.generated.json`. For a new device, apply it with
   `profile_write`, leaving it unloaded. For an existing device, unload through
   core, preserve its settings/calibration, and replace only affected sections.
   Use `replace: ["access"]` when removing obsolete connection fields; merging
   retains them. Never write profile YAML directly from provisioning scripts.
5. Start the stack only through its returned command when authorized, then load
   through core. Run the generation's `check.sh`; it only observes interfaces.
   Require a successful exit and inspect its named results. Retain
   `<device dir>/verify/measurements.json` unchanged as evidence; report failed
   checks by name without pruning checks or relaxing tolerances. For cameras,
   establish raw versus rectified image space from interface documentation and
   declare `driver.color_image_space` (and `driver.depth_image_space` for native
   depth with its own CameraInfo). Use `--introspect` to compare the live output
   with the declared intrinsics; apply observed fields from `profile.patch.json`
   through `profile_write`, reload and rerun checks after a mismatch.
   Registration alone does not imply measured readiness or authorize motion.
6. When setup planning is in use, save the generated recipe or update the existing
   preparation nodes with exact outputs and record the measurement evidence on
   the onboarding node. Use `verify-base` for existing base procedures. Reuse
   `verify-base-motion` for task-required base trials; use `verify-base-posture`
   only when the device exposes posture control and the task needs it. Motion verification requires
   separate authorization. Failed or pending installation and failed checks remain incomplete.

Provisioning stages all entrypoints and helpers together; it never changes the
active profile. Keep stack commands and driver paths pinned to the selected
generation. Satellites share their recorded parent's environment and stack.
Reload after changing driver configuration. Unload never terminates a borrowed
stack. Preserve the adapters' measured stop confirmation and failure latching.

For failed replacement, unload the candidate before restoring a previous
compatible generation through `profile_write`; preserve intervening user edits.
For legacy profiles using `kinex.ros2*`, read [migration](references/migration.md).
Use the existing shell tool for dependency installation. When sudo is required,
give the user the exact command and target host to run independently; leave the
prerequisite incomplete until they report completion and package checks pass.
