---
name: setup-device
description: Add a device or repair its driver — choose an instance or type guide, provision its runtime, fill a profile and verify the interface.
resolves: access:velocity,access:joint,access:gripper,access:dexterous_hand,access:suction,access:rgb,access:rgbd,access:imu,access:force_torque,access:model,intrinsics:model,access:detection,intrinsics:detection,access:segmentation,intrinsics:segmentation,access:other
---

# Set up a device

## Select the guide

Use the ordered Device setup guide roots in the system prompt (workspace/project,
global, builtin). For the requested family/name, look for `<root>/<name>/DEVICE.md`
in every root first. If no instance matches, use
`<root>/templates/<type>/DEVICE.md` in the first root containing it. Establish
missing type/name information from existing configuration before asking the user.
Do not substitute a generic template for an available concrete instance.

Read the selected guide's Setup section. Read its type's Use section from the
core runtime Device guide roots; workspace/global guides may contain both sections. The starter
profile is the single YAML block under Setup → Profile; copy that data, not the
illustrative fragments elsewhere in the guide. Template driver.py is executable
scaffolding. A concrete instance such as SAM3 may also have a substantial setup.sh.

## Prepare and register

1. Inspect existing configuration/SDKs and use the user's supplied facts and
   authorization. Ask only for missing facts. Keep source provenance; unknowns
   remain ??? and calibration work is queued through calib_write kind=needed.
2. Prepare the device directory under the workspace's devices/<name>/; keep device
   sources, caches, artifacts and outputs there. Use the shared Kinex core Python
   by default and record SDK dependencies with `uv add --project .kinex/python PACKAGE`. Use a separate
   environment and an explicit interpreter only when required by a vendor/model
   stack or supplied by the user. Include imports used by helpers (for example
   PyYAML, numpy, Pillow). Store credentials in environment variables.
3. Copy driver.py and every runtime support module into the device directory, then
   complete its SDK hooks. Never retain imports, symlinks or access.driver entries
   pointing into the installed @kinex/setup package; a configured device must work
   after that package is removed. Connection, model, calibration and
   command settings come from the actual sibling profile.yaml. The harness puts
   its kinex Python helpers and workspace lib/ on PYTHONPATH. Direct test
   invocations need those paths explicitly. Shared vendor clients belong in lib/.
   World needs a clock driver for read/wait. Remote models need only a thin client;
   local model artifacts are provisioned at their declared paths before loading.
4. Write the starter profile plus known instance facts through calib_write. Set
   all implemented driver actions; omit interpreter for Kinex core Python, or set
   an absolute path for a separate environment. Keep loaded:false
   for new devices. Repairing an existing driver preserves its profile and
   activation state; persistent drivers need /reload or device unload followed by load to pick up edits.
5. Validate schema, imports and driver syntax without starting the device. Use
   mock SDK tests for conversions, invalid-command rejection and lifecycle.
   calib_plan checks connection completeness and declared actions. Clear a resolved access request explicitly with needs_calibration:null.
   Registration ends unloaded. When activation is part of the authorized task,
   use the device tool action=load (device_act permission); /load is also available.
   Probe readiness with device status or /ping. Real reads/inference and motion
   tests follow activation and the user's authorized task.

## Shared driver protocol

Drivers are persistent by default (`access.driver.persistent: true`). The harness
runs `<interpreter> driver.py --serve` in the device directory: one JSON line
{id,action,args} per request, one flushed response {id,ok:true,...payload} or
{id,ok:false,error:"..."}. Echo the string id; replies may finish out of order. Use kinex.driver_protocol.run for the message loop,
stdout isolation and idempotent cleanup on EOF/SIGTERM. Load acquires connections
and starts any owned model, arm-control or camera-streaming service, then waits
for readiness. Load is idempotent: reuse healthy resources, and restore an owned
service that has stopped. Keep resources in the persistent driver. A failed
load must undo partial acquisition; use local try/finally or ExitStack in the SDK
hook. Reads, writes and inference do not restart a failed persistent service;
explicitly load it again. Status only observes and must never initialize it.
SDK diagnostics go to stderr; imports must also keep stdout clean. Preserve
large arrays/images as files; expose a main attachment as file. The harness
returns other payload fields as data. Set timeout_s for the longest operation.

