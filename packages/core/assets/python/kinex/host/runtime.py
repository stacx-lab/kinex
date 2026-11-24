"""The resident runtime: one ROS client of a workspace's devices, which outlives the programs exec runs.

It keeps the node, the service and action clients and the publishers, so the graph is discovered once and not
by every program. A program joins it over a Unix socket and its io is carried out here, in a session that has
its own streams, goals and commanded devices. Frames are pickled values after their length: both ends are
processes of one user in one Python environment, and a goal crosses as the id its program gave it.
"""
import asyncio
import contextlib
from io import BytesIO
import itertools
import json
import os
import pickle
import socket
import sys
import threading
import traceback

from kinex.communication import Communication, Goal, Subscription

# What a program may ask of its session.
REMOTE = ("listen", "publish", "ask", "_request", "start", "cancel", "finish")


class Pickler(pickle.Pickler):
    def persistent_id(self, value):
        return value.id if isinstance(value, Sent) else None


class Unpickler(pickle.Unpickler):
    def __init__(self, data, goals):
        super().__init__(BytesIO(data))
        self.goals = goals

    def persistent_load(self, id):
        return self.goals[id]


def packed(value):
    buffer = BytesIO()
    Pickler(buffer, 5).dump(value)
    return len(buffer.getvalue()).to_bytes(8, "big") + buffer.getvalue()


def received(link):
    """The next frame's data from a blocking socket."""
    def exactly(count):
        data = bytearray()
        while len(data) < count:
            chunk = link.recv(count - len(data))
            if not chunk:
                raise EOFError("the connection closed")
            data += chunk
        return data
    return exactly(int.from_bytes(exactly(8), "big"))


# The program's end -------------------------------------------------------------------------

def join(path):
    """Connect to the runtime at path and import the types of its catalog; None when it cannot be joined."""
    from rosidl_runtime_py.utilities import get_interface
    try:
        link = socket.socket(socket.AF_UNIX)
        link.connect(path)
        for name in pickle.loads(received(link)):
            get_interface(name)
    except Exception:
        return None
    return link


def settle(future, kind, value):
    """Complete a future of another thread's loop; one whose loop has ended stays as it is."""
    def complete():
        if not future.done():
            future.set_result(value) if kind == "result" else future.set_exception(value)
    with contextlib.suppress(RuntimeError):
        future.get_loop().call_soon_threadsafe(complete)


class Sent(Goal):
    """A goal as the program that sent it holds it: the runtime reports its feedback and its end."""

    def __init__(self, io, id):
        super().__init__(io)
        self.id, self.reply = id, asyncio.get_running_loop().create_future()

    def _report(self, status, result, feedback):
        self.feedback, self.status, self.result = feedback, status, result
        if result is not None:
            settle(self.reply, "result", None)

    async def cancel(self):
        await self.io._call("cancel", self.id)


class Attached(Communication):
    """A program's io, carried out by the runtime it has joined."""

    def __init__(self, link, catalog=None):
        super().__init__(catalog)
        self.link, self.lock, self.ids = link, threading.Lock(), itertools.count()
        self.calls, self.streams, self.sent, self.own = {}, {}, {}, None

    def _acquire(self):
        threading.Thread(target=self._receive, daemon=True).start()

    def _send(self, key, method, args):
        frame = packed((key, method, args))
        with self.lock:
            self.link.sendall(frame)

    def _receive(self):
        try:
            while True:
                kind, key, value = pickle.loads(received(self.link))
                if kind == "message":
                    if key in self.streams:
                        self.streams[key]._receive(value)
                elif kind == "goal":
                    self.sent[key]._report(*value)
                elif key in self.calls:
                    settle(self.calls[key], kind, value)
        except Exception as error:
            gone = ConnectionError(f"the Kinex runtime is gone: {error}")
            self._post(self._failed, gone)
            for future in tuple(self.calls.values()):
                settle(future, "error", gone)

    async def _call(self, method, *args):
        key, future = next(self.ids), asyncio.get_running_loop().create_future()
        self.calls[key] = future
        try:
            self._send(key, method, args)
            return await future
        except asyncio.CancelledError:
            with contextlib.suppress(OSError):
                self._send(key, "drop", ())
            raise
        finally:
            del self.calls[key]

    def _listen(self, stream, depth):
        key = next(self.ids)
        self.streams[key] = stream
        self._send(key, "listen", (key, stream.spec, depth))
        return key

    def _unlisten(self, key):
        del self.streams[key]
        with contextlib.suppress(OSError):
            self._send(key, "drop", ())

    async def publish(self, operation, message):
        self.operation(operation, "topic", "input")
        await self._enroll(operation)
        await self._call("publish", operation, message)

    async def request(self, operation, *, timeout_s=None, **fields):
        self.operation(operation, "service", "input")
        await self._enroll(operation)
        return await self._call("ask", operation, timeout_s, fields)

    async def _request(self, spec, fields, timeout_s=None, *, operation=None):
        return await self._call("_request", spec, fields, timeout_s)

    async def act(self, operation, goal):
        self.operation(operation, "action", "input")
        await self._enroll(operation)
        sent = Sent(self, next(self.ids))
        self.sent[sent.id] = sent
        await self._call("start", sent.id, operation, goal)
        return sent

    def _own(self):
        """A ROS client of the program's own, for what only a node of its own does: tf and serving."""
        if self.own is None:
            self.own = Communication(self.catalog, domain_id=self.domain_id)
            self.own.namespace = self.namespace
            self.own.open()
        return self.own

    def transforms(self):
        return self._own().transforms()

    def serve(self, interface, handler):
        return self._own().serve(interface, handler)

    async def close(self, error=None):
        if not self.opened or self.closed:
            return
        succeeded = error is None or isinstance(error, SystemExit) and error.code in (None, 0)
        try:
            # The session flushes the program's commands, or stops the devices it commanded.
            note = await self._call("finish", succeeded)
        except Exception as unfinished:
            if succeeded:
                raise
            note = f"scope cleanup failed: {unfinished}"
        finally:
            self.closed = True
            for stream in tuple(self.subscriptions):
                stream.close()
            if self.own is not None:
                await self.own.close()
            self.link.shutdown(socket.SHUT_RDWR)
            self.link.close()
        if note:
            error.add_note(note)


