"""Cooperative cancellation for bounded numerical computations."""
import threading
from contextlib import contextmanager

_operation = threading.local()

@contextmanager
def cancellation_scope(event):
    previous = getattr(_operation, "cancel", None)
    _operation.cancel = event
    try:
        yield
    finally:
        _operation.cancel = previous

def check_cancelled():
    event = getattr(_operation, "cancel", None)
    if event is not None and event.is_set():
        raise InterruptedError("operation cancelled")
