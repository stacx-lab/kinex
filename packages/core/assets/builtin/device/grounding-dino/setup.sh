#!/usr/bin/env bash
# Provision Grounding DINO into a device directory; Kinex owns registration and load.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE="usage: setup.sh --dir DEVICE_DIR --python KINEX_PYTHON [--compute cpu|cuda:N]"
DIR="" PY="" COMPUTE="cpu"
while (($#)); do
    case "$1" in
        --dir) DIR="${2:?$USAGE}"; shift 2 ;;
        --python) PY="${2:?$USAGE}"; shift 2 ;;
        --compute) COMPUTE="${2:?$USAGE}"; shift 2 ;;
        *) echo "$USAGE" >&2; exit 2 ;;
    esac
done
[[ -n "$DIR" && -x "$PY" && "$COMPUTE" =~ ^(cpu|cuda:[0-9]+)$ ]] || { echo "$USAGE" >&2; exit 2; }
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

# Kinex ROS messages are compiled against Kinex Python's numpy; keep that ABI.
NUMPY="$("$PY" -c 'import numpy; print(numpy.__version__)')"
uv pip install --python "$PY" --target "$DIR/site" --no-cache --link-mode=copy \
    "torch==2.6.0" "transformers==4.57.6" "numpy==$NUMPY"
cp "$HERE/node.py" "$HERE/env.sh" "$DIR/"
PYTHONPATH="$DIR/site" HF_HOME="$DIR/cache" "$PY" - "$DIR" "$COMPUTE" <<'PY'
import sys
from pathlib import Path

import torch
from huggingface_hub import snapshot_download

directory, compute = Path(sys.argv[1]), sys.argv[2]
torch.zeros(1, device=compute)
snapshot_download(
    "IDEA-Research/grounding-dino-tiny", revision="a2bb814dd30d776dcf7e30523b00659f4f141c71",
    local_dir=directory / "weights", allow_patterns=["*.json", "vocab.txt", "model.safetensors"],
)
print(f"torch {torch.__version__}; compute {compute} verified; weights ready")
PY
