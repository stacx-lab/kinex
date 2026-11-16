"""Entry point for exec: run source, a file's main or a lib program inside the
invocation's communication scope and return its result through the host dialog."""

import ast
import asyncio
import importlib.util
import inspect
import linecache
import os
import sys

from kinex import _emit, _request, io, lib, runtime
from kinex.common.plain import plain
from kinex.communication import Communication, ambient

SOURCE = "<exec>"


def body(source):
    """Source compiled as the body of an async function, so it may await and return."""
    module = ast.parse("async def main(): pass", SOURCE)
    module.body[0].body = ast.parse(source, SOURCE).body or module.body[0].body
    linecache.cache[SOURCE] = (len(source), None, source.splitlines(True), SOURCE)
    sys.path.insert(0, os.getcwd())
    scope = {"__name__": "__main__", "args": _request["args"], "io": io, "lib": lib, "runtime": runtime}
    exec(compile(module, SOURCE, "exec"), scope)
    return scope["main"]()


def script(file):
    """A file outside lib, loaded as a module; its main receives args as keywords."""
    sys.argv = [file, *_request.get("argv", [])]
    sys.path.insert(0, os.path.dirname(file))
    spec = importlib.util.spec_from_file_location("kinex_exec_file", file)
    module = sys.modules[spec.name] = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "main", None)):
        raise LookupError(f"{file} defines no main function")
    return module.main(**_request["args"])


def program(path):
    """A public function of a kinex.lib module, addressed as module.function."""
    module, _, name = path.rpartition(".")
    try:
        function = None if not module or name.startswith("_") else getattr(importlib.import_module(f"kinex.lib.{module}"), name, None)
    except ModuleNotFoundError as error:
        if not f"kinex.lib.{module}.".startswith(f"{error.name}."):
            raise
        function = None
    if not inspect.isroutine(function):
        raise LookupError(f"kinex.lib has no program {path}; browse the library with the lib tool")
    return function(**_request["args"])


async def main():
    with ambient(Communication()) as scope:
        try:
            if "program" in _request:
                result = program(_request["program"])
            else:
                result = script(_request["file"]) if "file" in _request else body(_request["source"])
            if inspect.isawaitable(result):
                result = await result
        except BaseException as error:
            await scope.close(error)
            raise
        await scope.close()
        return result


def trimmed(trace):
    """The traceback from the first frame outside this runner and asyncio."""
    hidden = (__file__, os.path.dirname(asyncio.__file__) + os.sep)
    while trace.tb_next and trace.tb_frame.f_code.co_filename.startswith(hidden):
        trace = trace.tb_next
    return trace


if __name__ == "__main__":
    # kinex has duplicated the protocol descriptors and consumed startup. Raw
    # writes and subprocess output now join print() on the diagnostic stream.
    os.dup2(2, 1)
    with open(os.devnull) as empty:
        os.dup2(empty.fileno(), 0)
    sys.stdout = sys.__stdout__ = sys.stderr
    sys.stdin = sys.__stdin__ = open(os.devnull)
    try:
        result = asyncio.run(main())
    except Exception as error:
        sys.excepthook(type(error), error, trimmed(error.__traceback__))
        sys.exit(1)
    files = []
    _emit({"return": plain(result, files), "files": files})
