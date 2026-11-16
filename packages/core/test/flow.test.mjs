import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-flow-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
after(() => rm(globals, { recursive: true, force: true }))
const { createKinexRuntime, executeRoboticsCommand } = await import('../dist/index.js')
const { flowChart, flowPage, FlowStep } = await import('../dist/lib/flow.js')
const builtin = fileURLToPath(new URL('../assets/python/kinex/lib', import.meta.url))

const TABLETOP = `"""Pick and place on a table."""
import asyncio

from kinex import io, lib
from kinex.lib.frames import transform_pose
from . import grasp


async def watch(limit):
    """Stop when the wrist force exceeds a limit."""
    async with io.subscribe("arm.wrench") as wrench:
        async for sample in wrench:
            if abs(sample.force.z) > limit:
                raise RuntimeError("contact")


async def move(pose, duration=2.0):
    target = await transform_pose(pose, "world", "arm/base")
    await io.publish("arm.pose_target", {"pose": target, "duration": duration})
    await io.request("world.wait", duration_s=duration)


async def pick_place(object: str, place: list, retries: int = 2) -> dict:
    """Pick an object and place it at a pose. </script>"""
    guard = asyncio.create_task(watch(30.0))
    try:
        for attempt in range(retries + 1):
            found = await lib.perception.locate_object_3d("head_camera", "detector", object)
            if found is None:
                continue
            above = [found[0], found[1], found[2] + 0.1, 1, 0, 0, 0]
            await asyncio.gather(move(above), io.publish("gripper.target", {"data": 1.0}))
            held = await grasp.close(found)
            if held:
                break
        else:
            raise RuntimeError(f"could not grasp {object}")
        async with asyncio.timeout(20):
            await move(place)
            await asyncio.sleep(0.5)
        state = await io.read("arm.joint_state")
        return {"object": object, "joints": list(state.position)}
    finally:
        guard.cancel()
`

const GRASP = `"""Grasping."""
from kinex import io


def _width(state):
    total = 0
    for value in state.position:
        if value < 0:
            continue
        total += value
    return total


async def close(pose, force=20.0):
    """Close the gripper and report whether something is held."""
    await io.publish("gripper.target", {"data": 0.0, "force": force})
    for _ in range(10):
        state = await io.subscribe("gripper.joint_state").next(timeout_s=1)
        if _width(state) > 0.002:
            return True
    return False
`

const PATTERNS = `"""Concurrency patterns."""
import asyncio
from asyncio import gather

from kinex import io, lib
from kinex.lib.tasks import pick_place
from .grasp import close as grip


async def sweep(arms, mode):
    async def reach(arm):
        await io.publish(f"{arm}.pose_target", {})

    await gather(*(reach(arm) for arm in arms))
    tasks = [asyncio.create_task(reach(arm)) for arm in arms]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    state = await asyncio.wait_for(io.read("arm.joint_state"), 2)
    total = await asyncio.to_thread(score, state)
    if mode == "pick":
        await pick_place("cup", [0, 0, 0])
    elif mode == "grip":
        await grip(None)
    elif await lib.motion.ready():
        total += 1
    else:
        total = 0
    while True:
        await asyncio.sleep(0.1)
        if total:
            break
    return await lib.missing.program(total)


def score(state):
    with open("weights") as handle:
        weights = handle.read()
    return sum(state.position)


async def again(count):
    if count:
        await again(count - 1)
`

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kinex-flow-'))
  const directory = path.join(root, 'project')
  const lib = path.join(directory, '.kinex/lib')
  const write = async (file, text) => {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), text)
  }
  await write('.kinex/lib/tasks/__init__.py', '"""Tabletop tasks."""\nfrom .tabletop import pick_place\n')
  await write('.kinex/lib/tasks/tabletop.py', TABLETOP)
  await write('.kinex/lib/tasks/grasp.py', GRASP)
  await write('.kinex/lib/tasks/patterns.py', PATTERNS)
  // A workspace module replaces the builtin of its name.
  await write('.kinex/lib/motion.py', '"""Workspace motion."""\nasync def ready():\n    return True\n')
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const chart = target => runtime.operation(() => flowChart(directory, target))
  return { runtime, directory, lib, write, chart }
}

