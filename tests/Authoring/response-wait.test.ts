import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { waitForPathResponse, waitForUrlResponse } from '../EndToEnd/response-wait-fixture.mjs'

function fixture(waiter, options = {}) {
  const arrival = Promise.withResolvers()
  const finished = Promise.withResolvers()
  let bodyReads = 0
  let expected = '/before.aeds'
  let predicate
  let forwarded
  const response = {
    url: () => `https://blog.test${expected}?revision=2`,
    request: () => ({ method: () => options.method ?? 'POST' }),
    status: () => options.status ?? 200,
    headers: () => ({ 'content-type': Object.hasOwn(options, 'type') ? options.type : 'application/octet-stream' }),
    body: () => { bodyReads++; return finished.promise },
  }
  const page = { waitForResponse: (matches, ...args) => {
    predicate = matches
    forwarded = args
    return arrival.promise
  } }
  const timeout = { timeout: 1234 }
  const pending = waiter(page, () => waiter === waitForUrlResponse
    ? `https://blog.test${expected}?revision=2` : expected, options.filterMethod, timeout)
  expected = '/after.aeds'
  assert.equal(predicate(response), true, 'Expected endpoint must be evaluated when the response arrives')
  assert.deepEqual(forwarded, [timeout])
  return { response, arrival, finished, pending, predicate, reads: () => bodyReads }
}

for (const waiter of [waitForPathResponse, waitForUrlResponse]) {
  test(`${waiter.name} retains the original binary body before returning the same response`, async () => {
    const f = fixture(waiter, { filterMethod: 'POST' })
    let resolved = false
    const observed = f.pending.then(response => { resolved = true; return response })
    f.arrival.resolve(f.response)
    await setImmediate()
    assert.equal(f.reads(), 1)
    assert.equal(resolved, false, 'The response body must finish before receipt validation proceeds')
    f.finished.resolve(Buffer.from([0, 1, 255]))
    assert.equal(await observed, f.response)
    assert.equal(f.predicate({ ...f.response, url: () => 'https://blog.test/wrong.aeds' }), false)
    assert.equal(f.predicate({ ...f.response, request: () => ({ method: () => 'GET' }) }), false)
  })
  test(`${waiter.name} propagates body failures without retrying or inventing bytes`, async () => {
    const f = fixture(waiter)
    const failure = new Error('original response body unavailable')
    const rejected = assert.rejects(f.pending, error => error === failure)
    f.arrival.resolve(f.response)
    await setImmediate()
    f.finished.reject(failure)
    await rejected
    assert.equal(f.reads(), 1)
  })
  for (const [name, options] of [
    ['HEAD', { method: 'HEAD' }],
    ['204', { status: 204 }],
    ['redirect', { status: 302 }],
    ['304', { status: 304 }],
    ['SSE', { type: 'text/event-stream' }],
    ['no MIME', { type: undefined }],
  ]) {
    test(`${waiter.name} leaves ${name} header-only observations unchanged`, async () => {
      const f = fixture(waiter, options)
      f.arrival.resolve(f.response)
      assert.equal(await f.pending, f.response)
      assert.equal(f.reads(), 0)
    })
  }
}

test('binary error frames and parameterized MIME are retained without accepting their status', async () => {
  const f = fixture(waitForPathResponse, { status: 403, type: 'Application/Octet-Stream; version=2' })
  f.arrival.resolve(f.response)
  f.finished.resolve(Buffer.from([0, 255]))
  assert.equal((await f.pending).status(), 403)
  assert.equal(f.reads(), 1)
})
