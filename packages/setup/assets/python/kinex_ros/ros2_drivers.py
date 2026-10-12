"""Device adapters for ROS joints, velocity bases, IMUs and cameras.

Load observes the borrowed stack. Motion uses the existing Kinex buffer and
stop contracts; unload releases this process's ROS resources only.
"""

import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import time

from kinex_ros.config import load
from kinex.driver_protocol import release, run
from kinex.joint_driver import Driver as JointDriver
from kinex.velocity_driver import Driver as VelocityDriver
from kinex.validation import settings
from kinex_ros.ros2 import (ROSError, Session, StopConfirm, camera_info_patch,
                        joint_state_vector, jtc_hold, jtc_point, twist, zero_twist)


def positive(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ROSError(f"{name} must be finite and positive", "invalid_ros_profile")
    return value


def remediation(missing):
    return f"{missing}; check that the required ROS nodes are running and reachable, then retry /load"


def configuration(directory, allow_missing_model=False):
    directory = Path(directory).resolve()
    driver = load(directory)
    expected = copy.deepcopy(driver.get("expected", {}))
    identity_file = directory / "identity.json"
    identity = json.loads(identity_file.read_text(encoding="utf8")) if identity_file.is_file() else {}
    if not isinstance(identity, dict):
        raise ROSError("identity.json must contain an object", "invalid_identity")
    description = expected.get("robot_description", {})
    if description.get("compare_to"):
        model = Path(directory) / description["compare_to"]
        if model.is_file():
            description["sha256"] = hashlib.sha256(model.read_bytes()).hexdigest()
        elif not allow_missing_model:
            raise ROSError(f"reference URDF {description['compare_to']} is missing; capture it explicitly with --save-urdf", "missing_model")
    return driver, expected, identity


@dataclass
class FaultRule:
    config: dict
    latest: object
    since: float | None = None

    def observe(self, message, received):
        value = message
        for name in self.config["field"].split("."):
            value = getattr(value, name)
        if value != self.config["equals"]:
            self.since = None
        elif self.since is None:
            self.since = received


@dataclass
class Connection:
    session: Session
    latest: object = None
    publisher: object = None
    action: object = None
    command_type: str = ""
    streams: dict = field(default_factory=dict)
    rules: list = field(default_factory=list)
    controller_fault: tuple = ("", 0.)
    stop_error: str = ""
    monitor_stop: object = field(default_factory=threading.Event)
    monitor: object = None

    def close(self):
        self.monitor_stop.set()
        def finish_monitor():
            if self.monitor is not None:
                self.monitor.join(1)
                if self.monitor.is_alive():
                    raise ROSError("controller monitor did not stop", "cleanup_timeout")
        release(finish_monitor, self.session.close)


class ROSDevice:
    def execute(self, action, args):
        if action == "write" and self.handle is not None and self.handle.stop_error:
            raise ROSError("previous stop failed; unload and load before writing again", "stop_failed", {"error": self.handle.stop_error})
        return super().execute(action, args)

    def _configure(self, directory):
        self.config, self.expected, self.identity = configuration(directory)
        self.directory = Path(directory).resolve()
        self._period_s = positive(self.config.get("period_s", .02), "driver.period_s")
        self.stale_s = self._period_s * positive(self.config.get("stale_periods", 5), "driver.stale_periods")
        self.connect_timeout = positive(self.config.get("connect_timeout_s", 2), "driver.connect_timeout_s")
        confirm = self.config.get("stop", {}).get("confirm")
        if self.profile["type"] in ("joint", "velocity") and confirm is None:
            raise ROSError("actuator adapters require stop.confirm with timeout_s and max_speed", "invalid_ros_profile")
        if confirm is not None:
            positive(confirm.get("timeout_s"), "stop.confirm.timeout_s")
            maximum = confirm.get("max_speed")
            if isinstance(maximum, bool) or not isinstance(maximum, (int, float)) or not math.isfinite(maximum) or maximum < 0:
                raise ROSError("stop.confirm.max_speed must be finite and nonnegative", "invalid_ros_profile")
        self.connection_spec = self.profile["access"]["connection"]
        if self.connection_spec.get("kind") != "ros":
            raise ROSError("ROS adapter requires access.connection.kind: ros", "invalid_ros_profile")
        for name in ("state_topic", "command_topic", "color_topic", "depth_topic"):
            if name in self.config and self.connection_spec.get(name) != self.config[name]:
                raise ROSError(f"profile {name} differs from profile_ros.yaml; update the profile and ROS configuration", "identity_mismatch")
        self.state_topic = self.config.get("state_topic")
        self.timestamp_source = self.config.get("timestamp_source", "header")

    @property
    def period_s(self):
        return self._period_s

    def _open(self, prepare, expected=None):
        clock = self.config.get("clock", {})
        session = Session("kinex_" + re.sub(r"[^A-Za-z0-9_]", "_", self.profile["name"]),
                          self.config.get("domain_id", 0), self.config.get("namespace", ""), clock.get("max_skew_s", .5))
        handle = Connection(session)
        try:
            session.open()
            prepare(handle)
            specification = copy.deepcopy(self.expected if expected is None else expected)
            specification["domain"] = True
            if self.state_topic:
                specification["state_topic"] = self.state_topic
                specification.setdefault("identity", {}).setdefault("single_publisher", self.state_topic)
            # Rate measurements require a separate, longer observation window.
            # Loading only waits for a fresh sample and checks the interface.
            for topic in specification.get("topics", []):
                topic.pop("min_hz", None)
            result = session.expect(specification, self.config, min(.1, self.connect_timeout), self.identity)
            if not result.ok:
                raise ROSError("; ".join(result.diff_lines), "interface_mismatch", {"checks": result.checks})
            for rule in self.config.get("faults", []):
                if rule.get("skip_when") and self.config.get(rule["skip_when"]):
                    continue
                if not all(name in rule for name in ("topic", "field", "equals", "code")):
                    raise ROSError("fault rules require topic, field, equals and code", "invalid_ros_profile")
                if not all(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name) for name in rule["field"].split(".")):
                    raise ROSError("invalid fault field path", "invalid_ros_profile")
                positive(rule.get("stale_s", self.stale_s), "fault.stale_s")
                positive(rule.get("for_s", self.stale_s), "fault.for_s")
                types = [rule["type"]] if rule.get("type") else session.topic_types().get(session.node.resolve_topic_name(rule["topic"]), [])
                cache = session.latest(rule["topic"], session.resolve_type(rule["topic"], types))
                cache.wait(self.connect_timeout)
                fault = FaultRule(rule, cache)
                cache.observe(fault.observe)
                handle.rules.append(fault)
            self._monitor(handle)
            return handle
        except Exception as error:
            try:
                handle.close()
            except Exception as cleanup:
                raise ROSError(remediation(f"{error}; cleanup failed: {cleanup}"), "cleanup_failed") from error
            raise ROSError(remediation(str(error)), getattr(error, "code", "ros2_unavailable"), getattr(error, "details", None)) from error

    def _monitor(self, handle):
        controller = self.config.get("controller")
        if not controller:
            return
        manager = self.config.get("controller_manager", "/controller_manager")
        def poll():
            while not handle.monitor_stop.is_set():
                try:
                    states = handle.session.controllers(manager, timeout_s=.2)
                    code = "" if states.get(controller) == "active" else "controller_inactive"
                except ROSError:
                    code = "controller_unavailable"
                previous, since = handle.controller_fault
                handle.controller_fault = (code, since if previous else time.monotonic()) if code else ("", 0.)
                handle.monitor_stop.wait(.2)
        handle.monitor = threading.Thread(target=poll, daemon=True, name="kinex-controller-status")
        handle.monitor.start()

    def _faults(self, handle):
        handle.session.check()
        faults = []
        if handle.stop_error:
            faults.append({"code": "stop_failed"})
        if handle.latest is not None and handle.latest.age_s() > self.stale_s:
            faults.append({"code": "joint_states_stale" if self.profile["type"] == "joint" else "feedback_stale"})
        now = time.monotonic()
        code, since = handle.controller_fault
        if code and now - since >= .4:
            faults.append({"code": code})
        for fault in handle.rules:
            rule, cache = fault.config, fault.latest
            with cache.condition:
                since = fault.since
                stale_since = cache.received_mono + rule.get("stale_s", self.stale_s)
                if now >= stale_since:
                    since = stale_since if since is None else min(since, stale_since)
                if since is not None and now - since >= rule.get("for_s", self.stale_s):
                    faults.append({"code": rule["code"]})
        return faults + self.vendor_faults(handle)

    def vendor_faults(self, handle):
        """Vendor subclasses return sustained conditions as [{code: str}]."""
        return []

    def _active(self, handle):
        faults = self._faults(handle)
        if faults:
            raise ROSError(f"ROS device has faults: {faults}", "device_fault", {"faults": faults})

    def disconnect(self, handle):
        handle.close()

    def _confirm(self, handle, speeds):
        stop = self.config.get("stop", {})
        confirm = stop.get("confirm")
        if confirm is None:
            return None
        return StopConfirm(handle.latest, speeds, confirm["max_speed"], confirm["timeout_s"])

    def _wait_confirm(self, handle, confirmation):
        if confirmation is not None:
            # Require feedback acquired after the stop commands completed.
            with handle.latest.condition:
                confirmation.after = handle.latest.count
            confirmation.wait()


