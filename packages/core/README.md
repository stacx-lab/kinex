# @kinex/core

Host-independent device management, ROS operations, Python execution and recording.
Setup procedures live in `@kinex/setup`; host/UI policy belongs to integrations.
See [ROS communication](../../docs/communication.md) for node factories, world
time, tf2, interface provisioning and invocation cleanup.

## Shared user commands

`/register`, `/unregister`, `/devices`, `/load`, `/unload`, `/ping`, `/stop` and
`/record` use trusted host APIs. Model calls use permission-checked tools. Python
cannot change device lifecycle or enable recording. New profiles remain unloaded
until explicit activation; load waits for readiness and unload releases only owned
resources. `/stop` also cancels running scripts that commanded a stopped device.

## Feature contributions

`coreContribution(runtime)` exports tools, commands, skills and stable instructions.
`composeContributions` combines independently owned packages and rejects duplicate
capabilities. Hosts own permissions, sessions, cancellation and compaction.

## Device calls and control

Each `.kinex/devices/<name>/profile.yaml` requires `type` and `description`.
Types are `world`, `joint`, `gripper`, `suction`, `locomotion`, `rgb`, `rgbd`,
`imu`, `force_torque`, `model` and the fallback `other`, which prescribes no facts
or operations. The description gives general identity, capabilities and
limitations. Top-level physical facts and explicit frames keep typed schema checks;
type does not imply an operation name or payload. Nodes own device connections;
`access` holds only `needs_calibration`, the explicit request against the
`access:<device>` readiness item.

`operations.<name>` requires its own `description`, transport, direction, endpoint
and ROS type. Describe only that operation: units, frames, timing, input/output
conventions, errors and effects. Both descriptions are required strings and may
be empty. `load`, `unload` and `status` are reserved host lifecycle actions. A
`stop` operation must be a `std_srvs/srv/Trigger` service; commanded actuators and
world waits require one. Read descriptions directly from `profile.yaml`. Query
runtime metadata and ROS payload schemas when needed, including while unloaded:

```python
from kinex import runtime, finish
names = runtime.devices()             # small identity/readiness list
ops = runtime.operations("sensor")    # operation metadata
spec = runtime.describe("sensor.sample")  # recursive ROS payload schemas
finish({"sample": spec})
```

These calls never load a device or advance time. `devices` and `operations` do not
import ROS; `describe` resolves installed interface definitions without ROS init.
Catalogs and descriptions stay in Python until selected for output.

The model `device` tool accepts `{deviceID, action, args}`. Action is explicit.
`devices` accepts `{calls: [...]}` and preauthorizes all valid calls before
concurrent dispatch; results preserve order and per-entry failures. Image
results attach PNG, JPEG, GIF or WebP files for the model. Python reaches devices only through
`communication()`.

For workflows use `communication()` async pub/sub and request/response helpers.
Commands are standard ROS messages; sending is not arrival. Measure feedback to
verify results. Use the world for time and tf2 for stamped transforms. Free-form
operations, including model inference, use `kinex_interfaces/srv/Json`:
`io.request` sends its keyword fields as one JSON object and returns the decoded
response. Cameras are `image` and, for rgbd, `depth` topics;
`helpers.camera_frame(io, camera)` returns the current image and its equally
stamped depth without advancing world time. Helper-specific operation requirements
are explicit helper contracts, never requirements of the device type. Device type
guides recommend ROS patterns; workspace descriptions define the actual interface.

Within `async with communication() as io`,
`await helpers.lookup_transform(io, target, source, stamp=None, timeout_s=5)` queries
Kinex-owned tf2 history without advancing world time. See
[the helper index](assets/python/kinex/helpers/helpers.txt) for available functions
and their implementations.

### Feedback control with `exec`

