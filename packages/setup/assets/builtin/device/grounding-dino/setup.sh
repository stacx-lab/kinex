#!/usr/bin/env bash
# Provision a device-local Grounding DINO runtime; registration and activation stay with the host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR=""
COMPUTE="cpu"
TORCH="2.6.0"
TORCHVISION=""
INDEX_URL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
        --compute) COMPUTE="${2:?--compute needs cpu or cuda:N}"; shift 2 ;;
        --torch) TORCH="${2:?--torch needs a version}"; shift 2 ;;
        --torchvision) TORCHVISION="${2:?--torchvision needs a version}"; shift 2 ;;
        --index-url) INDEX_URL="${2:?--index-url needs a URL}"; shift 2 ;;
        -h|--help) echo "usage: setup.sh --dir <device-dir> [--compute cpu|cuda:N] [--torch X.Y.Z] [--torchvision X.Y.Z] [--index-url URL]"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done
[[ -n "$DIR" ]] || { echo "--dir is required" >&2; exit 1; }
[[ "$COMPUTE" =~ ^(cpu|cuda:[0-9]+)$ ]] || { echo "compute must be cpu or cuda:N" >&2; exit 1; }
[[ "$TORCH" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?(\+[a-z0-9]+)?$ ]] || { echo "invalid --torch version: $TORCH" >&2; exit 1; }
if [[ -z "$TORCHVISION" ]]; then
    # torch 2.N pairs with torchvision 0.(N+15); pip picks the patch that matches torch.
    [[ "$TORCH" =~ ^2\.([0-9]+) ]] || { echo "cannot match torchvision for torch $TORCH; pass --torchvision" >&2; exit 1; }
    TORCHVISION="0.$((BASH_REMATCH[1] + 15)).*"
fi
[[ "$TORCHVISION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?(\+[a-z0-9]+|\.\*)?$ ]] || { echo "invalid --torchvision version: $TORCHVISION" >&2; exit 1; }
[[ -z "$INDEX_URL" || "$INDEX_URL" =~ ^https?:// ]] || { echo "--index-url must be an http(s) URL" >&2; exit 1; }
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
export HF_HOME="$DIR/hf-cache" XDG_CACHE_HOME="$DIR/cache" TORCH_HOME="$DIR/torch-cache"
export UV_CACHE_DIR="$DIR/uv-cache" UV_PYTHON_INSTALL_DIR="$DIR/python"
export PIP_NO_CACHE_DIR=1
PY="$DIR/venv/bin/python"
if ! "$PY" -m pip --version >/dev/null 2>&1; then
    if command -v uv >/dev/null 2>&1; then
        uv venv --seed --allow-existing --python python3 "$DIR/venv"
    else
        python3 -m venv "$DIR/venv"
    fi
fi
TORCH_ARGS=()
[[ -n "$INDEX_URL" ]] && TORCH_ARGS=(--index-url "$INDEX_URL")
"$PY" -m pip install "${TORCH_ARGS[@]}" "torch==$TORCH" "torchvision==$TORCHVISION"
"$PY" -m pip install 'transformers==4.57.6' pillow pyyaml
"$PY" - "$DIR" "$COMPUTE" <<'PY'
import pathlib
import sys
import torch
from huggingface_hub import snapshot_download
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

directory, compute = pathlib.Path(sys.argv[1]), sys.argv[2]
torch.zeros(1, device=compute)
snapshot_download(
    'IDEA-Research/grounding-dino-tiny',
    revision='a2bb814dd30d776dcf7e30523b00659f4f141c71',
    local_dir=directory / 'weights',
    allow_patterns=['*.json', 'vocab.txt', 'model.safetensors'],
)
AutoProcessor.from_pretrained(directory / 'weights', local_files_only=True, use_fast=False)
import torchvision
print(f'torch {torch.__version__}; torchvision {torchvision.__version__}; compute verified: {compute}; model artifacts ready')
PY
if [[ "$HERE" != "$DIR" ]]; then cp "$HERE/driver.py" "$DIR/driver.py"; fi
echo "interpreter: $PY"
echo "compute: $COMPUTE"
echo "Register the DEVICE.md profile with loaded: false; /load grounding-dino starts the service."
