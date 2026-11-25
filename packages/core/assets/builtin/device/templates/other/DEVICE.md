---
name: other
type: other
description: Fallback for a device no builtin type fits; it prescribes no facts or operations.
---

## Setup

Use this type only when no builtin type fits; a device that matches one, even
partly, belongs to that type. It has no typed facts or recommended operations:
`description` says what the device is and does, and each operation's `description`
is its whole contract: payload fields, units, frames, timing, preconditions and
side effects.

Prefer standard ROS interfaces: `std_srvs/srv/Trigger` or `SetBool` for actions,
`std_msgs` for simple values, and `custom_interfaces/srv/Json` for structured
requests whose fields the description defines, or `custom_interfaces/action/Json`
for one that runs as world time passes and ends with a result. A device that moves anything
declares a `stop` service `std_srvs/srv/Trigger`.

Frames are optional. Omit them for a device without spatial meaning, such as a
PLC, a light or a web service; otherwise declare `frames.base` and calibrated
frames as for any spatial device.

### Profile

```yaml
name: other
type: other
loaded: false
description: ''
runtime:
  nodes: []
operations: {}
```
