---
name: world
type: world
description: Authoritative world clock, waits and optional scene geometry.
---

## Setup

Every workspace requires a world device: exactly one per ROS domain. Its clock is
world time for every device node, tf2 lookup and recording. Kinex owns tf2
lookup. Keep task instructions and benchmark judging outside device operations.

### Operations

- `time` (required): output topic `rosgraph_msgs/msg/Clock`, `transient_local`.
  No other device publishes a clock; Kinex remaps device nodes' `/clock` to it.
- `wait` (recommended): service `custom_interfaces/srv/Wait`. It completes after
  `duration_s` (finite, nonnegative) of world time; zero is an observation barrier.
  Waits are sequential: one requested while another is pending is rejected.
  `timeout_s` bounds the longest wait. Every reply, a rejection included, reports
  the episode budget in `used_s` and `max_s`.
- `budget` (optional): output topic `custom_interfaces/msg/Budget`, reliable and
  `transient_local`, published whenever consumption changes, with the same `used_s`
  and `max_s` as a wait reply.
- `stop` (required with `wait`): service `std_srvs/srv/Trigger` that cancels the
  pending wait. Kinex calls it when a script that waited fails or abandons its wait.
- `reset` (simulators only): service `std_srvs/srv/Trigger` resetting the episode
  and clock. It invalidates observations and the pending wait.

A physical workspace keeps time with the real-world clock: copy the sibling
`node.py`, which publishes system time on `time` and completes `wait` against it.
It has no `reset`. A simulator relays its own clock, wait, stop and reset; describe
its pacing (realtime, stepped or paused) and terminal-episode behavior on `time`
and `wait`.

The episode budget is world time in seconds: `used_s` consumed and `max_s` allowed,
with `max_s` infinite for no cap. Convert native counts to seconds before reporting.
Consumption may include initialization, so `used_s` can differ from `time_s`. A world
without a budget, such as the real-world clock, reports NaN for both; never leave them
at zero. Kinex reports the budget as supplied, showing non-finite values as null; it
does not infer it from `time_s`, enforce it, or change control behavior.

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
    description: Await duration_s seconds of system time (finite, nonnegative, under 120) with 10 ms granularity. Zero is an observation barrier. One wait at a time; returns time_s and waited_s, and NaN used_s and max_s since real-world time has no episode budget.
    transport: service
    direction: input
    endpoint: /kinex/world/wait
    type: custom_interfaces/srv/Wait
    timeout_s: 120
  stop:
    description: Cancel the pending wait.
    transport: service
    direction: input
    endpoint: /kinex/world/stop
    type: std_srvs/srv/Trigger
bounds: ???
surfaces: []
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```

Bounds are `{min: [x,y,z], max: [x,y,z]}` in metres; null bounds impose no box,
null sides are open, and `???` means unresolved. Surfaces have a unique name,
world pose and rectangle, polygon or unbounded extent. Use only measured geometry.
