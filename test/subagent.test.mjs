import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isolate, fakeProvider, workspace, bind, seed } from './helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')

const JUDGE = `"""Whether the mug in an image stands upright, as a model judges it."""
import asyncio
from pathlib import Path
from kinex import args, finish, subagent


async def main(image, model=None, thinking=None):
    reply = await subagent("Is the mug upright? Answer yes or no.", show={"wrist": Path(image), "tolerance_deg": 5}, model=model, thinking=thinking)
    finish({"upright": reply.strip() == "yes"})


asyncio.run(main(**args()))
`

test('a program asks a subagent that runs as its own Pi session, on the session\'s model or the one the call names', { timeout: 60000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const models = path.join(isolation.root, 'config/agent/models.json')
  const catalog = JSON.parse(await readFile(models, 'utf8'))
  catalog.providers.fake.models.push({ ...catalog.providers.fake.models[0], id: 'small', name: 'Small' }, { ...catalog.providers.fake.models[0], id: 'blind', name: 'Blind', input: ['text'] })
  await writeFile(models, JSON.stringify(catalog))
  const outputs = []
  const app = await createApplication({ cwd, model: 'fake/test', report: text => outputs.push(text) })
  t.after(() => app.dispose())
  await seed(app.owner.runtime)
  await bind(app)
  await mkdir(path.join(cwd, '.kinex/programs'), { recursive: true })
  await writeFile(path.join(cwd, '.kinex/programs/judge.py'), JUDGE)
  await writeFile(path.join(cwd, 'frame.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  const command = async text => {
    outputs.length = 0
    await app.host.session.prompt(text)
    return outputs.join('\n')
  }
  const judge = async (reply, extra = '') => {
    fake.requests.length = 0
    fake.steps.push({ text: reply })
    const value = JSON.parse(await command(`/exec .kinex/programs/judge.py image=frame.png${extra}`))
    assert.equal(fake.requests.length, 1)
    return { ...value, request: fake.requests[0] }
  }

  // A call that names no model uses the session's.
  const first = await judge('yes')
  assert.deepEqual(first.result, { upright: true })
  assert.match(first.output, /^subagent fake\/test \(\d+\.\d s\): yes\n$/)
  // It sees the instruction and what the program shows, has no tools, and none of the main agent's context.
  assert.equal(first.request.model, 'test')
  assert.ok(!first.request.tools?.length)
  const system = first.request.messages.filter(message => message.role !== 'user')
  assert.equal(system.length, 1)
  assert.match(JSON.stringify(system), /one step of an automated robot program/)
  assert.doesNotMatch(JSON.stringify(first.request), /Robotics|exec runs Kinex Python/)
  const [user] = first.request.messages.filter(message => message.role === 'user')
  const parts = typeof user.content === 'string' ? [{ type: 'text', text: user.content }] : user.content
  assert.equal(parts.filter(part => part.type === 'text').map(part => part.text).join('\n'), 'Is the mug upright? Answer yes or no.\n\nwrist: image 1\ntolerance_deg: 5')
  const images = parts.filter(part => part.type === 'image_url').map(part => part.image_url.url)
  assert.equal(images.length, 1)
  assert.match(images[0], /^data:image\/png;base64,iVBORw0KGgo/)

  // A call may name its own model, and how hard it thinks.
  const second = await judge('no', ' model=fake/small')
  assert.deepEqual([second.result, second.request.model], [{ upright: false }, 'small'])
  assert.match(second.output, /^subagent fake\/small /)
  assert.match(JSON.parse(await command('/exec .kinex/programs/judge.py image=frame.png thinking=extreme')).error, /Unknown thinking level extreme/)

  // What the program cannot be given is an answer it can handle, not a crash of the host.
  fake.requests.length = 0
  const blind = JSON.parse(await command('/exec .kinex/programs/judge.py image=frame.png model=fake/blind'))
  assert.deepEqual([blind.error, blind.code], ['fake/blind does not read images', 'subagent_failed'])
  assert.match(JSON.parse(await command('/exec .kinex/programs/judge.py image=frame.png model=nowhere/none')).error, /nowhere/)
  assert.equal(fake.requests.length, 0)

  // The shell runs the same program with no main agent in the loop: only the subagent calls a model.
  fake.requests.length = 0
  fake.steps.push({ text: 'no' })
  const pending = promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/kinex.mjs', import.meta.url)), 'run', '/exec .kinex/programs/judge.py image=frame.png model=fake/small'],
    { cwd, env: process.env, timeout: 40000 })
  pending.child.stdin.end()
  const run = await pending
  assert.deepEqual(JSON.parse(run.stdout).result, { upright: false })
  assert.deepEqual(fake.requests.map(request => request.model), ['small'])
})
