"""ROS 2 transport helpers. Importing this module does not import or start ROS.

Each Session owns its context, node and executor, never the external ROS stack.
ROS imports stay at the boundary so the helpers also load on non-ROS hosts.
"""

from collections import deque
from dataclasses import dataclass
import hashlib
import math
import os
import threading
import time

from kinex.driver_protocol import release


class BundleError(RuntimeError):
    def __init__(self, message, code="ros2_error", details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class StopNotConfirmed(BundleError):
    def __init__(self, message="stop was not confirmed by fresh velocity feedback"):
        super().__init__(message, "stop_failed")


def stamp_seconds(sec, nanosec, received_s, max_skew_s, last_s=None):
    stamp = float(sec) + float(nanosec) / 1e9
    if not math.isfinite(stamp) or stamp <= 0 or abs(stamp - received_s) > max_skew_s:
        stamp = received_s
    return max(stamp, last_s) if last_s is not None else stamp


def message_class(type_name):
    from rosidl_runtime_py.utilities import get_message
    return get_message(type_name)


def _type(value):
    return message_class(value) if isinstance(value, str) else value


def _finite(values, name):
    result = list(values)
    if not result or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in result):
        raise BundleError(f"{name} requires finite numeric values", "invalid_feedback")
    return result


def _future(future, timeout_s):
    ready = threading.Event()
    future.add_done_callback(lambda _: ready.set())
    if not ready.wait(max(0, timeout_s)):
        raise BundleError("ROS request timed out; its remote outcome is unknown", "ros_timeout")
    return future.result()


def _bounded(action, timeout_s):
    errors = []
    def run():
        try:
            action()
        except Exception as error:
            errors.append(error)
    worker = threading.Thread(target=run, daemon=True, name="kinex-ros-cleanup")
    worker.start()
    worker.join(max(0, timeout_s))
    if worker.is_alive():
        raise BundleError("ROS cleanup timed out; process teardown is required", "cleanup_timeout")
    if errors:
        raise errors[0]


class Latest:
    def __init__(self, topic, max_skew_s=.5, stamp_source="header"):
        if stamp_source not in ("header", "receipt"):
            raise ValueError("stamp_source must be header or receipt")
        self.topic, self.max_skew_s, self.stamp_source = topic, max_skew_s, stamp_source
        self.message = self.stamp_s = self.received_s = None
        self.count = self.regressions = 0
        self.condition = threading.Condition()
        self.arrivals = deque(maxlen=100000)
        self.received_mono = None
        self.observers = []

    def update(self, message):
        received, monotonic = time.time(), time.monotonic()
        header = getattr(getattr(message, "header", None), "stamp", None)
        with self.condition:
            sec = header.sec if header is not None and self.stamp_source == "header" else 0
            nano = header.nanosec if header is not None and self.stamp_source == "header" else 0
            candidate = stamp_seconds(sec, nano, received, self.max_skew_s)
            if self.stamp_s is not None and candidate < self.stamp_s:
                self.regressions += 1
            self.stamp_s = max(candidate, self.stamp_s) if self.stamp_s is not None else candidate
            self.message, self.received_s, self.received_mono = message, received, monotonic
            self.count += 1
            self.arrivals.append(monotonic)
            for observe in self.observers:
                observe(message, monotonic)
            self.condition.notify_all()

    def observe(self, callback):
        """Observe every sample, including the cached sample, under the cache lock."""
        with self.condition:
            if self.message is not None:
                callback(self.message, self.received_mono)
            self.observers.append(callback)

    def get(self, max_age_s=None):
        return self.snapshot(max_age_s)[0]

    def snapshot(self, max_age_s=None):
        """Keep a message and its acquisition timestamp from the same callback."""
        with self.condition:
            if self.message is None or (max_age_s is not None and time.monotonic() - self.received_mono > max_age_s):
                raise BundleError(f"no fresh feedback on {self.topic}", "stale_feedback")
            return self.message, self.stamp_s

    def age_s(self):
        with self.condition:
            return math.inf if self.received_mono is None else time.monotonic() - self.received_mono

    def wait(self, timeout_s, after=None):
        with self.condition:
            if not self.condition.wait_for(lambda: self.message is not None and (after is None or self.count > after), max(0, timeout_s)):
                raise BundleError(f"timed out waiting for {self.topic}", "stale_feedback")
            return self.message

    def rate_hz(self, window_s):
        if window_s <= 0:
            raise ValueError("rate window must be positive")
        with self.condition:
            cutoff = time.monotonic() - window_s
            return sum(stamp >= cutoff for stamp in self.arrivals) / window_s


