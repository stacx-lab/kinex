#!/usr/bin/env bash
# Provision FastWAM into a device directory; Kinex owns registration and load.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE="usage: setup.sh --dir DEVICE_DIR --python KINEX_PYTHON [--compute cuda:N] [--variant VARIANT]"
SOURCE=https://github.com/yuantianyuan01/FastWAM.git
REVISION=7faa71108368fbb3b6885649f112af607427a2d4
DIR="" PY="" COMPUTE="cuda:0" VARIANT="libero_uncond_2cam224"
while (($#)); do
    case "$1" in
        --dir) DIR="${2:?$USAGE}"; shift 2 ;;
        --python) PY="${2:?$USAGE}"; shift 2 ;;
        --compute) COMPUTE="${2:?$USAGE}"; shift 2 ;;
        --variant) VARIANT="${2:?$USAGE}"; shift 2 ;;
        *) echo "$USAGE" >&2; exit 2 ;;
    esac
done
[[ -n "$DIR" && -x "$PY" && "$COMPUTE" =~ ^cuda:[0-9]+$ ]] || { echo "$USAGE" >&2; exit 2; }
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

# Kinex ROS messages are compiled against Kinex Python's numpy; keep that ABI.
NUMPY="$("$PY" -c 'import numpy; print(numpy.__version__)')"
uv pip install --python "$PY" --target "$DIR/site" --no-cache --link-mode=copy \
    --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match \
    -r "$HERE/requirements.txt" "numpy==$NUMPY"
if [[ ! -d "$DIR/source/.git" ]]; then
    git clone --quiet --filter=blob:none --no-checkout "$SOURCE" "$DIR/source"
    git -C "$DIR/source" sparse-checkout set src configs
fi
git -C "$DIR/source" cat-file -e "$REVISION^{commit}" 2>/dev/null || git -C "$DIR/source" fetch --quiet origin "$REVISION"
git -C "$DIR/source" checkout --quiet --detach "$REVISION"
cp "$HERE/node.py" "$HERE/env.sh" "$DIR/"
PYTHONPATH="$DIR/site:$DIR/source/src" "$PY" -c "import sys, torch; torch.zeros(1, device=sys.argv[1]); \
from fastwam.models.wan22.fastwam_optional_idm import FastWAMOptionalIDM" "$COMPUTE"
PYTHONPATH="$DIR/site" HF_HOME="$DIR/cache/huggingface" "$PY" "$HERE/provision.py" "$DIR" "$VARIANT"
echo "compute $COMPUTE verified; $VARIANT artifacts ready"
