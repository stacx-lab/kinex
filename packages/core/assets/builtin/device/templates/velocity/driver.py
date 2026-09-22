#!/usr/bin/env python3
"""Complete the SDK hooks; the shared driver owns validation and the watchdog."""
from pathlib import Path
from kinex.velocity_driver import Driver


class VelocityDeviceDriver(Driver):
    def connect(self):
        raise NotImplementedError("Start owned control services and connect using self.profile['access']['connection']; wait for readiness and roll back failed startup")

    def disconnect(self, handle):
        raise NotImplementedError("Release owned services and connection; preserve balance and shared external services")

    def read_state(self, handle):
        raise NotImplementedError("Read body pose, velocities, frames, faults and acquisition timestamp")

    def send_target(self, handle, command):
        raise NotImplementedError("Execute velocity/posture for command.for_s; return accepted, elapsed_s, reached and state")

    def halt(self, handle, target):
        raise NotImplementedError("Perform self.profile['intrinsics']['stop']; preserve posture/balance; target is the last command or None")


if __name__ == "__main__":
    VelocityDeviceDriver(Path(__file__).parent).main()
