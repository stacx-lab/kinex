"""Entry point for Python invocations: `exec` runs a script or source with the dialog kept
private; `tool FILE` runs a tool's async main(values, io) in an invocation-scoped
communication context and returns its result."""

import asyncio
import importlib.util
import os
import runpy
import sys
import uuid
from types import ModuleType

from kinex import _request, args, finish
from kinex.communication import communication


def tool(file, values):
    spec = importlib.util.spec_from_file_location("kinex_tool_" + uuid.uuid4().hex, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    async def invoke():
        async with communication() as io:
            return await module.main(values, io)
    return asyncio.run(invoke())


def script():
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


if __name__ == "__main__":
    if sys.argv[1] == "tool":
        finish(tool(sys.argv[2], args()))
    else:
        script()
