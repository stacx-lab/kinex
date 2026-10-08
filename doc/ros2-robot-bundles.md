# ROS 2 onboarding and device bundles

`@kinex/setup` owns ROS onboarding, provisioning, adapters and interface checks.
`@kinex/core` registers and operates devices through its existing driver contract;
it contains no ROS implementation or ROS Python dependency. The foundation ships
software fixtures, not vendor-specific production bundles or hardware certification.

## Package boundary

| Resource | Owner |
| --- | --- |
| `onboard-ros2`, dependency selection and migration instructions | Setup skill assets |
| `kinex_ros.bundle*`, `kinex_ros.ros2*` | Setup Python assets |
| `kinex_install_apt`, package verification and authentication recovery | Setup tool and helper |
| Terminal suspension, restoration and Ctrl+C handling | Standalone host |
| Registration, lifecycle, driver transport, recording and generic Python helpers | Core |
| ROS domain/namespace, CameraInfo topics, dependency pins and expected graph | Bundle facts and manifest |

Core keeps its pre-existing inert ROS connection topic shapes. It does not import
setup, create a ROS environment, select ROS integrations or discover ROS bundles
as a special case. Generic interpreter readiness, CRLF parsing, inherited stdin
and Python 3.10 cleanup support remain in core.

Standalone chooses an `ApplicationComposition` before creating the runtime. The
default supplies setup's skill roots, reserved tool names and contribution. A
custom descriptor replaces all three defaults; core-only composition is:

```ts
composition: {
  contributions: runtime => [coreContribution(runtime)],
}
```

The chosen roots and reservations apply across session replacement and workspace
changes. Workspace overrides retain normal discovery precedence. Setup contributes
current library paths and instance guides in dynamic context sections; discovery
creates neither a workspace nor `.kinex/python`.

## Onboarding

Both `/onboarding` and ROS `/register` work use setup's
[onboard-ros2 skill](../packages/setup/assets/builtin/skill/onboard-ros2/SKILL.md).
Core-only registration remains generic.

1. Inspect the device contract, existing configuration and driver host. Preserve
   working integrations unless replacement is requested.
2. Reuse compatible installed ROS driver packages, launch files and descriptions.
   Install missing apt binaries. Source builds and direct SDK fallbacks require a
   concrete compatibility/capability gap or an explicit user choice. Multiple
   instances share installed dependencies.
3. Select or author a minimal bundle, validate facts, resolve its dependency needs
   and stage a complete candidate generation.
4. Read the generated profile. Register a new device unloaded. For replacement,
   unload through core and update only the affected profile sections, preserving
   calibration, settings and needed markers. Core validates the resulting profile.
5. Start the returned stack command when authorized, load through core and run the
   generation's interface checker. Registration is not evidence of readiness.
6. Record interface evidence through `verify-checks` and the setup plan. Perform
   motion verification only when the task requires and authorizes it.

Kinex provisioning and drivers run on the Linux host that can reach the hardware.
Local apt installation cannot repair a remote driver's host. Neither the package
boundary nor a software test proves robot-side stop behavior.

## Bundle contract

A source directory contains `bundle.yaml`, `driver.py`, `provision.py`, an optional
`setup.sh` bootstrap and optional `check.py`. Shared documentation stays in content
roots; provisioning does not copy a `DEVICE.md` into the device. Only the existing
`legged_base` policy permits a custom per-device Use guide.

The version-1 manifest declares facts, dependencies, preflight checks, a driver,
expected interfaces, optional stack, profile intrinsics and task recipe. Unknown
keys are rejected. Whole-value fact placeholders preserve numeric/boolean types.
ROS domain IDs must be integers in 0–232; namespace validation belongs to setup.
The schemas live in `packages/setup/assets/python/kinex_ros/bundle_manifest.py`.

Setup context provides `setup.provisioning.core_library` (containing `kinex`) and
`setup.provisioning.setup_library` (containing `kinex_ros`). Both roots must be
absolute and valid, including on resumed runs:

