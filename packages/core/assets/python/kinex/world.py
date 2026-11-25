"""World time for a program: the world device's now, wait_all and wait_any, and ticks made of them.

Every world serves the same operations. Where time passes by itself, in the real world and
in a realtime simulator, a wait only blocks the program. A stepped simulator advances only
during a wait and rests otherwise. A program's tasks may wait at once, while the world admits
one wait at a time: a driver asks the world's wait_any for the earliest time any task waits
for and the goals they await, and at its reply the tasks it concerns resume before the next.
"""
import asyncio
import contextlib
import heapq
import itertools
import math
from collections import namedtuple
from numbers import Real

from kinex.communication import NOW, Goal, scope
from kinex.errors import OperationError, RPCError

Now = namedtuple("Now", "time_s used_s max_s")


class World:
    def __init__(self, scope):
        self.scope = scope
        self.deadlines, self.order = [], itertools.count()  # (world time, order, future), earliest first
        self.fresh = []  # (seconds, future): waits for time the driver has yet to place on the world's clock
        self.waits = []  # for each wait in progress, its futures and the goal each one awaits, if any
        self.holds = 0  # commands and requests in flight, and tick bodies: a stepped world rests
        self.kick = asyncio.Event()  # what the driver considers has changed
        self.driver = self.broken = self.device = None

    def _operation(self, name):
        """The world device's operation by name: the device is the one that serves now."""
        catalog = self.scope.catalog
        if self.device is None:
            self.device = next((reference.split(".")[0] for reference, spec in catalog.items() if spec["type"] == NOW), None)
        if self.device is None:
            raise RPCError("no world: load the world device", code="world_unavailable")
        return f"{self.device}.{name}", catalog[f"{self.device}.{name}"]

    async def now(self):
        """(time_s, used_s, max_s): world time in seconds, and the seconds of it the episode has used and is
        allowed. The real world and a realtime simulator have no budget: both are None, as is max_s without a cap."""
        reply = await self.scope._request(*self._operation("now"), {})
        return Now(*(value if math.isfinite(value) else None for value in (reply.time_s, reply.used_s, reply.max_s)))

    async def wait_all(self, entries, *, timeout=None):
        """Wait until every entry is over: a number is seconds of world time from now, a goal is over once it has
        finished. With a timeout, in seconds of world time, the wait ends then with what is left, and the goals
        still executing are cancelled. Returns whether each entry was over, in order. A stepped simulator advances
        only during a wait: wait_all([0]) is a barrier that lets no time pass.

        Example: left, right = await world.wait_all([arm.action("move")(trajectory=plan), 0.5], timeout=5)
        """
        return await self._wait(entries, timeout, False)

    async def wait_any(self, entries, *, timeout=None):
        """Wait until one entry is over, as wait_all waits for all; the entries left go on, unless a timeout
        ends the wait."""
        return await self._wait(entries, timeout, True)

    def rate(self, hz):
        """Ticks hz times a second of world time: `async for now in world.rate(20)`. A tick whose time has
        passed is skipped. A stepped simulator rests while a tick's body runs."""
        return Rate(self, hz)

    @contextlib.contextmanager
    def hold(self):
        """A command or request is in flight: a stepped world rests until it has left."""
        self.holds += 1
        self.kick.set()
        try:
            yield
        finally:
            self.holds -= 1
            self.kick.set()

    def _deadline(self, seconds=None, until=None):
        """A future that world time resolves, with the time reached: seconds from now, or at world time until."""
        future = self.scope.open().loop.create_future()
        if until is None:
            self.fresh.append((seconds, future))
        else:
            heapq.heappush(self.deadlines, (until, next(self.order), future))
        return future

    @contextlib.contextmanager
    def _blocked(self, waiting):
        """A task waits on these futures, each with the goal it awaits, if any: until the task resumes, one that
        is done keeps a stepped world resting."""
        self.waits.append(waiting)
        self._changed()
        try:
            yield
        finally:
            self.waits.remove(waiting)
            for future, goal in waiting.items():
                if goal is None and future is not self.broken:
                    future.cancel()  # its own deadline
            self._changed()

    async def _until(self, **when):
        future = self._deadline(**when)
        with self._blocked({future: None}):
            return await future

    async def _wait(self, entries, timeout, first):
        for entry in entries:
            if not isinstance(entry, Goal) and not (isinstance(entry, Real) and not isinstance(entry, bool) and entry >= 0):
                raise TypeError("a world waits for goals and for nonnegative seconds of world time")
        if first and not entries:
            raise ValueError("wait_any needs an entry to wait for")
        if self.broken is None:
            self.broken = self.scope.open().loop.create_future()
        futures = [entry.task if isinstance(entry, Goal) else self._deadline(entry) for entry in entries]
        expiry, broken = self._deadline(timeout) if timeout else None, self.broken
        watched, pending = {broken, *([expiry] if expiry else [])}, set(futures)
        waiting = {**dict.fromkeys(watched), **{future: entry if isinstance(entry, Goal) else None for future, entry in zip(futures, entries)}}
        with self._blocked(waiting):
            while pending and not (expiry and expiry.done()) and not (first and len(pending) < len(set(futures))):
                done, _ = await asyncio.wait(pending | watched, return_when=asyncio.FIRST_COMPLETED)
                if broken in done:
                    raise broken.exception()
                for future in done & pending:
                    del waiting[future]  # resumed for it: it no longer keeps the world resting
                pending -= done
                self.kick.set()
            over = [future.done() for future in futures]
            if expiry and expiry.done():
                for entry in dict.fromkeys(entries):
                    if isinstance(entry, Goal) and not entry.task.done():
                        await entry.cancel()
        return over

    def _advance(self, reached, now):
        """Resolve the deadlines up to world time reached, with the world's time now: to the nanosecond, so one
        computed from a tick count is due on its tick."""
        while self.deadlines and (self.deadlines[0][0] <= reached + 1e-9 or self.deadlines[0][2].done()):
            future = heapq.heappop(self.deadlines)[2]
            if not future.done():
                future.set_result(now)

    def _changed(self):
        """What waits on the world changed: the driver considers it."""
        self.kick.set()
        if self.driver is None:
            self.driver = asyncio.ensure_future(self._drive())

    def _wanted(self):
        """What to ask of the world's wait_any, (world time, goals, waits yet to place): None while the world
        must rest, since a command is in flight or a task has yet to resume, or while nothing waits on it."""
        waiting = [item for wait in self.waits for item in wait.items()]
        goals = tuple(dict.fromkeys(goal for _, goal in waiting if goal is not None))
        if self.holds or any(future.done() for future, _ in waiting) or any(goal.status != "executing" for goal in goals):
            return None
        while self.deadlines and self.deadlines[0][2].done():
            heapq.heappop(self.deadlines)
        if self.deadlines or self.fresh or goals:
            return (self.deadlines[0][0] if self.deadlines else math.inf), goals, tuple(id(future) for _, future in self.fresh)

    def _fail(self, error):
        """The world's wait failed: every task waiting on the world learns why."""
        waiting = [future for _, _, future in self.deadlines] + [future for _, future in self.fresh] + ([self.broken] if self.broken else [])
        for future in waiting:
            if not future.done():
                future.set_exception(error)
                future.add_done_callback(lambda done: done.cancelled() or done.exception())
        self.deadlines, self.fresh, self.broken = [], [], None

    async def _halt(self, call):
        """Stop the wait a request asked for, until the request has ended: a stop that overtakes it on the way
        finds nothing to stop. A world that does not answer is left after two seconds."""
        for _ in range(10):
            await self.scope._stop([self.device])
            await asyncio.wait({call}, timeout=.2)
            if call.done():
                return
        call.cancel()

    async def _drive(self):
        call, asked = None, False  # asked: a wait the world may still be running
        try:
            now, wait_any = self._operation("now"), self._operation("wait_any")
            await self.scope._enroll(wait_any[0])
            while self.waits:
                await self.scope._flush()  # the commands sent so far have reached their devices
                self.kick.clear()
                if self._wanted() is None:
                    await self.kick.wait()
                    continue
                time_s = (await self.scope._request(*now, {})).time_s
                # A wait for seconds starts at the world time the driver reads for it.
                for seconds, future in self.fresh:
                    if not future.done():
                        heapq.heappush(self.deadlines, (time_s + seconds, next(self.order), future))
                self.fresh = []
                want = self._wanted()
                if want is None:
                    continue
                until, goals, _ = want
                call, asked, stopped = asyncio.ensure_future(self.scope._request(*wait_any, {
                    "seconds": [] if until == math.inf else [max(0., until - time_s)],
                    "goals": [{"uuid": goal.handle.goal_id.uuid} for goal in goals]})), True, False
                while not call.done():
                    changed = asyncio.ensure_future(self.kick.wait())
                    await asyncio.wait({call, changed}, return_when=asyncio.FIRST_COMPLETED)
                    changed.cancel()
                    self.kick.clear()
                    if not call.done() and self._wanted() != want:
                        # What the wait was for changed: it ends where the world is, and says where.
                        stopped = True
                        await self._halt(call)
                try:
                    reply = call.result()
                except OperationError as error:
                    reply = error.response
                    if not stopped:
                        self._fail(error)
                except asyncio.CancelledError:
                    raise TimeoutError("the world did not end its wait when stopped") from None
                asked = False
                # A wait that ran out its time reached it, whatever floating point makes of the world's steps.
                self._advance(until if any(reply.elapsed) else reply.time_s, reply.time_s)
                # The results of the goals the world saw finish arrive before it advances again.
                landed = [goal.task for goal, finished in zip(goals, reply.finished) if finished]
                if landed:
                    await asyncio.wait(landed, timeout=10)
        except BaseException as error:
            if asked:  # an abandoned wait would keep advancing a stepped world
                try:
                    await self._halt(call)
                except Exception as cleanup:
                    error.add_note(f"wait cleanup failed: {cleanup}")
            if not isinstance(error, Exception):
                raise
            self._fail(error)
        finally:
            self.driver = None

    async def close(self):
        """End the driver with its program: a wait still running stops its world."""
        if self.driver is not None:
            self.driver.cancel()
            await asyncio.gather(self.driver, return_exceptions=True)


class Rate:
    def __init__(self, world, hz):
        self.world, self.start, self.last, self.ticks, self.held = world, None, None, 0, False
        if not hz > 0:
            raise ValueError("a rate is a positive number of ticks a second")
        self.period = 1 / hz

    def __aiter__(self):
        return self

    async def __anext__(self):
        self._release()
        if self.start is None:
            self.start = self.last = await self.world._until(seconds=0)
            asyncio.current_task().add_done_callback(lambda _: self._release())
        else:
            # The next tick still ahead of the last one's time: those whose time had passed by then are skipped.
            self.ticks = max(self.ticks + 1, math.ceil((self.last - self.start) / self.period - 1e-9))
            self.last = await self.world._until(until=self.start + self.ticks * self.period)
        self.world.holds += 1
        self.held = True
        return self.last

    def _release(self):
        """The tick's body has ended: by asking for the next tick, leaving the loop or ending its task."""
        if self.held:
            self.held = False
            self.world.holds -= 1
            self.world.kick.set()

    __del__ = _release


class _Ambient:
    """`kinex.world`: the active scope's world."""

    def __getattr__(self, name):
        return getattr(scope().world, name)


world = _Ambient()
