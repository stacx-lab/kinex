---
name: sam3
type: model
description: SAM3 open-vocabulary segmentation — text-prompted (detect) and point-prompted (segment_point) masks with boxes and scores; the perception backend for tools like locate_object_3d.
---

## Setup

Read the model type guide (`templates/model/DEVICE.md` in the device guide roots)
first: it defines `compute`, artifacts and the load/unload contract this bundle
follows. The weights are gated, so provision with a Hugging Face token from an
account granted access to `facebook/sam3`:

```sh
HF_TOKEN=... setup.sh --dir .kinex/devices/sam3 --python KINEX_PYTHON --compute cuda:0
```

It installs torch and the SAM3 dependencies into the device's `site/`, checks out
the pinned SAM3 source into `sam3/`, verifies the compute device, downloads the
pinned checkpoint into `weights/`, and copies `node.py` and `env.sh`. The `env.sh`
overlay exposes both to this node only and keeps Hugging Face offline, so load
never downloads. Write the profile below, set `compute` to the verified placement
(`cpu` or `cuda` with its index), then validate and load.

### Operations

Both are `kinex_interfaces/srv/Json` services taking `image` as an image file
path. Their `results` are sorted by descending score; each has `box`
`[x1, y1, x2, y2]` in input pixels, `score`, `label` and `mask`, the path of a
binary PNG at the input size.

- `detect`: masks for a noun-phrase `prompt`, filtered by `min_score` (default
  0.25) and capped by `max_results` (default 10); `label` is the prompt.
- `segment_point`: candidate masks of the object at `point` `[u, v]` in pixels,
  capped by `max_results` (default 3); `label` is `point`.

### Profile

```yaml
name: sam3
type: model
loaded: false
description: SAM3 open-vocabulary segmentation from text or point prompts. Boxes are image pixels and masks are binary PNG files; scores are not calibrated probabilities.
runtime:
  overlays: [env.sh]
  nodes: [{entry: node.py, factory: create}]
  ready_timeout_s: 180
operations:
  detect:
    description: "Segment a noun phrase. Input {image: image file path, prompt, min_score: default 0.25, max_results: default 10}. Output {results: [{box: [x1, y1, x2, y2] in input pixels, score, label: the prompt, mask: binary PNG path at input size}]} sorted by score."
    transport: service
    direction: input
    endpoint: /kinex/sam3/detect
    type: kinex_interfaces/srv/Json
    timeout_s: 30
  segment_point:
    description: "Segment the object at a pixel. Input {image: image file path, point: [u, v] in pixels, max_results: default 3}. Output {results: [{box, score, label: point, mask: binary PNG path}]} sorted by score; candidates may overlap."
    transport: service
    direction: input
    endpoint: /kinex/sam3/segment_point
    type: kinex_interfaces/srv/Json
    timeout_s: 30
family: sam3
variant: ???
implementation: {repository: "https://github.com/Max-Fu/sam3", revision: 6fe87d64a5beb9084923d7a9e002741178635b09}
artifacts:
  - name: checkpoint
    path: weights/sam3.pt
    source: {kind: huggingface, repo: facebook/sam3, revision: 3c879f39826c281e95690f02c7821c4de09afae7, filename: sam3.pt}
compute: ???
```
