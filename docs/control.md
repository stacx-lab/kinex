# Frames, kinematics and control

## Frames and poses

Frames form a forest; world is optional and missing relationships are not identity
transforms. Local frames declare `parent_frame`, `translation_m` and
`rotation_xyzw`; null parent means device base and null components mean unknown.
`???` is unresolved; null otherwise follows field semantics. Computed joint/hand
frames come from models, without duplicate declarations. Additional fixed frames
may name computed parents. Joint feedback omits `frame_poses`; live FK uses measured
positions without clamping. Velocity feedback omits global pose; unmounted bases
are unlocalized roots, connected to world only through explicit estimates.

FK/IK accept device-local `frame` and `reference_frame`, defaulting to modeled
endpoint and device base. Fixed endpoint descendants and base references are
supported. `relative_pose` composes full local poses through declared, live and
call-local estimated edges, preferring fewer estimates and caching only within a
call. It returns `pose`, `path` and `estimated_links`. Poses use
`[x,y,z,qx,qy,qz,qw]` in metres with unit xyzw quaternions. Python `frames.pose()`
retains separate translation/rotation fields. Shared Python pose validation
normalizes quaternion norms only within `[0.999, 1.001]`; persisted profiles and
velocity readings remain strict.

## Inverse kinematics

Numerical IK tries the seed then deterministic nearby retries, each within
0.35 rad per rotary joint or 5% of prismatic range around the original seed,
clamped to bounds. `ik.budget` defaults to five attempts, 0.02 seconds per attempt
and 0.1 seconds per target; `max_iterations` also bounds attempts. Deadlines are
cooperative between iterations. Verified candidates compete by joint-range-normalized
seed displacement; only zero displacement ends search early. Numerical and native
IK normalize rotary solutions to nearest equivalent angles within limits before
independent FK verification. Native IK retains its solver. Exhaustion reports
attempts, iterations, time and residuals without proving unreachability. Neither
nearest preference nor readiness certifies collision-free motion.

## Control tools

| Tool | Contract |
| --- | --- |
| `servo` | Read measured joints once, solve optional pose IK and submit a full locally planned trajectory. No duration override; `block: true` checks a world clock before submission and waits computed duration, without confirming arrival. Results report device, execution ID, target joints, duration and action count. |
| `closed_loop` | Compose perceive → process → control → world.wait → optional stop → until. `world` and `wait_s` are required; stages are optional. Wait sets observation/replanning cadence, so repeated writes may replace unfinished plans. Misses, errors, cancellation and exit stop owned motion. |
| `settled` | Check joint error and quiet velocity over stable world time using fresh, advancing device timestamps. Without velocity feedback, require three fresh position samples. Target changes reset stability, preserving the optional world-time timeout. |
| `run_policy` | Infer once, cap with optional `max_actions` before validation/IK, then submit device buffers concurrently. Cartesian actions use frozen frames and seeded IK. IK failure returns a shared valid prefix at original cadence; an empty prefix leaves existing motion intact. `stop_failed` remains a failure. |
| `device`, `devices` | Share dispatch and permissions. Batches authorize before dispatch, preserve result order and report per-entry errors; effects are not atomic. |

### Trajectory planning

Servo projects only its IK seed into bounds, preserves measured planning starts,
uses shortest continuous-joint travel and never wraps explicit bounded targets.
Planning failure submits nothing. Defaults are 1 rad/s and 3 rad/s², or 0.1 m/s
and 0.3 m/s² for linear joints, capped by known limits. Joint targets need no
geometry; pose goals require endpoint IK, including for hands. Policy seeds begin
with projected measured joints, then use preceding solutions. Policy results
contain `actions_submitted`, `duration_s`, `execution_ids` and `ik_failure`.

### Feedback loops and inline Python

Closed-loop stages reference tools or inline Python. Omitted/null stages return
`{}`; disabled processing does not forward observations. Process returns a dict;
optional process/control JSON Pointer mappings select arguments. Nulls are misses;
missing paths are errors. Until receives context/state and returns a dict with
optional boolean `done`, state and reason. Without a stopping decision, round and
timeout limits apply. Inline calls use fresh processes with the caller's interpreter,
cwd, deadline and permissions; source/arguments travel over JSONL, never argv.
Only inline control has controller capabilities.

See [device contracts](devices.md) for buffering, feedback and world clocks,
[setup and calibration](setup.md) for measurement evidence, and the
[control API](../packages/core/README.md#device-calls-and-control) for examples.

[Design index](README.md)
