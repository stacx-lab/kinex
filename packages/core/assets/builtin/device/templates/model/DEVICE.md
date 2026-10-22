---
name: model
type: model
description: Inference service whose operations depend on the model; compute and artifacts are profile facts.
---

## Setup

The model type prescribes no operations or payloads. Name each operation after
what the model computes and declare it as a `kinex_interfaces/srv/Json` service:
callers send a JSON object and receive one, and the operation description is the
only contract for their fields. Pass images and other large data as file paths.
Serve each operation with `kinex.communication.json_service(node, operation,
handler)`; `handler(**request)` returns the response object and its exceptions
become failed responses. The sibling `node.py` serves a TorchScript image model as
`infer` from an artifact named `weights`; the grounding-dino, sam3 and fastwam
bundles are complete examples.

Record `family`, optional `variant` and `implementation`, and `artifacts` with a
pinned source for every weight file. Record `compute` as where the node places
the model: `cpu`, `cuda` with a device `index`, `mps`, or `remote` when the node
only calls an external service. Install the model SDK into a device-local
directory that a `runtime.overlays` script adds to `PYTHONPATH`, pinning Kinex
Python's numpy, so the node keeps Kinex's ROS environment. `runtime.interpreter`
replaces that environment; use it only with overlays for a complete one.

### Load and unload

Load starts a fresh device process and creates the node; unload destroys the node
and then terminates that process group. Keep every resource inside this lifecycle:

- Load weights onto `compute` in the factory and fail clearly when an artifact
  or the compute device is missing. Provision artifacts during setup, never on load.
- Return from `ready()` only once the model serves requests, and size
  `runtime.ready_timeout_s` for the loading time.
- Release what process exit cannot in `destroy_node()`, such as remote sessions or
  servers in their own process group; never start detached processes.
- A borrowed service (`runtime.nodes: []`) keeps its own lifecycle; Kinex neither
  loads nor frees its model.

### Profile

```yaml
name: model
type: model
loaded: false
description: ''
runtime:
  nodes: [{entry: node.py, factory: create}]
  ready_timeout_s: 120
operations: {}
family: ???
variant: null
implementation: null
artifacts: ???
compute: ???
```
