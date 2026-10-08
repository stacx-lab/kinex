# ROS dependencies

## Reuse installed ROS packages before fetching source

Before any vendor `git clone`, `git fetch`, submodule initialization or `colcon`
build, source the selected ROS distribution and any known compatible workspace
overlay on the driver host. Inspect each required driver's actual ROS packages
with `ros2 pkg prefix PACKAGE` and `ros2 pkg executables PACKAGE`. Inspect
`<prefix>/share/PACKAGE` for package.xml, launch files, parameters, URDF/xacro and
meshes; use `dpkg-query` for installed Debian versions and file lists where
applicable. A missing command/package in an unsourced shell is not evidence that
source installation is needed. ROS base and message packages alone do not prove
that a vendor driver is installed.

If the installed driver satisfies the required interfaces and version, use it
directly. Launch by ROS package name, configure device addresses, serials,
namespaces and frames locally, and reuse installed descriptions/assets. Multiple
arms or cameras share the installed driver; they need instance configuration,
not separate source checkouts. Do not clone a vendor repository just to read its
documentation, copy launch files/meshes or create a Kinex adapter; inspect the
installed assets and official documentation directly.

For a genuinely missing package, check the configured apt repository for a
compatible binary and use the installer below. An apt authentication, repository
or network failure is not evidence that binaries are unavailable. Source fallback
requires recording the exact missing package, required version/feature and why
the installed/available binary cannot satisfy it. Check dependencies independently:
a source-only arm driver does not justify rebuilding an already installed camera
driver. Treat vendor binary and source installation instructions as alternatives.

When authoring workspace bundle manifests, use `pins.apt` for binary dependencies,
including requirements already installed, and reserve `pins.git` for justified
source dependencies. The installer executes both lists; listing the same
implementation in both will
clone/build it even after apt succeeds. Recheck existing setup-plan source-build
prerequisites against the installed packages and retire redundant steps. Record
the reused prefix/version and the selected launch file in the existing setup
result or preparation node.

## Install ROS and system dependencies

Dependency installation is part of registration/onboarding, before driver imports
and activation. Do not stop at giving the user apt commands. Run on the Linux host
where the driver will execute; a local workstation is not a substitute for the
robot host. For non-ROS devices, install only their guide's required dependencies.

For ROS devices, inspect `/etc/os-release`, architecture, installed ROS
distributions and the selected guide/manifest. Reuse a compatible installed
distribution; otherwise select one supported by both the host and device from
official ROS/vendor docs.
Ask only if the evidence leaves a material choice. Check the ROS apt repository
and configure it from that distribution's official installation instructions
through the host's normal shell permissions when needed. Do not change an
existing ROS distribution or perform a whole-system upgrade as a setup shortcut.

Batch the exact apt dependencies for the selected devices, including their ROS
base/runtime, message packages, RMW and vendor driver packages as needed. Prefer
manifest `pins.apt` and apt preflight entries when present. Resolve placeholders
from host facts, preserve version pins, and avoid speculative vendor packages.
Use the shared helper with the distro's system Python; it needs neither ROS nor
PyYAML and can bootstrap `python3-yaml` before a bundle is readable:

```sh
PYTHONHOME= PYTHONPATH="<setup.provisioning.setup_library>" /usr/bin/python3 -S "<setup.provisioning.setup_library>/kinex_ros/bundle_install.py" -- PACKAGE [PACKAGE ...]
PYTHONHOME= PYTHONPATH="<setup.provisioning.setup_library>" /usr/bin/python3 -S "<setup.provisioning.setup_library>/kinex_ros/bundle_install.py" --install -- PACKAGE [PACKAGE ...]
```

The first command checks without changes. When `kinex_install_apt` is available
and the driver runs on the same Linux host as Kinex, use that tool with the
required package list. It handles shell permission and hands sudo authentication
directly to the user terminal, then verifies installation and returns to onboarding.
It only operates on the host running Kinex; never use it to repair a remote host.
Otherwise, for `status:needs` apt entries, run the second command through the
host's existing shell approval mechanism. It refreshes
apt indexes, installs missing packages, verifies installed versions and skips
already satisfied packages. No separate manual-install handoff is needed.
If a shipped bundle exists, run its documented `setup.sh` with `--install` and
resume the same command after resolving needs. Bootstrap missing ROS/runtime
packages with the helper first when a missing setup file blocks bundle preflight.
For dependency repair after a completed bundle install, rerun its `--step install`
with `--install`, then resume the full setup command.

Keep failed dependencies incomplete. Inspect the returned apt stage/error for
repository, network, package or sudo failures; repair the cause and retry. For
`reason:sudo_authentication`, use `kinex_install_apt` on the same host if available,
or run the returned command with `--install --interactive` in a host-provided
interactive terminal. The helper authenticates and installs in the same process;
authenticating in an unrelated terminal may not authorize the agent's shell.
Never request or capture passwords in chat. If a terminal is unavailable, show
the returned recovery command and pause dependency setup. If authentication is
cancelled or fails, wait for the user before retrying; do not repeatedly prompt.
Allow at least 3600 seconds for a shell-based install (plus authentication time);
apt index refreshes and downloads can exceed a short tool timeout. Do not alter
sudoers. After installation,
source the selected ROS environment in the driver's wrapper, verify imports with
that interpreter and recheck setup. Do not install `rclpy` into core's uv environment.