class JointTrajectoryDriver(ROSDevice, JointDriver):
    def __init__(self, directory):
        JointDriver.__init__(self, Path(directory).resolve())
        self._configure(directory)
        self.joints = self.model().joints
        self.names = [joint["name"] for joint in self.joints]
        self.horizon = positive(self.config.get("time_from_start_s", self.period_s * 2), "driver.time_from_start_s")
        if self.config.get("stop", {}).get("method") != "measured_position_and_cancel":
            raise ROSError("joint adapter requires measured_position_and_cancel stop mapping", "invalid_ros_profile")
        if self.profile["intrinsics"]["control"].get("mode") != "position":
            raise ROSError("joint trajectory adapter requires position control", "invalid_ros_profile")

    def connect(self):
        def prepare(handle):
            session = handle.session
            session.wait_topics([self.state_topic, self.config["command_topic"]], self.connect_timeout)
            session.resolve_type(self.state_topic, ["sensor_msgs/msg/JointState"])
            session.resolve_type(self.config["command_topic"], ["trajectory_msgs/msg/JointTrajectory"])
            handle.latest = session.latest(self.state_topic, "sensor_msgs/msg/JointState", stamp_source=self.timestamp_source)
            joint_state_vector(handle.latest.wait(self.connect_timeout), self.names)
            handle.publisher = session.publisher(self.config["command_topic"], "trajectory_msgs/msg/JointTrajectory")
            handle.publisher.wait_subscribers(self.connect_timeout)
            if self.config.get("action"):
                handle.action = session.action(self.config["action"])
                if not handle.action.client.wait_for_server(timeout_sec=self.connect_timeout):
                    raise ROSError("trajectory action server is unavailable", "action_unavailable")
        expected = {**self.expected, "joints": self.names}
        return self._open(prepare, expected)

    def read_state(self, handle):
        message, stamp = handle.latest.snapshot()
        result = joint_state_vector(message, self.names)
        for key in ("velocities", "efforts"):
            if not self.profile["intrinsics"]["feedback"][key]:
                result[key] = []
        return {**result, "timestamp": stamp, "faults": self._faults(handle)}

    def set_target(self, handle, target):
        self._active(handle)
        state = joint_state_vector(handle.latest.get(self.stale_s), self.names)
        message = jtc_point(self.names, target, self.horizon)
        for joint, previous, value in zip(self.joints, state["positions"], target):
            delta = value - previous
            if joint["type"] == "continuous":
                delta = math.atan2(math.sin(delta), math.cos(delta))
            maximum = joint.get("max_velocity")
            if maximum is not None and abs(delta) / self.horizon > maximum + 1e-9:
                raise ROSError(f"{joint['name']} reference exceeds its velocity limit", "velocity_limit", {"joint": joint["name"], "implied_velocity": abs(delta) / self.horizon, "max_velocity": maximum})
        handle.publisher.publish(message)

    def halt(self, handle):
        confirmation = self._confirm(handle, lambda msg: joint_state_vector(msg, self.names)["velocities"] or [])
        def hold():
            state = joint_state_vector(handle.latest.get(self.stale_s), self.names)
            handle.publisher.publish(jtc_hold(self.names, state["positions"]))
        try:
            release(hold,
                    lambda: handle.action.cancel_all(timeout_s=.5) if handle.action else None,
                    lambda: self._wait_confirm(handle, confirmation))
        except Exception as error:
            handle.stop_error = str(error)
            error.code = "stop_failed"
            raise


