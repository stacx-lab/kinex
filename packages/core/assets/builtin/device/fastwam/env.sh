# Device-local packages, FastWAM source and offline caches for the FastWAM node only.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$here/site:$here/source/src${PYTHONPATH:+:$PYTHONPATH}" \
    HF_HOME="$here/cache/huggingface" XDG_CACHE_HOME="$here/cache" TORCH_HOME="$here/cache/torch" \
    TORCHINDUCTOR_CACHE_DIR="$here/cache/inductor" TRITON_CACHE_DIR="$here/cache/triton" \
    DIFFSYNTH_MODEL_BASE_PATH="$here/weights" DIFFSYNTH_SKIP_DOWNLOAD=true \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
