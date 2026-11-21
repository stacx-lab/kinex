"""The Kinex function library: reusable functions that exec programs import and compose.

Builtin modules ship in this directory and in the packages composed with core, such as
setup; workspace and global modules come from the .kinex/lib roots. KINEX_LIB lists the
roots beyond this directory, nearest first; a nearer module replaces one of the same name.
Browse the library with the lib tool. Modules load on first use, at any depth.
"""
import os
from importlib import import_module

__path__[:0] = filter(None, os.environ.get("KINEX_LIB", "").split(os.pathsep))


def _loader(package):
    """A module __getattr__ that imports a package's submodules on first attribute access."""
    def load(name):
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            module = import_module(f"{package}.{name}")
        except ModuleNotFoundError as error:
            if error.name != f"{package}.{name}":
                raise
            raise AttributeError(f"{package} has no module or attribute {name!r}; browse the library with the lib tool") from None
        if hasattr(module, "__path__"):
            vars(module).setdefault("__getattr__", _loader(module.__name__))
        return module
    return load


__getattr__ = _loader(__name__)
