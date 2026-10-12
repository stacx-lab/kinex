# Tools and skills

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
| `exec` | Run ordinary Python source or a script file with runtime access, captured output and optional structured results. |

Use `exec` for ad hoc scripting without a tool manifest or a required function
signature. One execution approval covers runtime reads and commands, including
composed Python tools. Scripts cannot load/unload devices or call the recording
tool. See [Python scripting](../packages/core/README.md#python-scripting) for inputs
and examples.

### Perception and control

These Python tools compose device calls and computation. Perception tools read
and compute; controller tools can also command devices. Neither class can load
or unload devices, and both retain permissions and cancellation.

| Tool | Kind | Purpose |
| --- | --- | --- |
| `relative_pose` | Perception | Express a frame or local pose relative to another frame. |
| `locate_object_3d` | Perception | Combine a camera, detection/segmentation model and depth to estimate an object's position in the camera frame. |
| `settled` | Perception | Check measured joint arrival and stability, typically as a feedback loop's stopping condition. |
| `servo` | Controller | Plan a joint trajectory to joint or pose targets. Waits its duration on a loaded world clock. Set `block=false` to return immediately. Verify arrival with feedback. |
| `run_policy` | Controller | Run policy inference once and submit the resulting valid action prefix across devices. |
| `closed_loop` | Controller | Repeat perception, processing and control on a world clock until a stopping condition or limit is reached. |

For example, a loop can use `relative_pose` to transform a target, `servo` to move
toward it and `settled` to check arrival. See the
[core control API](../packages/core/README.md#device-calls-and-control) for execution
details and [device contracts](devices.md) for the underlying interfaces.

## Built-in skill

Core ships [setup-device](../packages/core/assets/builtin/skill/setup-device/SKILL.md).
It guides the agent through selecting a device guide, provisioning a driver,
writing a profile and verifying the interface. It also supports driver repair.
The agent performs these steps through tools; loading the skill does not run them
automatically.

Onboarding, calibration and ROS skills belong to `@kinex/setup`; see
[setup and calibration](setup.md). For tool arguments and examples, see the
[core API](../packages/core/README.md#device-calls-and-control).

[Design index](README.md)