class StopConfirm:
    def __init__(self, latest, speeds, max_speed, timeout_s):
        if not math.isfinite(max_speed) or max_speed < 0 or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("stop threshold must be nonnegative and timeout positive")
        self.latest, self.speeds = latest, speeds
        self.max_speed, self.timeout_s = max_speed, timeout_s
        self.after = latest.count

    def wait(self):
        deadline = time.monotonic() + self.timeout_s
        after = self.after
        while time.monotonic() < deadline:
            try:
                with self.latest.condition:
                    message = self.latest.wait(deadline - time.monotonic(), after)
                    after = self.latest.count
                    values = _finite(self.speeds(message), "stop velocities")
                if max(abs(value) for value in values) <= self.max_speed:
                    return
            except BundleError as error:
                raise StopNotConfirmed(str(error)) from error
        raise StopNotConfirmed()


class Publisher:
    def __init__(self, session, topic, publisher):
        self.session, self.topic, self.publisher = session, topic, publisher

    def subscriber_count(self):
        return self.publisher.get_subscription_count()

    def wait_subscribers(self, timeout_s):
        deadline = time.monotonic() + timeout_s
        while not self.subscriber_count():
            self.session.check()
            if time.monotonic() >= deadline:
                raise BundleError(f"no subscribers on {self.topic}", "no_subscribers")
            time.sleep(.01)

    def publish(self, message):
        self.session.check()
        if self.subscriber_count() < 1:
            raise BundleError(f"no subscribers on {self.topic}", "no_subscribers")
        self.publisher.publish(message)

    def publish_repeat(self, message, n=5, period_s=.02):
        if n < 1 or period_s < 0:
            raise ValueError("repeat count must be positive and period nonnegative")
        for index in range(n):
            self.publish(message)
            if index + 1 < n:
                time.sleep(period_s)


class Service:
    def __init__(self, session, name, service_type):
        from rosidl_runtime_py.utilities import get_service
        self.type = get_service(service_type) if isinstance(service_type, str) else service_type
        self.client = session.node.create_client(self.type, name)

    def call(self, request=None, timeout_s=1):
        deadline = time.monotonic() + timeout_s
        if not self.client.wait_for_service(timeout_sec=max(0, timeout_s)):
            raise BundleError("ROS service is unavailable", "service_unavailable")
        return _future(self.client.call_async(request or self.type.Request()), deadline - time.monotonic())


class Action:
    def __init__(self, session, name, action_type):
        from rclpy.action import ActionClient
        from rosidl_runtime_py.utilities import get_action
        self.type = get_action(action_type) if isinstance(action_type, str) else action_type
        self.client = ActionClient(session.node, self.type, name)
        self.handles, self.pending, self.lock = [], [], threading.Lock()

    def _accepted(self, future):
        try:
            handle = future.result()
        except Exception:
            # send() reports the transport error; cancellation still tracks the
            # future until its outcome is available.
            return
        with self.lock:
            if future in self.pending:
                self.pending.remove(future)
            if handle.accepted:
                self.handles.append(handle)
        if handle.accepted:
            def finished(_):
                with self.lock:
                    if handle in self.handles:
                        self.handles.remove(handle)
            handle.get_result_async().add_done_callback(finished)

    def send(self, goal, timeout_s=1):
        deadline = time.monotonic() + timeout_s
        if not self.client.wait_for_server(timeout_sec=timeout_s):
            raise BundleError("ROS action server is unavailable", "action_unavailable")
        future = self.client.send_goal_async(goal)
        with self.lock:
            self.pending.append(future)
        future.add_done_callback(self._accepted)
        handle = _future(future, deadline - time.monotonic())
        if not handle.accepted:
            raise BundleError("ROS action goal was rejected", "goal_rejected")
        return handle

    def cancel_all(self, timeout_s=1):
        # Only cancel goals submitted by this client, never another operator's.
        deadline = time.monotonic() + timeout_s
        with self.lock:
            pending = list(self.pending)
            handles = list(self.handles)
        for future in pending:
            handle = _future(future, deadline - time.monotonic())
            if handle.accepted and handle not in handles:
                handles.append(handle)
        for handle in handles:
            response = _future(handle.cancel_goal_async(), deadline - time.monotonic())
            if response.return_code not in (0, 3):  # accepted or already terminated
                raise BundleError("ROS action cancellation was rejected", "stop_failed")
            with self.lock:
                if handle in self.handles:
                    self.handles.remove(handle)


