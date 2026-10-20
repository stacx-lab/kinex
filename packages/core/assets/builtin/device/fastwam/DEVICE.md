---
name: fastwam
type: model
description: FastWAM action inference for LIBERO and RoboTwin, including LIBERO Optional IDM. Returns predictions; run_policy owns IK and robot execution.
---

## Setup

This bundle retains historical provisioning assets. Its JSONL driver is no longer
supported by core. Reuse vendor dependencies as appropriate, then implement an
owned ROS node factory or bind to an existing ROS node. Follow setup-device and
the builtin typed template for the profile schema, runtime.nodes and operations.

Write the device's general description in profile.yaml and a separate description
on each operation for its inputs, outputs, conventions and behavior. Both strings
are required and may be empty. Do not copy type usage prose into agent context.
Select native ROS message/service types, preserve calibrated facts and declare
ownership/cancellation for stateful operations. Validate and load explicitly.
