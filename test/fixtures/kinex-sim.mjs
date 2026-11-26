#!/usr/bin/env node
// Stands in for kinex-sim: two tasks on one robot, a task description for the
// launched episode, and an episode that succeeds only when the workspace has the `press` skill.
// Two files in its state folder change that: `fail-launch` makes the next launch
// fail, once, and `limit` makes an episode that does not succeed end at the
// simulator's step limit instead of being stopped.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const state = process.env.FAKE_KINEX_SIM_STATE
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const print = result => console.log(JSON.stringify(result))
const read = file => JSON.parse(readFileSync(path.join(state, file), 'utf8'))
appendFileSync(path.join(state, 'calls.log'), args.join(' ') + '\n')
if (args[0] === 'tasks') print({ tasks: 2, ids: ['sim/open-door', 'sim/press-button'], robots: { 'sim/open-door': 'sim/arm', 'sim/press-button': 'sim/arm' } })
else if (args[0] === 'launch' && existsSync(path.join(state, 'fail-launch'))) {
  rmSync(path.join(state, 'fail-launch'))
  print({ error: 'no simulator could start' })
  process.exit(1)
} else if (args[0] === 'launch') {
  const domain = existsSync(path.join(state, 'domain')) ? Number(readFileSync(path.join(state, 'domain'), 'utf8')) + 1 : 1
  writeFileSync(path.join(state, 'domain'), String(domain))
  const id = 'run' + domain
  writeFileSync(path.join(state, id + '.log'), '')
  writeFileSync(path.join(state, id + '.json'), JSON.stringify({ id, task: args[1], domain }))
  print({ id, domain_id: domain, log: path.join(state, id + '.log') })
} else if (args[0] === 'describe') {
  const name = read('run' + value('--domain-id') + '.json').task.split('/')[1]
  print({ task: name, seed: 0, instruction: name.replace('-', ' the ') })
} else if (args[0] === 'setup') {
  mkdirSync(path.join(value('--directory'), '.kinex'), { recursive: true })
  writeFileSync(path.join(state, 'domain' + value('--domain-id')), value('--directory'))
  print({ task: args[1], loaded: false })
} else if (args[0] === 'stop') {
  const run = read(args[1] + '.json')
  const workspace = readFileSync(path.join(state, 'domain' + run.domain), 'utf8')
  const success = existsSync(path.join(workspace, '.kinex/skills/press/SKILL.md'))
  const reason = success ? 'success' : existsSync(path.join(state, 'limit')) ? 'timeout' : 'stopped'
  writeFileSync(path.join(state, args[1] + '.result'), JSON.stringify({ task: run.task, seed: 0, step: 40, time_s: 2, success, reason }))
  print({ id: args[1], state: 'stopped' })
} else if (args[0] === 'judge') print({ id: args[1], state: 'judged', episodes: [read(args[1] + '.result')] })
else { print({ error: 'unsupported ' + args[0] }); process.exit(1) }