@dataclass
class ExpectResult:
    ok: bool
    checks: list
    diff_lines: list


class Session:
    def __init__(self, node_name="kinex", domain_id=0, namespace="", max_skew_s=.5):
        if isinstance(domain_id, bool) or not isinstance(domain_id, int) or not 0 <= domain_id <= 232:
            raise ValueError("ROS domain_id must be an integer in 0..232")
        self.node_name, self.domain_id = node_name, domain_id
        self.namespace, self.max_skew_s = namespace, max_skew_s
        self.node = self.context = self.executor = self.thread = None
        self.closing, self.failure = False, None
        self.caches, self.services, self.actions = {}, {}, {}
        self._tf = None

    def open(self):
        if self.node is not None:
            return self
        if int(os.environ.get("ROS_DOMAIN_ID", "0")) != self.domain_id:
            raise BundleError("ROS_DOMAIN_ID does not match the bundle facts", "domain_mismatch")
        import rclpy
        from rclpy.context import Context
        from rclpy.executors import MultiThreadedExecutor
        from rclpy.signals import SignalHandlerOptions
        self.closing, self.failure = False, None
        self.context = Context()
        try:
            rclpy.init(args=[], context=self.context, domain_id=self.domain_id, signal_handler_options=SignalHandlerOptions.NO)
            self.node = rclpy.create_node(self.node_name, namespace=self.namespace, context=self.context)
            self.executor = MultiThreadedExecutor(num_threads=2, context=self.context)
            self.executor.add_node(self.node)
            self.thread = threading.Thread(target=self._spin, daemon=True, name="kinex-ros")
            self.thread.start()
        except Exception:
            self.close()
            raise
        return self

    def _spin(self):
        try:
            self.executor.spin()
        except Exception as error:
            if not self.closing:
                self.failure = error

    def check(self):
        if self.node is None or self.closing:
            raise BundleError("ROS session is closed", "session_closed")
        if self.failure is not None:
            raise BundleError(f"ROS executor failed: {self.failure}", "executor_failed")

    def close(self, timeout_s=3):
        if self.context is None:
            return
        import rclpy
        self.closing = True
        executor, node, context, thread = self.executor, self.node, self.context, self.thread
        actions = list(self.actions.values())
        self.executor = self.node = self.context = self.thread = None
        self.caches.clear()
        self.services.clear()
        self.actions.clear()
        self._tf = None
        deadline = time.monotonic() + max(0, timeout_s)
        def stage(action, remaining):
            _bounded(action, max(0, deadline - time.monotonic()) / remaining)
        # Executor cleanup may block beyond its timeout. Bound each
        # stage externally; the owning driver process handles unreleased threads.
        release(lambda: stage(lambda: executor.shutdown(timeout_sec=max(0, deadline - time.monotonic())), 5) if executor else None,
                lambda: stage(lambda: release(*(action.client.destroy for action in actions)), 4),
                lambda: stage(node.destroy_node, 3) if node else None,
                lambda: stage(lambda: rclpy.try_shutdown(context=context), 2),
                lambda: stage(lambda: thread.join(max(0, deadline - time.monotonic())), 1) if thread else None)

    def topic_types(self):
        self.check()
        return dict(self.node.get_topic_names_and_types())

    def publishers(self, topic):
        self.check()
        return self.node.get_publishers_info_by_topic(topic)

    def subscriber_count(self, topic):
        self.check()
        return self.node.count_subscribers(topic)

    def resolve_type(self, topic, candidates):
        types = self.topic_types().get(self.node.resolve_topic_name(topic), [])
        matches = [candidate for candidate in candidates if candidate in types]
        if len(matches) != 1:
            raise BundleError(f"{topic}: expected exactly one of {candidates}, found {types}", "topic_type_mismatch")
        return matches[0]

    def latest(self, topic, type_name, qos=None, stamp_source="header"):
        self.check()
        key = (topic, type_name, str(qos), stamp_source)
        if key not in self.caches:
            from rclpy.qos import qos_profile_sensor_data, QoSProfile, DurabilityPolicy
            if qos == "transient_local":
                qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
            latest = Latest(topic, self.max_skew_s, stamp_source)
            self.node.create_subscription(_type(type_name), topic, latest.update, qos if qos is not None else qos_profile_sensor_data)
            self.caches[key] = latest
        return self.caches[key]

    def publisher(self, topic, type_name, qos=10):
        self.check()
        return Publisher(self, topic, self.node.create_publisher(_type(type_name), topic, qos))

    def service(self, name, service_type):
        self.check()
        key = (name, service_type)
        if key not in self.services:
            self.services[key] = Service(self, name, service_type)
        return self.services[key]

    def action(self, name, action_type="control_msgs/action/FollowJointTrajectory"):
        self.check()
        key = (name, action_type)
        if key not in self.actions:
            self.actions[key] = Action(self, name, action_type)
        return self.actions[key]

    def param(self, node, name, timeout_s=1):
        service = self.service(node.rstrip("/") + "/get_parameters", "rcl_interfaces/srv/GetParameters")
        result = service.call(service.type.Request(names=[name]), timeout_s)
        if len(result.values) != 1:
            raise BundleError(f"parameter {name} is unavailable", "parameter_unavailable")
        value = result.values[0]
        fields = {1: "bool_value", 2: "integer_value", 3: "double_value", 4: "string_value"}
        if value.type not in fields:
            raise BundleError(f"parameter {name} is missing or not scalar", "parameter_unavailable")
        return getattr(value, fields[value.type])

    def robot_description(self, topic="/robot_description", timeout_s=1, parameter_node="/robot_state_publisher"):
        deadline = time.monotonic() + timeout_s
        try:
            return self.latest(topic, "std_msgs/msg/String", "transient_local").wait(timeout_s / 2).data
        except BundleError as error:
            if error.code != "stale_feedback":
                raise
            return self.param(parameter_node, "robot_description", max(0, deadline - time.monotonic()))

    def tf(self):
        if self._tf is None:
            from tf2_ros import Buffer, TransformListener
            buffer = Buffer()
            self._tf = (buffer, TransformListener(buffer, self.node, spin_thread=False))
        return self._tf[0]

    def controllers(self, manager="/controller_manager", timeout_s=1):
        result = self.service(manager.rstrip("/") + "/list_controllers", "controller_manager_msgs/srv/ListControllers").call(timeout_s=timeout_s)
        return {controller.name: controller.state for controller in result.controller}

    def switch_controllers(self, activate, deactivate=(), manager="/controller_manager", timeout_s=1):
        # Discovery/load must never mutate the external controller lifecycle.
        states = self.controllers(manager, timeout_s)
        return all(states.get(name) == "active" for name in activate) and all(states.get(name) != "active" for name in deactivate)

    def wait_topics(self, topics, timeout_s=1):
        deadline = time.monotonic() + timeout_s
        while True:
            graph = self.topic_types()
            missing = [topic for topic in topics if self.node.resolve_topic_name(topic) not in graph]
            if not missing:
                return
            if time.monotonic() >= deadline:
                raise BundleError(f"missing ROS topics: {', '.join(missing)}", "missing_topics", {"topics": missing})
            time.sleep(min(.02, max(0, deadline - time.monotonic())))

    def expect(self, expected, facts=None, duration_s=.1, identity=None):
        facts, identity = facts or {}, identity or {}
        checks, streams = [], {}
        frames = expected.get("frames", [])
        tf_buffer = self.tf() if frames else None
        def add(name, want, measured, reference, numeric=False, timestamps=None):
            entry = dict(name=name, expected=want, measured=measured, reference=reference)
            if numeric:
                entry.update(tolerance=0, units="Hz", timestamps=timestamps)
            entry["passed"] = measured == want
            checks.append(entry)
        graph = self.topic_types()
        for topic in expected.get("topics", []):
            if topic.get("skip_when") and facts.get(topic["skip_when"]):
                continue
            name, type_name = topic["name"], topic["type"]
            types = graph.get(self.node.resolve_topic_name(name), [])
            if not types and not topic.get("required", True):
                continue
            add("topic:" + name, True, type_name in types, "ROS graph topic types")
            if type_name in types and topic.get("min_hz") is not None:
                streams[name] = (self.latest(name, type_name), topic["min_hz"])
        start = time.time()
        begin = time.monotonic()
        if streams or frames:
            time.sleep(max(.001, duration_s))
        elapsed = max(time.monotonic() - begin, .001)
        end = max(time.time(), start + elapsed)
        for name, (latest, minimum) in streams.items():
            add("rate:" + name, 0, max(0, minimum - latest.rate_hz(elapsed)), "received samples / monotonic observation window", True, [start, end])
        controllers = expected.get("controllers", [])
        if controllers:
            states = self.controllers(expected.get("controller_manager", "/controller_manager"))
            for controller in controllers:
                if controller.get("required", True) or controller["name"] in states:
                    add("controller:" + controller["name"], controller.get("state", "active"), states.get(controller["name"]), "controller_manager/list_controllers")
        names = expected.get("joints", identity.get("joint_names"))
        if names:
            topic = expected.get("state_topic", facts.get("state_topic", "/joint_states"))
            try:
                actual = list(self.latest(topic, "sensor_msgs/msg/JointState").wait(max(.05, duration_s)).name)
            except BundleError:
                actual = []
            add("joints", sorted(names), sorted(actual), "joint state names vs declared model")
        publisher_topic = expected.get("identity", {}).get("single_publisher")
        if publisher_topic:
            publishers = self.publishers(publisher_topic)
            add("single_publisher:" + publisher_topic, True, len(publishers) == 1, "ROS graph publisher identities")
            if identity.get("publisher_node") and len(publishers) == 1:
                add("publisher_identity", identity["publisher_node"], publishers[0].node_namespace.rstrip("/") + "/" + publishers[0].node_name, "recorded publisher identity")
        description = expected.get("robot_description", {})
        digest = identity.get("robot_description_sha256")
        if description or digest:
            text = self.robot_description(topic=description.get("topic", "/robot_description"),
                                          parameter_node=description.get("parameter_node", "/robot_state_publisher"), timeout_s=max(.1, duration_s))
            actual_digest = hashlib.sha256(text.encode()).hexdigest()
            if digest:
                add("robot_description_sha256", digest, actual_digest, "recorded robot description")
            if description.get("sha256"):
                add("model_sha256", description["sha256"], actual_digest, "reference model.urdf")
            if description.get("expect_joints") is not None:
                from xml.etree import ElementTree
                actual = sum(joint.get("type") != "fixed" for joint in ElementTree.fromstring(text).findall("joint"))
                add("robot_description_joints", str(description["expect_joints"]), str(actual), "movable URDF joint count")
        if expected.get("domain"):
            add("domain", str(facts.get("domain_id", 0)), str(self.domain_id), "session context ROS domain")
            add("namespace", "/" + facts.get("namespace", "").strip("/"), self.node.get_namespace(), "session node namespace")
        if "domain_id" in identity:
            add("recorded_domain", str(identity["domain_id"]), str(self.domain_id), "recorded ROS domain")
        if "namespace" in identity:
            add("recorded_namespace", "/" + identity["namespace"].strip("/"), self.node.get_namespace(), "recorded ROS namespace")
        if names and identity.get("joint_names"):
            add("recorded_joints", sorted(identity["joint_names"]), sorted(names), "recorded joint names vs declared model")
        if frames:
            import yaml
            known = yaml.safe_load(tf_buffer.all_frames_as_yaml()) or {}
            known = set(known) | {entry.get("parent") for entry in known.values()}
            for frame in frames:
                add("frame:" + frame, True, frame in known, "observed TF graph")
        failures = [f"FAIL {item['name']}: expected {item['expected']!r} measured {item['measured']!r}" for item in checks if not item["passed"]]
        return ExpectResult(not failures, checks, failures[:20])


