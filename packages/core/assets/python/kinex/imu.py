"""Typed IMU reads through shared dispatch, with no implicit gravity removal."""

from kinex import device, profile


def read(name):
    if profile(name)["type"] != "imu":
        raise ValueError("input device must have type imu")
    # Dispatch has already validated channels and subtracted the profile bias.
    return device(name)
