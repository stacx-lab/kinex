---
name: sam3
type: segmentation
description: SAM3 open-vocabulary segmentation service — text-prompt (detect) and point-prompt (segment_point) masks with boxes/scores; the perception backend for tools like locate_object_3d.
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
