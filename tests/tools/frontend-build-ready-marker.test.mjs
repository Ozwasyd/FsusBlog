import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  frontendBuildReadyMarkerSchema,
  frontendBuildStageReceiptSchema,
  publishFrontendBuildTerminalMarker,
  validateFrontendBuildStageReceiptBinding,
  validateFrontendBuildStageReceiptIdentity
} from '../../tools/test-matrix/frontend-build-ready-marker.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-frontend-build-marker-'))
  return {
    root,
    file: path.join(root, '.tmp', 'test-runs', 'run-1', 'frontend-build-ready.json'),
    runId: 'run-1',
    buildLayout: { digest: 'sha256:layout-1' }
  }
}

function fileOutput(file) {
  const bytes = fs.readFileSync(file)
  return {
    status: 'file',
    size: bytes.length,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }
}

function directoryOutput(directory, stageCwd) {
  const entries = fs.readdirSync(directory).sort().map((name) => {
    const output = fileOutput(path.join(directory, name))
    return { path: name, type: 'file', size: output.size, sha256: output.sha256 }
  })
  return {
    status: 'directory',
    entries: entries.length,
    size: entries.reduce((sum, entry) => sum + entry.size, 0),
    sha256: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
    root: path.relative(stageCwd, directory).replaceAll(path.sep, '/')
  }
}

function successfulStageReceipt(value) {
  const stageCwd = path.join(value.root, 'src/frontend')
  const indexFile = path.join(stageCwd, 'dist/index.html')
  const wasmDirectory = path.join(stageCwd, 'dist/wasm')
  fs.mkdirSync(wasmDirectory, { recursive: true })
  fs.writeFileSync(indexFile, '<!doctype html>\n')
  fs.writeFileSync(path.join(wasmDirectory, 'runtime.wasm'), 'wasm')
  const expectedStages = [
    { id: 'vite-build', command: ['vite', 'build'], dependsOn: [], ownedOutputs: ['dist/index.html'] },
    { id: 'sync-wasm', command: ['internal', 'sync-wasm'], dependsOn: ['vite-build'], ownedOutputs: ['dist/wasm'] }
  ]
  const receipt = {
    schema: frontendBuildStageReceiptSchema,
    status: 'success',
    schedulerRunId: value.runId,
    sourceState: { commit: 'commit-1', worktreeFingerprint: 'tree-1' },
    stages: [
      {
        ...expectedStages[0],
        status: 'success',
        outputs: { 'dist/index.html': fileOutput(indexFile) }
      },
      {
        ...expectedStages[1],
        status: 'success',
        outputs: { 'dist/wasm': directoryOutput(wasmDirectory, stageCwd) }
      }
    ]
  }
  return { receipt, expectedStages, stageCwd, criticalOutputPaths: ['dist/index.html', 'dist/wasm'] }
}

function writeStageReceiptBinding(value, prepared = successfulStageReceipt(value)) {
  const { receipt } = prepared
  const receiptPath = `.tmp/build/${value.runId}/generated/frontend-build-stages.json`
  const receiptFile = path.join(value.root, receiptPath)
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true })
  fs.writeFileSync(receiptFile, bytes)
  const identity = validateFrontendBuildStageReceiptIdentity(receipt, {
    runId: value.runId,
    sourceState: { commit: 'commit-1', worktreeFingerprint: 'tree-1' }
  })
  return {
    root: value.root,
    receiptFile,
    receiptPath,
    marker: {
      stageReceipt: {
        path: receiptPath,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        identity
      }
    },
    identity,
    expectedStages: prepared.expectedStages,
    stageCwd: prepared.stageCwd,
    criticalOutputPaths: prepared.criticalOutputPaths
  }
}

function validationOptions(value, binding) {
  return {
    root: binding.root,
    marker: binding.marker,
    runId: value.runId,
    sourceState: { commit: 'commit-1', worktreeFingerprint: 'tree-1' },
    expectedPath: binding.receiptPath,
    expectedStages: binding.expectedStages,
    stageCwd: binding.stageCwd,
    criticalOutputPaths: binding.criticalOutputPaths
  }
}

