#!/usr/bin/env bash
# Provision only; register profile.generated.json through Kinex, then explicitly load.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR=""
SOURCE=https://github.com/yuantianyuan01/FastWAM.git
COMPUTE=cuda:0
VARIANT=libero_uncond_2cam224
REVISION=7faa71108368fbb3b6885649f112af607427a2d4
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR="$2"; shift 2 ;;
        --source) SOURCE="$2"; shift 2 ;;
        --compute) COMPUTE="$2"; shift 2 ;;
        --variant) VARIANT="$2"; shift 2 ;;
        *) echo "Usage: setup.sh --dir PATH [--source CHECKOUT] [--compute cuda:N] [--variant VARIANT]" >&2; exit 1 ;;
    esac
done
[ -n "$DIR" ] || { echo '--dir is required' >&2; exit 1; }
[[ "$COMPUTE" =~ ^cuda:[0-9]+$ ]] || { echo 'FastWAM requires cuda:N' >&2; exit 1; }
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
export UV_CACHE_DIR="$DIR/cache/uv"
export UV_PYTHON_INSTALL_DIR="$DIR/cache/python"
export HF_HOME="$DIR/cache/huggingface"
export XDG_CACHE_HOME="$DIR/cache"
export TMPDIR="$DIR/cache/tmp"
mkdir -p "$TMPDIR"
for file in driver.py fastwam_config.py provision.py artifacts.json requirements.txt DEVICE.md setup.sh; do
    [ "$HERE" = "$DIR" ] || cp "$HERE/$file" "$DIR/$file"
done
if [ ! -x "$DIR/venv/bin/python" ]; then uv venv --python 3.10 "$DIR/venv"; fi
uv pip install --python "$DIR/venv/bin/python" 'torch==2.7.1+cu128' --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$DIR/venv/bin/python" -r "$DIR/requirements.txt"
if [ ! -d "$DIR/source/.git" ]; then
    git clone --no-hardlinks --filter=blob:none --no-checkout "$SOURCE" "$DIR/source"
    git -C "$DIR/source" sparse-checkout set src configs
fi
git -C "$DIR/source" cat-file -e "$REVISION^{commit}" || git -C "$DIR/source" fetch origin "$REVISION"
git -C "$DIR/source" checkout --detach "$REVISION"
PYTHONPATH="$DIR/source/src" "$DIR/venv/bin/python" -c 'from fastwam.models.wan22.fastwam import FastWAM; from fastwam.models.wan22.fastwam_optional_idm import FastWAMOptionalIDM; from fastwam.datasets.lerobot.utils.normalizer import LinearNormalizer'
"$DIR/venv/bin/python" "$DIR/provision.py" --compute "$COMPUTE" --variant "$VARIANT"
uv pip freeze --python "$DIR/venv/bin/python" > "$DIR/installed-requirements.txt"
echo "Provisioned. Register $DIR/profile.generated.json through Kinex; load remains explicit."
