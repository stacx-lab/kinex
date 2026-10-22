---
name: world
type: world
description: Authoritative world clock, waits and optional scene geometry.
---

## Setup

Every workspace requires a world device: exactly one per ROS domain. Its clock is
world time for every device node, tf2 lookup and recording. Kinex supplies tf2
lookup; do not register frame-graph nodes or lookup operations. Keep task
instructions and benchmark judging outside device operations.

### Operations

- `time` (required): output topic `rosgraph_msgs/msg/Clock`, `transient_local`.
  No other device publishes a clock; Kinex remaps device nodes' `/clock` to it.
- `wait` (recommended): service `kinex_interfaces/srv/Wait` with `cancellation`
  metadata for `kinex_interfaces/srv/CancelWait`. It completes after `duration_s`
  (finite, nonnegative) of world time; zero is an observation barrier and
  concurrent waits share progression. Kinex fills `owner` and `request_id` and
  cancels through the declared endpoint; an empty `request_id` retires the owner.
  `timeout_s` bounds the longest wait.
- `reset` (simulators only): service `std_srvs/srv/Trigger` resetting the episode
  and clock. It invalidates observations, pending waits and motion ownership.

A physical workspace keeps time with the real-world clock: copy the sibling
`node.py`, which publishes system time on `time` and completes `wait` against it.
It has no `reset`. A simulator relays its own clock, waits and reset; describe its
pacing (realtime, stepped or paused) and terminal-episode behavior on `time` and
`wait`.

### Profile

```yaml
name: world
type: world
loaded: false
description: Real-world clock from system time. No reset; bounds and surfaces are informational.
runtime:
  nodes: [{entry: node.py, factory: create}]
operations:
  time:
    description: System time published every 10 ms.
    transport: topic
    direction: output
    endpoint: /kinex/world/time
    type: rosgraph_msgs/msg/Clock
    qos: {depth: 1, reliability: reliable, durability: transient_local}
  wait:
    description: Await duration_s seconds of system time (finite, nonnegative, under 120) with 10 ms granularity. Zero is an observation barrier. Returns time_s and waited_s.
    transport: service
    direction: input
    endpoint: /kinex/world/wait
    type: kinex_interfaces/srv/Wait
    timeout_s: 120
    cancellation: {endpoint: /kinex/world/cancel_wait, type: kinex_interfaces/srv/CancelWait}
bounds: null
surfaces: []
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```

Bounds are `{min: [x,y,z], max: [x,y,z]}` in metres; null bounds impose no box,
null sides are open, and `???` means unresolved. Surfaces have a unique name,
world pose and rectangle, polygon or unbounded extent. Use only measured geometry.
