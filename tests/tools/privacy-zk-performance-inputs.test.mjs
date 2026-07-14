import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyPrivacyZkPerformanceInputs } from '../../tools/test/verify-privacy-zk-performance-inputs.mjs'
import { publishRunBoundMarker } from '../../tools/test-matrix/run-bound-marker.mjs'

const sourceState = { commit: 'abc123', worktreeFingerprint: 'tree-1' }

function writeJson(root, relativeFile, value) {
  const file = path.join(root, relativeFile)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`)
}

function writeFixture(root, runId) {
  for (const [markerId, producerBundleId, producerStepId] of [
    ['backend-coverage-ready', 'backend-tests', 'backend-coverage-summary'],
    ['frontend-coverage-ready', 'frontend-tests', 'frontend-coverage-summary']
  ]) {
    const artifact = path.join(root, `${markerId}.json`)
    fs.writeFileSync(artifact, '{}\n')
    publishRunBoundMarker({
      file: path.join(root, `.tmp/test-runs/${runId}/${markerId}.json`), root, markerId, runId,
      sourceState, producerBundleId, producerStepId, artifacts: [artifact]
    })
  }
  writeJson(root, `.tmp/test-runs/${runId}/frontend-build-ready.json`, {
    schema: 'fsusblog.local-production.frontend-build-ready.v1', status: 'success', schedulerRunId: runId,
    buildLayout: { sourceCommit: sourceState.commit, sourceFingerprint: sourceState.worktreeFingerprint }
  })
  for (const stage of ['contract', 'functional']) {
    writeJson(root, `.tmp/security/privacy-zk-comment-matrix-stages/${stage}.json`, {
      schema: 'fsusblog.privacy-zk-comment-matrix-stage.v1',
      status: 'ok',
      stage,
      runId
    })
  }
}

test('privacy-ZK performance inputs bind all prerequisite bundles and receipts to one run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeFixture(root, 'production-fresh')

  const evidence = verifyPrivacyZkPerformanceInputs({
    runId: 'production-fresh',
    sourceState,
    repositoryRoot: root
  })
  assert.equal(evidence.markers.length, 2)
  assert.equal(evidence.stages.length, 2)
  assert.ok([...evidence.markers, evidence.frontendBuild, ...evidence.stages]
    .every((entry) => entry.digest.startsWith('sha256:')))
})

test('privacy-ZK performance inputs report every missing or stale prerequisite together', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-failures-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeFixture(root, 'stale-run')
  fs.rmSync(path.join(root, '.tmp/test-runs/stale-run/frontend-build-ready.json'))

  assert.throws(
    () => verifyPrivacyZkPerformanceInputs({ runId: 'production-fresh', sourceState, repositoryRoot: root }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 5)
      assert.match(error.message, /5 independent files/u)
      assert.match(error.message, /backend-coverage-ready\.json/u)
      assert.match(error.message, /contract\.json/u)
      assert.match(error.message, /functional\.json/u)
      return true
    }
  )
})
