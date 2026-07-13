import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyPrivacyZkPerformanceInputs } from '../../tools/test/verify-privacy-zk-performance-inputs.mjs'

function writeJson(root, relativeFile, value) {
  const file = path.join(root, relativeFile)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`)
}

function writeFixture(root, runId) {
  for (const physicalBundleId of ['backend-tests', 'frontend-tests', 'runtime-browser']) {
    writeJson(root, `.tmp/local-production/${physicalBundleId}/summary.json`, {
      schema: 'fsusblog.local-production.bundle.v1',
      status: 'success',
      physicalBundleId,
      schedulerRunId: runId
    })
  }
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
    repositoryRoot: root
  })
  assert.equal(evidence.bundles.length, 3)
  assert.equal(evidence.stages.length, 2)
  assert.ok([...evidence.bundles, ...evidence.stages]
    .every((entry) => entry.digest.startsWith('sha256:')))
})

test('privacy-ZK performance inputs report every missing or stale prerequisite together', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-failures-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeFixture(root, 'stale-run')
  fs.rmSync(path.join(root, '.tmp/local-production/runtime-browser/summary.json'))

  assert.throws(
    () => verifyPrivacyZkPerformanceInputs({ runId: 'production-fresh', repositoryRoot: root }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 5)
      assert.match(error.message, /5 independent files/u)
      assert.match(error.message, /runtime-browser\/summary\.json/u)
      assert.match(error.message, /contract\.json/u)
      assert.match(error.message, /functional\.json/u)
      return true
    }
  )
})
