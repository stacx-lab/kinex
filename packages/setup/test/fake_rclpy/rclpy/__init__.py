"""Test-only rclpy facade installed exclusively on the test PYTHONPATH."""

import sys
from types import ModuleType, SimpleNamespace
from fake_rclpy.scenario import Context, Node, MultiThreadedExecutor, ActionClient


def module(name, **attributes):
    result = ModuleType(name)
    result.__dict__.update(attributes)
    sys.modules[name] = result
    return result


def init(args=None, context=None, domain_id=None, signal_handler_options=None):
    context.running = True
    context.domain_id = domain_id


def try_shutdown(context=None):
    context.running = False


def create_node(name, namespace="", context=None):
    return Node(name, namespace, context)


module("rclpy.context", Context=Context)
module("rclpy.node", Node=Node)
module("rclpy.executors", MultiThreadedExecutor=MultiThreadedExecutor)
module("rclpy.signals", SignalHandlerOptions=SimpleNamespace(NO=0))
module("rclpy.qos", QoSProfile=SimpleNamespace, DurabilityPolicy=SimpleNamespace(TRANSIENT_LOCAL=1), qos_profile_sensor_data=SimpleNamespace(depth=5))
module("rclpy.action", ActionClient=ActionClient)
