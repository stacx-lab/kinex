#!/usr/bin/env python3
"""Complete the vendor hooks for an asynchronous scalar actuator."""

from pathlib import Path
from kinex.velocity_driver import Driver
from kinex.scalar_control import command, reading


class ScalarDriver(Driver):
    def command(self, args):
        return command(self.profile, args)

    def reading(self, state):
        return reading(self.profile, state)

    def references(self, value):
        return [{"target": target} for target in value["actions"]]

    def connect(self):
        raise NotImplementedError("Connect using access.connection")

    def disconnect(self, handle):
        raise NotImplementedError("Release the connection and owned services")

    @property
    def period_s(self):
        raise NotImplementedError("Return the hardware control period")

    def read_state(self, handle):
        raise NotImplementedError("Read declared positions, velocities, sensors, faults and timestamp")

    def set_target(self, handle, command):
        raise NotImplementedError("Set the binary target without waiting")

    def halt(self, handle, target):
        raise NotImplementedError("Perform the declared stop behavior")


if __name__ == "__main__":
    ScalarDriver(Path(__file__).parent).main()
