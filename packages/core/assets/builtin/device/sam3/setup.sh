#!/usr/bin/env bash
# Provision SAM3 into a device directory; Kinex owns registration and load.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE="usage: HF_TOKEN=... setup.sh --dir DEVICE_DIR --python KINEX_PYTHON [--compute cpu|cuda:N]"
# The pinned checkout defines the model; another commit is another model.
SOURCE=https://github.com/Max-Fu/sam3.git
REVISION=6fe87d64a5beb9084923d7a9e002741178635b09
WEIGHTS_REVISION=3c879f39826c281e95690f02c7821c4de09afae7
DIR="" PY="" COMPUTE="cuda:0"
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
# Fail before slow installs: facebook/sam3 serves weights only to granted accounts.
[[ -s "$DIR/weights/sam3.pt" || -n "${HF_TOKEN:-}" ]] || {
    echo "set HF_TOKEN from an account granted access to https://huggingface.co/facebook/sam3" >&2; exit 2; }

# Kinex ROS messages are compiled against Kinex Python's numpy; keep that ABI.
NUMPY="$("$PY" -c 'import numpy; print(numpy.__version__)')"
uv pip install --python "$PY" --target "$DIR/site" --no-cache --link-mode=copy \
    "torch==2.6.0" "torchvision==0.21.*" "huggingface_hub<2" transformers iopath einops "timm>=1.0.17" \
    "ftfy==6.1.1" regex decord pycocotools psutil pyyaml "setuptools<81" "numpy==$NUMPY"
[[ -d "$DIR/sam3/.git" ]] || git clone --quiet --filter=blob:none --no-checkout "$SOURCE" "$DIR/sam3"
git -C "$DIR/sam3" cat-file -e "$REVISION^{commit}" 2>/dev/null || git -C "$DIR/sam3" fetch --quiet origin "$REVISION"
git -C "$DIR/sam3" checkout --quiet --detach "$REVISION"
cp "$HERE/node.py" "$HERE/env.sh" "$DIR/"
PYTHONPATH="$DIR/site:$DIR/sam3" HF_HOME="$DIR/cache" "$PY" - "$DIR" "$COMPUTE" "$WEIGHTS_REVISION" <<'PY'
import sys
from pathlib import Path

import torch
from huggingface_hub import hf_hub_download
from sam3.model_builder import build_sam3_image_model  # noqa: F401

directory, compute, revision = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
torch.zeros(1, device=compute)
if not (directory / "weights/sam3.pt").is_file():
    hf_hub_download("facebook/sam3", "sam3.pt", revision=revision, local_dir=directory / "weights")
print(f"torch {torch.__version__}; compute {compute} verified; weights ready")
PY