Reads/status/FK/IK run concurrently with bounded writes. Writes are ordered per
logical device; independent devices may write together. Capture start/stop uses a
separate ordered queue. Load/unload fence active users before replacing resources.
SDK hooks must protect short native operations and connection bookkeeping, never
hold a lock needed by reads or halt throughout a motion wait. Check
`kinex.driver_protocol.check_cancelled()` between native operations in write hooks.
Stop cancels active and queued writes before invoking halt; new writes wait for
stop completion. The runner also accepts the internal `{id,interrupt:true}` control
frame to cancel hooks when a different driver's stop affects this device.
World drivers accept `{id,interrupt:request_id}` to cancel one wait.
Camera hooks must return consistent snapshots; file paths must identify immutable
per-response artifacts. The camera templates serialize SDK acquisition and copy
reused buffers. Recorder shutdown must finish before disconnecting its source.
Existing hand-written persistent loops must migrate to correlated replies; untagged
responses fail with a migration error. Regenerate RoboEnv workspace drivers from
the updated catalog and reload devices before use.

Only use explicit persistent:false for adapters that require a fresh process
per call. These receive one `{action,args}` JSON line on stdin and
return one response object; they cannot retain a connection or recording
between calls or own a long-lived service. Close temporary clients at process
exit without cancelling accepted asynchronous commands; explicit unload performs
the declared stop. Persistent driver edits take effect after /reload.

Implement read/load/unload/status, plus the type's actions and model operations.
Read/status report actual state; acquisition timestamps identify samples, not
polling. Drivers adapt native units/axes and transport; shared helpers implement
common validation/conversion. Force/IMU drivers return raw SI measurements;
the harness applies profile bias once. Actuated writes validate before effects,
require positive duration_s and replace goals without restarting identical targets.
Submit the validated buffer and return execution_id, submission elapsed_s and
measured state immediately. Consume references at the fixed device cadence;
submission does not promise arrival. Explicit stop clears the affected buffers.
Read/load must not initiate motion or silently clear faults; unload releases
resources and safely stops active actuation. Attempt recorder shutdown, halt,
disconnect and owned-service cleanup even if an earlier stage fails; use
kinex.driver_protocol.release for independent stages. Retain cleanup handles
and required configuration so unload does not depend on rereading profile.yaml.
Cleanup is idempotent and never opens a connection on an inactive persistent driver.
Report actual stop scope and cleanup errors. Model inference never commands a robot.

Keep driver-owned child services in its process group (no detached daemon or
start_new_session); retain their handles and stop/wait for them on unload. The
harness allows five seconds for EOF cleanup, then terminates the owned group.
A remote/shared service is borrowed: close the client, never stop the shared
server. For a device such as a YAM arm, implement control-service startup and
readiness in connect, and owned-service shutdown in disconnect. Starting the
service must not move the arm, home it or clear faults.

Every type supports load/unload/status. World loads its clock driver.
Ping never spawns a process. The agent
can load/unload through the device tool with device_act permission; Python tools
cannot change lifecycle. Verify repeated load/unload, failed startup, cleanup
failures and process exit with fake SDKs before testing hardware.

Declare local frames in `intrinsics.frames`: fixed xyz+xyzw poses, `null` for
moving frames returned by `read.frame_poses`, or `???` until calibrated. All are
relative to the canonical device frame. Use `device:frame` references and
`extrinsics.mount` for placement in a parent device's frame. Frames have no
separate device directory or driver.

A reusable instance can be saved under a content root's device/<name>/ with
DEVICE.md (Setup/Profile) and its driver. Type guides have Use and Setup sections;
keep setup material out of Use, which is injected into normal task context.

### Gripper geometry

For a gripper, describe its canonical TCP, preferred approach, fixed closing axis
(if one exists), contact surfaces and opening limits in `intrinsics.geometry`.
Follow the gripper template. Inspect vendor/model geometry; do not guess axes from
the mount. Dynamic pad frames belong to `intrinsics.frames` and every read must
supply their poses. Geometry is advisory; leave unavailable facts unknown without
blocking the control contract. Angular/adaptive/multi-finger mechanisms need not
have a single closing axis or affine aperture model.
