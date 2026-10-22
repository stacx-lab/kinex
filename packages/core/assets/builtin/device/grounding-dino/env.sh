# Device-local packages and offline caches for the Grounding DINO node only.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$here/site${PYTHONPATH:+:$PYTHONPATH}" HF_HOME="$here/cache" HF_HUB_OFFLINE=1
