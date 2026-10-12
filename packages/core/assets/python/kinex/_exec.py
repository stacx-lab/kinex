"""Run an ordinary script while keeping the runtime dialog private."""

import os
import runpy
import sys
from types import ModuleType

from kinex import _request


if __name__ == "__main__":
    # kinex has duplicated the protocol descriptors and consumed startup. Raw
    # writes and subprocess output now join print() on the diagnostic stream.
    os.dup2(2, 1)
    with open(os.devnull) as empty:
        os.dup2(empty.fileno(), 0)
    sys.stdout = sys.__stdout__ = sys.stderr
    sys.stdin = sys.__stdin__ = open(os.devnull)
    file = _request.get("file")
    sys.argv = [file or "-c", *_request.get("argv", [])]
    sys.path.insert(0, os.path.dirname(file) if file else os.getcwd())
    if file:
        runpy.run_path(file, run_name="__main__")
    else:
        module = ModuleType("__main__")
        sys.modules["__main__"] = module
        exec(compile(_request["source"], "<kinex-exec>", "exec"), module.__dict__)
