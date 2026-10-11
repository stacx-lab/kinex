# Bundle entrypoints

Setup context provides `setup.provisioning.core_library` (the directory containing
`kinex`) and `setup.provisioning.setup_library` (containing `kinex_ros`). Pass both
absolute paths explicitly, including on resumed runs:

```sh
bash <source>/setup.sh --dir <project>/.kinex/devices/<name> \
  --core-library <core_library> --setup-library <setup_library> \
  --fact name=<name> --install
```

The source `provision.py` calls `kinex_ros.bundle.provision(source, argv, steps)`.
The optional steps mapping contains vendor functions `(bundle, facts, state)`;
write generated artifacts under `bundle.directory` (the staging directory).
`bundle.device_directory` identifies persistent instance resources. Do not write
active profiles, driver files or wrappers there. The source `setup.sh` validates
both library roots and executes the source provisioner with command-local
`PYTHONPATH=<setup_library>:<core_library>`. Do not copy into the active device
before provisioning. `--questionnaire` returns declared facts; `--step NAME`
forces a new attempt through that step and completes subsequent preparation.

The manifest is version 1 and rejects unknown keys. Inspect the setup library's
`kinex_ros/bundle_manifest.py` for fields. Declare the device type, facts, required
apt/git dependencies, driver adapter/topics, expected interfaces, optional stack,
profile intrinsics and task recipe. Whole-value fact placeholders preserve types.
Keep domain/namespace and CameraInfo settings in bundle facts/driver configuration;
core profiles retain only their existing connection topics. Never duplicate a
satisfied binary dependency in `pins.git`.

Small drivers call `kinex_ros.ros2_drivers.bundle_driver(Path(__file__).parent).main()`.
Available adapters are `JointTrajectoryDriver`, `TwistDriver`, `ImuSource` and
`CameraSource`. Vendor subclasses reuse their measured-state/buffer/stop contracts.

The last stdout line contains `{status, needs, manual_steps, next, generations}`.
Completed artifacts live under `ros/generations/<id>/`, with only `__init__`,
`bundle_manifest`, `ros2`, `ros2_drivers` and `ros2_check` in their private
`kinex_ros` package. Profile entry/interpreter paths select that same generation.
Use returned paths, not assumed root `driver.py`, `stack.sh` or `check.sh` paths.
Identical inputs resume; changes create a separate candidate. A failed candidate
leaves selected files intact. Completed vendor steps retain their generated artifacts
on resume. Provision satellites through their parent bundle to pin its completed
generation. Host package installation is not rolled back.

Custom drivers and `check.py` hooks read configuration from `bundle_manifest`.
Keep installation and generation in the source provisioner: runtime imports of
`kinex_ros.bundle`, `bundle_install`, `bundle_render` or `provision` are rejected
before publishing a candidate, including imports in generated helper modules.
Use `checks(session, bundle, facts)` in `check.py` to return measured assertions.
Deploy custom runtime resources through vendor steps and test them without setup
or the source directory; static checks cannot establish arbitrary dynamic imports.
Provisioning inputs and the runtime file list both affect generation identity.
Source `provision.py` and `setup.sh` are not deployed; existing generations remain
unchanged until explicitly replaced through the normal profile lifecycle.

A generated recipe prepares access with `onboard-ros2` and verifies only the
selected task. Shared type guides stay in core's device guide roots. Only
`legged_base` permits custom per-device Use guides. No vendor bundle is shipped
by this foundation; do not claim hardware support from software fixtures.
