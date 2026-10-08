"""Scripted ROS graph with physical-time feedback and driver-loss models."""

from concurrent.futures import Future
import copy
import json
import math
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace

from fake_rclpy.interfaces import REGISTRY, from_dict
from fake_rclpy.messages import to_dict


def completed(value):
    future = Future()
    future.set_result(value)
    return future


class World:
    def __init__(self, specification=None):
        file = os.environ.get("KINEX_FAKE_RCLPY_SCENARIO")
        self.spec = copy.deepcopy(specification if specification is not None else json.loads(Path(file).read_text()) if file else {})
        self.topics = self.spec.setdefault("topics", {})
        self.start = self.updated = time.monotonic()
        self.command_at = None
        self.goal = None
        self.velocity = [0., 0., 0.]
        self.published = []
        self.lock = threading.RLock()

    def publish(self, topic, message):
        data = to_dict(message)
        with self.lock:
            self.published.append((topic, data))
            log = os.environ.get("KINEX_FAKE_RCLPY_LOG")
            if log:
                with open(log, "a", encoding="utf8") as output:
                    output.write(json.dumps({"topic": topic, "message": data}) + "\n")
            robot = self.spec.get("robot", {})
            if topic == robot.get("command_topic"):
                self.command_at = time.monotonic()
                if robot["kind"] == "jtc":
                    # Native JTC rejects an empty trajectory; it does not stop.
                    if not message.points:
                        return
                    self.goal = [message.points[-1].positions[list(message.joint_names).index(name)]
                                 for name in robot["names"]]
                else:
                    value = message.twist if hasattr(message, "twist") else message
                    self.velocity = [value.linear.x, value.linear.y, value.angular.z]

    def sample(self, topic):
        with self.lock:
            configuration = self.topics[topic]
            data = copy.deepcopy(configuration.get("message", {}))
            robot = self.spec.get("robot", {})
            now = time.monotonic()
            if topic == robot.get("state_topic"):
                dt, self.updated = now - self.updated, now
                if robot["kind"] == "jtc":
                    positions = robot.setdefault("positions", [0.] * len(robot["names"]))
                    previous = list(positions)
                    if self.goal is not None:
                        fraction = 1 - math.exp(-dt / robot.get("response_s", .03))
                        positions[:] = [p + (q - p) * fraction for p, q in zip(positions, self.goal)]
                    data.update(name=robot["names"], position=positions, velocity=[(p - old) / max(dt, 1e-6) for p, old in zip(positions, previous)], effort=[0.] * len(positions))
                else:
                    if self.command_at is not None and now - self.command_at > robot.get("command_timeout_s", .1):
                        self.velocity = [0., 0., 0.]
                    x, y, yaw = self.velocity
                    data["twist"] = {"twist": {"linear": {"x": x, "y": y}, "angular": {"z": yaw}}}
            cls = REGISTRY[configuration["type"]]
            message = from_dict(cls, data)
            if hasattr(message, "header"):
                stamp = time.time() + configuration.get("clock_offset_s", 0)
                message.header.stamp.sec, message.header.stamp.nanosec = divmod(round(stamp * 1e9), 1000000000)
            return message


class Context:
    def __init__(self):
        self.world = World()
        self.running = False
    def ok(self):
        return self.running


class Node:
    def __init__(self, name, namespace, context):
        self.name, self.namespace, self.context = name, "/" + namespace.strip("/"), context
        self.world, self.subscriptions, self.destroyed = context.world, [], False

    def resolve_topic_name(self, topic):
        return topic if topic.startswith("/") else self.namespace.rstrip("/") + "/" + topic

    def get_namespace(self):
        return self.namespace

    def get_topic_names_and_types(self):
        return [(name, [value["type"]]) for name, value in self.world.topics.items()]

    def get_publishers_info_by_topic(self, topic):
        config = self.world.topics.get(self.resolve_topic_name(topic), {})
        return [SimpleNamespace(node_name=config.get("publisher", "robot") + (str(i) if i else ""), node_namespace="/") for i in range(config.get("publishers", 1 if config else 0))]

    def count_subscribers(self, topic):
        return self.world.topics.get(self.resolve_topic_name(topic), {}).get("subscribers", 0)

    def create_subscription(self, cls, topic, callback, qos):
        entry = SimpleNamespace(topic=self.resolve_topic_name(topic), callback=callback, last=None, qos=qos)
        self.subscriptions.append(entry)
        return entry

    def create_publisher(self, cls, topic, qos):
        name = self.resolve_topic_name(topic)
        return SimpleNamespace(publish=lambda message: self.world.publish(name, message), get_subscription_count=lambda: self.count_subscribers(topic))

    def create_client(self, cls, name):
        def response(request):
            if name.endswith("/list_controllers"):
                return SimpleNamespace(controller=[SimpleNamespace(name=key, state=value) for key, value in self.world.spec.get("controllers", {}).items()])
            parameters = self.world.spec.get("parameters", {}).get(name.rsplit("/", 1)[0], {})
            def value(key):
                item = parameters.get(key)
                kind, field = {bool: (1, "bool_value"), int: (2, "integer_value"), float: (3, "double_value"), str: (4, "string_value")}.get(type(item), (0, "string_value"))
                return SimpleNamespace(type=kind, **{field: item})
            return SimpleNamespace(values=[value(key) for key in request.names])
        return SimpleNamespace(wait_for_service=lambda timeout_sec: name not in self.world.spec.get("missing_services", []), call_async=lambda request: completed(response(request)))

    def destroy_node(self):
        self.destroyed = True
        self.subscriptions.clear()


class MultiThreadedExecutor:
    def __init__(self, num_threads, context):
        self.context, self.nodes, self.stop = context, [], threading.Event()
    def add_node(self, node):
        self.nodes.append(node)
    def spin(self):
        while self.context.ok() and not self.stop.is_set():
            now = time.monotonic()
            for node in list(self.nodes):
                for subscription in list(node.subscriptions):
                    config = node.world.topics.get(subscription.topic)
                    if config is None:
                        continue
                    if config.get("stale_after_s") is not None and now - node.world.start >= config["stale_after_s"]:
                        continue
                    if config.get("latched") and subscription.last is not None:
                        continue
                    rate = config.get("rate_hz", 100)
                    if rate <= 0 and not config.get("latched"):
                        continue
                    if subscription.last is None or now - subscription.last >= 1 / max(rate, 1):
                        subscription.last = now
                        subscription.callback(node.world.sample(subscription.topic))
            self.stop.wait(.001)
    def shutdown(self, timeout_sec=None):
        self.stop.set()
        return True


class ActionClient:
    def __init__(self, node, cls, name):
        self.node, self.name = node, name
        self.destroyed = False
    def destroy(self):
        self.destroyed = True
    def wait_for_server(self, timeout_sec):
        return self.name not in self.node.world.spec.get("missing_actions", [])
    def send_goal_async(self, goal):
        result = Future()
        def cancel():
            self.node.world.goal = None
            self.node.world.published.append((self.name, {"cancel": True}))
            result.set_result(SimpleNamespace(status=5))
            return completed(SimpleNamespace(return_code=0))
        return completed(SimpleNamespace(accepted=True, cancel_goal_async=cancel, get_result_async=lambda: result))
