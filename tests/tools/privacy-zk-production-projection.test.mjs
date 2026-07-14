import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  projectPrivacyFunctionalEvidence,
  requiredBackendClasses,
  requiredFrontendFiles
} from '../../tools/test/lanes/project-privacy-zk-production.mjs'

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeTrx(file, classes) {
  const definitions = classes.map((className, index) => `
    <UnitTest id="test-${index}" name="${className}.Passes">
      <TestMethod className="FsusBlog.Server.Tests.Unit.${className}" name="Passes" />
    </UnitTest>`).join('')
  const results = classes.map((className, index) => `
    <UnitTestResult testId="test-${index}" testName="${className}.Passes" outcome="Passed" />`).join('')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `<TestRun><TestDefinitions>${definitions}</TestDefinitions><Results>${results}</Results></TestRun>\n`)
}

function fixture() {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-zk-projection-'))
  const runId = 'production-fixture'
  const contractReceipt = path.join(repositoryRoot, '.tmp/security/privacy-zk-comment-matrix-stages/contract.json')
  writeJson(contractReceipt, {
    schema: 'fsusblog.privacy-zk-comment-matrix-stage.v1',
    status: 'ok',
    stage: 'contract',
    runId,
    generatedAt: new Date(Date.now() - 2_000).toISOString()
  })
  const mainTrx = path.join(repositoryRoot, '.tmp/test-results/backend/production/main.trx')
  const postludeTrx = path.join(repositoryRoot, '.tmp/test-results/backend/production/postlude.trx')
  writeTrx(mainTrx, requiredBackendClasses)
  writeTrx(postludeTrx, ['BackendTestGovernanceTests'])
  const backendSummary = path.join(repositoryRoot, '.tmp/test-results/backend/production/summary.json')
  writeJson(backendSummary, {
    schema: 'fsusblog.backend-production-shards.v2',
    status: 'success',
    producer: { runId },
    execution: { exactOnce: true, allPassed: true },
    partitions: [
      { trx: path.relative(repositoryRoot, mainTrx) },
      { trx: path.relative(repositoryRoot, postludeTrx) }
    ]
  })
  const vitestRoot = path.join(repositoryRoot, '.tmp/test-results/vitest')
  const rollingReport = path.join(vitestRoot, 'production-rolling/merged.json')
  writeJson(rollingReport, {
    success: true,
    testResults: requiredFrontendFiles.map((file) => ({
      name: path.join(repositoryRoot, file),
      status: 'passed',
      assertionResults: [{ fullName: `${file} passes`, status: 'passed' }]
    }))
  })
  writeJson(path.join(vitestRoot, 'production-rolling/summary.json'), {
    schema: 'fsusblog.frontend-vitest-rolling.v2',
    status: 'success',
    schedulerRunId: runId,
    exactOnce: true,
    artifacts: { mergedJson: path.relative(repositoryRoot, rollingReport) }
  })
  const smokeEvidence = path.join(repositoryRoot, '.tmp/security/privacy-zk-prod-smoke.json')
  writeJson(smokeEvidence, {
    schema: 'fsusblog.privacy-zk-prod-smoke.v1',
    status: 'expected_unavailable',
    errors: []
  })
  return {
    repositoryRoot,
    runId,
    contractReceipt,
    backendSummary,
    vitestRoot,
    smokeEvidence,
    output: path.join(repositoryRoot, '.tmp/security/privacy-zk-comment-matrix-stages/functional.json')
  }
}

test('projects exact passing privacy coverage from run-bound backend and frontend primary reports', () => {
  const files = fixture()
  try {
    const receipt = projectPrivacyFunctionalEvidence({ ...files, expectedRunId: files.runId })
    assert.equal(receipt.mode, 'exact-production-result-projection')
    assert.equal(receipt.backendProjection.length, requiredBackendClasses.length)
    assert.equal(receipt.frontendProjection.length, requiredFrontendFiles.length)
    assert.equal(receipt.smokeStatus, 'expected_unavailable')
    assert.equal(JSON.parse(fs.readFileSync(files.output, 'utf8')).runId, files.runId)
  } finally {
    fs.rmSync(files.repositoryRoot, { recursive: true, force: true })
  }
})

test('fails closed when a required privacy backend class is absent', () => {
  const files = fixture()
  try {
    const mainTrx = path.join(files.repositoryRoot, '.tmp/test-results/backend/production/main.trx')
    writeTrx(mainTrx, requiredBackendClasses.slice(1))
    assert.throws(
      () => projectPrivacyFunctionalEvidence({ ...files, expectedRunId: files.runId }),
      /missing privacy class AnonymousCredentialIssuerTests/u
    )
    assert.equal(fs.existsSync(files.output), false)
  } finally {
    fs.rmSync(files.repositoryRoot, { recursive: true, force: true })
  }
})

test('fails closed on stale or duplicate frontend evidence and run mismatch', () => {
  const files = fixture()
  try {
    assert.throws(
      () => projectPrivacyFunctionalEvidence({ ...files, expectedRunId: 'different-run' }),
      /run binding mismatch/u
    )
    const report = path.join(files.vitestRoot, 'production-rolling/merged.json')
    const document = JSON.parse(fs.readFileSync(report, 'utf8'))
    document.testResults.push(document.testResults[0])
    writeJson(report, document)
    assert.throws(
      () => projectPrivacyFunctionalEvidence({ ...files, expectedRunId: files.runId }),
      /exactly one current result/u
    )
  } finally {
    fs.rmSync(files.repositoryRoot, { recursive: true, force: true })
  }
})
