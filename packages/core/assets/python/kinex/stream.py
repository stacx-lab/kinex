"""Native device capture. A recorder opens once and runs until stop().

VideoRecorder: grab() -> RGB bytes/array/PIL image, optionally paired with depth.
StateRecorder: read_state() -> a timestamped state row. Both expose latest and
wait_latest(), so read() can reuse capture without accessing hardware twice.
VideoWriter is also used by the harness's stdlib-only record_encode.py bridge.
"""

import json
import math
import pathlib
import threading
import time

from .video import VideoWriter


class _Recorder:
    def __init__(self, sample, rate):
        if not math.isfinite(rate) or rate <= 0:
            raise ValueError("capture rate must be positive and finite")
        self.sample, self.rate = sample, float(rate)
        self.latest = self.error = self.capture_error = None
        self.started_ns = self.ended_ns = None
        self.count = self.dropped = self.read_errors = 0
        self.started_mono = self.ended_mono = None
        self._thread = None
        self._stop = threading.Event()
        self._first = threading.Event()
        self._result = None

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self._thread is not None:
            return
        self.started_ns = time.time_ns()
        self.started_mono = time.monotonic()
        self._open()
        self._thread = threading.Thread(target=self._run, name=type(self).__name__, daemon=True)
        self._thread.start()

    def stop(self):
        if self._result is not None:
            return self._result
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                self.error = self.error or "capture hook did not stop within 5s"
                raise TimeoutError(self.error)
        self.ended_ns = time.time_ns()
        self.ended_mono = time.monotonic()
        self._close()
        self._result = self.facts()
        return self._result

    def wait_latest(self, timeout=2.0):
        self._first.wait(timeout)
        return self.latest

    def _run(self):
        period = 1.0 / self.rate
        next_tick = time.monotonic()
        while not self._stop.is_set():
            try:
                sample = self.sample()
            except Exception as exc:
                self.read_errors += 1
                self.capture_error = f"{type(exc).__name__}: {exc}"
            else:
                if self._stop.is_set():
                    break
                self.latest = sample
                self._first.set()
                try:
                    self._sink(sample, time.time_ns())
                except Exception as exc:
                    self.error = f"{type(exc).__name__}: {exc}"
                    break
                self.count += 1
            next_tick += period
            now = time.monotonic()
            late = max(0, math.ceil((now - next_tick) / period))
            self.dropped += late
            next_tick += late * period
            self._stop.wait(max(0.0, next_tick - now))

    def capture_facts(self):
        elapsed = (self.ended_mono or time.monotonic()) - (self.started_mono or time.monotonic())
        return {**({"capture_error": self.capture_error} if self.capture_error else {}),
                "capture_samples": self.count, "capture_missed": self.dropped,
                "capture_errors": self.read_errors, "capture_hz": round(self.count / max(elapsed, 0.001), 2)}


class VideoRecorder(_Recorder):
    def __init__(self, grab, dir, rate_hz=15, fps=15, max_px=None, image=None, depth=None):
        super().__init__(grab, rate_hz)
        self.dir, self.fps, self.max_px = dir, fps, max_px
        self.image, self.depth = image or (lambda sample: sample), depth
        self.writer = None

    def _open(self):
        self.writer = VideoWriter(self.dir, fps=self.fps, max_px=self.max_px, depth=self.depth is not None)

    def _sink(self, sample, t_ns):
        self.writer.push(self.image(sample), self.depth(sample) if self.depth else None, t_ns)

    def _close(self):
        if self.writer is not None:
            self.writer.close()

    def facts(self):
        facts = self.writer.facts() if self.writer else {"frames": 0}
        facts.update(self.capture_facts())
        if self.error:
            facts["error"] = self.error
        return {key: value for key, value in facts.items() if value is not None}


class StateRecorder(_Recorder):
    def __init__(self, read_state, dir, rate_hz=50):
        super().__init__(read_state, rate_hz)
        self.dir = pathlib.Path(dir)
        self.rows = None

    def _open(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        self.rows = open(self.dir / "state.jsonl", "w", buffering=1)

    def _sink(self, sample, t_ns):
        if not isinstance(sample, dict):
            raise TypeError("state capture must return a dict")
        self.rows.write(json.dumps({**sample, "t_ns": t_ns}, default=lambda v: v.tolist()) + "\n")

    def _close(self):
        if self.rows is not None:
            self.rows.close()

    def facts(self):
        facts = {"state": str(self.dir / "state.jsonl"), "rows": self.count,
                 "started_ns": self.started_ns, "ended_ns": self.ended_ns}
        facts.update(self.capture_facts())
        if self.error:
            facts["error"] = self.error
        return {key: value for key, value in facts.items() if value is not None}


def read_pgm16(path):
    """A binary P5 PGM file (maxval 65535, big-endian) -> (le16 bytes, width, height)."""
    return parse_pgm16(pathlib.Path(path).read_bytes())


def parse_pgm16(raw):
    """Binary P5 PGM bytes (maxval 65535, big-endian) -> (le16 bytes, width, height)."""
    fields = []
    pos = 0
    while len(fields) < 4:
        while pos < len(raw) and raw[pos:pos + 1].isspace():
            pos += 1
        if raw[pos:pos + 1] == b"#":
            newline = raw.find(b"\n", pos)
            if newline == -1:
                raise ValueError("truncated PGM comment")
            pos = newline + 1
            continue
        end = pos
        while end < len(raw) and not raw[end:end + 1].isspace():
            end += 1
        if end == pos or end == len(raw):
            raise ValueError("truncated PGM header")
        fields.append(raw[pos:end])
        pos = end
    if fields[0] != b"P5" or fields[3] != b"65535":
        raise ValueError("expected binary 16-bit PGM")
    width, height = int(fields[1]), int(fields[2])
    pos += 2 if raw[pos:pos + 2] == b"\r\n" else 1
    body = raw[pos:]
    if width <= 0 or height <= 0 or len(body) != width * height * 2:
        raise ValueError("PGM depth size does not match dimensions")
    swapped = bytearray(body)
    swapped[0::2], swapped[1::2] = body[1::2], body[0::2]
    return bytes(swapped), width, height
