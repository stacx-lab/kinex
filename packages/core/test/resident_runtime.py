"""A program's io through the resident runtime, against a device served in this process. Needs Kinex's ROS Python."""
import asyncio
import json
import socket
import subprocess
import sys
import tempfile
import unittest

from control_msgs.action import FollowJointTrajectory
from rclpy.action import ActionServer
from std_msgs.msg import Float64
from std_srvs.srv import Trigger

from kinex.communication import communication
from kinex.errors import OperationError
from kinex.host.runtime import Attached, join

DOMAIN = 182
CATALOG = {f"sensor.{name}": {"transport": transport, "direction": direction, "endpoint": f"/resident_test/{name}", "type": kind}
           for name, transport, direction, kind in (
               ("value", "topic", "output", "std_msgs/msg/Float64"), ("command", "topic", "input", "std_msgs/msg/Float64"),
               ("stop", "service", "input", "std_srvs/srv/Trigger"), ("check", "service", "input", "std_srvs/srv/Trigger"),
               ("move", "action", "input", "control_msgs/action/FollowJointTrajectory"))}


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(.01)


class ResidentRuntime(unittest.IsolatedAsyncioTestCase):
    async def test_programs_join_one_runtime_and_a_failed_one_stops_its_devices(self):
        commands, stops, count = [], [], iter(range(10**9))

        def move(handle):
            handle.publish_feedback(FollowJointTrajectory.Feedback())
            handle.succeed()
            return FollowJointTrajectory.Result(error_string="done")

        async with communication(CATALOG, domain_id=DOMAIN) as device:
            node, endpoint = device.node, lambda name: CATALOG[f"sensor.{name}"]["endpoint"]
            value = node.create_publisher(Float64, endpoint("value"), 10)
            node.create_timer(.02, lambda: value.publish(Float64(data=float(next(count)))))
            node.create_subscription(Float64, endpoint("command"), lambda message: commands.append(message.data), 10)
            node.create_service(Trigger, endpoint("stop"), lambda _, reply: stops.append(1) or Trigger.Response(success=True))
            node.create_service(Trigger, endpoint("check"), lambda _, reply: Trigger.Response(message="no"))
            ActionServer(node, FollowJointTrajectory, endpoint("move"), move)
            with tempfile.TemporaryDirectory() as directory:
                runtime = subprocess.Popen([sys.executable, "-m", "kinex.host.runtime"], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, text=True)
                try:
                    runtime.stdin.write(json.dumps({"catalog": CATALOG, "domain_id": DOMAIN, "socket": f"{directory}/runtime"}) + "\n")
                    runtime.stdin.flush()
                    self.assertEqual(json.loads(await asyncio.to_thread(runtime.stdout.readline)), {"ready": True})
                    io = Attached(join(f"{directory}/runtime"), CATALOG).open()
                    with io.subscribe("sensor.value", depth=3) as stream:
                        first, second = await stream.next(timeout_s=5), await stream.next(timeout_s=5)
                    self.assertGreater(second.data, first.data)
                    await io.publish("sensor.command", {"data": 2.5})
                    await until(lambda: commands == [2.5])
                    with self.assertRaises(OperationError) as rejected:
                        await io.request("sensor.check")
                    self.assertEqual(rejected.exception.response.message, "no")
                    goal = await io.act("sensor.move", {})
                    self.assertEqual(((await goal.wait()).error_string, goal.status), ("done", "succeeded"))
                    # A program that fails has the device it commanded stopped, by the runtime.
                    await io.close(RuntimeError("the program failed"))
                    self.assertEqual(len(stops), 1)
                    # So has one that is gone without a word; it had joined the runtime the first left.
                    killed = Attached(join(f"{directory}/runtime"), CATALOG).open()
                    await killed.publish("sensor.command", {"data": 1.})
                    killed.link.shutdown(socket.SHUT_RDWR)  # as its process dying does
                    await until(lambda: len(stops) == 2)
                    # One that succeeds leaves its device as it commanded it.
                    done = Attached(join(f"{directory}/runtime"), CATALOG).open()
                    await done.publish("sensor.command", {"data": 0.})
                    await done.close()
                    await until(lambda: commands == [2.5, 1., 0.])
                    self.assertEqual(len(stops), 2)
                finally:
                    runtime.stdin.close()
                    runtime.wait(10)


if __name__ == "__main__":
    unittest.main()