def velocity_vector(message):
    value = message.twist.twist
    return {axis: float(getattr(vector, component)) for prefix, vector in (("v", value.linear), ("w", value.angular))
            for axis, component in ((prefix + "x", "x"), (prefix + "y", "y"), (prefix + "z", "z"))}


class TwistDriver(ROSDevice, VelocityDriver):
    def __init__(self, directory):
        VelocityDriver.__init__(self, Path(directory).resolve())
        self._configure(directory)
        if self.config.get("stop", {}).get("method") != "zero_twist_repeat":
            raise ROSError("velocity adapter requires zero_twist_repeat stop mapping", "invalid_ros_profile")
        modes = self.profile["intrinsics"]["control"]["modes"]
        if len(modes) != 1:
            raise ROSError("generic Twist adapter requires one mode; vendor mode switching needs a specialized driver", "unsupported_control")
        for mode in modes.values():
            if mode.get("posture") is not None:
                raise ROSError("generic Twist adapter cannot command posture", "unsupported_control")
            if mode.get("velocity") is None or mode["velocity"]["frame"] != "body":
                raise ROSError("Twist commands require body-frame velocity", "unsupported_control")
            for component in mode["velocity"]["components"]:
                if component["units"] != ("m/s" if component["axis"].startswith("v") else "rad/s"):
                    raise ROSError("Twist commands require SI velocity units", "unsupported_control")

    def connect(self):
        def prepare(handle):
            session = handle.session
            session.wait_topics([self.state_topic, self.config["command_topic"]], self.connect_timeout)
            session.resolve_type(self.state_topic, ["nav_msgs/msg/Odometry"])
            candidates = [self.config["cmd_vel_type"]] if self.config.get("cmd_vel_type") else ["geometry_msgs/msg/Twist", "geometry_msgs/msg/TwistStamped"]
            handle.command_type = session.resolve_type(self.config["command_topic"], candidates)
            handle.latest = session.latest(self.state_topic, "nav_msgs/msg/Odometry", stamp_source=self.timestamp_source)
            handle.latest.wait(self.connect_timeout)
            handle.publisher = session.publisher(self.config["command_topic"], handle.command_type)
            handle.publisher.wait_subscribers(self.connect_timeout)
        return self._open(prepare)

    def read_state(self, handle):
        message, stamp = handle.latest.snapshot()
        if self.config.get("feedback_frame") and message.child_frame_id != self.config["feedback_frame"]:
            raise ROSError("odometry child frame differs from the declared feedback frame", "frame_mismatch")
        values = velocity_vector(message)
        axes = self.profile["intrinsics"]["feedback"]["velocity_components"]
        return {"velocities": [values[axis] for axis in axes], "faults": self._faults(handle), "timestamp": stamp}

    def set_target(self, handle, value):
        self._active(handle)
        values = value["velocity"]
        message = twist([values.get(axis, 0.) for axis in ("vx", "vy", "vz")],
                        [values.get(axis, 0.) for axis in ("wx", "wy", "wz")], handle.command_type)
        if hasattr(message, "header"):
            message.header.frame_id = self.config.get("command_frame", "")
        handle.publisher.publish(message)

    def halt(self, handle, target):
        confirmation = self._confirm(handle, lambda msg: list(velocity_vector(msg).values()))
        stop = self.config["stop"]
        count = stop.get("count", 5)
        if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
            raise ROSError("stop.count must be a positive integer", "invalid_ros_profile")
        try:
            for index in range(count):
                message = zero_twist(handle.command_type)
                if hasattr(message, "header"):
                    message.header.frame_id = self.config.get("command_frame", "")
                handle.publisher.publish(message)
                if index + 1 < count:
                    time.sleep(self.period_s)
            self._wait_confirm(handle, confirmation)
        except Exception as error:
            handle.stop_error = str(error)
            error.code = "stop_failed"
            raise


