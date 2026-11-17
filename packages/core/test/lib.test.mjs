import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-lib-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
after(() => rm(globals, { recursive: true, force: true }))
const { createKinexRuntime, executeRoboticsCommand } = await import('../dist/index.js')
const { scanPython } = await import('../dist/lib/python.js')
const library = fileURLToPath(new URL('../assets/python', import.meta.url))

const TRICKY = `#!/usr/bin/env python3
# A comment before the docstring.
r"""Tricky module: a \\d raw docstring.

    Indented detail.
"""
import os

TEXT = """
def hidden_in_string(): pass
"""
SHAPES = {
    "a": (1,
def_not_a_function := 2),
}


@decorator(option="(")
async def grasp(
    arm: str,
    pose: list[float],  # def inside(a comment):
    *,
    label: str = "a: (b) # not a comment",
    limits: dict[str, tuple[float, float]] = {"x": (0, 1)},
) -> dict[str, float]:
    """Close the gripper at a pose.

    Returns the measured width.
    """
    def inner(): pass
    return {}


def plain(a, b=lambda x: x, *args, **kwargs): return a
def replaced(old): "old"
def replaced(new: int) -> int:
    'The later definition wins.'
def _private(): """Hidden."""
class Controller:
    def method(self): pass
if os.name:
    def conditional(): pass
def undocumented(x): x = 'not a docstring'; return x
`

test('source scanning reads docstrings and top-level function headers as written', () => {
  const { doc, functions } = scanPython(TRICKY)
  assert.equal(doc, 'Tricky module: a \\d raw docstring.\n\nIndented detail.')
  assert.deepEqual(functions.map(item => [item.name, item.signature, item.doc]), [
    ['grasp', 'async def grasp(arm: str, pose: list[float], *, label: str = "a: (b) # not a comment", limits: dict[str, tuple[float, float]] = {"x": (0, 1)}) -> dict[str, float]',
      'Close the gripper at a pose.\n\nReturns the measured width.'],
    ['plain', 'def plain(a, b=lambda x: x, *args, **kwargs)', ''],
    ['replaced', 'def replaced(new: int) -> int', 'The later definition wins.'],
    ['undocumented', 'def undocumented(x)', ''],
  ])
  assert.equal(functions[0].line, TRICKY.split('\n').findIndex(line => line.startsWith('async def grasp')) + 1)
  assert.deepEqual(scanPython(''), { doc: '', functions: [] })
  assert.deepEqual(scanPython('x = 1\n"""not first"""\n'), { doc: '', functions: [] })
})

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kinex-lib-'))
  const directory = path.join(root, 'project/nested')
  const roots = { near: path.join(directory, '.kinex/lib'), far: path.join(root, 'project/.kinex/lib'), global: path.join(globals, 'config/lib') }
  const write = async (base, file, text) => {
    await mkdir(path.dirname(path.join(roots[base], file)), { recursive: true })
    await writeFile(path.join(roots[base], file), text)
  }
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); await rm(roots.global, { recursive: true, force: true }) })
  return { runtime, directory, roots, write, node: target => runtime.tools.call('lib', target === undefined ? {} : { path: target }, { sessionID: 'lib' }).then(result => {
    assert.ok(!result.isError, result.output)
    return JSON.parse(result.output)
  }) }
}

