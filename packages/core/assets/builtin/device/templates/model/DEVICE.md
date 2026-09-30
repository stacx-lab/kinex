---
name: model
type: model
description: General ML inference service — local model process or remote client, explicit artifacts and typed operation inputs/outputs.
---

## Setup

Use setup-device to provision a local runtime or an existing remote service's
thin client. Determine model identity, implementation revision, artifacts and
operation contracts from the actual SDK/API. Download artifacts to their declared
paths before activation; runtime must not silently fetch a different checkpoint.
Implement open_service, infer and close_service in driver.py; read settings from
the actual profile.yaml. Add every operation name to access.driver.actions.
The unimplemented skeleton fails honestly until these hooks are supplied.

### Fields

- `access.connection`: `{kind: process, compute: {kind: cpu|mps}}` or
  `{kind: process, compute: {kind: cuda, index: <nonnegative integer>}}`;
  alternatively `{kind: url, url: <endpoint>, auth_env: <env-name|null>}`.
  Credentials are read from the named environment variable by the remote client.
- `access.driver`: entry, optional interpreter, actions, persistent, timeout_s.
  Include read/load/unload/status and all declared operation names.
- `intrinsics.family`: identifier; `variant`: identifier or null;
  `implementation`: `{repository: <URL>, revision: <revision>}` or null.
- `intrinsics.artifacts`: array of `{name, path, source}`. Paths are relative to
  the device directory or absolute. Source is `{kind: local}`,
  `{kind: huggingface, repo, revision, filename}`, or `{kind: url, url, sha256}`.
  These are provisioning facts. Runtime reads provisioned paths; it does not
  silently download a different checkpoint. `[]` means no client-side artifacts;
  `"???"` means not yet established.
- `intrinsics.operations`: array of `{name, input, output}`. Names are unique
  and cannot use reserved driver actions. Input and output are non-null objects.
  Profiles use a closed JSON Schema subset: `type` is string, number, integer,
  boolean, array or object. All can specify `nullable`. Strings may specify enum
  or format (path/uri), minLength/maxLength; numbers minimum/maximum/default; arrays items and
  minItems/maxItems; objects properties and required. Each property name is an
  identifier. Object keys not declared in properties are rejected. Nested
  structures describe tensors, observations and results without an opaque
  config dictionary. There are no description, instructions or extension keys.
- Section provenance is `source`; unresolved work uses the enum
  `needs_calibration` reason, cleared explicitly with null when the item is resolved.

`???` marks unresolved required facts during registration. It does not authorize
an SDK default or an arbitrary substitute. Profiles must describe at least one
operation before intrinsics are complete.

### Verify

Validate imports, the profile and driver syntax before registration completes.
Use a timeout covering initialization and the longest inference. After /load,
check readiness and an inference with a real input. Closing a remote client must
not stop a shared server. A policy returns predictions; controller tools own
movement and termination.

### Profile

```yaml
name: "???"
type: model
loaded: false
access:
  source: unknown
  connection:
    kind: process
    compute: "???"
  driver:
    entry: driver.py
    actions: [read, load, unload, status]
    persistent: true
    timeout_s: 300
intrinsics:
  source: unknown
  family: "???"
  variant: null
  implementation: null
  artifacts: "???"
  operations: []
```

## Use

A model serves inference, never robot commands. read/status report readiness without loading weights or running inference. `load` initializes the service and `unload` releases its model/client; both use
the device tool with device_act permission or /load and /unload. A remote client must not stop a shared server.

intrinsics.operations declares operation names and typed input/output contracts; inspect this device's profile for its actual interface. The harness validates inputs before inference, applies numeric input defaults, and validates results. Undeclared operations and extra object keys are rejected. Contracts describe payloads without the transport ok field; file is a path exposed through filePath/file. Large inputs/outputs use files.

Contract types are string/number/integer/boolean/array/object with explicit properties, required fields, item shapes, bounds and nullable values. Task text is an inference argument, not an instruction stored in the profile. Device-specific artifacts, placement and SDK behavior belong to the profile/driver. Controller tools interpret policy predictions and command actuators separately.

Use the detection or segmentation device type for image-based object localization.
Those types share model lifecycle and provisioning, with a canonical detect contract.
