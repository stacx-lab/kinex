import ONBOARDING from "./onboarding.txt"
import ROS2 from "./onboarding-ros2.txt"
import CALIBRATE from "./calibrate.txt"

// Agent-guided robotics procedures shared by standalone commands and host adapters.
export { ONBOARDING, CALIBRATE }
export const ONBOARDING_ROS2 = `${ROS2}\n\n${ONBOARDING}`
export const workflows = { onboarding: ONBOARDING, "onboarding-ros2": ONBOARDING_ROS2, calibrate: CALIBRATE }
