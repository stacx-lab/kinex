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
compatible binary and follow the installation guidance below. An apt permission, repository
or network failure is not evidence that binaries are unavailable. Source fallback
requires recording the exact missing package, required version/feature and why
the installed/available binary cannot satisfy it. Check dependencies independently:
a source-only arm driver does not justify rebuilding an already installed camera
driver. Treat vendor binary and source installation instructions as alternatives.

When authoring workspace bundle manifests, use `pins.apt` for binary dependencies,
including requirements already installed, and reserve `pins.git` for justified
source dependencies. Provisioning checks apt packages and installs/builds declared
Git sources with `--install`; listing the same implementation in both still
clones/builds it after its apt packages are satisfied. Recheck existing setup-plan source-build
prerequisites against the installed packages and retire redundant steps. Record
the reused prefix/version and the selected launch file in the existing setup
result or preparation node.

## Install ROS and system dependencies

Dependency installation is part of registration/onboarding, before driver imports
and activation. Run on the Linux host
where the driver will execute; a local workstation is not a substitute for the
robot host. For non-ROS devices, install only their guide's required dependencies.

For ROS devices, inspect `/etc/os-release`, architecture, installed ROS
distributions and the selected guide/manifest. Reuse a compatible installed
distribution; otherwise select one supported by both the host and device from
official ROS/vendor docs.
Ask only if the evidence leaves a material choice. Check the ROS apt repository
and configure it from that distribution's official installation instructions
through the host's normal shell permissions when needed; hand privileged changes
to the user as described below. Do not change an
existing ROS distribution or perform a whole-system upgrade as a setup shortcut.

Batch the exact apt dependencies for the selected devices, including their ROS
base/runtime, message packages, RMW and vendor driver packages as needed. Prefer
manifest `pins.apt` and apt preflight entries when present. Resolve placeholders
from host facts, preserve version pins, and avoid speculative vendor packages.
Bundle preflight and installation steps report missing apt packages and versions
without executing apt. Use the existing permission-checked shell tool to run
`apt-get update` and `apt-get install -y --no-remove -- PACKAGE ...` when the
current user has the required privileges. Quote package arguments and preserve
architecture/version pins. Bootstrap `python3-yaml` the same way if a missing
PyYAML import prevents bundle inspection.

When sudo is required, give the user the exact commands and identify the driver
host where they must run them, for example `sudo apt-get update` followed by
`sudo apt-get install -y --no-remove -- PACKAGE ...` with the actual packages.
Ask them to run the commands independently and report completion. Do not run
sudo or collect credentials through agent tools. Keep the dependency prerequisite
incomplete while waiting; continue only work that does not depend on it.

After installation, recheck installed packages and pinned versions, source the
selected ROS environment in the driver's wrapper, and verify imports with that
interpreter. Do not install `rclpy` into core's uv environment. Resume the same
bundle setup command; `--install` allows pip/Git preparation and source builds,
which remain blocked while apt prerequisites are missing. For dependency repair
after a completed generation, rerun `--step install --install` to force rechecking.
Keep repository, network and package failures incomplete and resolve their cause;
they are not grounds for switching to a source build by themselves.
