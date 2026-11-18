"""Entry point for exec: run a program as __main__ inside the invocation's communication
scope, release that scope, and return what finish left through the host dialog."""

import asyncio
import linecache
import os
import sys
from types import ModuleType

from kinex import _emit, _request
from kinex.communication import Communication, ambient

SOURCE = "<exec>"


def program():
    """Execute the request's file or source as the __main__ module."""
    file = _request.get("file")
    if file:
        with open(file, "rb") as handle:
            source = handle.read()
    else:
        source = _request["source"]
        linecache.cache[SOURCE] = (len(source), None, source.splitlines(True), SOURCE)
    sys.argv = [file or SOURCE, *_request.get("argv", [])]
    sys.path.insert(0, os.path.dirname(file) if file else os.getcwd())
    module = sys.modules["__main__"] = ModuleType("__main__")
    if file:
        module.__file__ = file
    exec(compile(source, file or SOURCE, "exec"), module.__dict__)


def run():
    """Run the program and release its scope; the payload finish left, or None without one."""
    payload = failure = None
    with ambient(Communication()) as scope:
        try:
            program()
        except SystemExit as exit:
            payload = getattr(exit, "payload", None)
            failure = None if exit.code in (None, 0) else exit
        except BaseException as error:
            failure = error
        if scope.opened:
            # The program's own loop has ended: success flushes its commands, failure stops its devices.
            asyncio.run(scope.close(failure))
    if failure:
        raise failure
    return payload


def trimmed(trace):
    """The traceback past this runner's own frames."""
    while trace and trace.tb_frame.f_code.co_filename == __file__:
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
        payload = run()
    except Exception as error:
        sys.excepthook(type(error), error, trimmed(error.__traceback__))
        sys.exit(1)
    if payload is not None:
        _emit(payload)
