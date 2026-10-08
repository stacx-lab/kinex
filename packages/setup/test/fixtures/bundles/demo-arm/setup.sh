#!/usr/bin/env bash
# Run from the source; provisioning stages all files before registration.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE=""
SETUP=""
ARGS=("$@")
while [ $# -gt 0 ]; do
    case "$1" in
        --core-library) CORE="$2"; shift 2 ;;
        --setup-library) SETUP="$2"; shift 2 ;;
        --library) echo 'use --core-library and --setup-library' >&2; exit 2 ;;
        *) shift ;;
    esac
done
[[ "$CORE" = /* && -f "$CORE/kinex/__init__.py" ]] || { echo 'provide --core-library containing kinex/__init__.py' >&2; exit 2; }
[[ "$SETUP" = /* && -f "$SETUP/kinex_ros/__init__.py" ]] || { echo 'provide --setup-library containing kinex_ros/__init__.py' >&2; exit 2; }
PYTHONHOME= PYTHONPATH="$SETUP:$CORE" exec /usr/bin/python3 "$HERE/provision.py" "${ARGS[@]}"
