---
name: velocity
type: velocity
description: velocity control and observation contract.
---

## Setup

Follow setup-device for registration, Python provisioning and node lifecycle. This
template validates physical facts; it does not prescribe operation names.

Declare supported control modes, command limits, measured response and stop scope. Keep the base unlocalized unless measured localization is available. Explain coordinate frames, units, command expiry and stopping in operation descriptions.

Every profile requires a top-level `description` giving general device identity,
capabilities and limitations. Every `operations.<name>.description` explains only
that operation: inputs/outputs, units, frames, timing, preconditions and side effects.
Both descriptions are required strings; use an empty string when no text is known.
Agents retrieve them through `runtime.device(name)` and `runtime.describe("device.operation")`.

Start from the profile below, select the typed facts and fill unknowns from
documentation or calibration. Use `???` for unresolved facts and `null` only where
allowed. Add actual topic/service operations and their descriptions; an empty
operations mapping is an unfinished setup, not an implicit type interface.
Register owned factories as `runtime.nodes: [{entry: node.py, factory: create}]`.
For externally managed nodes use `runtime.nodes: []` and their real endpoints.
Nodes inherit Kinex Python unless a separate SDK requires an interpreter override.
The old sibling driver scaffolds are unsupported by the runtime; implement ROS
node factories or bind to existing ROS nodes.

### Profile fields

| Field | Contract |
| --- | --- |
| `control` | `mode: motion` identifies the control contract; `body_frame` names the body frame. Each entry in `modes` combines `velocity` and `posture` channels; use `null` for an unsupported channel. At least one channel must be supported. |
| `control.modes.<name>.velocity` | `{frame: body\|heading, components: [{axis, units, bounds}]}`. Unique axes: `vx/vy/vz` in m/s, `wx/wy/wz` in rad/s, or explicitly `normalized` inputs. |
| `control.modes.<name>.posture` | `{reference, components: [{axis, units, bounds, default}]}`. Unique axes: `height` in m, `roll/pitch/yaw` in rad. Defaults must satisfy bounds; height bounds must be positive. |
| Component `bounds` | `{min, max}` with `min < max`; velocity bounds include zero. `null` means no declared bound; velocity `???` remains unresolved. `control.limit_handling: native` delegates saturation to the controller. |
| `feedback` | `velocity_components` lists measured axes in return order; `velocity_frame` names their frame. With no velocity measurement, use `[]` and `null`, respectively. |
| `stop` | `{behavior, affected_devices}`. Behavior is `stand`, `hold`, `halt` or `controller_emergency_stop`; choose the implemented behavior and scope. |

### Driver hooks

Complete the sibling [driver scaffold](driver.py); its buffer requires
`persistent: true`. `period_s` is a positive command period in seconds.
`set_target(handle, command)` receives the validated command dictionary repeatedly
during its interval; apply it without waiting for `duration_s` or restarting a
whole-duration SDK operation on every tick. `read_state` returns the Use feedback.

Expiry calls `halt(handle, target)` rather than sending zero velocity itself.
Implement zero travel while preserving posture/balance for expiry, explicit stop
and cleanup. Handle `target=None` before the first write. Declaring `stop` does
not implement it. Verify replacement, expiry and explicit stop, including before
the first write, with posture retained.

### Response behavior

Displacement may differ from velocity × duration; short commands may not visibly move.
During authorized setup checks, measure response for each supported motion mode.
Record observed thresholds in `intrinsics.control.modes.<mode>.response`:

- `min_abs_vel`: per-axis translational magnitudes, such as `{vx: 0.05}`.
- `min_abs_w`: per-axis angular magnitudes, such as `{wz: 0.1}`.
- `min_duration_s`: positive duration in seconds that produced measurable response
  at the tested speeds.

Axis values are nonnegative and use the declared command units, including normalized
units where applicable. Record only tested axes; omit unknown fields. These are
observations under tested conditions, not universal deadbands or enforced command
limits. Preserve test conditions and evidence in the setup report, including
direction, posture, load, surface, speeds, durations and observed response.
Zero and smaller commands remain valid; do not clamp them to these thresholds.

### Profile

```yaml
name: velocity
type: velocity
loaded: false
access:
  source: unknown
  method: unknown
  calibrated_at: null
  connection: ???
intrinsics:
  frames: {}
  source: unknown
  method: unknown
  calibrated_at: null
  control: ???
  feedback: ???
  stop: ???
extrinsics:
  source: unknown
description: ""
runtime:
  nodes: []
operations: {}
```
