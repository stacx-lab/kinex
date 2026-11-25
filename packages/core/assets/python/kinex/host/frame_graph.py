"""Kinex-owned tf2 history; independent of device operations."""
import threading

from rclpy.duration import Duration
from tf2_ros import Buffer, LookupException, TransformException, TransformListener

# World-time TF history. A standalone scope resolves what it observes itself (tf2's default);
# the runtime keeps more, to answer the stamps a model reuses across later programs.
SCOPE_HISTORY_S = 10.
HISTORY_S = 120.


def nanoseconds(stamp):
    return stamp.sec * 1_000_000_000 + stamp.nanosec


def device_of(frame):
    return frame.split("/", 1)[0]


class FrameBuffer(Buffer):
    """A domain's tf2 history, with the frames its device hosts publish now.

    A device's frames belong to the host that publishes them. TF and the device
    lifecycle arrive unordered: a host latches its mounts before its device is
    announced loaded, and a host that fails to load is never announced at all. So
    arrival is never judged by whether the device is loaded. Every frame that
    arrives is kept; device(name, False) is told whenever the device has no live
    host, before one starts and after one ends, and forgets what the last one
    published; only a loaded device's frames are looked up.
    """

    def __init__(self, history_s=SCOPE_HISTORY_S):
        super().__init__(cache_time=Duration(seconds=history_s))
        self.history_s = history_s
        self.fixed = {}
        self.latest = {}
        self.future = {}
        self.clock_stamp = None
        self.lock = threading.RLock()
        self.blocked = set()

    def set_transform_static(self, value, authority):
        with self.lock:
            self.fixed[value.child_frame_id] = (value, authority)
            super().set_transform_static(value, authority)

    def set_transform(self, value, authority):
        with self.lock:
            if self.clock_stamp is not None and nanoseconds(value.header.stamp) > self.clock_stamp:
                self.future[value.child_frame_id] = (value, authority)
                return
            self.future.pop(value.child_frame_id, None)
            self.latest[value.child_frame_id] = (value, authority)
            super().set_transform(value, authority)

    def device(self, name, active):
        with self.lock:
            if active:
                self.blocked.discard(name)
                return
            self.blocked.add(name)
            for mapping in (self.fixed, self.latest, self.future):
                for child in list(mapping):
                    if child.split("/", 1)[0] == name:
                        del mapping[child]

    def edges(self):
        # tf2 retains static caches even after clear(). Track live topology so
        # unloaded calibration cannot be resolved from that retained cache.
        # All transform values and temporal interpolation still belong to tf2.
        return {child: value.header.frame_id for mapping in (self.fixed, self.latest)
                for child, (value, _) in mapping.items()}

    def connected(self, target, source):
        edges = self.edges()
        known = set(edges) | set(edges.values())
        def ancestors(frame):
            result = set()
            while frame in known and frame not in result:
                if device_of(frame) in self.blocked:
                    break
                result.add(frame)
                frame = edges.get(frame)
            return result
        return bool(ancestors(target) & ancestors(source))

    def explain(self, target, source, time):
        """Why source cannot be expressed in target at time; for failed lookups only."""
        with self.lock:
            edges = self.edges()
            known = set(edges) | set(edges.values())
            for frame in (target, source):
                if device_of(frame) in self.blocked:
                    return f"{device_of(frame)} is not loaded"
            for frame in (target, source):
                device = device_of(frame)
                if frame not in known:
                    published = sorted(name for name in known if device_of(name) == device)
                    if not published:
                        return f"{frame} is not on TF, nor is any frame of {device}"
                    return f"{frame} is not on TF; {device} has {', '.join(published)}"
            if not self.connected(target, source):
                def top(frame):
                    seen = set()
                    while frame in edges and frame not in seen and device_of(frame) not in self.blocked:
                        seen.add(frame)
                        frame = edges[frame]
                    return frame + (f" of unloaded {device_of(frame)}" if device_of(frame) in self.blocked else "")
                return (f"{target} and {source} are not connected: {target} is under {top(target)} and "
                        f"{source} under {top(source)}; a mount of unknown calibration publishes no edge")
            available, reason = super().can_transform_core(target, source, time)
        if available:
            return "the transform became available as the wait ended; retry"
        if "past" in reason:
            reason += f" Kinex keeps {self.history_s:g} s of world-time TF history."
        return reason

    def timed_out(self, target, source, time, waited_s):
        return f"transform lookup timed out after {waited_s:g} s: {self.explain(target, source, time)}"

    def can_transform_core(self, target, source, time):
        with self.lock:
            if not self.connected(target, source):
                return False, "frame is unloaded or unavailable"
            return super().can_transform_core(target, source, time)

    def lookup_transform_core(self, target, source, time):
        with self.lock:
            if not self.connected(target, source):
                raise LookupException(self.explain(target, source, time))
            try:
                return super().lookup_transform_core(target, source, time)
            except TransformException as error:
                raise type(error)(self.explain(target, source, time)) from None

    def observe_clock(self, stamp):
        with self.lock:
            if self.clock_stamp is None or stamp < self.clock_stamp:
                super().clear()
                self.future.clear()
                # Mounts remain valid across reset. Preserve a reset sample that
                # arrived before its clock callback; discard the previous epoch.
                self.latest = {key: item for key, item in self.latest.items()
                               if nanoseconds(item[0].header.stamp) <= stamp}
                for value, authority in self.fixed.values():
                    super().set_transform_static(value, authority)
                for value, authority in self.latest.values():
                    super().set_transform(value, authority)
            self.clock_stamp = stamp
            # Clock and TF are separate DDS streams. Hold a sample that arrives
            # ahead of its clock; it must not make future/old-epoch poses visible.
            for value, authority in list(self.future.values()):
                if nanoseconds(value.header.stamp) <= stamp:
                    self.set_transform(value, authority)


def listen(node, history_s=SCOPE_HISTORY_S):
    from rclpy.qos import DurabilityPolicy, QoSProfile
    buffer = FrameBuffer(history_s)
    # Several devices publish TF in one world step; a shallow reader queue drops samples.
    return buffer, TransformListener(buffer, node, qos=QoSProfile(depth=100, durability=DurabilityPolicy.TRANSIENT_LOCAL))
