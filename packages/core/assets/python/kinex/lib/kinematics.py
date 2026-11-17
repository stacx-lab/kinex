"""Joint device FK and IK from the device's resolved URDF, without device I/O."""

from kinex import profile
from kinex.common import joints
from kinex.values import components, pose


class JointModel(joints.JointModel):
    """A joint device's commanded joints, in URDF document order, and its link FK/IK.

    Poses are RigidTransforms of a URDF link in <device>/base; link defaults to
    the model's only tip link.
    """

    def fk(self, positions, link=None):
        """Link pose at commanded joint positions; mimic joints follow their sources."""
        return pose(super().fk(positions, link))

    def ik(self, target, seed, link=None, **options):
        """Commanded positions, as an array, placing link at target nearest the seed
        projected into limits. target is a pose in any form. Joints off the link's
        path keep their seed values; options override the solver tolerances, damping,
        max_iterations and search budget."""
        import numpy as np
        return np.array(super().ik(components(target, single=True).tolist(), seed, link, **options))


def joint_model(device):
    """Load a joint device's model without device I/O.

    joints lists the commanded joints in URDF document order with limits and
    rate limits; names holds their names. fk(positions, link=None) returns the
    link pose in <device>/base as a RigidTransform. ik(pose, seed, link=None,
    **options) returns commanded positions nearest the seed as an array, or
    raises ValueError when no verified solution is found. Positions are any
    sequence of numbers, a joint_state message's position included. tips lists
    the model's tip links; link defaults to the only one and must be named when
    there are several. Measured links are also on TF as <device>/<link>.

    Example: arm = lib.kinematics.joint_model("arm"); q = arm.ik(arm.fk(seed), seed)
    """
    return JointModel(profile(device))
