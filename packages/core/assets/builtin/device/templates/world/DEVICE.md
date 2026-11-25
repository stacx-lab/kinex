---
name: world
type: world
description: The world's time and its waits, with optional scene geometry.
---

## Setup

Every workspace requires exactly one world device per ROS domain. It keeps time for
every device node, tf2 lookup and recording, and it is where programs wait. Keep
task instructions and benchmark judging out of its operations.

Every world, the real one or a simulator's, declares the same four operations with
the names, types and descriptions below: they are what a program's `world` object
calls and what the model reads in the profile. Worlds differ only in whether time
passes by itself. In the real world and in a simulator running in real time it
does, and a wait only answers once its entries are over. A stepped simulator
advances only during a wait and rests otherwise. The profile says neither.

The world also publishes its time on the domain's `/clock`
(`rosgraph_msgs/msg/Clock`, reliable and `transient_local`), which Kinex's device
nodes, tf2 history and recording follow. It is not an operation: do not declare it,
and let no other node publish `/clock` in the domain. A world has no `reset`: an
episode starts with its world.

A physical workspace copies the sibling `node.py`: it publishes system time on
`/clock`, serves the four operations against it and learns that a goal has finished
from the status its action server publishes; a goal no server reports counts as
executing.

### Operations

- `now`: service `custom_interfaces/srv/Now`, no request fields. It replies
  `time_s`, world time in seconds, and the time budget in seconds of world time,
  `used_s` spent of `max_s` allowed: NaN for both without a budget, as in the real
  world, and an infinite `max_s` without a limit. `used_s` may include
  initialization, so it can differ from `time_s`. Kinex reports the budget as
  supplied and does not enforce it.
- `wait_all`: service `custom_interfaces/srv/Wait`. Its entries are `seconds`,
  durations of world time from now, and `goals`, ids of executing action goals,
  each over once it finishes. The wait ends once every entry is over, or at a
  positive `timeout`, in seconds of world time, with `timed_out` true; the goals
  left go on, and a caller that gives up on one cancels it. It replies `time_s`,
  the world time reached, and whether each entry was over: `elapsed` for the
  seconds, `finished` for the goals. A wait with no entries returns at once. A
  world admits one wait at a time and rejects a second with `success` false.
- `wait_any`: service `custom_interfaces/srv/Wait`, as `wait_all`, but the wait
  ends once one entry is over; it needs an entry.
- `stop`: service `std_srvs/srv/Trigger` that cancels the pending wait. Kinex calls
  it when a program fails during a wait or abandons one.

A world may end a wait early with `success` false, for example when a device
refuses a command: `time_s` says how far it ran, and a stepped world never advances
the rest. The waits' `timeout_s` bounds the wall time of one call.

### Profile

```yaml
name: world
type: world
loaded: false
description: World time and waits.
runtime:
  observation: now
  nodes: [{entry: node.py, factory: create}]
operations:
  now:
    description: 'World time, time_s, and the time budget in seconds of world time: used_s spent of max_s allowed. Without a budget both are NaN; without a limit max_s is inf.'
    transport: service
    direction: input
    endpoint: /kinex/world/now
    type: custom_interfaces/srv/Now
  wait_all:
    description: 'Wait until every entry is over: each of seconds, a duration of world time from now, and each of goals, the id of an executing action goal, once it finishes. A positive timeout, in seconds of world time, ends the wait with entries left (timed_out). The reply gives time_s, the world time reached, and whether each entry was over: elapsed for seconds, finished for goals. One wait at a time: a second is rejected. With no entries it returns at once.'
    transport: service
    direction: input
    endpoint: /kinex/world/wait_all
    type: custom_interfaces/srv/Wait
    timeout_s: 120
  wait_any:
    description: 'Wait until one entry is over: each of seconds, a duration of world time from now, and each of goals, the id of an executing action goal, once it finishes. A positive timeout, in seconds of world time, ends the wait with entries left (timed_out). The reply gives time_s, the world time reached, and whether each entry was over: elapsed for seconds, finished for goals. One wait at a time: a second is rejected.'
    transport: service
    direction: input
    endpoint: /kinex/world/wait_any
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

Bounds are `{min: [x, y, z], max: [x, y, z]}` in metres; null bounds impose no box,
null sides are open, and `???` means unresolved. Surfaces have a unique name, a
world pose and a rectangle, polygon or unbounded extent. Record only measured
geometry.
