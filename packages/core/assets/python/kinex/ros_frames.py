"""Publish calibrated rigid transforms; tf2 owns live frame composition."""

def frame_id(device, frame=None):
    return f"{device}/{frame}" if frame and frame != device else device


def dynamic_qos():
    from rclpy.qos import QoSProfile, DurabilityPolicy
    # Retain the latest measured configuration for readers joining a paused world.
    return QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)


def transform(parent, child, pose, stamp=None):
    from geometry_msgs.msg import TransformStamped
    from kinex.motion import pose as validate_pose
    values = list(map(float, validate_pose(list(pose))))
    value = TransformStamped()
    value.header.frame_id, value.child_frame_id = parent, child
    if stamp is not None:
        value.header.stamp = stamp
    value.transform.translation.x, value.transform.translation.y, value.transform.translation.z = values[:3]
    (value.transform.rotation.x, value.transform.rotation.y,
     value.transform.rotation.z, value.transform.rotation.w) = values[3:]
    return value


def publish_profile(node, profile):
    from tf2_ros import StaticTransformBroadcaster
    transforms = []
    def add(parent, child, translation, rotation):
        if not isinstance(translation, (list, tuple)) or not isinstance(rotation, (list, tuple)):
            return  # Unknown calibration never becomes identity.
        transforms.append(transform(parent, child, [*translation, *rotation]))
    name = profile["name"]
    mount = profile.get("extrinsics", {}).get("mount")
    if isinstance(mount, dict):
        parent = frame_id(mount["parent"], mount["parent_frame"])
        add(parent, name, mount.get("translation_m"), mount.get("rotation_xyzw"))
    for frame, value in profile.get("intrinsics", {}).get("frames", {}).items():
        parent = frame_id(name, value.get("parent_frame"))
        add(parent, frame_id(name, frame), value.get("translation_m"), value.get("rotation_xyzw"))
    if not transforms:
        return []
    broadcaster = StaticTransformBroadcaster(node)
    broadcaster.sendTransform(transforms)
    return [broadcaster]
