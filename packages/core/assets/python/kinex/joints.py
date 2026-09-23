"""Profile-owned models and common joint command/read/FK/IK semantics."""


from kinex.geometry import compose_rt, invert_rt, xyzq_to_rt
from kinex.kinematics import Kinematics
from kinex.motion import flat, joint_target, pose, pose_error, vector
from kinex.joint_control import joint_model, command


def settings(directory):
    from kinex.validation import settings as load_profile
    profile = load_profile(directory)
    if profile.get("type") not in {"joint", "dexterous_hand"}:
        raise ValueError("Expected a joint or dexterous_hand profile")
    return profile


class JointDevice:
    def __init__(self, profile, directory=None, native_fk=None, native_ik=None):
        self.profile, self.intrinsics = profile, profile["intrinsics"]
        self.model = joint_model(profile, directory)
        self.joints = self.model["joints"]
        self.kinematics = self.intrinsics.get("kinematics")
        self.options = self.kinematics["ik"] if self.kinematics else None
        self.native_fk, self.native_ik = native_fk, native_ik
        self.solver = Kinematics(self.model, self.options) if self.kinematics and self.model["chain"] is not None else None
        names = [j["name"] for j in self.joints]
        if not names or len(names) != len(set(names)):
            raise ValueError("Model requires unique joint names")
        home = self.intrinsics["home"]
        if home is not None:
            if not isinstance(home, dict) or set(home) != set(names):
                raise ValueError("home must name every model joint exactly once")
            joint_target([home[name] for name in names], self.joints)
        if self.options and self.options["backend"] == "numerical" and self.solver is None:
            raise ValueError("Numerical IK requires model geometry")

    def project(self, value):
        q = vector(value, len(self.joints), "joints")
        return [max(j["limits"]["min"], min(j["limits"]["max"], v)) if j["limits"] else v for j, v in zip(self.joints, q)]

    def command(self, args):
        return command(self.profile, args, self.model)

    def fk(self, joints):
        if not self.kinematics or not self.kinematics["fk"]:
            raise ValueError("FK is unsupported")
        q = joint_target(joints, self.joints)
        if self.kinematics["fk"] == "numerical":
            return self.solver.fk(q)
        if self.native_fk is None:
            raise ValueError("Driver FK hook is required")
        reported = pose(self.native_fk(q))
        return {"pose": flat(compose_rt(xyzq_to_rt(reported), invert_rt(xyzq_to_rt(self.kinematics["frame_to_reported"]))))}

    def ik(self, target, seed):
        if not self.options:
            raise ValueError("IK is unsupported")
        target = pose(target)
        seed = joint_target(seed, self.joints)
        if self.options["backend"] == "numerical":
            result = self.solver.ik(target, seed)
        else:
            if self.native_ik is None:
                raise ValueError("Driver IK hook is required")
            native_target = flat(compose_rt(xyzq_to_rt(target), xyzq_to_rt(self.options["frame_to_solver"])))
            result = {"joints": self.native_ik(native_target, seed)}
        joint_target(result["joints"], self.joints)
        error = pose_error(target, self.fk(result["joints"])["pose"])
        if error["position_m"] > self.options["position_tolerance_m"] or error["rotation_rad"] > self.options["rotation_tolerance_rad"]:
            raise ValueError("IK result failed FK residual verification")
        return result

    def reading(self, state):
        feedback = self.intrinsics["feedback"]
        positions = vector(state.get("positions"), len(self.joints), "read.positions")
        result = {"positions": positions}
        if "pose" in state:
            result["pose"] = state["pose"]
        for key in ("velocities", "efforts"):
            result[key] = vector(state.get(key), len(self.joints), f"read.{key}") if feedback[key] else vector(state.get(key, []), 0, f"unsupported read.{key}")
        faults = state.get("faults")
        if not isinstance(faults, list) or any(not isinstance(f, dict) or set(f) != {"code"} or not isinstance(f["code"], str) for f in faults):
            raise ValueError("read.faults must contain {code: string} entries")
        result["faults"] = faults
        timestamp = state.get("sample_time_s")
        if timestamp is not None:
            vector([timestamp], 1, "sample_time_s")
        result["sample_time_s"] = timestamp
        if timestamp is None:
            vector([state.get("received_time_s")], 1, "received_time_s")
            result["received_time_s"] = state["received_time_s"]
        result["frame_poses"] = dict(state.get("frame_poses", {}))
        if self.kinematics:
            frame = self.kinematics["frame"]
            if self.intrinsics.get("frames", {}).get(frame) is None:
                result["frame_poses"][frame] = self.frame_pose(positions, state)
        return result

    def frame_pose(self, positions, state):
        k = self.kinematics
        if k["feedback"] == "driver":
            frames = state.get("frame_poses", {})
            if k["frame"] in frames:
                return pose(frames[k["frame"]], "read.frame_poses")
            reported = pose(state.get("reported_pose"), "read.reported_pose")
            return flat(compose_rt(xyzq_to_rt(reported), invert_rt(xyzq_to_rt(k["frame_to_reported"]))))
        if k["fk"] == "numerical":
            return self.solver.forward(positions)[0]
        if self.native_fk is None:
            raise ValueError("Driver FK hook is required for feedback")
        reported = pose(self.native_fk(positions))
        return flat(compose_rt(xyzq_to_rt(reported), invert_rt(xyzq_to_rt(k["frame_to_reported"]))))
