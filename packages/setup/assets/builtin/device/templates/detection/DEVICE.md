---
name: detection
type: detection
description: Image object detector with a standard text-prompt interface and optional masks.
---

## Setup

Use setup-device to provision a local runtime or remote service. Follow the
model type's provisioning conventions: record identity, implementation, local
artifacts, connection and driver interpreter; keep loaded: false. Match a
concrete instance guide first. The model driver skeleton supplies lifecycle;
implement its SDK hooks for detect using the contract above.

Core supplies detect in intrinsics.operations; do not redefine it. Add only
additional operations there and declare them in access.driver.actions.
Weights must exist locally before activation; runtime must not download them.

### Profile

```yaml
name: detection
type: detection
loaded: false
access:
  connection: {kind: process, compute: "???"}
  driver:
    entry: driver.py
    persistent: true
    actions: [read, load, unload, status, detect]
    timeout_s: 300
intrinsics:
  family: "???"
  artifacts: "???"
```