class SensorSource(ROSDevice):
    def __init__(self, directory):
        self.profile = settings(Path(directory).resolve())
        self._configure(directory)
        self.handle = None

    def connection(self):
        if self.handle is None:
            self.handle = self.connect()
        return self.handle

    def close(self):
        handle, self.handle = self.handle, None
        if handle is not None:
            self.disconnect(handle)

    def execute(self, action, args):
        if args:
            raise ValueError(f"{action} accepts no arguments")
        if action == "load":
            self.connection()
            return {"loaded": True}
        if action == "unload":
            self.close()
            return {"unloaded": True}
        if action == "status":
            return {"connected": self.handle is not None}
        if action == "read":
            return self.read_sample(self.connection())
        raise ValueError(f"unsupported sensor action {action}")

    def dispatch(self, action, args):
        try:
            return {"ok": True, **self.execute(action, args)}
        except Exception as error:
            return {"ok": False, "error": f"{type(error).__name__}: {error}", "code": getattr(error, "code", None), "details": getattr(error, "details", None)}

    def main(self):
        run(self.dispatch, self.close)


class ImuSource(SensorSource):
    def connect(self):
        def prepare(handle):
            handle.session.wait_topics([self.state_topic], self.connect_timeout)
            handle.session.resolve_type(self.state_topic, ["sensor_msgs/msg/Imu"])
            handle.latest = handle.session.latest(self.state_topic, "sensor_msgs/msg/Imu", stamp_source=self.timestamp_source)
            handle.latest.wait(self.connect_timeout)
        return self._open(prepare)

    def read_sample(self, handle):
        message, stamp = handle.latest.snapshot(self.stale_s)
        measurement = self.profile["intrinsics"]["measurement"]
        result = {"timestamp": stamp, "magnetic_field": None}
        if measurement.get("magnetic_field") is not None:
            raise ROSError("sensor_msgs/Imu does not contain a magnetic field", "unsupported_channel")
        for name in ("angular_velocity", "linear_acceleration", "orientation"):
            declared = measurement[name]
            if declared is None:
                result[name] = None
                continue
            covariance = getattr(message, name + "_covariance")
            if len(covariance) and covariance[0] == -1:
                raise ROSError(f"IMU reports {name} as unavailable", "missing_measurement")
            value = getattr(message, name)
            if name == "orientation":
                result[name] = [value.x, value.y, value.z, value.w]
            else:
                if name == "linear_acceleration" and self.config.get("acceleration_quantity") != declared["quantity"]:
                    raise ROSError("declare the ROS driver's acceleration_quantity to match the profile", "measurement_mismatch")
                result[name] = {axis: getattr(value, axis) for axis in declared["axes"]}
        return result


