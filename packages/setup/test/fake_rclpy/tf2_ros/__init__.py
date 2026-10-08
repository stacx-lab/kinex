class Buffer:
    def __init__(self):
        self.frames = {}
    def all_frames_as_yaml(self):
        import json
        return json.dumps(self.frames)


class TransformListener:
    def __init__(self, buffer, node, spin_thread=False):
        buffer.frames = node.world.spec.get("frames", {})