Use bounded Python loops and return only selected results; cleanup follows
[commands and cleanup](../../docs/communication.md#commands-and-cleanup).
For example, wait until an arm settles, then return two camera images:

```python
import asyncio
from kinex import communication, finish, helpers

async def main():
    async with communication() as io:
        state = io.subscribe("arm.joint_state", depth=1)
        for step in range(50):
            sample = await state.next(timeout_s=2)
            if max(map(abs, sample.velocity)) < 0.005:
                break
            await io.request("world.wait", duration_s=0.1)
        files = [helpers.save_image((await helpers.camera_frame(io, camera))[0])
                 for camera in ("camera_wrist", "camera_scene")]
    finish({"steps": step + 1}, file=files)

asyncio.run(main())
```

## Public runtime

- `tools.list()` returns input JSON schemas plus discovery problems; defaulted
  arguments remain optional for host validation. `tools.call()`
  rescans, validates arguments, checks permissions and returns normalized results.
- `skills.list()/load()` and `context()` provide discovered skills and robotics
  context (shared instructions, guide roots, skills, recording and Python
  environment) for the host's prompt. Python context includes `library` and `workspaceLibrary`
  paths for shells that need an explicit `PYTHONPATH`. Core does not edit the
  host's system prompt.
- `devices.warmLoaded()` restores already-loaded devices once per runtime and returns
  activation handles after reserving their initialization lanes. Await each `ready`
  for completion; failures remain per device. Disposal cancels pending initialization.
- `python.status()/initialize()/prepare({signal})` inspect, seed and synchronize the
  separate `.kinex/python` project. Status is read-only; initialize installs nothing.
  The project may be absent. Default Python execution prepares it only when the
  environment is missing or its ROS interface receipt no longer matches the core and
  configured interface sources; otherwise it runs directly, even if dependency
  declarations have changed. Explicit `prepare()` always synchronizes. Concurrent
  first use within a process waits for preparation; failed bootstraps can retry
  without accepting a partial environment.
  Preparation returns the interpreter and child-process environment.
- `devices.list()/load()/reload()/unload()/ping()` provide device lifecycle APIs,
  and `devices.operations()` lists each device's declared operations.
  Load/reload returns `{device, ready}`; await
  `ready` for background initialization. `devices.dispatch()` is a trusted operation API.
- `devices.templates()` discovers provisioning instances and type templates.
  `devices.unregister(name, signal?)` holds the device lifecycle fence through
  recording shutdown, deactivation and deletion. Attempt directories and setup plans
  are retained.
  Failed deactivation preserves device files. This trusted method
  does not prompt; the `/unregister` command confirms through its host.
- `profiles.writeManifest()/writeDevice()` and `readiness()` expose workspace
  state. Profile writes validate using the existing schemas.
- `recording.start()/snap()/stop()/status()/recent()` manage topic bags and explicit
  snapshots. Start specs accept `{rate, operations?}` per device; the default is all
  declared topics. Rates cap outputs in world time, while commands, clock and TF
  remain unfiltered. See [recording](../../docs/agent-integration.md#recording).
- `subscribe()` observes device, tool execution and recording events and returns an
  unsubscribe function. Listeners run synchronously and must not throw or block.
- `observe()` accepts host message boundaries for recording attribution. Optional
  `host.exportTrace(sessionID, range)` supplies a host-specific transcript snapshot;
  without it, recording has no transcript dependency or delayed export wait.
- `dispose()` is idempotent. It cancels active tool/device calls, finalizes recordings,
  waits for transcript export and closes child processes. Hosts must call it on
  workspace switch/shutdown. Custom tools must honor their abort signal.

Construction/import does not connect to hardware, write files, or install process
handlers. Each runtime owns its ROS hosts, running invocations,
observers, model cache and recorder. Separate runtime instances isolate in-memory
state even when device names match. Disk profiles remain shared when the directory
is shared; use separate workspaces for independent persistent state.
URDF parsing is shared within a runtime. Cancelling a caller releases its wait;
runtime disposal cancels the shared parser and releases its process.

Exported subpaths support internal Kinex consumers; the root runtime API is the
intended integration surface.

Onboarding and calibration use `createKinexSetup(runtime)` and
`setupContribution(setup)` from `@kinex/setup`. Core retains registration workflows
at `@kinex/core/workflows/index`, template discovery and unregister.
`runtime.readiness()` reports profile completeness and prerequisite status without
procedural calibration guidance.

The core model tool `profile_write` writes workspace facts (`kind: robot`), device
profiles (`kind: device`) and calibration-request markers (`kind: needed`). It
preserves validation, merge/replace semantics, provenance and explicit marker
clears. New devices remain unloaded; edits preserve activation intent. The trusted
profile API remains available for hosts. The tool requests `profile_write`
permission, whose core resolver default is `allow`; explicit rules and host
callbacks still apply.

`runtime.operation(fn, signal?)` tracks a trusted feature operation in the runtime's
scope and supplies a combined cancellation signal. `runtime.tools.execute(def, input,
invocation)` runs a feature tool through validation, permissions, cancellation and
recording attribution. These are trusted host composition APIs, not model tools.
Invocation permission/question callbacks take precedence over runtime host defaults.
`Def.recordingOrigin: "agent"` identifies direct device traffic for the recorder;
other tool traffic retains its tool name.

## Assets and discovery

Builtin type templates in `assets/builtin/device/templates` contain Setup guidance,
usually with recommended operations, and a Profile example. They explain how to
author descriptions, physical facts, operations and nodes, and supply no usage text
([device contracts](../../docs/devices.md#profiles)). Every template except `other`
ships a reference `node.py`; sensor and actuator nodes adapt an existing ROS driver
to the Kinex contract. The `grounding-dino`, `sam3` and `fastwam` bundles provision
model nodes. The stable prompt describes the workspace layout and directs agents to
runtime discovery; neither it nor context refresh and compaction inject catalogs.

Guide discovery preserves nearest-workspace/user/builtin precedence and searches
named bundles before type templates. Python discovery is inert; `.kinex/python`
is prepared lazily on approved execution or by explicit preparation. Nodes use
Kinex Python unless a device SDK needs a separate `runtime.interpreter`.

## Python scripting

Use `exec` to run ordinary Python with access to the active runtime. Supply exactly
one of `python` (source) or `file` (a script path); no manifest or `main()` function
is required. Multiline source is passed directly, without shell syntax.
Optional `description` supplies a short lowercase label, such as `inspect arm state`,
that hosts show as the call's subject; standalone shows the highlighted source or
the `python` command beneath it.

```json
{
  "description": "list devices",
  "python": "from kinex import runtime, finish\nfinish(runtime.devices())"
}
```

Files run from the runtime's working directory, with normal script-local imports,
`__file__` and `__name__ == "__main__"`. Relative paths resolve from that working
directory. For example:

```json
{"file": "scripts/inspect.py", "argv": ["--samples", "10"], "args": {"device": "left_arm"}}
```

`args` defaults to `{}` and is available through `kinex.args()`; `argv` defaults to
`[]` and populates `sys.argv[1:]`. Execution lazily prepares and reuses Kinex's
managed Python; exec and Python tools have no interpreter option. `timeout_s`
defaults to 120 wall-clock seconds. Each invocation uses a fresh
process; script stdin receives EOF. Owned subprocesses are terminated when the
invocation ends, including on success.

The result contains bounded combined stdout/stderr in `output` and `result`
(normally `null`). Normal completion and `sys.exit(0)` succeed. Optionally
use `kinex.finish(value)` for a JSON result: ROS messages, NumPy values and tuples
become plain JSON, non-finite numbers become `null`, and images are rejected.
Return images as files instead: `kinex.finish(value, file=image_path)` attaches one,
for example from `helpers.save_image(image)`, and `file=[path1, path2]` attaches
several in order. When attaching files, `value` must be a JSON object (or omitted);
the paths are included in its `file` field. Include camera identities and
timestamps alongside them. Printing paths or returning base64 text does not attach
images.
Execution failures set the tool's error flag and return `error` in place of `result`,
retaining RPC `code` and `details` when present. An uncaught exception's traceback
appears once, in `error`; a script that exits nonzero without one reports its code.
Output truncation is reported explicitly. Raw prints and subprocess output cannot
be interpreted as runtime messages. Invalid arguments use the standard tool
validation error result; permission denial propagates to the host.

One `python_tool` approval covers an invocation. Scripts reach devices only through
`communication`; they cannot change device lifecycle or control recording. The
`kinex` root (`args`, `finish`, `fail`, `profile`, `robot`, `communication`,
`runtime`, `RPCError` and `OperationError`) and `kinex.helpers` form the exec API.
`kinex.node` gives device nodes command routing, JSON services and URDF link
frames; `kinex.lib` holds shared internals and `kinex.host` the processes the
runtime launches. Workspace helpers in `.kinex/lib` are importable from exec,
tools and nodes. Cleanup follows
[commands and cleanup](../../docs/communication.md#commands-and-cleanup). Request a
device's `stop` operation, for example in a `finally` block around a control loop,
when successful completion must stop motion. `exec` and manifest tools share the
execution runner.

Python startup uses a separate host RPC channel; ordinary script stdout/stderr
remain diagnostics. Importing the library outside a tool dialog is inert.
`runtime.devices`, `runtime.device`, `runtime.operations`, and `runtime.describe`
provide discovery. `finish(result, file=...)` selects results and images for the
agent. Device operation payloads follow declared ROS interfaces.

For pure joint kinematics and trajectory planning in exec:

```python
from kinex import helpers

arm = helpers.joint_model("arm")  # commanded joints, URDF FK and IK
# start/target: positions in URDF document order.
target = arm.ik(goal_pose, start)
plan = helpers.trajectory(arm.joints, start, target, period_s=0.01, fraction=0.15)
```

`plan.actions` contains synchronized joint references and `plan.duration_s` their
planned duration. The helpers perform no device I/O. Scripts obtain measured
positions, encode and submit the plan through the declared command operation,
such as a `JointTrajectory` on `joint_target`, wait on the world clock and
verify arrival. For timestamped
points, sample `i` (starting at 1) occurs at `i * plan.duration_s / len(plan.actions)`.

## Development

Run `npm run build`, `npm run test:core`, or the complete `npm run check` from the
repository root. Tests use explicit protocol-host fixtures; native ROS integration
checks verify actual topics, services, world timing, recording and tf2 separately.

## License

Apache-2.0. See [LICENSE](LICENSE).
