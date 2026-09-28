"""A driver-owned reference buffer on the hardware clock."""

import threading
import time
import uuid

from kinex.validation import number


class Buffer:
    def __init__(self, period_s, apply, halt, *, expire=False):
        if number(period_s, "period_s") <= 0:
            raise ValueError("period_s must be positive")
        self.period = period_s
        self.apply, self.halt, self.expire = apply, halt, expire
        self.condition = threading.Condition()
        self.pending = None
        self.error = None
        self.closed = False
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def submit(self, actions, duration):
        with self.condition:
            if self.closed or self.error:
                raise RuntimeError(self.error or "buffer is closed")
            self.pending = (actions, duration, time.monotonic())
            self.condition.notify_all()
            return uuid.uuid4().hex

    def stop(self):
        with self.condition:
            self.pending = None
            self.halt()
            self.condition.notify_all()

    def run(self):
        with self.condition:
            while not self.closed:
                if self.pending is None:
                    self.condition.wait()
                    continue
                actions, duration, start = self.pending
                elapsed = time.monotonic() - start
                try:
                    if elapsed >= duration:
                        if self.expire:
                            self.halt()
                        else:
                            self.apply(actions[-1])
                        self.pending = None
                        continue
                    self.apply(actions[min(int(elapsed * len(actions) / duration), len(actions) - 1)])
                except Exception as error:
                    self.error = str(error)
                    self.pending = None
                    try:
                        self.halt()
                    except Exception as cleanup:
                        self.error += f"; stop failed: {cleanup}"
                self.condition.wait(self.period)

    def close(self):
        with self.condition:
            self.closed = True
            self.pending = None
            self.condition.notify_all()
        self.thread.join()