async function structure(f) {
  // A package and a module of one name in one root; the package wins.
  await f.write('near', 'tabletop/__init__.py', '"""Tabletop tasks for this cell.\n\nPoses are in arm/base."""\nfrom kinex.lib import motion\n\nasync def pick(object: str, attempts: int = 3) -> dict:\n    """Pick an object."""\n    return {}\n\ndef grasping():\n    """Collides with the submodule."""\n')
  await f.write('near', 'tabletop.py', '"""Shadowed by the package."""\ndef shadowed(): pass\n')
  await f.write('near', 'tabletop/grasping.py', '"""Grasp primitives."""\ndef grasp(arm: str, width_m: float = 0.08) -> bool:\n    """Close on an object."""\n    return True\n')
  await f.write('near', 'tabletop/_private.py', 'def secret(): pass\n')
  await f.write('near', 'tabletop/weights/model.bin', 'data')
  await f.write('near', 'my-module.py', 'def unreachable(): pass\n')
  // A workspace module replaces the builtin of its name; a farther root is hidden by a nearer one.
  await f.write('near', 'motion.py', '"""Workspace motion."""\ndef move(arm: str): pass\n')
  await f.write('far', 'motion.py', '"""Hidden by the nearer workspace."""\ndef hidden(): pass\n')
  // Directories without __init__.py merge across roots, to any depth.
  await f.write('near', 'skills/a/reach.py', '"""Reach."""\nasync def reach(arm: str, pose: list[float]): pass\n')
  await f.write('far', 'skills/b/deep/push.py', '"""Push."""\ndef push(distance_m: float): pass\n')
  await f.write('global', 'skills/shared.py', '"""Shared across workspaces."""\ndef wave(): pass\n')
  // A module in a later root beats a bare directory in an earlier one.
  await f.write('near', 'scene/notes.py', 'def unreachable(): pass\n')
  await f.write('far', 'scene.py', '"""Scene queries."""\ndef objects(): pass\n')
}

test('the lib tool navigates any structure one level at a time, as Python imports it', async t => {
  const f = await fixture(t)
  await structure(f)
  const root = await f.node()
  assert.equal(root.node.kind, 'module')
  assert.match(root.node.doc, /^The Kinex function library/)
  const modules = Object.fromEntries(root.node.modules.map(item => [item.name, item]))
  assert.deepEqual(Object.keys(modules), ['frames', 'images', 'kinematics', 'motion', 'perception', 'scene', 'skills', 'tabletop'])
  assert.deepEqual(modules.motion, { name: 'motion', origin: 'workspace', summary: 'Workspace motion.' })
  assert.deepEqual(modules.tabletop, { name: 'tabletop', origin: 'workspace', summary: 'Tabletop tasks for this cell.' })
  assert.deepEqual(modules.skills, { name: 'skills', origin: null, summary: '' })
  assert.equal(modules.frames.origin, 'builtin')
  assert.deepEqual(root.problems, [`${path.join(f.roots.near, 'my-module.py')}: not importable, its name is not a Python identifier`])

  const tabletop = await f.node('tabletop')
  assert.deepEqual(tabletop.node, { kind: 'module', path: 'tabletop', file: path.join(f.roots.near, 'tabletop/__init__.py'), origin: 'workspace',
    doc: 'Tabletop tasks for this cell.\n\nPoses are in arm/base.', modules: [{ name: 'grasping', origin: 'workspace', summary: 'Grasp primitives.' }], functions: ['pick', 'grasping'] })
  assert.match(tabletop.problems[0], /tabletop\.grasping is both a module and a function/)
  assert.deepEqual((await f.node('tabletop.pick')).node, { kind: 'function', path: 'tabletop.pick', file: path.join(f.roots.near, 'tabletop/__init__.py'), line: 6,
    signature: 'async def pick(object: str, attempts: int = 3) -> dict', doc: 'Pick an object.' })
  assert.equal((await f.node('tabletop.grasping')).node.kind, 'module')
  assert.equal((await f.node('tabletop.grasping.grasp')).node.signature, 'def grasp(arm: str, width_m: float = 0.08) -> bool')
  assert.deepEqual((await f.node('motion')).node.functions, ['move'])
  assert.deepEqual((await f.node('scene')).node.functions, ['objects'])
  const skills = await f.node('skills')
  assert.deepEqual([skills.node.file, skills.node.origin, skills.node.functions], [null, null, []])
  assert.deepEqual(skills.node.modules, [{ name: 'a', origin: null, summary: '' }, { name: 'b', origin: null, summary: '' }, { name: 'shared', origin: 'global', summary: 'Shared across workspaces.' }])
  assert.equal((await f.node('skills.b.deep.push.push')).node.signature, 'def push(distance_m: float)')
  for (const missing of ['absent', 'tabletop.absent', 'tabletop.pick.deeper', 'tabletop._private', 'motion.trajectory', 'scene.notes']) {
    const result = await f.runtime.tools.call('lib', { path: missing }, { sessionID: 'lib' })
    assert.equal(result.isError, true, missing)
    assert.match(result.output, /kinex\.lib has no module or function/)
  }
  for (const invalid of ['a..b', '.a', 'a.', 'a-b', '1a']) assert.equal((await f.runtime.tools.call('lib', { path: invalid }, { sessionID: 'lib' })).isError, true)
  const context = (await f.runtime.context()).lib
  assert.match(context, /- tabletop \(workspace\): Tabletop tasks for this cell\./)
  assert.match(context, /- frames \(builtin\): /)
  assert.ok(!context.includes('pick'))
  const listed = await executeRoboticsCommand(f.runtime, 'lib', 'tabletop.grasping.grasp', { sessionID: 'user', confirm: async () => true })
  assert.equal(JSON.parse(listed.text).node.doc, 'Close on an object.')
})

