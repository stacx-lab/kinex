"""Small ROS interface schemas used by the test transport, never packaged."""

from types import SimpleNamespace
from fake_rclpy.messages import define, from_dict


REGISTRY = {}
def message(name, fields):
    cls = define(name, fields)
    REGISTRY[name] = cls
    return cls


Time = message("builtin_interfaces/msg/Time", [("sec", int), ("nanosec", int)])
Duration = message("builtin_interfaces/msg/Duration", [("sec", int), ("nanosec", int)])
Header = message("std_msgs/msg/Header", [("stamp", Time), ("frame_id", str)])
String = message("std_msgs/msg/String", [("data", str)])
Bool = message("std_msgs/msg/Bool", [("data", bool)])
Vector3 = message("geometry_msgs/msg/Vector3", [("x", float), ("y", float), ("z", float)])
Quaternion = message("geometry_msgs/msg/Quaternion", [("x", float), ("y", float), ("z", float), ("w", float)])
Twist = message("geometry_msgs/msg/Twist", [("linear", Vector3), ("angular", Vector3)])
TwistStamped = message("geometry_msgs/msg/TwistStamped", [("header", Header), ("twist", Twist)])
TwistWithCovariance = message("geometry_msgs/msg/TwistWithCovariance", [("twist", Twist), ("covariance", [float])])
JointState = message("sensor_msgs/msg/JointState", [("header", Header), ("name", [str]), ("position", [float]), ("velocity", [float]), ("effort", [float])])
Point = message("trajectory_msgs/msg/JointTrajectoryPoint", [("positions", [float]), ("velocities", [float]), ("accelerations", [float]), ("effort", [float]), ("time_from_start", Duration)])
Trajectory = message("trajectory_msgs/msg/JointTrajectory", [("header", Header), ("joint_names", [str]), ("points", [Point])])
Odometry = message("nav_msgs/msg/Odometry", [("header", Header), ("child_frame_id", str), ("twist", TwistWithCovariance)])
Imu = message("sensor_msgs/msg/Imu", [("header", Header), ("orientation", Quaternion), ("orientation_covariance", [float]), ("angular_velocity", Vector3), ("angular_velocity_covariance", [float]), ("linear_acceleration", Vector3), ("linear_acceleration_covariance", [float])])
Image = message("sensor_msgs/msg/Image", [("header", Header), ("height", int), ("width", int), ("encoding", str), ("is_bigendian", int), ("step", int), ("data", bytes)])
CompressedImage = message("sensor_msgs/msg/CompressedImage", [("header", Header), ("format", str), ("data", bytes)])
CameraInfo = message("sensor_msgs/msg/CameraInfo", [("header", Header), ("height", int), ("width", int), ("distortion_model", str), ("d", [float]), ("k", [float]), ("r", [float]), ("p", [float])])


class Request(SimpleNamespace):
    pass


def get_service(name):
    if name not in ("controller_manager_msgs/srv/ListControllers", "rcl_interfaces/srv/GetParameters"):
        raise ValueError(name)
    return SimpleNamespace(Request=Request)


def get_action(name):
    if name != "control_msgs/action/FollowJointTrajectory":
        raise ValueError(name)
    return SimpleNamespace(Goal=Request)
