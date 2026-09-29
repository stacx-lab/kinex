#!/usr/bin/env bash
# ONE entry point for provisioning the sam3 device — venv, pinned checkout,
# gated weights, driver — everything confined to --dir. Idempotent: complete
# steps are skipped, so re-running after a failure continues where it stopped.
# Registration (calib_write) and /load stay with the harness; this script only
# prepares. Shape modeled on agentic-robotics-bench's scripts/perception.sh.
#
#     setup.sh --dir <device-dir> [--compute cuda:0|cpu] [--torch 2.6.0] [--token hf_...]
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The cap-x pins — a different commit is a different model.
SAM3_REPO=https://github.com/Max-Fu/sam3.git
SAM3_SHA=6fe87d64a5beb9084923d7a9e002741178635b09
SAM3_HF_REPO=facebook/sam3

DIR=""
COMPUTE="cuda:0"
TORCH_VERSION="2.6.0"
TOKEN=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dir)     DIR="$2"; shift 2 ;;
        --compute) COMPUTE="$2"; shift 2 ;;
        --torch)   TORCH_VERSION="$2"; shift 2 ;;
        --token)   TOKEN="$2"; shift 2 ;;
        -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument '$1'; try --help" >&2; exit 1 ;;
    esac
done
[ -n "$DIR" ] || { echo "--dir <device-dir> is required" >&2; exit 1; }
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
PY="$DIR/venv/bin/python"
PIP="$PY -m pip"

step() { echo; echo "=== $* ==="; }
die()  { echo "$*" >&2; exit 1; }

# Token sources, in order (perception.sh's hf_token): read BEFORE anything slow
# so a machine without one stops in a second, not after a torch download.
hf_token() {
    local f="${HF_TOKEN_PATH:-${HF_HOME:-$HOME/.cache/huggingface}/token}"
    if   [ -n "$TOKEN" ];                      then printf '%s' "$TOKEN"
    elif [ -n "${HF_TOKEN:-}" ];               then printf '%s' "$HF_TOKEN"
    elif [ -n "${HUGGING_FACE_HUB_TOKEN:-}" ]; then printf '%s' "$HUGGING_FACE_HUB_TOKEN"
    elif [ -s "$f" ];                          then tr -d '[:space:]' < "$f"
    fi
}

weights_complete() {
    [ -s "$DIR/weights/sam3.pt" ]
}

token=""
if ! weights_complete; then
    token="$(hf_token || true)"
    [ -n "$token" ] || die \
"NO HUGGING FACE TOKEN, and $SAM3_HF_REPO is gated. Supply one from an account
with an accepted access request (https://huggingface.co/$SAM3_HF_REPO):
    setup.sh ... --token hf_...     or HF_TOKEN=hf_... setup.sh ...
    (a cached 'hf auth login' token also works)"
fi

step "venv -> $DIR/venv"
if [ -x "$PY" ]; then echo "  already present"; else python3 -m venv "$DIR/venv"; fi

step "torch $TORCH_VERSION (wheel bundles its matching CUDA + cuDNN — never mix a system cuDNN in)"
if $PY -c "import torch; assert torch.__version__.startswith('$TORCH_VERSION')" 2>/dev/null; then
    echo "  already installed"
else
    $PIP install --no-cache-dir "torch==$TORCH_VERSION" torchvision
fi

step "sam3 runtime deps (sam3 itself installs --no-deps)"
# huggingface_hub<2: 2.x fits no recent transformers, so pip falls back to
# transformers 4.12 + tokenizers 0.10 (source-only, needs a Rust compiler).
$PIP install --no-cache-dir "huggingface_hub[cli]<2" iopath transformers \
    einops "timm>=1.0.17" "ftfy==6.1.1" regex decord pycocotools psutil \
    pillow numpy pyyaml "setuptools<81"  # sam3 imports pkg_resources (removed in 81)

step "sam3 checkout @ ${SAM3_SHA:0:8}"
if [ -d "$DIR/sam3/.git" ] && [ "$(git -C "$DIR/sam3" rev-parse HEAD)" = "$SAM3_SHA" ]; then
    echo "  already at pin"
else
    [ -d "$DIR/sam3/.git" ] || git clone --quiet --filter=blob:none "$SAM3_REPO" "$DIR/sam3"
    git -C "$DIR/sam3" fetch --quiet origin "$SAM3_SHA" || true
    git -C "$DIR/sam3" checkout --quiet "$SAM3_SHA"
fi
# editable_mode=compat: strict editable installs (setuptools >= 64) expose sam3
# as a namespace package with __file__ = None, and the model builder resolves
# its BPE vocab via a __file__-relative path -> TypeError at weight load.
$PIP install --no-cache-dir --no-deps -e "$DIR/sam3" --config-settings editable_mode=compat

step "verify imports + package assets"
$PY - << 'EOF'
import os, sam3
assert sam3.__file__ is not None, (
    "sam3 imported as a namespace package (__file__ is None) — the editable install "
    "must use --config-settings editable_mode=compat")
vocab = os.path.join(os.path.dirname(sam3.__file__), "assets", "bpe_simple_vocab_16e6.txt.gz")
assert os.path.exists(vocab), f"missing package asset: {vocab}"
from sam3.model_builder import build_sam3_image_model  # noqa: F401
import PIL, numpy, yaml  # noqa: F401
print("  imports + assets ok")
EOF

step "torch / cuDNN smoke check (compute: $COMPUTE)"
COMPUTE="$COMPUTE" $PY - << 'EOF'
import os, torch
compute = os.environ["COMPUTE"]
print(f"  torch {torch.__version__}, cuda available: {torch.cuda.is_available()}, cudnn: {torch.backends.cudnn.version()}")
if compute.startswith("cuda"):
    assert torch.cuda.is_available(), (
        "cuda requested but torch.cuda.is_available() is False — check the driver, "
        "and that LD_LIBRARY_PATH does not point at a system CUDA/cuDNN (the wheel is self-contained)")
    torch.zeros(1, device=compute)
print("  compute ok")
EOF

step "weights: $SAM3_HF_REPO -> $DIR/weights (device-local)"
if weights_complete; then
    echo "  already complete"
else
    cli=""
    for c in "$DIR/venv/bin/hf" "$DIR/venv/bin/huggingface-cli"; do
        [ -x "$c" ] && { cli="$c"; break; }
    done
    [ -n "$cli" ] || die "no hf CLI in the venv (huggingface_hub[cli] install failed?)"
    HF_HOME="$DIR/hf-cache" "$cli" download "$SAM3_HF_REPO" sam3.pt --revision main --local-dir "$DIR/weights" --token "$token" >/dev/null
    weights_complete || die \
"checkpoint incomplete after download (weights/sam3.pt missing).
A gated fetch with a token lacking an accepted access request leaves only a skeleton —
request access at https://huggingface.co/$SAM3_HF_REPO and re-run."
fi

step "driver -> $DIR/driver.py"
cp "$HERE/driver.py" "$DIR/driver.py"

step "done"
echo "  interpreter: $DIR/venv/bin/python"
echo "  compute:     $COMPUTE"
echo "  register with calib_write (DEVICE.md Setup/Profile YAML), filling access.driver.interpreter"
echo "  and access.connection.compute ({kind: cuda, index: N} or {kind: cpu}); keep loaded: false — /load sam3 serves it."
