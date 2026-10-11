# Devices, motion and recording

## Driver interfaces

Types define interfaces; profiles separate access, intrinsics and extrinsics.
Drivers own SDK connections, units, boundary validation and cleanup. Persistent
drivers use JSONL; one-shot drivers consume `{action,args}` and release temporary
clients. Core includes a mock, not a simulator engine.

## Scheduling and motion ownership

Dispatch validates before admission and observes traffic. Per-device schedulers
replace prior motion; reads can overlap writes and independent devices write
concurrently. Stop bypasses approval, interrupts affected calls and clears queued
writes within the driver's declared operation-specific stop scope. Unload attempts
capture shutdown, stop and resource release. Uncertain writes are never retried.

Actuator writes submit validated buffers with `duration_s`, returning immediately
with `execution_id` and measured `state`. Gripper/suction actions are flat numeric
sequences; joint/hand actions are sequences of joint vectors. New writes replace
pending references without stopping; invalid writes leave them intact. Position
commands retain the final reference; velocity commands expire to zero velocity
while retaining posture. Background faults remain visible in reads.

Ownership outlives submission: cleanup may stop only that invocation's remaining
motion, never another caller's replacement. Invalid post-submission feedback cancels
that submission before reporting failure. Failed cleanup reports `stop_failed`
and blocks further writes until recovery. Public `error`, `code` and `details`
survive direct, batch and Python calls without exposing driver stderr; Python uses
`RPCError`, a `RuntimeError` subclass.

## Device-specific behavior

Joint goals are absolute, in model order and radians/metres; home is a joint-name
map. Returning to declared home permits a fixed 1° revolute recovery margin only
for an inward-moving prefix ending within limits. Measured starts are not clamped;
prismatic limits remain strict. Native controller bounds retain native saturation
when `limit_handling: native` is declared.

Gripper stop clears pending references while retaining the applied target and
preload, including direction-gripper accumulated targets. It never replaces a
loaded target with measured aperture; explicit open releases. Reset seeds from
measured posture, and stop before a first write must not close. Gripper feedback
reports aperture, faults and timestamp; finger measurements remain driver-private.
Hands use joint vectors and optional fingertip geometry whose chains name model
joints in traversal order. Fixed palm/grasp references are local frames; optional
weighted centers are geometric references, not contact feedback.

`legged_base` uses `mode` for writes and measured state, with declared write schema,
minimal skills and optional mode graph. Motion follows named-axis velocity,
optional posture and duration conventions. Drivers validate live prerequisites,
submit without waiting for physical completion and own replacement/cancellation.
Stand/crouch transitions may have limited interruption; guides declare that scope.

## World time and cancellation

`world.read` returns `time_s` and optional `budget: {used_s, max_s}` in seconds;
used time is finite/nonnegative, allowance positive/finite or null for no cap.
Drivers own accounting; Kinex neither infers nor enforces a budget. Reads do not
advance time. `world.wait` returns `time_s` and actual `waited_s`; concurrent waits
share world time with individual cancellation.

Persistent waits use `access.driver.timeout_s` (default 60 seconds), allowing one
additional configured timeout for cancellation acknowledgement. Successful
recovery preserves the driver and reports `wait_timeout` without elapsed time;
failed recovery terminates it and requires explicit load. Caller cancellation
uses the same bounded recovery. Cancellation neither resets the world nor clears
actuator buffers: realtime continues; stepped simulation pauses without waits.

## Observations and cameras

Observations and write-result states use finite numeric `timestamp` seconds in
the device clock: acquisition time, otherwise receipt time. Combined observations
use the latest component timestamp; cached data retains it. Timestamps carry no
clock label and are not implicitly synchronized. Cameras support file, array and
base64 output with one timestamp for color/depth. Arrays cross JSON as base64 and
are decoded by Python; fixed dimensions are validated. Agent tools allow file
output only; hosts inspect image paths explicitly.

## Recording

Manual recording is available; model recording is opt-in. Native capture or dispatch
sampling produces manifests, timelines, profile snapshots and per-device products;
incidental traffic is separate. Acquisition timestamps, cadence and playback FPS
are distinct. Losses are counted, failures are per-device, finalization is bounded
and quotas permit limited overshoot. Hosts supply transcript references; outcome
labels are annotations, not verification.

See [control](control.md) for motion tools and
[agent integration](agent-integration.md) for session ownership and permissions.

[Design index](README.md)
