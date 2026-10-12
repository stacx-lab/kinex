---
name: setup-device
description: Add a device or repair its driver — choose an instance or type guide, provision its runtime, fill a profile and verify the interface.
resolves: access:velocity,access:legged_base,access:joint,access:gripper,access:dexterous_hand,access:suction,access:rgb,access:rgbd,access:imu,access:force_torque,access:model,intrinsics:model,access:detection,intrinsics:detection,access:segmentation,intrinsics:segmentation,access:other
---

# Set up a device

## Select the guide

Resolve name/type from configuration and user facts before asking. In context's
ordered Device guide roots, search all `<root>/<name>/DEVICE.md` paths before
falling back to the first `<root>/templates/<type>/DEVICE.md`.
Read Setup and applicable Use sections; start from Setup → Profile YAML or the
setup script's profile. Follow the type's units, frames, commands and feedback.

## Provision and register

Use the nearest `.kinex/` directory in the current directory or its ancestors;
if none exists, use `.kinex/` in the current directory. Copy the driver scaffold
and support files into that directory's `devices/<name>/` (the workspace's
`.kinex/devices/<name>/`), independent of packaged template paths. Complete its SDK
hooks; read connection, model and calibration settings from sibling `profile.yaml`.
Shared vendor clients may use `.kinex/lib/` in the same workspace.

Use context's core Python; record dependencies with
`uv add --project <python.project> PACKAGE`. If the vendor or user requires another
environment, set `access.driver.interpreter` to its absolute interpreter path;
otherwise omit it. Keep credentials in environment variables. For direct checks,
set command-local `PYTHONPATH` to context's core helper and workspace library paths.

Use `profile_write`: declare implemented actions, preserve facts/provenance, leave
unknowns as `???`, and mark missing calibration `kind=needed`. Clear resolved
requests with `needs_calibration:null` in the relevant section. New devices stay
unloaded; edits preserve activation intent.

Custom `.kinex/devices/<name>/DEVICE.md` files are allowed only for type `legged_base`.
For that type, write a concise `## Use` as required by its guide: it replaces the
type's Use section, so include the applicable operating contract and verified
examples. Keep provisioning in Setup. For every other type, do not create or
customize a per-device `DEVICE.md`; use the shared type guide and keep instance
parameters in `profile.yaml` and SDK adaptation in the driver.

## Driver contract

Reuse core helpers. Default to persistent drivers with `kinex.driver_protocol.run`
for correlated JSONL, concurrency and exit cleanup. Keep SDK diagnostics off stdout,
including imports; set `timeout_s` for the longest operation.

Implement `load`, `unload`, `status` and type operations:

- **Lifecycle:** load acquires resources, reuses healthy connections, waits for
  readiness and rolls back failed startup. Status only observes; ordinary calls
  never restart failed services.
- **Feedback:** adapt SDK units/axes/frames; return actual observations and the
  type's absence values, never invented or echoed commands. Preserve acquisition
  timestamps, including cached readings.
- **Writes:** validate before effects; replace pending references and return
  `{execution_id, state}` immediately with measured state, not claimed arrival.
  Follow the type's duration, expiry and stop rules.
- **Concurrency:** keep reads/stop responsive with short SDK locks; never hold
  their locks across motion waits. In long-running request handlers, call
  `kinex.driver_protocol.check_cancelled()` between bounded SDK operations.
  Background workers need their own stop/cancellation mechanism.
- **Cleanup:** declare all affected devices in stop scopes. Unload stops within
  scope and releases resources. Use `kinex.driver_protocol.release` for independent
  cleanup stages even after failures; retain handles, report errors and make retries harmless without
  opening connections. Keep owned services in the driver's process group and
  stop/wait for them; close borrowed clients without terminating shared services.

Use `persistent:false` only when each call needs a fresh process: retain no
connections, recordings or owned services between calls. Release temporary clients
without cancelling accepted asynchronous commands; explicit unload performs stop.

Prioritize using official vendor SDKs such as pyrealsense2 for RealSense cameras and i2rt python API for i2rt yam manipulators.
Search for official documentations of the SDKs and follow recommanded usage.
Do not reimplement functionalities provided in the SDKs.
Do not assume user is faimiliar with the SDKs.

## Setup process

Supervised movement of the devices is encouraged for to enable faster setup.
Any movable device (bases, joints) needs response time, avoid using very small speed commands in the setup.
Test and record response behavior under `control.modes.<mode>.response`.
**Do not enforce any additional safety constraints** other than the declared fields in the
device profile through the whole process, inlcuding check scripts, drivers, etc.
Allow human to override any existing safety check.

## Verify

Check schema, imports and syntax without starting hardware. Use focused mocks for
changed conversions, input rejection and lifecycle failures as relevant.

Activate only when authorized, through device load/unload actions or `/load`;
Python tools cannot change lifecycle. Check readiness with status or `/ping`, then
perform task-required reads, inference or motion checks. After code or cached
configuration changes, reload persistent drivers with `/reload <name>` or unload/load.
