import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  publishRunBoundMarker,
  readRunBoundMarker,
  waitForRunBoundMarker
} from '../../tools/test-matrix/run-bound-marker.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-marker-'))
  const artifact = path.join(root, 'evidence.json')
  const file = path.join(root, '.tmp', 'test-runs', 'run-1', 'coverage-ready.json')
  fs.writeFileSync(artifact, '{"status":"success"}\n')
  const expected = {
    root,
    markerId: 'backend-coverage-ready',
    runId: 'run-1',
    sourceState: { commit: 'abc', worktreeFingerprint: 'tree-1' },
    producerBundleId: 'backend-tests',
    producerStepId: 'backend-coverage-summary'
  }
  return { root, artifact, file, expected }
}

test('run-bound marker binds run, source, producer, and artifact digest', () => {
  const value = fixture()
  publishRunBoundMarker({
    file: value.file,
    ...value.expected,
    artifacts: [value.artifact]
  })
  assert.equal(readRunBoundMarker(value.file, value.expected).markerId, 'backend-coverage-ready')
  assert.throws(() => readRunBoundMarker(value.file, {
    ...value.expected,
    sourceState: { ...value.expected.sourceState, worktreeFingerprint: 'tree-2' }
  }), /another source state/u)
  fs.writeFileSync(value.artifact, '{"status":"changed"}\n')
  assert.throws(() => readRunBoundMarker(value.file, value.expected), /artifact changed/u)
})

test('wait returns as soon as the exact marker is published', async () => {
  const value = fixture()
  const waiting = waitForRunBoundMarker({ file: value.file, expected: value.expected, timeoutMs: 1_000, pollIntervalMs: 5 })
  setTimeout(() => publishRunBoundMarker({
    file: value.file,
    ...value.expected,
    artifacts: [value.artifact]
  }), 10)
  assert.equal((await waiting).status, 'success')
})

test('wait fails immediately on producer failure and cancellation', async () => {
  const value = fixture()
  await assert.rejects(waitForRunBoundMarker({
    file: value.file,
    expected: value.expected,
    timeoutMs: 1_000,
    producerFailure: () => 'backend-tests failed'
  }), /producer failed/u)

  const controller = new AbortController()
  const waiting = waitForRunBoundMarker({
    file: value.file,
    expected: value.expected,
    timeoutMs: 1_000,
    pollIntervalMs: 50,
    signal: controller.signal
  })
  controller.abort()
  await assert.rejects(waiting, /cancelled/u)
})