function rewriteReceipt(binding, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  fs.writeFileSync(binding.receiptFile, bytes)
  binding.marker.stageReceipt.contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

test('stage receipt binding accepts only the exact current success identity and content digest', () => {
  const value = fixture()
  const binding = writeStageReceiptBinding(value)
  const verified = validateFrontendBuildStageReceiptBinding(validationOptions(value, binding))

  assert.equal(verified.path, binding.receiptPath)
  assert.deepEqual(verified.identity, binding.identity)
  assert.equal(verified.receipt.status, 'success')
})

test('stage receipt binding fails closed for stale schema, status, run, source, identity, path, and digest', () => {
  const cases = [
    ['schema', (receipt) => { receipt.schema = 'fsusblog.frontend-build-stage-receipt.v0' }, /schema mismatch/u],
    ['status', (receipt) => { receipt.status = 'partial' }, /status is not success/u],
    ['run', (receipt) => { receipt.schedulerRunId = 'run-0' }, /run ID mismatch/u],
    ['source', (receipt) => { receipt.sourceState.commit = 'commit-0' }, /source identity mismatch/u]
  ]
  for (const [label, mutate, expected] of cases) {
    const value = fixture()
    const binding = writeStageReceiptBinding(value)
    const receipt = JSON.parse(fs.readFileSync(binding.receiptFile, 'utf8'))
    mutate(receipt)
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
    fs.writeFileSync(binding.receiptFile, bytes)
    binding.marker.stageReceipt.contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    assert.throws(() => validateFrontendBuildStageReceiptBinding(validationOptions(value, binding)), expected, label)
  }

  const identityValue = fixture()
  const identityBinding = writeStageReceiptBinding(identityValue)
  identityBinding.marker.stageReceipt.identity = { ...identityBinding.identity, status: 'partial' }
  assert.throws(
    () => validateFrontendBuildStageReceiptBinding(validationOptions(identityValue, identityBinding)),
    /marker identity mismatch/u
  )

  const digestValue = fixture()
  const digestBinding = writeStageReceiptBinding(digestValue)
  fs.appendFileSync(digestBinding.receiptFile, ' ')
  assert.throws(
    () => validateFrontendBuildStageReceiptBinding(validationOptions(digestValue, digestBinding)),
    /content digest mismatch/u
  )

  const pathValue = fixture()
  const pathBinding = writeStageReceiptBinding(pathValue)
  pathBinding.marker.stageReceipt.path = `.tmp/build/${pathValue.runId}/generated/other.json`
  assert.throws(
    () => validateFrontendBuildStageReceiptBinding(validationOptions(pathValue, pathBinding)),
    /path mismatch/u
  )
})

test('stage receipt binding rejects missing, failed, or semantically forged stages and outputs', () => {
  const cases = [
    ['missing stage', (receipt) => receipt.stages.pop(), /stage roster mismatch/u],
    ['failed stage', (receipt) => { receipt.stages[0].status = 'failure' }, /status is not successful/u],
    ['forged command', (receipt) => { receipt.stages[0].command = ['vite', 'serve'] }, /command mismatch/u],
    ['forged dependency', (receipt) => { receipt.stages[1].dependsOn = [] }, /dependsOn mismatch/u],
    ['forged owned output', (receipt) => { receipt.stages[0].ownedOutputs = ['dist/other.html'] }, /ownedOutputs mismatch/u],
    ['missing output', (receipt) => { delete receipt.stages[0].outputs['dist/index.html'] }, /output roster mismatch/u],
    ['forged output digest', (receipt) => {
      receipt.stages[0].outputs['dist/index.html'].sha256 = `sha256:${'0'.repeat(64)}`
    }, /critical output digest mismatch/u]
  ]
  for (const [label, mutate, expected] of cases) {
    const value = fixture()
    const binding = writeStageReceiptBinding(value)
    const receipt = JSON.parse(fs.readFileSync(binding.receiptFile, 'utf8'))
    mutate(receipt)
    rewriteReceipt(binding, receipt)
    assert.throws(
      () => validateFrontendBuildStageReceiptBinding(validationOptions(value, binding)),
      expected,
      label
    )
  }

  const value = fixture()
  const binding = writeStageReceiptBinding(value)
  fs.writeFileSync(path.join(binding.stageCwd, 'dist/index.html'), '<!doctype html><p>mutated</p>\n')
  assert.throws(
    () => validateFrontendBuildStageReceiptBinding(validationOptions(value, binding)),
    /critical output digest mismatch/u
  )
})

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

test('a current success marker is replaced when its receipt validator fails closed', () => {
  const value = fixture()
  fs.mkdirSync(path.dirname(value.file), { recursive: true })
  fs.writeFileSync(value.file, `${JSON.stringify({
    schema: frontendBuildReadyMarkerSchema,
    status: 'success',
    schedulerRunId: value.runId
  })}\n`)

  const result = publishFrontendBuildTerminalMarker({
    ...value,
    status: 'failure',
    reason: 'receipt changed',
    validateExistingSuccess: () => false
  })

  assert.equal(result.preserved, false)
  assert.equal(result.marker.status, 'failure')
  assert.equal(result.marker.reason, 'receipt changed')
})

test('unsupported terminal status is rejected before publishing', () => {
  const value = fixture()
  assert.throws(() => publishFrontendBuildTerminalMarker({
    ...value,
    status: 'success'
  }), /invalid frontend build terminal status/u)
  assert.equal(fs.existsSync(value.file), false)
})