def joint_state_vector(message, names):
    actual = list(message.name)
    if len(set(actual)) != len(actual) or len(set(names)) != len(names) or set(actual) != set(names):
        raise BundleError("joint feedback names do not match the model", "joint_names_mismatch")
    order = [actual.index(name) for name in names]
    result = {}
    for source, target in (("position", "positions"), ("velocity", "velocities"), ("effort", "efforts")):
        values = list(getattr(message, source))
        if not values and source != "position":
            result[target] = None
            continue
        if len(values) != len(actual):
            raise BundleError(f"joint {source} length does not match names", "invalid_feedback")
        values = _finite(values, source)
        result[target] = [values[index] for index in order]
    return result


def jtc_point(names, positions, duration_s):
    positions = _finite(positions, "joint targets")
    if len(names) != len(positions) or not math.isfinite(duration_s) or duration_s < 0:
        raise ValueError("trajectory needs matching joints and a nonnegative duration")
    message = message_class("trajectory_msgs/msg/JointTrajectory")()
    message.joint_names = list(names)
    point = message_class("trajectory_msgs/msg/JointTrajectoryPoint")()
    point.positions = [float(value) for value in positions]
    nanoseconds = round(duration_s * 1e9)
    point.time_from_start.sec, point.time_from_start.nanosec = divmod(nanoseconds, 1000000000)
    message.points = [point]
    return message