// Steps without their line numbers, compact enough to compare whole charts.
const shape = steps => steps.map(step => {
  FlowStep.parse(step)
  switch (step.kind) {
    case 'io': return `${step.verb} ${step.operation}${step.dynamic ? ' (dynamic)' : ''}`
    case 'call': return `call ${step.label}${step.target ? '' : ' (opaque)'}`
    case 'compute': return `compute ${step.names.join(',')}`
    case 'wait': return step.label
    case 'exit': return `${step.how} ${step.label}`.trim()
    case 'join': case 'cancel': return `${step.kind} ${step.task}`
    case 'branch': return { if: step.arms.map(arm => [arm.condition, shape(arm.body)]), else: shape(step.orelse) }
    case 'loop': return { loop: step.header, body: shape(step.body), else: shape(step.orelse) }
    case 'scope': return { scope: step.label, timeout: step.timeout, body: shape(step.body) }
    case 'try': return { try: shape(step.body), on: step.handlers.map(handler => [handler.exception, shape(handler.body)]), else: shape(step.orelse), finally: shape(step.final) }
    case 'parallel': return { parallel: step.mode, branches: step.branches.map(branch => [branch.each, shape(branch.body)]) }
    case 'spawn': return { spawn: step.task, body: shape(step.body) }
    default: throw new Error(`unknown step ${step.kind}`)
  }
})
const named = (flow, name) => Object.values(flow.functions).find(item => item.path === name)

test('a program charts as device operations, calls, computation and the control flow around them', async t => {
  const f = await fixture(t)
  const flow = await f.chart('tasks.tabletop.pick_place')
  assert.deepEqual(flow.problems, [])
  const entry = flow.functions[flow.entry]
  assert.deepEqual([entry.path, entry.name, entry.file, entry.line, entry.signature, entry.doc], ['tasks.tabletop.pick_place', 'pick_place', path.join(f.lib, 'tasks/tabletop.py'), 23,
    'async def pick_place(object: str, place: list, retries: int=2) -> dict', 'Pick an object and place it at a pose. </script>'])
  assert.equal(entry.source.split('\n').length, entry.end - entry.line + 1)
  assert.match(entry.source, /^async def pick_place/)
  assert.deepEqual(shape(entry.body), [
    { spawn: 'guard', body: ['call watch'] },
    { try: [
      { loop: 'for attempt in range(retries + 1)', body: [
        'call perception.locate_object_3d',
        { if: [['found is None', ['continue']]], else: [] },
        'compute above',
        { parallel: 'all', branches: [[null, ['call move']], [null, ['publish gripper.target']]] },
        'call tasks.grasp.close',
        { if: [['held', ['break']]], else: [] },
      ], else: ["raise RuntimeError(f'could not grasp {object}')"] },
      { scope: 'timeout 20 s', timeout: true, body: ['call move', 'sleep 0.5 s'] },
      'read arm.joint_state',
      "return {'object': object, 'joints': list(state.position)}",
    ], on: [], else: [], finally: ['cancel guard'] },
  ])
  // Every step carries the lines it came from, inside its function.
  const lines = steps => steps.flatMap(step => [step, ...['body', 'orelse', 'final'].flatMap(key => lines(step[key] ?? [])),
    ...[...(step.arms ?? []), ...(step.handlers ?? []), ...(step.branches ?? [])].flatMap(item => lines(item.body))])
  for (const step of lines(entry.body)) assert.ok(entry.line <= step.line && step.line <= step.end && step.end <= entry.end, JSON.stringify(step))

  // A call opens the callee's own chart, across modules and into the builtin library.
  const call = (fn, label) => lines(fn.body).find(step => step.kind === 'call' && step.label === label)
  assert.equal(flow.functions[call(entry, 'tasks.grasp.close').target].path, 'tasks.grasp.close')
  assert.equal(flow.functions[call(entry, 'perception.locate_object_3d').target].file, path.join(builtin, 'perception.py'))
  assert.deepEqual(shape(named(flow, 'tasks.tabletop.watch').body), [
    { scope: 'subscribed to arm.wrench', timeout: false, body: [
      { loop: 'for sample in each message of arm.wrench', body: ['next arm.wrench', { if: [['abs(sample.force.z) > limit', ["raise RuntimeError('contact')"]]], else: [] }], else: [] },
    ] },
  ])
  assert.deepEqual(shape(named(flow, 'tasks.tabletop.move').body), ['call frames.transform_pose', 'publish arm.pose_target', 'request world.wait'])
  assert.equal(flow.functions[call(named(flow, 'tasks.tabletop.move'), 'frames.transform_pose').target].path, 'frames.transform_pose')
  assert.deepEqual(shape(named(flow, 'tasks.grasp.close').body), [
    'publish gripper.target',
    { loop: 'for _ in range(10)', body: ['next gripper.joint_state', 'call _width', { if: [['_width(state) > 0.002', ['return True']]], else: [] }], else: [] },
    'return False',
  ])
  // Control flow that only computes folds into the computation, with its loop's own continue.
  assert.deepEqual(shape(named(flow, 'tasks.grasp._width').body), ['compute total,value', 'return total'])
})

