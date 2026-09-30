---
name: segmentation
type: segmentation
description: Image object detector that supplies a foreground mask for every detection.
---

## Setup

Use setup-device and the model provisioning conventions: record identity,
implementation, local artifacts, connection and driver interpreter; keep
loaded: false. Match a concrete instance guide first. Implement the model
driver skeleton's SDK hooks, returning a real foreground mask for each result.

Core supplies the mask-required detect contract in intrinsics.operations;
do not redefine it. Declare extra operations, such as point segmentation,
with their input/output contracts and include them in access.driver.actions.
Weights must exist locally before activation; runtime must not download them.

### Profile

```yaml
name: segmentation
type: segmentation
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