def image_array(message, depth=False):
    """Decode owned arrays, respecting Image row padding and byte order."""
    import numpy as np
    if hasattr(message, "format"):
        if depth:
            raise ROSError("compressed depth is unsupported; use a 16UC1 Image topic", "unsupported_encoding")
        import io
        from PIL import Image
        with Image.open(io.BytesIO(bytes(message.data))) as image:
            return np.array(image.convert("RGB"), dtype=np.uint8, copy=True)
    allowed = ("16UC1", "mono16") if depth else ("rgb8", "bgr8")
    if message.encoding not in allowed or message.height <= 0 or message.width <= 0:
        raise ROSError(f"unsupported image encoding or dimensions: {message.encoding}", "unsupported_encoding")
    item = 2 if depth else 3
    if message.step < message.width * item or len(message.data) != message.height * message.step:
        raise ROSError("image data length/stride differs from geometry", "invalid_image")
    if depth:
        dtype = np.dtype(">u2" if message.is_bigendian else "<u2")
        return np.ndarray((message.height, message.width), dtype=dtype, buffer=bytes(message.data), strides=(message.step, 2)).astype(np.uint16, copy=True)
    array = np.ndarray((message.height, message.width, 3), dtype=np.uint8, buffer=bytes(message.data), strides=(message.step, 3, 1))
    return array[:, :, ::-1].copy() if message.encoding == "bgr8" else array.copy()


