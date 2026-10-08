# ROS container checks

Run from a Linux host with Docker:

```sh
bash packages/setup/test/container/ros2-smoke.sh jazzy
bash packages/setup/test/container/ros2-smoke.sh humble
```

This smoke gate uses native rclpy, DDS discovery and ROS message classes. A
container-local joint publisher receives commands and returns feedback; the
test checks load, write, stop, checker evidence and borrowed-stack cleanup.
A native IMU message regression covers covariance arrays and unavailable channels.
A source-build regression checks out two local Git repositories, lists the
dependent package first and verifies their shared colcon build succeeds.
The source mount is read-only and the container has no host network or hardware
devices. Image construction installs dependencies and needs network access.

The ordinary `npm run check` suite uses the scripted fake transport and needs
neither Docker nor ROS. The native smoke test is manual and is not a claim of
UR, ros2_control, driver-loss or physical-robot support.

The UR bundle milestone must add a separate `ros2-ur-mock.sh` and runtime
client using `use_mock_hardware=true`, including the last-command behavior
after driver SIGKILL. Generic arm/base bundles also need their ros2_control
demo checks. Record Humble and Jazzy outcomes in `PLAN.md`; do not count an
unrun container command as validation.
