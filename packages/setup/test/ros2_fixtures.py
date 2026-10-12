"""Software-only ROS configuration fixtures shared by ROS adapter and checker tests."""

import json
from pathlib import Path
import yaml


URDF = '<robot name="demo"><link name="base"/><link name="tip"/><joint name="a" type="revolute"/><joint name="b" type="revolute"/></robot>'


def fixture(directory, kind="joint"):
    directory = Path(directory)
    names = {"joint": "arm", "velocity": "base", "imu": "imu", "rgb": "camera", "rgbd": "camera"}
    name = names[kind]
    driver = {"period_s": .01, "stale_periods": 20, "connect_timeout_s": .2, "clock": {"max_skew_s": .5}}
    graph = {"topics": {}, "controllers": {"jtc": "active"}}
    expected = {"topics": [], "domain": True}
    if kind == "joint":
        driver.update(adapter="JointTrajectoryDriver", state_topic="/joint_states", command_topic="/jtc/joint_trajectory", controller="jtc",
                      action="/jtc/follow_joint_trajectory", time_from_start_s=.1,
                      stop={"method": "measured_position_and_cancel", "confirm": {"max_speed": .001, "timeout_s": .2},
                            "driver_loss": {"command_timeout_s": .1, "source": "fixture controller model"}})
        intrinsics = {"frames": {}, "kinematics": None, "home": None,
                      "model": {"format": "joints", "joints": [{"name": joint, "type": "revolute", "limits": {"min": -3., "max": 3.}, "max_velocity": 10., "max_effort": None} for joint in ["a", "b"]]},
                      "control": {"mode": "position"}, "feedback": {"velocities": True, "efforts": True}, "stop": {"behavior": "hold", "affected_devices": [name]}}
        graph["topics"] = {"/joint_states": {"type": "sensor_msgs/msg/JointState", "rate_hz": 200},
                           "/jtc/joint_trajectory": {"type": "trajectory_msgs/msg/JointTrajectory", "subscribers": 1},
                           "/robot_description": {"type": "std_msgs/msg/String", "latched": True, "message": {"data": URDF}}}
        graph["robot"] = {"kind": "jtc", "state_topic": "/joint_states", "command_topic": "/jtc/joint_trajectory", "names": ["b", "a"], "positions": [0., 0.]}
        expected.update(joints=["a", "b"], controllers=[{"name": "jtc", "state": "active"}], identity={"single_publisher": "/joint_states"})
    elif kind == "velocity":
        driver.update(adapter="TwistDriver", state_topic="/odom", command_topic="/cmd_vel", feedback_frame="base_link",
                      stop={"method": "zero_twist_repeat", "count": 3, "confirm": {"max_speed": .001, "timeout_s": .2}})
        intrinsics = {"frames": {}, "control": {"mode": "motion", "body_frame": "base", "modes": {"drive": {"velocity": {"frame": "body", "components": [
            {"axis": axis, "units": "rad/s" if axis == "wz" else "m/s", "bounds": {"min": -1., "max": 1.}} for axis in ["vx", "vy", "wz"]]}, "posture": None}}},
            "feedback": {"velocity_components": ["vx", "vy", "wz"], "velocity_frame": "base"}, "stop": {"behavior": "halt", "affected_devices": [name]}}
        graph["topics"] = {"/odom": {"type": "nav_msgs/msg/Odometry", "rate_hz": 200, "message": {"child_frame_id": "base_link"}},
                           "/cmd_vel": {"type": "geometry_msgs/msg/Twist", "subscribers": 1}}
        graph["robot"] = {"kind": "cmd_vel", "state_topic": "/odom", "command_topic": "/cmd_vel", "command_timeout_s": .1}
    elif kind == "imu":
        driver.update(adapter="ImuSource", state_topic="/imu", acceleration_quantity="specific_force")
        channel = {"axes": ["x", "y", "z"], "bias": {"x": .1, "y": 0., "z": 0.}}
        intrinsics = {"measurement": {"angular_velocity": channel, "linear_acceleration": {**channel, "quantity": "specific_force"},
                                      "orientation": {"reference": {"kind": "startup"}}, "magnetic_field": None}, "sample_rate_hz": 100}
        graph["topics"] = {"/imu": {"type": "sensor_msgs/msg/Imu", "rate_hz": 200, "message": {"angular_velocity": {"x": .2}, "linear_acceleration": {"z": 9.81}, "orientation": {"w": 1.},
                        "angular_velocity_covariance": [0.] * 9, "linear_acceleration_covariance": [0.] * 9, "orientation_covariance": [0.] * 9}}}
    else:
        driver.update(adapter="CameraSource", color_topic="/color", camera_info_topic="/info", color_image_space="raw", sync_tolerance_s=.05)
        geometry = {"width": 2, "height": 1, "fps": 30., "projection": {"model": "pinhole", "fx": 100., "fy": 100., "cx": 1., "cy": .5, "skew": 0.},
                    "distortion": {"model": "none"}, "fov": "???", "pixel_format": "rgb8", "image_format": "png"}
        intrinsics = {"color": geometry}
        graph["topics"] = {"/color": {"type": "sensor_msgs/msg/Image", "rate_hz": 200, "message": {"width": 2, "height": 1, "encoding": "bgr8", "step": 8, "data": [30, 20, 10, 60, 50, 40, 0, 0]}},
                           "/info": {"type": "sensor_msgs/msg/CameraInfo", "rate_hz": 200, "message": {"width": 2, "height": 1, "k": [100., 0., 1., 0., 100., .5, 0., 0., 1.], "d": [0.] * 5, "distortion_model": "plumb_bob"}}}
        if kind == "rgbd":
            driver["depth_topic"] = "/depth"
            intrinsics["depth"] = {"width": 2, "height": 1, "fps": 30., "pixel_format": "uint16", "image_format": "pgm16_be", "quantity": "z", "scale_m_per_unit": .001,
                                   "invalid_value": 0, "valid_range_m": {"min": .1, "max": 5.}, "reliable_range_m": "???", "registration": "color"}
            graph["topics"]["/depth"] = {"type": "sensor_msgs/msg/Image", "rate_hz": 200, "message": {"width": 2, "height": 1, "encoding": "16UC1", "step": 6, "is_bigendian": 1, "data": [3, 232, 255, 255, 0, 0]}}
    feedback = driver.get("state_topic", driver.get("color_topic"))
    expected["topics"] = [{"name": feedback, "type": graph["topics"][feedback]["type"], "min_hz": 1}]
    config = {"domain_id": 0, "namespace": "", **driver, "expected": expected,
              "ready_topics": [feedback], "ready_timeout_s": .1}
    directory.mkdir(parents=True, exist_ok=True)
    write(directory / "profile_ros.yaml", config)
    actions = ["read", "load", "unload", "status"]
    if kind in ("joint", "velocity"):
        actions += ["write", "stop"]
    if kind in ("rgb", "rgbd"):
        actions += ["introspect"]
    if kind in ("joint", "rgb", "rgbd"):
        actions += ["record_start", "record_stop"]
    connection_keys = ("state_topic", "command_topic", "color_topic", "depth_topic")
    profile = {
        "name": name, "type": kind, "loaded": False,
        "access": {"source": "default", "connection": {"kind": "ros", **{key: driver[key] for key in connection_keys if key in driver}},
                   "driver": {"entry": "driver.py", "interpreter": str(directory.resolve() / "ros-python"),
                              "actions": actions, "persistent": True, "timeout_s": 30}},
        "intrinsics": {"source": "default", **intrinsics},
        "extrinsics": {"source": "default"},
    }
    write(directory / "profile.yaml", profile)
    (directory / "driver.py").write_text("from pathlib import Path\nfrom kinex_ros.ros2_drivers import ros_driver\nros_driver(Path(__file__).parent).main()\n", encoding="utf8")
    (directory / "DEVICE.md").write_text(f"# {name}\n\n## Setup\nSoftware-only {kind} adapter fixture.\n", encoding="utf8")
    (directory / "scenario.json").write_text(json.dumps(graph), encoding="utf8")
    return config, profile, graph


def write(path, value):
    Path(path).write_text(yaml.safe_dump(value, sort_keys=False), encoding="utf8")


def runtime_fixture(directory, setup_library, core_library):
    """Create a test driver in place; return fields for the profile tool."""
    import shutil
    import sys
    from shlex import quote
    directory = Path(directory).resolve()
    _, profile, _ = fixture(directory)
    (directory / "profile.yaml").unlink()
    (directory / "DEVICE.md").unlink()
    helpers = directory / "python/kinex_ros"
    helpers.mkdir(parents=True)
    for name in ("__init__", "config", "ros2", "ros2_drivers"):
        shutil.copyfile(Path(setup_library) / "kinex_ros" / f"{name}.py", helpers / f"{name}.py")
    # Fixed fake-ROS launcher for this test fixture, not a runtime script generator.
    wrapper = directory / "ros-python"
    libraries = str(directory / "python") + ":" + core_library
    wrapper.write_text("#!/usr/bin/env bash\n"
                       + f'export PYTHONPATH={quote(libraries)}"${{PYTHONPATH:+:$PYTHONPATH}}"\n'
                       + f'exec {quote(sys.executable)} "$@"\n')
    wrapper.chmod(0o755)
    return profile
