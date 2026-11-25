"""The workspace's Python runtime for one ROS domain: the bridge to its loaded devices, which stays up between
programs, with the exec programs that attach to it.

The host loads and unloads devices here as their nodes come and go, so a program starts with Python, ROS and its
devices' clients already up. A program is a complete script run as __main__ in a thread of its own, with a scope on
the bridge: ending it releases what it made, flushing its commands on success and stopping its devices on failure.
"""
import asyncio
import contextlib
import importlib
import linecache
import os
import signal
import sys
import time
import traceback
from types import ModuleType

import kinex
import kinex.lib
from kinex import _call, _emit, _listen, _Output
from kinex.communication import Bridge, Scope, ambient
from kinex.errors import RPCError

SOURCE = "<exec>"


def fresh(roots):
    """Forget the modules imported from roots, so a program runs the library and its helpers as they now are.
    Kinex Python's own packages, which may live under a root, stay imported."""
    kept = [sys.prefix, sys.base_prefix, os.path.dirname(kinex.__file__), os.path.join(os.environ.get("KINEX_WORKSPACE", os.sep), "python")]
    under = lambda file, folders: any(file.startswith(os.path.abspath(folder) + os.sep) for folder in folders)
    importlib.invalidate_caches()  # a root made since the last program is found
    for name, module in list(sys.modules.items()):
        file = os.path.abspath(getattr(module, "__file__", None) or os.sep)
        if under(file, roots) and not under(file, kept):
            del sys.modules[name]
            parent, _, child = name.rpartition(".")
            if parent in sys.modules:
                vars(sys.modules[parent]).pop(child, None)


def reap():
    """End the processes a program left running: they are its own, since the runtime starts none. They share the
    runtime's process group, whose signal the runtime itself sits out. Main thread."""
    if os.getpgrp() == os.getpid():
        ignored = signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.killpg(0, signal.SIGTERM)
        signal.signal(signal.SIGTERM, ignored)
        # They have ended before the program's result goes back, as when each program had a process to end.
        deadline = time.monotonic() + 1
        with contextlib.suppress(ChildProcessError):  # none left
            while time.monotonic() < deadline:
                if os.waitpid(-1, os.WNOHANG) == (0, 0):
                    time.sleep(.005)


def program(request):
    """Execute the request's file or source as the __main__ module."""
    file = request.get("file")
    if file:
        with open(file, "rb") as handle:
            source = handle.read()
    else:
        source = request["source"]
        linecache.cache[SOURCE] = (len(source), None, source.splitlines(True), SOURCE)
    sys.argv = [file or SOURCE, *request.get("argv", [])]
    sys.path.insert(0, os.path.dirname(file) if file else os.getcwd())
    module = sys.modules["__main__"] = ModuleType("__main__")
    if file:
        module.__file__ = file
    exec(compile(source, file or SOURCE, "exec"), module.__dict__)


def run(scope, request):
    """Run a program to its end in this thread and release its scope: what finish left, and its failure."""
    payload = failure = None
    state = sys.modules["__main__"], sys.argv, list(sys.path), sys.stdout, sys.stderr, kinex._request
    kinex._request, sys.stdout, sys.stderr = request, _Output(), _Output()
    os.chdir(request["cwd"])
    # The library roots beyond the shipped one, as they are now, and where the program's own helpers are.
    roots = [os.path.abspath(root) for root in request["lib"]]
    kinex.lib.__path__[:] = [*roots, os.path.dirname(kinex.lib.__file__)]
    os.environ["KINEX_LIB"] = os.pathsep.join(roots)
    fresh([*roots, os.path.dirname(request.get("file") or "") or request["cwd"]])
    try:
        with ambient(scope):
            try:
                program(request)
            except SystemExit as exit:
                payload = getattr(exit, "payload", None)
                failure = None if exit.code in (None, 0) else exit
            except BaseException as error:
                failure = error
            # The program's own loop has ended: success flushes its commands, failure stops its devices.
            try:
                asyncio.run(scope.close(failure))
            except BaseException as error:
                failure = failure or error
    finally:
        sys.modules["__main__"], sys.argv, sys.path[:], sys.stdout, sys.stderr, kinex._request = state
    return payload, failure


