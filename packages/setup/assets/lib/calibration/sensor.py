"""Static bias of IMU and force/torque channels."""
import numpy as np

import kinex
from kinex.lib.calibration import CalibrationError

# Where each channel sits in a reading. The node already subtracts the profile bias, so
# the mean residual is added to it. Static averaging cannot separate a magnetic field from
# its bias, so magnetometers are not calibrated here.
CHANNELS = {
    "imu": {"angular_velocity": ("angular_velocity",), "linear_acceleration": ("linear_acceleration",)},
    "force_torque": {"force": ("wrench", "force"), "torque": ("wrench", "torque")},
}
AXES = ("x", "y", "z")


def bias(run, gravity_m_s2=None):
    """The bound target's per-axis bias from the run's static readings of it.

    Sample the unloaded, motionless sensor at least 20 times with run.sample(target). Gyros,
    gravity_removed accelerometers and wrench channels expect zero; a specific_force
    accelerometer expects gravity_m_s2, its static reading in the IMU frame, such as
    [0, 0, 9.80665] when level with +z up. Proposes the current bias plus each axis's mean
    residual; a std comparable to the residual means the sensor was not static.

    Example: result = lib.calibration.sensor.bias(run, gravity_m_s2=[0, 0, 9.80665])
    """
    target = run.role("target")
    profile = kinex.device(target).profile
    if profile["type"] not in CHANNELS:
        raise ValueError("bias calibration needs an imu or force_torque target")
    if not isinstance(profile.get("measurement"), dict):
        raise ValueError("record the measured channels first")
    specs = {channel: profile["measurement"][channel] for channel in CHANNELS[profile["type"]]
             if isinstance(profile["measurement"].get(channel), dict) and isinstance(profile["measurement"][channel].get("bias"), dict)}
    if not specs:
        raise ValueError(f"{target} declares no channel with a recorded bias to calibrate")
    expected = {channel: _gravity(spec, gravity_m_s2) if channel == "linear_acceleration" else [0, 0, 0] for channel, spec in specs.items()}
    readings = [sample["data"] for sample in run.samples(target)]

    def solve():
        channels = {}
        for channel, spec in specs.items():
            axes = {}
            for axis in spec["axes"]:
                values = np.array([value for data in readings if (value := _reading(data, CHANNELS[profile["type"]][channel], axis)) is not None])
                if not len(values):
                    raise CalibrationError(f"no {channel}.{axis} readings from {target}")
                residual = float(values.mean()) - expected[channel][AXES.index(axis)]
                axes[axis] = {"n": len(values), "mean": float(values.mean()), "std": float(values.std()), "residual": residual,
                              "bias": spec["bias"][axis] + residual}
            channels[channel] = axes
        return {"n": len(readings), "channels": channels}

    def facts(data):
        biases = {channel: {axis: value["bias"] for axis, value in axes.items()} for channel, axes in data["channels"].items()}
        return ("bias", {"measurement": {channel: {"bias": value} for channel, value in biases.items()}},
                [(f"/measurement/{channel}/bias", value) for channel, value in biases.items()])

    return run._solve("sensor-bias", solve, lambda data: "passed" if data["n"] >= 20 else "failed", facts)


def _gravity(spec, gravity_m_s2):
    if spec.get("quantity") == "gravity_removed":
        return [0, 0, 0]
    if gravity_m_s2 is None:
        raise ValueError("specific-force accelerometers need gravity_m_s2, the expected static reading in the IMU frame")
    return list(gravity_m_s2)


def _reading(data, path, axis):
    for key in (*path, axis):
        data = data.get(key) if isinstance(data, dict) else None
    return data if isinstance(data, (int, float)) and not isinstance(data, bool) else None
