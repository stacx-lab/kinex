---
name: model
type: model
description: General ML inference service — local model process or remote client, explicit artifacts and typed operation inputs/outputs.
---

## Use

A model serves inference, never robot commands. read/status report readiness without loading weights or running inference. `load` initializes the service and `unload` releases its model/client; both use
the device tool with device_act permission or /load and /unload. A remote client must not stop a shared server.

intrinsics.operations declares operation names and typed input/output contracts; inspect this device's profile for its actual interface. The harness validates inputs before inference, applies numeric input defaults, and validates results. Undeclared operations and extra object keys are rejected. Contracts describe payloads without the transport ok field; file is a path exposed through filePath/file. Large inputs/outputs use files.

Contract types are string/number/integer/boolean/array/object with explicit properties, required fields, item shapes, bounds and nullable values. Task text is an inference argument, not an instruction stored in the profile. Device-specific artifacts, placement and SDK behavior belong to the profile/driver. Controller tools interpret policy predictions and command actuators separately.

Use the detection or segmentation device type for image-based object localization.
Those types share model lifecycle and provisioning, with a canonical detect contract.