def failed(error):
    """A program's failure as the host reports it: an RPC error's own fields, or the traceback past this runner."""
    if isinstance(error, SystemExit):
        return {"error": f"script exited with code {error.code}"}
    if isinstance(error, asyncio.CancelledError):
        return {"error": "exec interrupted"}
    if isinstance(error, RPCError) and (error.code is not None or error.details is not None):
        return error.payload()
    trace = error.__traceback__
    while trace and trace.tb_frame.f_code.co_filename == __file__:
        trace = trace.tb_next
    return {"error": "".join(traceback.format_exception(type(error), error, trace)).rstrip()}


class Runtime:
    def __init__(self, ros):
        self.domain, self.clock = ros.get("domain_id", 0), ros.get("clock")
        self.catalog = {"_world.time": self.clock} if self.clock else {}
        self.bridge, self.tasks = None, {}
        self.programs = asyncio.Lock()  # one program at a time

    def load(self, profile):
        """A device's nodes are up: its operations join the catalog, and the bridge that programs attach to."""
        name = profile["name"]
        self.catalog.update({f"{name}.{operation}": spec for operation, spec in profile["operations"].items()})
        if self.bridge is None:
            try:
                self.bridge = Bridge(self.catalog, self.domain)
            except RPCError:  # Kinex Python without ROS: a program that reaches for a device learns why
                return
            # tf2 history kept across programs: a stamp from an earlier one stays answerable.
            from kinex.host.frame_graph import HISTORY_S
            self.bridge.transforms(HISTORY_S)
        self.bridge.tf.device(name, True)

    def unload(self, name):
        for reference in [reference for reference in self.catalog if reference.split(".")[0] == name]:
            del self.catalog[reference]
        if self.bridge is not None:
            self.bridge.unload(name)
            self.bridge.tf.device(name, False)

    async def exec(self, request):
        """Run one program: {return, files} from its finish, or {error, ...} for its failure."""
        async def enroll(device):
            await _call({"call": "ros_enroll", "device": device})
        async with self.programs:
            scope = Scope(self.bridge, catalog=self.catalog, domain_id=self.domain, enroll=enroll)
            work = asyncio.ensure_future(asyncio.to_thread(run, scope, request))
            try:
                payload, failure = await asyncio.shield(work)
            except asyncio.CancelledError:
                # Cancelled by the host: the program's tasks end, and its scope stops what it commanded. A
                # program that does not end is the host's to kill.
                if scope.opened and not scope.loop.is_closed():
                    scope.loop.call_soon_threadsafe(lambda: [task.cancel() for task in asyncio.all_tasks(scope.loop)])
                payload, failure = await work
                failure = failure or asyncio.CancelledError()
            finally:
                reap()
        return failed(failure) if failure else payload or {"return": None, "files": []}

    async def run(self, action, args):
        if action == "load":
            return self.load(args["profile"])
        if action == "unload":
            return self.unload(args["device"])
        return await self.exec(args)

    async def close(self):
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        if self.bridge is not None:
            await self.bridge.close()


async def main():
    runtime, loop, requests = Runtime(kinex._request.get("ros", {})), asyncio.get_running_loop(), asyncio.Queue()

    async def handle(identifier, action, args):
        try:
            _emit({"id": identifier, "ok": True, "data": await runtime.run(action, args)})
        except BaseException as error:
            _emit({"id": identifier, "ok": False, "error": str(error) or type(error).__name__})
        finally:
            runtime.tasks.pop(identifier, None)
    # The host's requests arrive on the dialog's reading thread; None ends the runtime with the dialog.
    _listen(lambda request: loop.call_soon_threadsafe(requests.put_nowait, request))
    try:
        while request := await requests.get():
            if "cancel" in request:
                task = runtime.tasks.get(request["cancel"])
                if task:
                    task.cancel()
            else:
                runtime.tasks[request["id"]] = asyncio.create_task(handle(request["id"], request["action"], request.get("args", {})))
    finally:
        await runtime.close()


if __name__ == "__main__":
    # kinex has duplicated the protocol descriptors and consumed startup. Raw
    # writes and subprocess output now join print() on the diagnostic stream.
    os.dup2(2, 1)
    with open(os.devnull) as empty:
        os.dup2(empty.fileno(), 0)
    sys.stdout = sys.__stdout__ = sys.stderr
    sys.stdin = sys.__stdin__ = open(os.devnull)
    asyncio.run(main())