def jtc_hold(names, positions):
    # ros2_control rejects empty trajectories. Replace the pending reference
    # with a zero-time measured-position hold and explicit zero derivatives.
    message = jtc_point(names, positions, 0)
    message.points[0].velocities = [0.] * len(names)
    message.points[0].accelerations = [0.] * len(names)
    return message


def twist(linear=(0., 0., 0.), angular=(0., 0., 0.), type_name="geometry_msgs/msg/Twist", stamp_s=None):
    linear, angular = _finite(linear, "linear velocity"), _finite(angular, "angular velocity")
    if len(linear) != 3 or len(angular) != 3:
        raise ValueError("twist vectors must have three components")
    message = message_class(type_name)()
    value = message.twist if type_name.endswith("/TwistStamped") else message
    for name, number in zip(("x", "y", "z"), linear):
        setattr(value.linear, name, float(number))
    for name, number in zip(("x", "y", "z"), angular):
        setattr(value.angular, name, float(number))
    if hasattr(message, "header"):
        message.header.stamp.sec, message.header.stamp.nanosec = divmod(round((time.time() if stamp_s is None else stamp_s) * 1e9), 1000000000)
    return message


def zero_twist(type_name="geometry_msgs/msg/Twist"):
    return twist(type_name=type_name)


def camera_info_patch(message, image_space):
    """Describe the selected image stream, not the raw camera calibration alone."""
    if image_space not in ("raw", "rectified"):
        raise BundleError("camera image_space must be raw or rectified", "invalid_bundle")
    if message.width <= 0 or message.height <= 0:
        raise BundleError("CameraInfo has invalid dimensions", "invalid_camera_info")
    matrix = list(message.p if image_space == "rectified" else message.k)
    width = 4 if image_space == "rectified" else 3
    if len(matrix) != 3 * width:
        raise BundleError("CameraInfo has an invalid camera matrix", "invalid_camera_info")
    _finite(matrix, "camera matrix")
    if matrix[0] <= 0 or matrix[width + 1] <= 0:
        raise BundleError("CameraInfo focal lengths must be positive", "invalid_camera_info")
    if matrix[width] != 0 or matrix[2 * width:] != ([0., 0., 1., 0.] if width == 4 else [0., 0., 1.]):
        raise BundleError("CameraInfo camera matrix must describe a pinhole projection", "invalid_camera_info")
    if image_space == "rectified":
        distortion = {"model": "none"}
    else:
        coefficients = list(message.d)
        if coefficients:
            _finite(coefficients, "distortion coefficients")
        if not coefficients or (message.distortion_model in ("", "plumb_bob") and not any(coefficients)):
            distortion = {"model": "none"}
        elif message.distortion_model == "plumb_bob" and len(coefficients) == 5:
            distortion = dict(zip(("k1", "k2", "p1", "p2", "k3"), coefficients))
            distortion["model"] = "opencv_brown_conrady"
        else:
            raise BundleError("raw CameraInfo distortion must use five-coefficient plumb_bob; declare rectified only for a rectified stream", "unsupported_distortion")
    return {"width": message.width, "height": message.height,
            "projection": {"model": "pinhole", "fx": matrix[0], "fy": matrix[width + 1],
                           "cx": matrix[2], "cy": matrix[width + 2], "skew": matrix[1]},
            "distortion": distortion}
