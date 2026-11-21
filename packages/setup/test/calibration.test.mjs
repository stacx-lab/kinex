import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKinexRuntime } from '@kinex/core'
import { createKinexSetup, setupLibRoots, setupSkillRoots, setupToolNames } from '../dist/index.js'

const globals = await mkdtemp(path.join(os.tmpdir(), 'kinex-calibration-home-'))
process.env.KINEX_CONFIG_DIR = path.join(globals, 'config')
after(() => rm(globals, { recursive: true, force: true }))
const python = process.env.PYTHON ?? 'python3'
const here = fileURLToPath(new URL('.', import.meta.url))
const env = { ...process.env, PYTHONPATH: fileURLToPath(new URL('../../core/assets/python', import.meta.url)),
  KINEX_LIB: setupLibRoots.join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1' }

for (const [name, file] of [['runs, sampling and the rigid, TCP, bias and base solvers', 'calibration.py'],
  ['board observations and camera solvers', 'camera_calibration.py'], ['camera models', 'camera_intrinsics.py']])
  test(`calibration: ${name}`, () => { execFileSync(python, [path.join(here, file)], { env, cwd: here, stdio: 'pipe' }) })

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-calibration-'))
  const runtime = createKinexRuntime({ directory, host: { ask: async () => {} }, settings: { python: { provider: 'uv' } },
    builtinSkillRoots: setupSkillRoots, builtinLibRoots: setupLibRoots, reservedToolNames: setupToolNames })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, runtime, setup: createKinexSetup(runtime), lib: async target => JSON.parse((await runtime.tools.call('lib', { path: target }, { sessionID: 'lib' })).output).node }
}

test('setup adds the calibration library to kinex.lib, documented without starting Python', async t => {
  const { lib } = await fixture(t)
  const root = await lib('')
  assert.equal(root.modules.find(module => module.name === 'calibration')?.origin, 'builtin')
  const calibration = await lib('calibration')
  assert.deepEqual(calibration.functions, ['start', 'resume'])
  assert.deepEqual(calibration.modules.map(module => module.name), ['base', 'camera', 'rigid', 'sensor', 'tcp'])
  for (const module of ['', ...calibration.modules.map(module => `.${module.name}`)]) {
    const node = await lib(`calibration${module}`)
    assert.ok(node.doc.split('\n')[0].endsWith('.'), node.path)
    for (const name of node.functions) assert.ok((await lib(`${node.path}.${name}`)).doc, `${node.path}.${name}`)
  }
})

test('exec programs run calibration solvers and setup completes nodes only from passing results', async t => {
  const { directory, runtime, setup } = await fixture(t)
  const environment = await runtime.python.initialize()
  await mkdir(path.dirname(environment.executable), { recursive: true })
  await symlink(execFileSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(), environment.executable)
  await runtime.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'mobile' } })
  await runtime.profiles.writeDevice({ description: '', name: 'base', type: 'locomotion', loaded: false, runtime: { nodes: [] },
    frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } } })
  const program = `import asyncio
from kinex import finish, lib

def check(measured):
    return {"name": "units", "expected": "normalized", "measured": measured, "reference": "SDK metadata"}

async def main():
    run = lib.calibration.start("verify-base-interface", base="base")
    finish({"passed": lib.calibration.base.verify(run, ["units"], [check("normalized")]),
            "failed": lib.calibration.base.verify(run, ["units"], [check("m/s")])})

asyncio.run(main())
`
  const executed = await runtime.tools.call('exec', { description: 'verify base units', python: program }, { sessionID: 'calibrate' })
  assert.ok(!executed.isError, executed.output)
  const { passed, failed } = JSON.parse(executed.output).result
  assert.equal(passed.run, failed.run)
  assert.deepEqual([passed.quality, failed.quality], ['passed', 'failed'])
  for (const result of [passed, failed]) assert.ok(await stat(path.join(directory, '.kinex', result.evidence)))
  await setup.plan.save({ version: 1, task: { objective: 'Base units', targets: ['units'] }, nodes: [{ id: 'units', title: 'Command units',
    kind: 'verify', skill: 'verify-base-interface', bindings: { base: 'base' } }] }, 0)
  await assert.rejects(setup.plan.record('units', { status: 'done', note: 'units differ', evidence: [failed.evidence] }, 1), /Failed computation or quality/)
  const view = await setup.plan.record('units', { status: 'done', note: 'normalized units', evidence: [passed.evidence] }, 1)
  assert.equal(view.taskSatisfied, true)
})
