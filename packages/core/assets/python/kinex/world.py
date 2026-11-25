"""World time for a program: the world device's now and wait, and what a program awaits through them.

Every world serves the same operations. Where time passes by itself, in the real world and in a realtime
simulator, a wait only blocks the program. A stepped simulator advances only during a wait and rests otherwise.
A program's tasks may wait at once, for time and for goals of theirs to end, while the world admits one wait at a
time: a driver asks the world to wait until the earliest time any task waits for, without end when they wait for
goals alone, and a world that executes goals ends that wait when one ends. At its reply the tasks it concerns
resume before the next.
"""
import asyncio
import contextlib
import heapq
import itertools
import math
from collections import namedtuple
from numbers import Real

from kinex.communication import NOW, scope
from kinex.errors import OperationError, RPCError

Now = namedtuple("Now", "time_s used_s max_s")


class World:
    def __init__(self, scope):
        self.scope = scope
        self.deadlines, self.order = [], itertools.count()  # (world time, order, future), earliest first
        self.fresh = []  # (seconds, future): waits for time the driver has yet to place on the world's clock
        self.waits = []  # for each task that waits, its futures and the goal each one awaits, if any
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
        """(time_s, used_s, max_s): world time in seconds, and the seconds of it the time budget has used and
        allows. Without a budget both are None, as is max_s without a limit."""
        reply = await self.scope._request(*self._operation("now"), {})
        return Now(*(value if math.isfinite(value) else None for value in (reply.time_s, reply.used_s, reply.max_s)))

    async def wait(self, seconds):
        """Wait seconds of world time and return the world time reached. A stepped simulator advances only while a
        program waits, for time or for a goal: wait(0) is a barrier that lets no time pass.

        Example: await world.wait(0.5)
        """
        if not isinstance(seconds, Real) or isinstance(seconds, bool) or not 0 <= seconds < math.inf:
            raise TypeError("a world waits for nonnegative seconds of world time")
        return await self._until(seconds=seconds)

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

    async def _over(self, goal):
        """Wait until a goal has ended, as world time passes: what awaiting a goal does."""
        if goal.task.done():
            return
        if self.broken is None:
            self.broken = self.scope.open().loop.create_future()
        broken = self.broken
        with self._blocked({goal.task: goal, broken: None}):
            await asyncio.wait({goal.task, broken}, return_when=asyncio.FIRST_COMPLETED)
            if not goal.task.done():
                raise broken.exception()

    def _advance(self, reached):
        """Resolve the deadlines up to the world time reached: to the nanosecond, so one computed from a tick
        count is due on its tick."""
        while self.deadlines and (self.deadlines[0][0] <= reached + 1e-9 or self.deadlines[0][2].done()):
            future = heapq.heappop(self.deadlines)[2]
            if not future.done():
                future.set_result(reached)

    def _changed(self):
        """What waits on the world changed: the driver considers it."""
        self.kick.set()
        if self.driver is None:
            self.driver = asyncio.ensure_future(self._drive())

    def _wanted(self):
        """What to ask of the world's wait, (world time, goals, waits yet to place): None while the world must
        rest, since a command is in flight or a task has yet to resume, or while nothing waits on it."""
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
            now, wait = self._operation("now"), self._operation("wait")
            await self.scope._enroll(wait[0])
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
                # Without a time to wait for, only goals: the wait has no end but a goal's.
                call, asked, stopped = asyncio.ensure_future(
                    self.scope._request(*wait, {"seconds": max(0., until - time_s)})), True, False
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
                self._advance(reply.time_s)
                ended = {bytes(goal.uuid) for goal in reply.ended}
                landed = [goal.task for goal in goals if bytes(goal.handle.goal_id.uuid) in ended]
                if landed:
                    # The results of the goals the world saw end arrive before it advances again.
                    await asyncio.wait(landed, timeout=10)
                elif not ended and not stopped and reply.time_s < min(until, time_s + 1e-9):
                    # The world waited for nothing: it executes none of the goals awaited, whose ends come from
                    # elsewhere. It is asked again once one has, or shortly.
                    changed = asyncio.ensure_future(self.kick.wait())
                    await asyncio.wait({changed, *(goal.task for goal in goals)}, timeout=.2, return_when=asyncio.FIRST_COMPLETED)
                    changed.cancel()
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
