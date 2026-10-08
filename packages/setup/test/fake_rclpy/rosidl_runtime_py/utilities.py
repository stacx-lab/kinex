from fake_rclpy.interfaces import REGISTRY, get_service, get_action


def get_message(name):
    return REGISTRY[name]
