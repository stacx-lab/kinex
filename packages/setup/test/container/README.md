# ROS container checks

Run from a Linux host with Docker:

```sh
bash packages/setup/test/container/ros2-smoke.sh
```

This smoke gate targets ROS 2 Jazzy on Ubuntu 24.04 with Python 3.12 and uses
native rclpy, DDS discovery and ROS message classes. A
container-local joint publisher receives commands and returns feedback; the
test checks load, write, stop, checker evidence and borrowed-stack cleanup.
A native IMU message regression covers covariance arrays and unavailable channels.
The source mount is read-only and the container has no host network or hardware
devices. Image construction installs dependencies and needs network access.

The ordinary `npm run check` suite uses the scripted fake transport and needs
neither Docker nor ROS. The native smoke test is manual and is not a claim of
UR, ros2_control, driver-loss or physical-robot support.
