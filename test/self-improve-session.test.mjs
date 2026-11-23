import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isolate, workspace } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
// A stand-in for rosbridge, and no sandbox: these tests start no worker.
process.env.KINEX_ROSBRIDGE = fileURLToPath(new URL('./fixtures/rosbridge.mjs', import.meta.url))
process.env.FAKE_ROSBRIDGE_STATE = isolation.root
process.env.KINEX_SELF_IMPROVE_SANDBOX = 'off'
const { createKinexRuntime, PermissionDeniedError } = await import('@kinex/core')
const { selfImproveContribution } = await import('@kinex/self-improve')
const { checked, current } = await import('@kinex/self-improve/scheduler')

const catalog = [{ id: 'sim/open-door', robot: 'sim/arm' }, { id: 'sim/press-button', robot: 'sim/arm' }, { id: 'lab/stack', robot: 'lab/hand' }]
const command = { sessionID: 'session', confirm: async () => false }

test('a run\'s tasks are ids of the catalog, all on one robot', () => {
  assert.deepEqual(checked(['sim/press-button', 'sim/open-door', 'sim/open-door'], catalog), ['sim/open-door', 'sim/press-button'])
  assert.throws(() => checked(['sim/open-door', 'sim/missing'], catalog), /Unknown tasks: sim\/missing/)
  assert.throws(() => checked(['sim/open-door', 'lab/stack'], catalog), /different robots \(sim\/arm, lab\/hand\)/)
  assert.throws(() => checked([], catalog), /at least one task/)
})

