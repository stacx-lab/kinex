---
name: onboard-ros2
description: Register or repair ROS 2 hardware integrations using reusable packages, device-local drivers and measured interface checks.
---

# Onboard ROS 2 hardware

For ROS hardware, follow `/onboarding` and core's `setup-device` skill.

Prefer compatible installed driver packages, then apt binaries.
Use vendor source or a direct SDK only for a concrete unsupported capability/version
or the user's explicit choice; record the reason.

## Devices and shared ROS backend

Do not invent virtual devices that are not related to real hardware.
Prefer a shared ROS backend in `.kinex/lib` to handle the ROS communication lifecycle
and communication across multiple topics.

## Device files

Create only the files needed by the driver. Devices sharing a ROS stack reuse its
environment and existing nodes; `stack.sh` is unnecessary when nodes already run.

```text
.kinex/devices/<name>/
├── profile.yaml       # Managed by profile_write
├── driver.py          # Driver entry; filename may differ
├── profile_ros.yaml   # Required for built-in adapters; optional for custom drivers
├── ros-python         # Optional ROS environment wrapper
├── stack.sh           # Optional vendor startup wrapper
├── model.urdf         # Optional when installed assets are insufficient
└── python/kinex_ros/   # Optional local copy of required runtime helpers
```

Put ROS settings in `profile_ros.yaml`: `adapter`, `domain_id`, `namespace`, topics,
CameraInfo settings and optional `expected` interfaces. The setup package's
`assets/python/kinex_ros/` contains the helpers; inspect `config.py` and
`ros2_drivers.py` for supported fields. Built-in adapters (`JointTrajectoryDriver`,
`TwistDriver`, `ImuSource`, `CameraSource`) use this entry point:

```python
from pathlib import Path
from kinex_ros.ros2_drivers import ros_driver

ros_driver(Path(__file__).parent).main()
```

Return interface observations to the caller; do not create device-local measurement
reports or setup-progress files.

For cameras, establish raw versus rectified image space from interface documentation
and declare `color_image_space` (and `depth_image_space` for native
depth with its own CameraInfo). Compare live CameraInfo with the declared
intrinsics and apply observed corrections through `profile_write`.

## Dependencies and ROS Python

Before downloading or building vendor source, source the selected ROS distribution
and compatible workspace overlays on the driver host, then check installed driver
packages, versions and resources using `ros2 pkg` and `dpkg-query`. Neither a missing
command in an unsourced shell nor the presence of ROS base/message packages
establishes whether the required vendor driver is installed.

When installation is needed, configure the selected ROS distribution's apt repository
following its official installation instructions.

When sudo is required, give the user the exact command and target host to run
independently.

Match the driver interpreter to the selected ROS installation: Jazzy/Ubuntu 24.04 uses
Python 3.12; Humble/Ubuntu 22.04 uses Python 3.10.

For ROS interpreters older than Python 3.11, install `exceptiongroup` in the
ROS driver's Python environment (`/absolute/path/to/ros/python -m pip install
exceptiongroup`). Before importing `kinex`, use an environment-local startup shim
to expose the package's `ExceptionGroup` and `BaseExceptionGroup` in `builtins`;
installing the package alone does not provide these names. Keep this compatibility
setup in the ROS environment; do not modify core to support the older interpreter.

Run ROS drivers in a separate process with a command-local environment:

```sh
env -u PYTHONPATH -u PYTHONHOME bash --noprofile --norc -c '
  source "/opt/ros/<distro>/setup.bash"
  # Source a compatible workspace overlay here if needed.
  exec /absolute/path/to/ros/python "$@"
' ros-driver /absolute/path/to/driver.py
```

Set required driver paths and the core library path from context through
`PYTHONPATH` inside this subprocess only; keep ROS out of the core environment.
Match the running robot's ROS domain and middleware configuration. Create a separate ROS Python environment only when additional pip
dependencies require it.
