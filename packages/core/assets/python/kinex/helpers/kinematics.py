"""Joint device kinematics from the device's resolved URDF."""

from kinex import profile
from kinex.joints import JointModel


def joint_model(device):
    """Load a joint device's model without device I/O.

    joints lists the commanded joints in URDF document order with limits and
    rate limits; names holds their names. fk(positions, link=None) returns the
    link pose [x, y, z, qx, qy, qz, qw] in <device>/base. ik(pose, seed,
    link=None, **options) returns commanded positions nearest the seed, or
    raises ValueError when no verified solution is found. link defaults to the
    model's tip_link. Measured links are also on TF as <device>/<link>.

    Example: arm = helpers.joint_model("arm"); q = arm.ik(arm.fk(seed), seed)
    """
    return JointModel(profile(device))
