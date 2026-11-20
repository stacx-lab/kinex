"""Joint device FK and IK from the device's resolved URDF, without device I/O."""

from kinex import profile
from kinex.common import joints
from kinex.common.kinematics import IKError  # noqa: F401  (raised by ik; programs catch it here)
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
        max_iterations and search budget, and take search ("local" or "global"),
        free_axis and position_only."""
        import numpy as np
        return np.array(super().ik(components(target, single=True).tolist(), seed, link, **options))


def joint_model(device):
    """A joint device's kinematic model from its URDF, without device I/O.

    model.joints lists the commanded joints in URDF order with limits, model.names their
    names and model.tips the tip links. model.fk(positions, link=None) is the link's pose
    in <device>/base. model.ik(target, seed, link=None) is the positions nearest seed
    that reach the target pose, as an array; the search stays near the seed, so it never
    returns a distant posture. When none is found it raises IKError (a ValueError) whose
    details.reason says why: "posture_change" (reachable only from a distant posture,
    given as details.alternative_joints with details.travel_rad), "out_of_reach" or
    "not_found". ik(..., search="global") returns that distant posture instead; move there
    deliberately, for example by retracting with lib.motion.cartesian first.
    ik(..., free_axis=[x, y, z]) leaves rotation about that link-frame axis free, such as a
    gripper's approach axis, and ik(..., position_only=True) ignores rotation.
    link defaults to the only tip. Positions are any sequence, a joint_state's included.

    Example: arm = lib.kinematics.joint_model("arm"); q = arm.ik(arm.fk(seed), seed)
    """
    return JointModel(profile(device))
