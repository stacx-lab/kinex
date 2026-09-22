#!/usr/bin/env python3
"""Complete the device API hooks. The common driver owns validation and FK/IK."""
from pathlib import Path
from kinex.joint_driver import Driver


class JointDeviceDriver(Driver):
    def connect(self):
        raise NotImplementedError("Start owned control services and connect using self.profile['access']['connection']; wait for readiness and roll back failed startup")

    def disconnect(self, handle):
        raise NotImplementedError("Release the connection and owned services; leave shared external services running")

    def read_state(self, handle):
        raise NotImplementedError("Read measured state; see DEVICE.md#use")

    def send_target(self, handle, command):
        raise NotImplementedError("Execute for command.for_s; honor arrive and max_velocity; return accepted, elapsed_s, reached and state")

    def halt(self, handle):
        raise NotImplementedError("Perform self.profile['intrinsics']['stop'] behavior")

    def native_fk(self, handle, joints):
        raise NotImplementedError("Only for model.format:driver; return the solver tip pose in metres/xyzw")

    def native_ik(self, handle, pose, seed):
        raise NotImplementedError("Only for ik.backend:driver; return joints in resolved model order")


if __name__ == "__main__":
    JointDeviceDriver(Path(__file__).parent).main()