test('a session has the tools only while it plans or schedules a run, and a run exists once the user approved its plan', async t => {
  const directory = await workspace(t)
  const runtime = createKinexRuntime({ directory })
  t.after(() => runtime.dispose())
  const session = selfImproveContribution(runtime)
  const names = async () => (await session.tools.list()).tools.map(tool => tool.name)
  const asked = []
  const call = (name, input, approve = true) => session.tools.call(name, input, { sessionID: 'session', callID: 'call', abort: new AbortController().signal, questions: async () => ({}),
    ask: async request => { asked.push(request); if (!approve) throw new PermissionDeniedError(request.permission) } })
  assert.deepEqual(await names(), [])
  assert.throws(() => call('improve_next', {}), /unknown self-improve tool/)
  const [improve] = session.commands
  await assert.rejects(improve.execute('', command), /Usage: \/self-improve/)
  await assert.rejects(improve.execute('stop now', command), /Usage: \/self-improve/)
  assert.deepEqual(await improve.execute('stop', command), { kind: 'output', text: 'No self-improve run is scheduled in this Kinex.' })

  // The command hands the request to the session, which plans it with the user.
  const planning = await improve.execute('the sim tasks, two rounds', command)
  assert.equal(planning.kind, 'workflow')
  assert.match(planning.prompt, /^The user asks for a self-improve run: the sim tasks, two rounds\n\n[^]*improve_tasks[^]*improve_plan[^]*improve_next/)
  assert.deepEqual(await names(), ['improve_tasks', 'improve_plan'])
  assert.match((await call('improve_tasks', { pattern: 'sim/*' })).output, /^sim\/open-door \(robot sim\/arm\)\nsim\/press-button \(robot sim\/arm\)$/)

  // Nothing exists before the user approves: a plan that is declined leaves the session planning.
  await assert.rejects(call('improve_plan', { tasks: ['sim/open-door'] }, false), PermissionDeniedError)
  assert.equal(current().run, undefined)
  const [request] = asked
  assert.equal(request.permission, 'unattended')
  assert.match(request.description, /^Self-improve plan: 1 task of rosbridge's catalog on robot sim\/arm: sim\/open-door\nRounds: 1\./)
  assert.match(request.description, /A trial starts with `[^`]* launch <task> --execution-mode stepped --early-stop`[^\n]*one worker sub-agent without a sandbox[^\n]*It ends with `[^`]* stop`, and `[^`]* judge` decides the outcome/)
  assert.match(request.description, /\nTrials and distillations run in the background with nobody to approve their steps\.$/)
  const unknown = await call('improve_plan', { tasks: ['sim/missing'] })
  assert.deepEqual([unknown.isError, /Unknown tasks: sim\/missing/.test(unknown.output)], [true, true])

  const approved = await call('improve_plan', { tasks: ['sim/press-button', 'sim/open-door'], rounds: 2, parallel: 2, batches: [1] })
  const { run } = current()
  assert.deepEqual({ ...run.config, libRoots: undefined }, { selection: 'the sim tasks, two rounds', tasks: ['sim/open-door', 'sim/press-button'], robot: 'sim/arm', rounds: 2, parallel: 2, batches: [1],
    sandbox: false, libRoots: undefined, helpers: 10, trialTimeoutS: 3600, distillTimeoutS: 7200, startGapS: 10, rosbridge: process.env.KINEX_ROSBRIDGE })
  assert.match(approved.output, new RegExp(`^The self-improve run ${run.root} is scheduled\\.\\n\\nWave 1: start this trial now, as a background sub-agent, unless you started it a moment ago:\\nsubagent\\(\\{ agent: "self-improve-trial", task: "${path.basename(run.root)}/t001" \\}\\)\\n`))
  assert.deepEqual(await names(), ['improve_next'])
  // The commands that do the run's jobs are named where pi-subagents reads its agents.
  const agent = await readFile(path.join(process.env.KINEX_CONFIG_DIR, 'agent/agents/self-improve-trial.md'), 'utf8')
  assert.match(agent, /^---\nname: self-improve-trial\n[^]*runner:\n  type: external-cli\n  command: "[^"]+"\n  args: \["[^"]*main\.js","trial"\]\n/)
  // They say nothing of the run, so two Kinex that schedule different runs share them; the run keeps which Kinex its children are.
  assert.ok(!agent.includes(path.basename(run.root)))
  assert.deepEqual(JSON.parse(await readFile(path.join(run.root, 'kinex.json'), 'utf8')), { entry: process.argv[1], flags: [] })
  assert.match(await readFile(path.join(process.env.KINEX_CONFIG_DIR, 'agent/agents/self-improve-distill.md'), 'utf8'), /"distill"/)
  await assert.rejects(improve.execute('another run', command), /is already scheduled in this Kinex; \/self-improve stop ends it/)
  // The command completes to its subcommands and to the versions the newest run has to install.
  assert.deepEqual(await improve.choices(), ['status', 'stop', 'resume', 'install L0'])

  // Stopping ends the scheduling here; resuming schedules the run again and asks the user once more.
  assert.match((await improve.execute('stop', command)).text, new RegExp(`^Stopped the self-improve run ${run.root}\\. /self-improve resume continues it`))
  assert.deepEqual([current(), await names()], [undefined, []])
  const resumed = await improve.execute('resume', command)
  assert.deepEqual([resumed.kind, current().run.root, await names()], ['workflow', run.root, ['improve_next']])
  assert.match(resumed.prompt, /is scheduled in this Kinex again\. Call improve_next/)
  asked.length = 0
  await assert.rejects(call('improve_next', {}, false), PermissionDeniedError)
  assert.ok((await call('improve_next', {})).output.includes(`subagent({ agent: "self-improve-trial", task: "${path.basename(run.root)}/t001" })`))
  assert.match(asked.at(-1).description, /^Continue the self-improve run /)
  await call('improve_next', {})
  assert.equal(asked.length, 2, 'the user is asked once')
  await improve.execute('stop', command)
})

test('an installed brief is a context section of each session, never an instruction', async t => {
  const directory = await workspace(t)
  const runtime = createKinexRuntime({ directory })
  t.after(() => runtime.dispose())
  const file = path.join(directory, '.kinex/self-improve/brief.md')
  const session = selfImproveContribution(runtime)
  assert.deepEqual(await session.context(), { instructions: '', sections: {} })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'Load the press skill first.\n')
  assert.deepEqual(await session.context(), { instructions: '', sections: { brief: 'Load the press skill first.' } })
  // A session that was given a brief is told when it is gone; one that never was hears nothing.
  await rm(file)
  assert.deepEqual(await session.context(), { instructions: '', sections: { brief: '' } })
  assert.deepEqual(await selfImproveContribution(runtime).context(), { instructions: '', sections: {} })
})

test('loading self-improve registers no process listener', async () => {
  const entry = fileURLToPath(import.meta.resolve('@kinex/self-improve'))
  const script = `const before = process.listenerCount('exit'); await import(${JSON.stringify(entry)}); console.log(process.listenerCount('exit') - before)`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])
  assert.equal(stdout.trim(), '0')
})
