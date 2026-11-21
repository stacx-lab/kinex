import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isolate, fakeProvider, workspace, bind } from './helpers.mjs'

const isolation = await isolate()
after(isolation.cleanup)
const { createApplication } = await import('../dist/application.js')

const said = request => JSON.stringify(request.messages.filter(message => message.role === 'user'))

test('a turn in a folder of its own runs in a fresh session there, and the user\'s session returns', { timeout: 120000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const home = await workspace(t)
  const app = await createApplication({ cwd: home, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  app.host.setRebindSession(() => bind(app))
  // Where each request was made: the workspace runtime and the session's folder at that moment.
  const places = []
  fake.respond = () => { places.push([app.owner.runtime.directory, app.host.cwd]); return { text: 'NOTED' } }

  await app.main.turn({ prompt: 'HOME_FIRST' })
  const file = app.host.session.sessionFile
  assert.match(said(fake.requests.at(-1)), /HOME_FIRST/)

  for (const name of ['d001', 'd002']) {
    const directory = path.join(await workspace(t), name)
    const session = path.join(directory, 'record', 'session.jsonl')
    await mkdir(path.join(directory, 'workspace'), { recursive: true })
    await mkdir(path.dirname(session))
    await writeFile(session, '')
    await app.main.turn({ prompt: `DISTILL_${name}`, directory: path.join(directory, 'workspace'), session })
    const request = fake.requests.at(-1)
    assert.match(said(request), new RegExp(`DISTILL_${name}`))
    assert.doesNotMatch(said(request), /HOME_FIRST|DISTILL_d001.*DISTILL_d002/, 'the session starts empty')
    assert.deepEqual(places.at(-1), [path.join(directory, 'workspace'), path.join(directory, 'workspace')], 'the runtime and the session are the folder\'s')
    assert.match(await readFile(session, 'utf8'), new RegExp(`DISTILL_${name}`), 'the transcript is kept in the given file')
    assert.equal(app.host.session.sessionFile, file, 'the user\'s session is back')
    assert.equal(app.host.cwd, home)
    assert.equal(app.owner.runtime.directory, home)
  }

  await app.main.turn({ prompt: 'HOME_AGAIN' })
  assert.match(said(fake.requests.at(-1)), /HOME_FIRST.*HOME_AGAIN/, 'with its conversation')
  assert.doesNotMatch(said(fake.requests.at(-1)), /DISTILL/)
})

test('a turn that is aborted or fails rejects, and the user\'s session still returns', { timeout: 120000 }, async t => {
  const fake = await fakeProvider(t, isolation.root)
  const home = await workspace(t)
  const app = await createApplication({ cwd: home, model: 'fake/test', mode: 'auto' })
  t.after(() => app.dispose())
  await bind(app)
  app.host.setRebindSession(() => bind(app))
  const directory = await workspace(t)
  const session = path.join(directory, 'session.jsonl')
  await writeFile(session, '')
  const stop = new AbortController()
  fake.respond = () => { stop.abort(new Error('the deadline passed')); return { wait: new Promise(() => {}) } }
  await assert.rejects(app.main.turn({ prompt: 'SLOW', directory, session }, stop.signal), /the deadline passed/)
  assert.equal(app.host.cwd, home)
  fake.respond = () => ({ text: 'NOTED' })
  await app.main.turn({ prompt: 'STILL_HERE' })
  assert.match(said(fake.requests.at(-1)), /STILL_HERE/)
})