test('the scanned tree matches what Python imports and inspects', async t => {
  const f = await fixture(t)
  await structure(f)
  const walk = async (target = '') => {
    const { node } = await f.node(target || undefined)
    const prefix = target ? `${target}.` : ''
    const functions = await Promise.all(node.functions.map(async name => (await f.node(prefix + name)).node))
    // Where a submodule and a function share a name, the path resolves to the module.
    const own = { [target]: { file: node.file, functions: Object.fromEntries(functions.filter(item => item.kind === 'function').map(item => [item.path.split('.').at(-1), item.signature])) } }
    return Object.assign(own, ...await Promise.all(node.modules.map(item => walk(prefix + item.name))))
  }
  const scanned = await walk()
  const oracle = `import importlib, inspect, json, sys
result = {}
for target in json.loads(sys.argv[1]):
    module = importlib.import_module("kinex.lib" + ("." + target if target else ""))
    functions = {name: list(inspect.signature(value).parameters) for name, value in vars(module).items()
                 if inspect.isfunction(value) and value.__module__ == module.__name__ and not name.startswith("_")}
    result[target] = {"file": getattr(module, "__file__", None), "functions": functions}
print(json.dumps(result))`
  const imported = JSON.parse(execFileSync(process.env.PYTHON ?? 'python3', ['-c', oracle, JSON.stringify(Object.keys(scanned))], {
    env: { ...process.env, PYTHONPATH: library, PYTHONDONTWRITEBYTECODE: '1', KINEX_LIB: [f.roots.near, f.roots.far, f.roots.global].join(path.delimiter) }, encoding: 'utf8',
  }))
  assert.ok(Object.keys(scanned).length > 12)
  for (const [target, node] of Object.entries(scanned)) {
    assert.equal(node.file, imported[target].file, target)
    // The collision's function is replaced by the submodule on import as well.
    const names = Object.keys(imported[target].functions).filter(name => !(`${target}.${name}` in scanned))
    assert.deepEqual(Object.keys(node.functions).sort(), names.sort(), target)
    for (const name of names) for (const parameter of imported[target].functions[name])
      assert.match(node.functions[name], new RegExp(`[(, *]${parameter}\\b`), `${target}.${name}`)
  }
})

test('every builtin lib module and function documents itself', async t => {
  const f = await fixture(t)
  const root = await f.node()
  assert.deepEqual(root.problems, [])
  assert.deepEqual(root.node.modules.map(item => item.name), ['frames', 'images', 'kinematics', 'motion', 'perception'])
  for (const item of root.node.modules) {
    assert.equal(item.origin, 'builtin')
    const { node, problems } = await f.node(item.name)
    assert.deepEqual(problems, [])
    assert.ok(node.doc && item.summary === node.doc.split('\n')[0] && item.summary.endsWith('.'), item.name)
    assert.ok(node.functions.length, item.name)
    for (const name of node.functions) {
      const found = (await f.node(`${item.name}.${name}`)).node
      assert.ok(found.doc, found.path)
      assert.ok(!/\bio\b/.test(found.signature), `${found.path} takes the ambient scope, not an io parameter`)
    }
  }
})
