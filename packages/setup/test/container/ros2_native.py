"""Native DDS pub/sub, request/response and multiple static-frame smoke check."""
import asyncio
import os

from kinex import helpers
from kinex.communication import communication
from kinex.ros_frames import publish_profile

async def main():
    from rclpy.node import Node
    from std_msgs.msg import Float64
    from std_srvs.srv import Trigger
    from tf2_ros import Buffer, TransformListener
    from rclpy.time import Time
    catalog = {
        'sensor.measurement': {'description': 'Test measurement', 'transport': 'topic', 'direction': 'output',
                               'endpoint': '/kinex_test/value', 'type': 'std_msgs/msg/Float64'},
        'sensor.query': {'description': 'Test response', 'transport': 'service', 'direction': 'input',
                        'endpoint': '/kinex_test/query', 'type': 'std_srvs/srv/Trigger'},
    }
    async with communication(catalog, domain_id=int(os.environ.get('ROS_DOMAIN_ID', '0'))) as io:
        source = Node('kinex_test_source', context=io.context)
        io.extra_nodes.append(source)
        io.executor.add_node(source)
        publisher = source.create_publisher(Float64, '/kinex_test/value', 10)
        def query(request, response):
            response.success = True
            response.message = 'native response'
            return response
        source.create_service(Trigger, '/kinex_test/query', query)
        stream = io.subscribe('sensor.measurement', depth=2)
        profile = {'name': 'arm', 'frames': {
            'base': {'parent': 'world:base', 'translation_m': [1, 0, 0], 'rotation_xyzw': [0, 0, 0, 1]},
            'flange': {'parent': 'arm:base', 'translation_m': [0, 2, 0], 'rotation_xyzw': [0, 0, 0, 1]},
            'tool': {'parent': 'arm:flange', 'translation_m': [0, 0, 3], 'rotation_xyzw': [0, 0, 0, 1]},
            'unknown': {'parent': 'arm:base', 'translation_m': None, 'rotation_xyzw': None},
        }}
        broadcasters = publish_profile(source, profile)
        buffer = Buffer()
        listener = TransformListener(buffer, io.node)
        try:
            async with asyncio.timeout(10):
                while not source.count_subscribers('/kinex_test/value'):
                    await asyncio.sleep(.02)
                publisher.publish(Float64(data=7.0))
                assert (await stream.next(timeout_s=5)).data == 7
                response = await io.request('sensor.query')
                assert response.success and response.message == 'native response'
                while not buffer.can_transform('world/base', 'arm/tool', Time()):
                    await asyncio.sleep(.02)
                transform = buffer.lookup_transform('world/base', 'arm/tool', Time())
                v = transform.transform.translation
                assert (v.x, v.y, v.z) == (1, 2, 3)
                relation = await helpers.lookup_transform(io, 'world:base', 'arm:tool')
                assert relation.transform == transform.transform
                assert not buffer.can_transform('world/base', 'arm/unknown', Time())
        finally:
            listener.unregister()
    print('native pub/sub, request/response and multiple static frames passed')

asyncio.run(main())