test('concurrency, dynamic names and unresolved calls have their own steps', async t => {
  const f = await fixture(t)
  const flow = await f.chart('tasks.patterns.sweep')
  const entry = flow.functions[flow.entry]
  assert.deepEqual(shape(entry.body), [
    { parallel: 'all', branches: [['for arm in arms', ['call reach']]] },
    { loop: 'for arm in arms', body: [{ spawn: null, body: ['call reach'] }], else: [] },
    { parallel: 'first', branches: [['for each of tasks', []]] },
    { scope: 'timeout 2 s', timeout: true, body: ['read arm.joint_state'] },
    'call score',
    { if: [["mode == 'pick'", ['call tasks.pick_place']], ["mode == 'grip'", ['call tasks.grasp.close']]], else: ['call motion.ready', 'compute total'] },
    { loop: 'repeat', body: ['sleep 0.1 s', { if: [['total', ['break']]], else: [] }], else: [] },
    'call missing.program (opaque)',
    'return await lib.missing.program(total)',
  ])
  const targets = Object.fromEntries(entry.body.flatMap(step => step.kind === 'branch' ? [...step.arms.flatMap(arm => arm.body), ...step.orelse] : [step])
    .filter(step => step.kind === 'call' && step.target).map(step => [step.label, flow.functions[step.target]]))
  // Library calls are named by their library path however the code imports them: a re-export is
  // followed to its definition, an alias to its function, and a workspace module replaces the builtin.
  assert.deepEqual(shape(named(flow, 'tasks.patterns.sweep.reach').body), ["publish f'{arm}.pose_target' (dynamic)"])
  assert.equal(targets['tasks.pick_place'].path, 'tasks.tabletop.pick_place')
  assert.equal(targets['tasks.grasp.close'].path, 'tasks.grasp.close')
  assert.equal(targets['motion.ready'].file, path.join(f.lib, 'motion.py'))
  assert.deepEqual(shape(targets.score.body), ['compute handle,weights', 'return sum(state.position)'])

  const again = await f.chart('tasks.patterns.again')
  assert.deepEqual(Object.keys(again.functions), [again.entry])
  assert.equal(again.functions[again.entry].body[0].arms[0].body[0].target, again.entry)
})