```sh
bash <source>/setup.sh --dir <workspace>/.kinex/devices/<name> \
  --core-library <core_library> --setup-library <setup_library> \
  --fact name=<name> --install
```

The bootstrap executes the source provisioner with a command-local Python path;
it does not copy files over the selected driver. `provision.py` calls
`kinex_ros.bundle.provision(source, argv, steps={...})`. Vendor steps receive
`(bundle, facts, state)` and write artifacts into `bundle.directory`, the staging
area. Persistent instance resources use `bundle.device_directory`.

`--questionnaire` returns fact requirements. `--step NAME` or `--reset` starts a
new candidate and completes preparation. `--install` permits apt, pip and Git
dependency installation/builds. Without it, apt packages are checked and declared
pip/Git preparation returns actionable needs without installing or fetching.
With installation enabled, all Git sources are checked out before one shared
`colcon build` of the repositories marked `build: colcon`. Colcon orders their
package dependencies regardless of manifest order; failed dependency preparation
prevents the build. Other source directories are excluded.

The last stdout line is JSON with `status`, `needs`, `manual_steps`, `next` and,
on completion, `generations`. Exit codes are 0 for success, 2 for unresolved
needs and 1 for provisioning errors.

## Generation and recovery

```text
.kinex/devices/<name>/
  profile.yaml                 selected configuration, owned by core
  state.json                   provisioning attempt and step receipts
  .provision.lock              serialization of provisioning
  env.sh, src/, ws/             persistent instance environment/overlay
  identity.json, verify/        recorded identity and measurement evidence
  ros/staging/<id>/             incomplete candidate
  ros/generations/<id>/
    bundle.yaml, facts.yaml, generation.json
    driver.py, provision.py, python/kinex_ros/
    ros-python, check.sh, stack.sh, cyclonedds.xml
    profile.generated.json, recipe.json, model.urdf
```

Optional files appear only when declared or generated. Completed generations are
immutable. The relative `access.driver.entry` and absolute
`access.driver.interpreter` identify the same generation. Generated URDF paths
point into it too. There is no `current` symlink or root driver shim.

Provisioning hashes source entrypoints, setup helpers, facts, dependency manifests,
library roots and environment-selection inputs. Identical inputs resume without
recopying over completed vendor artifacts. Changed inputs create a new candidate. After all steps succeed, Python/shell syntax,
required driver paths and generated URDFs are checked before the directory is
renamed into `generations`. A crash after rename is reconciled on resume.

Provisioning never changes `profile.yaml` or device activation. Failed candidates
leave selected files intact. Core's `profile_write` performs final schema validation
and selection; a rejected write leaves the prior profile in place. Recovery after
a failed candidate load unloads it and restores compatible saved sections through
`profile_write`, preserving intervening user edits.

A parent may provision an existing registered device of the same name and type
without replacing its profile or driver. Foreign ownership receipts remain
authoritative. Satellites are provisioned through their parent, which supplies
a completed generation.
All parent/satellite destinations are checked for self-collisions, duplicates and
foreign ownership before writes, then locked in deterministic order. Satellites
pin their parent's completed generation for interpreter/stack use. Parent success
followed by satellite failure leaves an unselected candidate; it does not partially
activate the group. Shared package installations, device overlays and external
services are not rolled back with a generation.

The wrapper sources the declared ROS installation, instance overlay and `env.sh`,
sets ROS identity/RMW, then prepends generation-local `kinex_ros` and installed
core `kinex`. Every runtime helper needed by the generated driver is copied.
Removing setup or the original bundle source leaves provisioned drivers operational;
core and the selected ROS installation remain required.

Legacy profiles with domain/namespace/CameraInfo connection fields or drivers
importing `kinex.ros2*` need an explicit
[migration](../packages/setup/assets/builtin/skill/onboard-ros2/references/migration.md).
Read original YAML as data and preserve loaded intent before upgrading. Stop/unload
first, move ROS settings into setup facts/configuration, then replace access through
core. Failed legacy migration stays unloaded and repairs forward. Returning to an
old integration requires matching old packages and configuration, not just its profile.

