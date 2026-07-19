import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  frontendBuildReadyMarkerSchema,
  publishFrontendBuildTerminalMarker
} from '../../tools/test-matrix/frontend-build-ready-marker.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-frontend-build-marker-'))
  return {
    file: path.join(root, '.tmp', 'test-runs', 'run-1', 'frontend-build-ready.json'),
    runId: 'run-1',
    buildLayout: { digest: 'sha256:layout-1' }
  }
}

test('a current-run success marker survives later failure and cancellation signals', () => {
  for (const status of ['failure', 'cancelled']) {
    const value = fixture()
    const success = {
      schema: frontendBuildReadyMarkerSchema,
      status: 'success',
      schedulerRunId: value.runId,
      producerStepId: 'sync-static-assets',
      artifactDigests: { index: 'sha256:index' }
    }
    fs.mkdirSync(path.dirname(value.file), { recursive: true })
    fs.writeFileSync(value.file, `${JSON.stringify(success, null, 2)}\n`)

    const result = publishFrontendBuildTerminalMarker({
      ...value,
      status,
      reason: `later ${status}`
    })

    assert.equal(result.preserved, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(value.file, 'utf8')), success)
  }
})

test('failure before readiness publishes a run-bound terminal marker atomically', () => {
  const value = fixture()
  const publishedAt = new Date('2026-07-20T08:00:00.000Z')
  const result = publishFrontendBuildTerminalMarker({
    ...value,
    status: 'failure',
    reason: 'sync-static-assets failed',
    now: () => publishedAt
  })

  assert.equal(result.preserved, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(value.file, 'utf8')), {
    schema: frontendBuildReadyMarkerSchema,
    status: 'failure',
    physicalBundleId: 'build-static',
    producerStepId: 'sync-static-assets',
    schedulerRunId: value.runId,
    buildLayout: value.buildLayout,
    reason: 'sync-static-assets failed',
    publishedAt: publishedAt.toISOString(),
    generatedAt: publishedAt.toISOString()
  })
  assert.deepEqual(fs.readdirSync(path.dirname(value.file)), ['frontend-build-ready.json'])
})

test('a stale success marker cannot suppress the current run terminal state', () => {
  const value = fixture()
  fs.mkdirSync(path.dirname(value.file), { recursive: true })
  fs.writeFileSync(value.file, `${JSON.stringify({
    schema: frontendBuildReadyMarkerSchema,
    status: 'success',
    schedulerRunId: 'run-0'
  })}\n`)

  publishFrontendBuildTerminalMarker({
    ...value,
    status: 'cancelled',
    reason: 'SIGTERM'
  })

  const marker = JSON.parse(fs.readFileSync(value.file, 'utf8'))
  assert.equal(marker.status, 'cancelled')
  assert.equal(marker.schedulerRunId, value.runId)
  assert.equal(marker.reason, 'SIGTERM')
})

test('unsupported terminal status is rejected before publishing', () => {
  const value = fixture()
  assert.throws(() => publishFrontendBuildTerminalMarker({
    ...value,
    status: 'success'
  }), /invalid frontend build terminal status/u)
  assert.equal(fs.existsSync(value.file), false)
})
