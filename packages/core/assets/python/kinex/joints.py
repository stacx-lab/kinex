"""Profile-owned models and common joint command/read/FK/IK semantics."""


from kinex.geometry import compose_rt, invert_rt, xyzq_to_rt
from kinex.kinematics import Kinematics
from kinex.local_frames import fixed_transform, frame_definitions
from kinex.motion import flat, joint_target, pose, pose_error, vector
from kinex.joint_control import joint_model, command, project_seed


def settings(directory):
    from kinex.validation import settings as load_profile
    profile = load_profile(directory)
    if profile.get("type") not in {"joint", "dexterous_hand"}:
        raise ValueError("Expected a joint or dexterous_hand profile")
    return profile


class JointDevice:
    def __init__(self, profile, directory=None, native_fk=None, native_ik=None):
        self.profile, self.intrinsics = profile, profile["intrinsics"]
        self.frames = frame_definitions(profile)
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
        return project_seed(value, self.joints)

    def command(self, args):
        return command(self.profile, args, self.model)

    def frame_pair(self, frame, reference_frame):
        if frame is None:
            if not self.kinematics:
                raise ValueError("Specify a modeled frame")
            frame = self.kinematics["frame"]
        if not isinstance(frame, str) or frame not in self.frames:
            raise ValueError("Frame must name a declared device-local frame")
        return frame, fixed_transform(self.frames, reference_frame)

    def fk(self, joints, frame=None, reference_frame=None):
        q = vector(joints, len(self.joints), "joints")
        frame, reference = self.frame_pair(frame, reference_frame)
        frames = self.frames
        anchor, seen = frame, set()
        while anchor not in frames or "source" not in frames[anchor]:
            if anchor is None or anchor not in frames or anchor in seen:
                raise ValueError("Frame is not a modeled endpoint or fixed descendant")
            seen.add(anchor)
            anchor = frames[anchor]["parent_frame"]
        offset = fixed_transform(frames, frame, anchor)
        if frames[anchor]["source"] == "hand":
            from kinex.hand import forward
            poses = forward({**self.profile, "resolved_model": self.model}, q)
            current = compose_rt(xyzq_to_rt(poses[anchor]), offset)
        else:
            if not self.kinematics or not self.kinematics["fk"]:
                raise ValueError("FK is unsupported")
            if self.kinematics["fk"] == "numerical":
                endpoint = self.solver.forward(q)[0]
            else:
                if self.native_fk is None:
                    raise ValueError("Driver FK hook is required")
                reported = pose(self.native_fk(q))
                endpoint = flat(compose_rt(xyzq_to_rt(reported), invert_rt(xyzq_to_rt(self.kinematics["frame_to_reported"]))))
            current = compose_rt(xyzq_to_rt(endpoint), offset)
        return {"pose": flat(compose_rt(invert_rt(reference), current)),
                "frame": frame, "reference_frame": reference_frame}

    def ik(self, target, seed, frame=None, reference_frame=None):
        if not self.options:
            raise ValueError("IK is unsupported")
        target = pose(target)
        seed = joint_target(seed, self.joints)
        frame, reference = self.frame_pair(frame, reference_frame)
        offset = fixed_transform(self.frames, frame, self.kinematics["frame"])
        endpoint = flat(compose_rt(compose_rt(reference, xyzq_to_rt(target)), invert_rt(offset)))
        if self.options["backend"] == "numerical":
            result = self.solver.ik(endpoint, seed)
        else:
            if self.native_ik is None:
                raise ValueError("Driver IK hook is required")
            native_target = flat(compose_rt(xyzq_to_rt(endpoint), xyzq_to_rt(self.options["frame_to_solver"])))
            result = {"joints": self.native_ik(native_target, seed)}
        joint_target(result["joints"], self.joints)
        error = pose_error(target, self.fk(result["joints"], frame, reference_frame)["pose"])
        if error["position_m"] > self.options["position_tolerance_m"] or error["rotation_rad"] > self.options["rotation_tolerance_rad"]:
            raise ValueError("IK result failed FK residual verification")
        return {**result, "frame": frame, "reference_frame": reference_frame}

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
        result["timestamp"] = vector([state.get("timestamp")], 1, "timestamp")[0]
        return result
