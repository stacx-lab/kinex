import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineSource, readLine } from '../dist/util/lines.js'

test('subprocess lines decode multibyte characters split across chunks', async () => {
  const bytes = new TextEncoder().encode('{"name":"é"}\n')
  const split = bytes.indexOf(0xc3) + 1
  const source = lineSource(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, split))
    controller.enqueue(bytes.slice(split))
    controller.close()
  } }))
  assert.equal(await readLine(source, Date.now() + 1000), '{"name":"é"}')
  assert.equal(await readLine(source, Date.now() + 1000), undefined)
})
