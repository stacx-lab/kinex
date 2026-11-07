# Device-local packages, the SAM3 checkout and offline caches for the SAM3 node only.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$here/site:$here/sam3${PYTHONPATH:+:$PYTHONPATH}" HF_HOME="$here/cache" HF_HUB_OFFLINE=1
