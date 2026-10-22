---
name: grounding-dino
type: model
description: Grounding DINO tiny open-vocabulary detection, returning text-labeled boxes and scores in the input image.
---

## Setup

Read the model type guide (`templates/model/DEVICE.md` in the device guide roots)
first: it defines `compute`, artifacts and the load/unload contract this bundle
follows. Then provision the device directory with the Kinex Python executable:

```sh
setup.sh --dir .kinex/devices/grounding-dino --python KINEX_PYTHON --compute cuda:0
```

It installs torch and transformers into the device's `site/`, downloads the
pinned checkpoint into `weights/`, verifies the compute device, and copies
`node.py` and `env.sh`. The `env.sh` overlay exposes `site/` to this node only and
keeps Hugging Face offline, so load never downloads. Write the profile below,
set `compute` to the verified placement (`cpu` or `cuda` with its index), then
validate and load.

### Operations

- `detect`: `kinex_interfaces/srv/Json` taking `image` (an image file path), a
  lowercase `prompt` with categories separated by `.`, `min_score` (box
  threshold, default 0.25) and `max_results` (default 10). It returns `results`
  with `box` `[x1, y1, x2, y2]` in input pixels, `score` and the matched prompt
  phrase as `label`, sorted by descending score. No masks.

### Profile

```yaml
name: grounding-dino
type: model
loaded: false
description: Grounding DINO tiny open-vocabulary object detector. Boxes are image pixels; scores are not calibrated probabilities and small or occluded objects may be missed.
runtime:
  overlays: [env.sh]
  nodes: [{entry: node.py, factory: create}]
  ready_timeout_s: 120
operations:
  detect:
    description: "Detect prompt phrases. Input {image: image file path, prompt: lowercase phrases separated by '.', min_score: box threshold (default 0.25), max_results: default 10}. Output {results: [{box: [x1, y1, x2, y2] in input pixels, score, label: matched phrase}]} sorted by score; no masks."
    transport: service
    direction: input
    endpoint: /kinex/grounding_dino/detect
    type: kinex_interfaces/srv/Json
    timeout_s: 30
family: grounding_dino
variant: tiny
implementation: {repository: "https://github.com/huggingface/transformers", revision: v4.57.6}
artifacts:
  - name: checkpoint
    path: weights
    source: {kind: huggingface, repo: IDEA-Research/grounding-dino-tiny, revision: a2bb814dd30d776dcf7e30523b00659f4f141c71, filename: model.safetensors}
compute: ???
```