class CameraSource(SensorSource):
    def __init__(self, directory):
        super().__init__(directory)
        self.recorder = None
        self.sample_lock = threading.RLock()

    def open_stream(self):
        def prepare(handle):
            topics = [self.config["color_topic"]]
            if self.profile["type"] == "rgbd":
                topics.append(self.config["depth_topic"])
            handle.session.wait_topics(topics, self.connect_timeout)
            for channel, topic in zip(("color", "depth"), topics):
                candidates = ["sensor_msgs/msg/Image"] if channel == "depth" else ["sensor_msgs/msg/Image", "sensor_msgs/msg/CompressedImage"]
                selected = handle.session.resolve_type(topic, candidates)
                latest = handle.session.latest(topic, selected, stamp_source=self.timestamp_source)
                latest.wait(self.connect_timeout)
                handle.streams[channel] = latest
            if self.config.get("camera_info_topic"):
                handle.streams["info"] = handle.session.latest(self.config["camera_info_topic"], "sensor_msgs/msg/CameraInfo")
            if self.config.get("depth_camera_info_topic"):
                handle.streams["depth_info"] = handle.session.latest(self.config["depth_camera_info_topic"], "sensor_msgs/msg/CameraInfo")
        return self._open(prepare)

    def connect(self):
        return self.open_stream()

    def close_stream(self, handle):
        handle.close()

    def disconnect(self, handle):
        self.close_stream(handle)

    def grab(self, handle):
        with self.sample_lock:
            color, stamp = handle.streams["color"].snapshot(self.stale_s)
            result = {"color": image_array(color), "timestamp": stamp}
            if "depth" in handle.streams:
                depth, depth_stamp = handle.streams["depth"].snapshot(self.stale_s)
                if abs(stamp - depth_stamp) > positive(self.config.get("sync_tolerance_s", .05), "sync_tolerance_s"):
                    raise ROSError("color and depth samples are not synchronized", "unsynchronized_images")
                array = image_array(depth, depth=True)
                meta = self.profile["intrinsics"]["depth"]
                if meta["registration"] == "color" and (depth.header.frame_id != color.header.frame_id or array.shape != result["color"].shape[:2]):
                    raise ROSError("registered depth must match the color frame and dimensions", "frame_mismatch")
                metres = array.astype(float) * meta["scale_m_per_unit"]
                limits = meta["valid_range_m"]
                array[(array == 0) | (metres < limits["min"]) | (metres > limits["max"])] = meta["invalid_value"]
                result.update(depth=array, timestamp=max(stamp, depth_stamp))
            from kinex.capture import validate
            return validate(self.profile, result)

    def introspect(self, args=None):
        if args:
            raise ValueError("introspect accepts no arguments")
        color_space = self.config.get("color_image_space")
        if color_space is None:
            raise ROSError("camera introspection requires color_image_space: raw or rectified", "missing_image_space")
        handle = self.connection()
        cache = handle.streams.get("info")
        if cache is None:
            raise ROSError("camera_info_topic is required for introspection", "missing_camera_info")
        info = cache.wait(self.connect_timeout)
        color, _ = handle.streams["color"].snapshot(self.stale_s)
        if color.header.frame_id != info.header.frame_id:
            raise ROSError("CameraInfo and image frames differ", "frame_mismatch")
        patch = camera_info_patch(info, color_space)
        pixels = image_array(color)
        if (patch["height"], patch["width"]) != pixels.shape[:2]:
            raise ROSError("CameraInfo geometry differs from the active image", "invalid_camera_info")
        patch.update(pixel_format="rgb8", image_format="png", fps=None)
        intrinsics = {"source": "introspected", "method": "introspection",
                      "calibrated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "color": patch}
        if "depth" in handle.streams:
            depth, _ = handle.streams["depth"].snapshot(self.stale_s)
            pixels = image_array(depth, depth=True)
            meta = {"height": pixels.shape[0], "width": pixels.shape[1], "fps": None,
                    "pixel_format": "uint16", "image_format": "pgm16_be"}
            if self.profile["intrinsics"]["depth"]["registration"] == "color":
                if depth.header.frame_id != color.header.frame_id or pixels.shape != (patch["height"], patch["width"]):
                    raise ROSError("registered depth must match the color frame and dimensions", "frame_mismatch")
            elif "depth_info" in handle.streams:
                info = handle.streams["depth_info"].wait(self.connect_timeout)
                if info.header.frame_id != depth.header.frame_id or (info.height, info.width) != pixels.shape:
                    raise ROSError("depth CameraInfo differs from the active depth image", "invalid_camera_info")
                depth_space = self.config.get("depth_image_space")
                if depth_space is None:
                    raise ROSError("native depth introspection requires depth_image_space: raw or rectified", "missing_image_space")
                geometry = camera_info_patch(info, depth_space)
                meta.update(projection=geometry["projection"], distortion=geometry["distortion"])
            # Scale, quantity, registration and valid range are vendor facts;
            # sensor_msgs/Image and CameraInfo cannot establish them.
            intrinsics["depth"] = meta
        return {"intrinsics": intrinsics}

    def close(self):
        def disconnect():
            if self.recorder is not None and self.recorder.running:
                raise ROSError("capture still uses the ROS stream", "cleanup_failed")
            super(CameraSource, self).close()
        release(self.record_stop, disconnect)

    def record_stop(self):
        if self.recorder is None:
            return {"file": None, "frames": 0}
        recorder = self.recorder
        result = recorder.stop()
        self.recorder = None
        if self.profile["type"] == "rgbd":
            result["depth_scale"] = self.profile["intrinsics"]["depth"]["scale_m_per_unit"]
        return result

    def execute(self, action, args):
        if action == "read":
            if set(args) - {"output"}:
                raise ValueError("camera read accepts only output")
            from kinex.capture import save
            # Reuse the ROS caches, applying freshness and sync checks even during recording.
            sample = self.grab(self.connection())
            return save(self.profile, sample, self.directory / "out", args.get("output", "array"))
        if action == "introspect":
            return self.introspect(args)
        if action == "record_start":
            from kinex.stream import VideoRecorder
            self.record_stop()
            handle = self.connection()
            self.recorder = VideoRecorder(lambda: self.grab(handle), args["dir"], rate_hz=args.get("rate_hz") or 15,
                                          fps=args.get("fps") or 15, max_px=args.get("max_px"), image=lambda frame: frame["color"],
                                          depth=(lambda frame: frame["depth"]) if self.profile["type"] == "rgbd" else None)
            self.recorder.start()
            return self.recorder.facts()
        if action == "record_stop":
            return self.record_stop()
        if action == "status":
            return {"streaming": self.handle is not None, "recording": self.recorder.facts() if self.recorder else None}
        return super().execute(action, args)


def ros_driver(directory):
    """Choose the adapter declared in the device's profile_ros.yaml."""
    config = load(directory)
    adapters = {"JointTrajectoryDriver": JointTrajectoryDriver, "TwistDriver": TwistDriver,
                "ImuSource": ImuSource, "CameraSource": CameraSource}
    name = config.get("adapter")
    if name not in adapters:
        raise ROSError(f"unknown ROS adapter {name!r}", "invalid_ros_profile")
    return adapters[name](directory)
