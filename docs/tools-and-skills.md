# Tools and skills

For ROS devices, use the [async protocol API](communication.md). The world device
owns timing, and relative_pose uses tf2 with ROS frame IDs.

`@kinex/core` provides tools for operating devices and a skill for preparing them.
Tools execute code; skills supply instructions that the agent follows. These
built-ins complement the host's coding tools, such as shell and file editing.

## Built-in tools

### Device access and workspace

| Tool | Purpose |
| --- | --- |
| `device` | Call one device: read observations, submit commands, run inference, or load/unload it. |
| `devices` | Call multiple devices concurrently, returning results in input order with per-call errors. |
| `device_stop` | Stop a device or all loaded actuators within their declared stop scopes; no approval required. |
| `profile_write` | Validate and save workspace/device facts, including calibration requests. New devices remain unloaded. |
| `record` | Start/stop observation capture, take snapshots and inspect recordings. Exposed to the model only when recording is enabled. |
| `skill` | Load a named skill's instructions into the agent's context. |

### Perception and control

These Python tools are interfaces to the `kinex.helpers` functions of the same
name. They cannot load or unload devices and retain permissions and cancellation.

| Tool | Purpose |
| --- | --- |
| `relative_pose` | Express a frame or local pose relative to another frame. |
| `locate_object_3d` | Combine a camera, detection model and depth to estimate an object's position in the camera frame. |
| `run_policy` | Run policy inference once and submit the resulting valid action prefix across devices. |

### Python execution with `exec`

Use `exec` to combine device calls, helpers and computation in one invocation. Supply exactly one of `python` (ordinary source) or `file` (a script
path); no tool manifest or required function signature is needed. Optional `args`
are available through `kinex.args()`, and `argv` supplies script arguments.
`description` gives the invocation a short display label.

Scripts reach devices through `communication()`: `io.request`, `io.publish` and
`io.subscribe` on declared operations, concurrently with asyncio when needed.
`kinex.helpers`, indexed by `kinex/helpers/helpers.txt`, supplies frame,
kinematics, policy, perception and image functions; calling them inside exec
shares its communication and cleanup. Host coding tools are outside this
Python API.

Use bounded Python loops for feedback control and settling checks; their control
flow, state and stopping conditions belong in the script. A typical sequence is:

1. Read measured state and compute or submit a control action.
2. Wait on the device's world clock when needed; choose an explicit interval
   for replanning during motion.
3. Check fresh feedback, faults and the task's tolerances. Bound retries and
   elapsed time; position agreement alone does not establish stability or task
   success. Cached observations do not supply new evidence.
4. Call the device's `stop` operation when the loop's exit requires it.
5. Save selected camera images with `helpers.save_image` and return their paths
   through `kinex.finish(result, file=[...])` when the next decision needs visual
   input.

`finish` can return JSON and one or more images in order. Include camera names and
timestamps in the result to identify observations. Images read in Python stay ROS
messages and attach only through `finish` file paths; printing paths does not attach
them. Direct `device`/`devices` camera reads attach images automatically.

One execution approval covers an invocation's reads and commands; scripts cannot
load/unload devices or control recording. See
[commands and cleanup](communication.md#commands-and-cleanup) for failure cleanup
and stops. Each invocation uses a fresh process with a default 120-second wall-clock
timeout and returns an exit code, bounded stdout/stderr and an optional JSON result.

See [Python scripting](../packages/core/README.md#python-scripting) for all inputs,
the [control example](../packages/core/README.md#feedback-control-with-exec) for a
bounded loop returning multiple camera images, and [device contracts](devices.md)
for the underlying interfaces.

## Built-in skill

Core ships [setup-device](../packages/core/assets/builtin/skill/setup-device/SKILL.md).
It guides the agent through selecting a device guide, provisioning a node,
writing a profile and verifying the interface. It also supports node repair.
The agent performs these steps through tools; loading the skill does not run them
automatically.

Onboarding, calibration and ROS skills belong to `@kinex/setup`; see
[setup and calibration](setup.md). For tool arguments and examples, see the
[core API](../packages/core/README.md#device-calls-and-control).

[Design index](README.md)
