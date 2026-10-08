#!/usr/bin/env bash
# Native-rclpy transport smoke test. Robot/controller integration is a later gate.
set -euo pipefail
distro=${1:-jazzy}
case "$distro" in humble|jazzy) ;; *) echo 'usage: ros2-smoke.sh humble|jazzy' >&2; exit 64 ;; esac
root=$(cd "$(dirname "$0")/../../../.." && pwd)
tag="kinex-ros2-smoke:$distro"
docker build --build-arg ROS_DISTRO="$distro" -t "$tag" - <<'DOCKERFILE'
ARG ROS_DISTRO=jazzy
FROM osrf/ros:${ROS_DISTRO}-desktop
RUN apt-get update && apt-get install -y --no-install-recommends \
    git cmake python3-colcon-common-extensions python3-yaml python3-numpy python3-pil \
    ros-${ROS_DISTRO}-control-msgs ros-${ROS_DISTRO}-controller-manager-msgs \
    && rm -rf /var/lib/apt/lists/*
DOCKERFILE
# Do not join the host's robot network or expose hardware devices.
docker run --rm --network none -v "$root:/src:ro" "$tag" timeout -k 5 60 bash -c '
  set -euo pipefail
  set +u
  source "/opt/ros/$ROS_DISTRO/setup.bash"
  set -u
  export ROS_DOMAIN_ID=0 ROS_LOCALHOST_ONLY=1 PYTHONDONTWRITEBYTECODE=1
  export PYTHONPATH="/src/packages/core/assets/python:/src/packages/setup/assets/python:/src/packages/setup/test${PYTHONPATH:+:$PYTHONPATH}"
  python3 /src/packages/setup/test/container/ros2_native.py
'