test('a file outside the library charts its main, another function, and its sibling modules', async t => {
  const f = await fixture(t)
  await f.write('scripts/steps.py', 'from kinex import io\n\nasync def nudge(arm):\n    await io.publish(arm + ".joint_target", {})\n')
  await f.write('scripts/run.py', 'import steps\nfrom kinex.lib.tasks.grasp import close\n\nasync def main(arm="left"):\n    await steps.nudge(arm)\n    return await close(None)\n\ndef helper():\n    return 1\n')
  const flow = await f.chart('scripts/run.py')
  const entry = flow.functions[flow.entry]
  assert.equal(entry.path, 'run.py:main')
  assert.deepEqual(shape(entry.body), ['call steps.nudge', 'call tasks.grasp.close', 'return await close(None)'])
  assert.deepEqual(Object.values(flow.functions).map(item => item.path).sort(), ['run.py:main', 'steps.py:nudge', 'tasks.grasp._width', 'tasks.grasp.close'])
  assert.deepEqual(shape(named(flow, 'steps.py:nudge').body), ["publish arm + '.joint_target' (dynamic)"])
  assert.equal((await f.chart(`${path.join(f.directory, 'scripts/run.py')}:helper`)).functions[`${path.join(f.directory, 'scripts/run.py')}::helper`].name, 'helper')

  await assert.rejects(f.chart('scripts/run.py:absent'), /defines no function absent; it defines main, helper/)
  await assert.rejects(f.chart('tasks.tabletop'), /tasks\.tabletop is a module; chart one of its functions: watch, move, pick_place/)
  await assert.rejects(f.chart('tasks.absent.program'), /kinex\.lib has no module or function/)
  await f.write('scripts/broken.py', 'def main(:\n')
  await assert.rejects(f.chart('scripts/broken.py'), /broken\.py/)
  // A callee that does not parse is reported and left closed; the chart still draws.
  await f.write('.kinex/lib/motion.py', 'def ready(:\n')
  const partial = await f.chart('tasks.patterns.sweep')
  assert.match(partial.problems[0], /motion\.py/)
  assert.ok(partial.functions[partial.entry].body.some(step => step.kind === 'branch'))
})

test('/visualize writes a self-contained page that carries the chart', async t => {
  const f = await fixture(t)
  const context = { sessionID: 'user', confirm: async () => true }
  const written = await executeRoboticsCommand(f.runtime, 'visualize', 'tasks.tabletop.pick_place', context)
  const file = path.join(f.directory, '.kinex/flow/tasks.tabletop.pick_place.html')
  assert.match(written.text, /^Flow chart of tasks\.tabletop\.pick_place \(\d+ functions\): /)
  assert.ok(written.text.endsWith(file))
  const page = await readFile(file, 'utf8')
  // The page needs nothing else, and no program text can end its script.
  assert.ok(!/<script[^>]*\ssrc=|<link\s|@import|https?:\/\//.test(page))
  assert.equal(page.match(/<\/script>/g).length, 2)
  const flow = await f.chart('tasks.tabletop.pick_place')
  assert.deepEqual(JSON.parse(/const FLOW = (.*)<\/script>/.exec(page)[1]), flow)
  assert.equal(await flowPage(flow), page)

  const chosen = path.join(f.directory, 'charts/close.html')
  const named = await executeRoboticsCommand(f.runtime, 'visualize', 'tasks.grasp.close charts/close.html', context)
  assert.ok(named.text.endsWith(`(2 functions): ${chosen}`))
  assert.match(await readFile(chosen, 'utf8'), /tasks\.grasp\._width/)
  for (const usage of ['', 'a b c']) await assert.rejects(executeRoboticsCommand(f.runtime, 'visualize', usage, context), /Usage: \/visualize/)

  // The viewer draws every kind of step the schema defines.
  const kinds = FlowStep.options.map(option => option.shape.kind.value)
  assert.equal(kinds.length, 13)
  const drawn = /const DRAW = \{([\s\S]*?)\n\}/.exec(page)[1]
  for (const kind of kinds) assert.match(drawn, new RegExp(`\\n  ${kind}[:,]`), kind)
})
