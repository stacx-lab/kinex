"""Shared controller reads, predicates and scoped cleanup."""

from contextlib import contextmanager

from kinex import device, stop_owned


def read(name):
    """One reading, for the verification a write's own report cannot provide."""
    state = device(name)
    if not isinstance(state.get("faults"), list):
        raise ValueError(f"{name} read.faults must be a list")
    return state


def stop_all(names):
    """Attempt every stop, including when an earlier device refuses to stop."""
    errors = []
    for name in dict.fromkeys(names):
        try:
            device(name, "stop")
        except Exception as error:
            errors.append(f"{name}: {error}")
    if errors:
        raise RuntimeError("stop failed: " + "; ".join(errors))


@contextmanager
def stop_on_error(names=None):
    """Stop named devices, or owned motion by default, without masking the failure."""
    try:
        yield
    except BaseException as error:
        try:
            if names is None:
                stop_owned()
            else:
                stop_all(names)
        except Exception as cleanup:
            error.add_note(str(cleanup))
        raise
