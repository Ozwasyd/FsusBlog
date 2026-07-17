import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSessionPrepConcurrency } from '../frontend/fixtures/session-prep-admission.mjs'

test('session prep admission follows live PostgreSQL PID headroom', () => {
  assert.equal(resolveSessionPrepConcurrency(4, { current: 31, max: 64 }), 4)
  assert.equal(resolveSessionPrepConcurrency(4, { current: 51, max: 64 }), 3)
  assert.equal(resolveSessionPrepConcurrency(4, { current: 63, max: 64 }), 1)
})

test('session prep admission keeps the scheduler request when the PID controller is unlimited', () => {
  assert.equal(resolveSessionPrepConcurrency(6, { current: 200, max: null }), 6)
})

test('session prep admission rejects invalid resource snapshots', () => {
  assert.throws(
    () => resolveSessionPrepConcurrency(4, { current: 65, max: 64 }),
    /invalid PostgreSQL PID snapshot/u
  )
  assert.throws(
    () => resolveSessionPrepConcurrency(0, { current: 1, max: 64 }),
    /requested concurrency must be a positive integer/u
  )
})