## Apt and terminal ownership

`kinex_install_apt` is a normal setup contribution executed through core's tracked,
permission-checked tool path. It asks for shell permission once, runs the installed
setup helper noninteractively and requests a terminal only for a structured
`sudo_authentication` need. It invokes `/usr/bin/python3 -S` with an absolute helper
path, cleared `PYTHONHOME` and controlled setup `PYTHONPATH`; workspace replacements
and site initialization cannot intercept authentication.

`createKinexSetup(runtime, { host })` accepts an optional `SetupHost.withTerminal`.
The host returns `unavailable`, or lends the terminal to the supplied action once
and returns `completed` with its result. Standalone serializes this with dialogs,
stops/restores the TUI and combines invocation, runtime and terminal cancellation.
Ctrl+C cancels the owned installer group and returns to the session. Each installer
command owns a separate process group in the same session; timeout or host
cancellation terminates its workers too, before reporting failure. Passwords stay
at sudo's terminal; apt stdin stays closed. Missing terminal support preserves the
explicit recovery command. Failure/cancellation stays incomplete without automatic
authentication retry.

## Adapter contracts

| Device | Adapter | Interface |
| --- | --- | --- |
| joint | `JointTrajectoryDriver` | JointState, joint trajectory topic/action and controller manager |
| velocity | `TwistDriver` | Twist/TwistStamped with declared measured feedback |
| rgb/rgbd | `CameraSource` | Image/CompressedImage, depth and CameraInfo |
| imu | `ImuSource` | sensor_msgs/Imu |

`kinex_ros.ros2` owns node/executor lifetime, latest-message caches, graph discovery,
controller services, identity checks and bounded cleanup. Imports of rclpy stay lazy.
A small entrypoint calls `bundle_driver(Path(__file__).parent).main()`.

Drivers borrow their ROS stack: load connects/verifies and unload releases owned
resources, without starting or terminating that stack. Joint stop holds the fresh
measured position and cancels owned goals; base stop repeats zero velocity. Stop
requires fresh measured confirmation and latches failure until unload/load. Joint
references retain velocity guards and core's buffered control contracts.

Load checks publisher identity, expected joints, recorded description hashes and
ROS domain/namespace. It does not command motion. Timestamps follow declared
header/receipt policy and never regress. Camera adapters check image stride,
endianness, freshness and color/depth alignment; unknown depth calibration remains
explicit. IMU data stays in SI units and core applies profile bias once.

`check.sh` observes interfaces and writes device-level `verify/measurements.json`.
Optional URDF/identity capture and CameraInfo introspection require explicit flags.
Evidence includes measured values and references; configuration/cleanup failures
replace stale success evidence. Setup's `verify-checks` evaluates the measurements
through existing joint, base and sensor verification procedures.

## Validation and scope

Fake rclpy, manifests and tests live under `packages/setup/test`; none are shipped
as runtime dependencies. Tests cover profile schema integration, identity, feedback,
stop/fault handling, cleanup, generation recovery, satellite ownership, terminal
behavior and core/setup package independence. Packed-consumer tests remove setup
and the source bundle before operating a generated driver and running its checker.

`npm run check` builds once and runs core, setup, standalone, PTY, packed-consumer
and release checks. Python 3.10 CI covers Humble compatibility. The manual
[native smoke tests](../packages/setup/test/container/README.md) use real rclpy/DDS
on Humble and Jazzy without hardware access. Native transport tests do not establish
ros2_control integration or physical robot behavior.

`packages/setup/script/onboarding-metrics.mjs` measures session time, turns, calls,
tokens, profile-write failures and driver edits. Hardware baselines and vendor
bundles remain deferred until their robots are connected. Native plugin snapshots
are updated separately from this repository.