# The runtime's end -------------------------------------------------------------------------

class Relayed(Goal):
    """A goal whose feedback and end its session reports to the program that sent it."""
    key = None

    def _feedback(self, message):
        super()._feedback(message)
        self.io._post(self.io.report, self)

    def _finished(self, reply):
        super()._finished(reply)
        self.io.report(self)


class Session(Communication):
    """One joined program's scope on the runtime's ROS client."""
    goal = Relayed

    def __init__(self, base, reader, writer):
        super().__init__(base.catalog, domain_id=base.domain_id)
        for name in ("loop", "context", "executor", "node", "clients", "publishers", "actions"):
            setattr(self, name, getattr(base, name))
        self.opened, self.reader, self.writer, self.tasks, self.goals = True, reader, writer, {}, {}

    async def _release(self):
        pass  # the runtime's client outlives its sessions

    def send(self, kind, key, value):
        if self.writer.is_closing():
            return
        try:
            frame = packed((kind, key, value))
        except Exception as error:
            frame = packed(("error", key, RuntimeError(f"{type(value).__name__} cannot cross to the program: {error}")))
        self.writer.write(frame)

    def report(self, goal):
        if goal.key is not None:
            self.send("goal", goal.key, (goal.status, goal.result, goal.feedback))

    async def listen(self, key, spec, depth):
        with Subscription(self, spec, depth) as stream:
            self.subscriptions.append(stream)
            while True:
                self.send("message", key, await stream.next())
                await self.writer.drain()

    async def ask(self, operation, timeout_s, fields):
        return await self.request(operation, timeout_s=timeout_s, **fields)

    async def start(self, key, operation, goal):
        sent = self.goals[key] = await self.act(operation, goal)
        sent.key = key
        self.report(sent)

    async def cancel(self, key):
        await self.goals[key].cancel()

    async def finish(self, succeeded):
        error = None if succeeded else RuntimeError()
        await self.close(error)
        return "\n".join(getattr(error, "__notes__", ()))

    async def call(self, key, method, args):
        try:
            self.send("result", key, await getattr(self, method)(*args))
        except Exception as error:
            self.send("error", key, error)
        finally:
            self.tasks.pop(key, None)

    async def run(self, types):
        self.writer.write(packed(types))
        try:
            while True:
                size = int.from_bytes(await self.reader.readexactly(8), "big")
                key, method, args = Unpickler(await self.reader.readexactly(size), self.goals).load()
                if method == "drop":
                    if key in self.tasks:
                        self.tasks[key].cancel()
                elif method in REMOTE:
                    self.tasks[key] = asyncio.ensure_future(self.call(key, method, args))
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            tasks = tuple(self.tasks.values())
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # A program that left without finishing has failed: its devices stop here.
            await self.close(RuntimeError("the program ended without closing its scope"))
            self.writer.close()


def failed(error):
    traceback.print_exception(error)
    os._exit(1)


async def serve(startup):
    base = Communication(startup["catalog"], domain_id=startup["domain_id"]).open()
    base._failed = failed
    # Find every service and action server now, so that no program waits for one.
    for spec in base.catalog.values():
        if spec["transport"] == "service":
            base._client(spec)
    found = [asyncio.ensure_future(base._action(spec)) for spec in base.catalog.values() if spec["transport"] == "action"]
    types = sorted({spec["type"] for spec in base.catalog.values()})
    server = await asyncio.start_unix_server(
        lambda reader, writer: Session(base, reader, writer).run(types), startup["socket"])
    print(json.dumps({"ready": True}), flush=True)
    await asyncio.to_thread(sys.stdin.read)  # the host closes stdin to end the runtime
    server.close()
    for task in found:
        task.cancel()
    await base.close()


if __name__ == "__main__":
    asyncio.run(serve(json.loads(sys.stdin.readline())))
