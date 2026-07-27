import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  beginProductionFreshForbiddenOutputObservation,
  captureProductionFreshOutputInventory,
  createProductionFreshOutputRoot,
  finalizeProductionFreshAttempt,
  finishProductionFreshForbiddenOutputObservation,
  mutateProductionFreshOutput,
  outputPath,
  productionFreshGovernanceOutputs,
  resolveProductionFreshOutputAttempt,
  sealTerminalProductionFreshOutputs,
  verifyProducerOutputDelta,
  verifyProducerOutputs,
  verifyProductionFreshReceiptInventory,
  verifyTerminalProductionFreshOutputs
} from '../../tools/test-matrix/production-fresh-run-bound-outputs.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-output-'))
  const makeWritable = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const child = path.join(directory, name)
      if (fs.lstatSync(child).isSymbolicLink()) continue
      if (fs.lstatSync(child).isDirectory()) makeWritable(child)
      else fs.chmodSync(child, 0o644)
    }
    fs.chmodSync(directory, 0o755)
  }
  return { root, close: () => { makeWritable(root); fs.rmSync(root, { recursive: true, force: true }) } }
}

function write(layout, relative, value = relative) {
  const file = outputPath(layout, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

test('parallel Fresh runs isolate same named outputs and inventories', () => {
  const value = fixture()
  try {
    const a = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' })
    const b = createProductionFreshOutputRoot({ root: value.root, runId: 'run-b' })
    write(a, 'bundles/shared.json', 'a'); write(b, 'bundles/shared.json', 'b')
    const receiptA = verifyProducerOutputs({ layout: a, producerId: 'a', relativeOutputs: ['bundles/shared.json'] })
    const receiptB = verifyProducerOutputs({ layout: b, producerId: 'b', relativeOutputs: ['bundles/shared.json'] })
    assert.notEqual(receiptA.perOutputDigest['bundles/shared.json'], receiptB.perOutputDigest['bundles/shared.json'])
    assert.notEqual(a.outputRoot, b.outputRoot)
  } finally { value.close() }
})

test('undeclared outputs and symlink escapes fail closed', () => {
  const value = fixture()
  try {
    const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' })
    write(layout, 'reports/declared.json'); write(layout, 'reports/undeclared.json')
    assert.throws(() => verifyProducerOutputs({ layout, producerId: 'producer', relativeOutputs: ['reports/declared.json'] }), /undeclared=reports\/undeclared.json/)
    fs.rmSync(outputPath(layout, 'reports/undeclared.json'))
    fs.symlinkSync(path.join(value.root, 'outside'), outputPath(layout, 'reports/escape'))
    assert.throws(() => verifyProducerOutputs({ layout, producerId: 'producer', relativeOutputs: ['reports/declared.json'] }), /symlink/)
  } finally { value.close() }
})

test('ancestor and intermediate symlinks fail before output creation or write', () => {
  const value = fixture()
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-output-outside-'))
    fs.symlinkSync(outside, path.join(value.root, '.tmp'))
    assert.throws(
      () => createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' }),
      /symlink is not allowed/)
    assert.deepEqual(fs.readdirSync(outside), [])
    fs.rmSync(path.join(value.root, '.tmp'))
    const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' })
    fs.rmSync(path.join(layout.outputRoot, 'reports'), { recursive: true })
    fs.symlinkSync(outside, path.join(layout.outputRoot, 'reports'))
    assert.throws(() => outputPath(layout, 'reports/escaped.json'), /symlink is not allowed/)
    assert.equal(fs.existsSync(path.join(outside, 'escaped.json')), false)
    fs.rmSync(outside, { recursive: true, force: true })
  } finally { value.close() }
})

test('terminal roots reject real cross-run delete overwrite rename and chmod actions', () => {
  const value = fixture()
  try {
    const a = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' })
    write(a, 'summary/result.json', 'old')
    const before = verifyProducerOutputs({ layout: a, producerId: 'producer', relativeOutputs: ['summary/result.json'] })
    sealTerminalProductionFreshOutputs(a)
    const b = createProductionFreshOutputRoot({ root: value.root, runId: 'run-b' })
    write(b, 'summary/result.json', 'new')
    const aFile = outputPath(a, 'summary/result.json')
    for (const mutation of [
      { operation: 'delete' },
      { operation: 'overwrite', contents: 'corrupt' },
      { operation: 'rename', destination: outputPath(b, 'summary/stolen.json') },
      { operation: 'chmod', mode: 0o644 }
    ]) {
      assert.throws(
        () => mutateProductionFreshOutput({ layout: b, target: aFile, ...mutation }),
        /output escapes run root/)
    }
    const after = verifyProducerOutputs({ layout: a, producerId: 'producer', relativeOutputs: ['summary/result.json'] })
    assert.deepEqual(after, before)
    assert.equal(fs.statSync(aFile).mode & 0o777, 0o444)
    assert.equal(fs.existsSync(outputPath(b, 'summary/stolen.json')), false)
    assert.equal(verifyTerminalProductionFreshOutputs(a).attempts.length, 1)
    assert.throws(() => outputPath(a, '../run-b/summary/result.json'), /safe non-empty relative/)
  } finally { value.close() }
})

test('resume seals the old attempt and allocates a distinct append-only attempt', () => {
  const value = fixture()
  try {
    const first = createProductionFreshOutputRoot({ root: value.root, runId: 'same-run' })
    write(first, 'reports/result.json', 'first')
    const before = captureProductionFreshOutputInventory(first)
    sealTerminalProductionFreshOutputs(first)
    const resumed = createProductionFreshOutputRoot({ root: value.root, runId: 'same-run', resume: true })
    assert.equal(resumed.attemptId, 'attempt-0002')
    assert.notEqual(resumed.outputRoot, first.outputRoot)
    write(resumed, 'reports/result.json', 'second')
    assert.deepEqual(captureProductionFreshOutputInventory(first), before)
    assert.equal(resolveProductionFreshOutputAttempt({ root: value.root, runId: 'same-run' }).attemptId, 'attempt-0002')
  } finally { value.close() }
})

test('producer delta receipts bind only newly declared files and reject overwrite or removal', () => {
  const value = fixture()
  try {
    const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' })
    write(layout, 'reports/existing.json', 'sealed-input')
    const before = captureProductionFreshOutputInventory(layout)
    write(layout, 'reports/new.json', 'new')
    const receipt = verifyProducerOutputDelta({
      layout,
      producerId: 'lane-a',
      before,
      relativeOutputs: ['reports/new.json']
    })
    assert.equal(receipt.runId, 'run-a')
    assert.equal(receipt.attemptId, 'attempt-0001')
    assert.deepEqual(receipt.relativeOutputs, ['reports/new.json'])

    const secondBefore = captureProductionFreshOutputInventory(layout)
    write(layout, 'reports/existing.json', 'overwritten')
    assert.throws(() => verifyProducerOutputDelta({
      layout,
      producerId: 'lane-b',
      before: secondBefore,
      relativeOutputs: ['reports/declared.json']
    }), /undeclared=reports\/existing\.json.*missing=reports\/declared\.json/)

    const thirdBefore = captureProductionFreshOutputInventory(layout)
    fs.rmSync(outputPath(layout, 'reports/new.json'))
    assert.throws(() => verifyProducerOutputDelta({
      layout,
      producerId: 'lane-c',
      before: thirdBefore,
      relativeOutputs: ['reports/another.json']
    }), /removed=reports\/new\.json/)
  } finally { value.close() }
})

test('aggregate receipt inventory rejects gaps and overlapping producer ownership', () => {
  const value = fixture()
  try {
    const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' })
    let before = captureProductionFreshOutputInventory(layout)
    write(layout, 'reports/a.json', 'a')
    const a = verifyProducerOutputDelta({
      layout,
      producerId: 'a',
      before,
      relativeOutputs: ['reports/a.json']
    })
    before = captureProductionFreshOutputInventory(layout)
    write(layout, 'coverage/b.json', 'b')
    const b = verifyProducerOutputDelta({
      layout,
      producerId: 'b',
      before,
      relativeOutputs: ['coverage/b.json']
    })
    const aggregate = verifyProductionFreshReceiptInventory({ layout, receipts: [a, b] })
    assert.deepEqual(aggregate.relativeOutputs, ['coverage/b.json', 'reports/a.json'])

    write(layout, 'summary/undeclared.json', 'gap')
    assert.throws(
      () => verifyProductionFreshReceiptInventory({ layout, receipts: [a, b] }),
      /undeclared=summary\/undeclared\.json/)
    assert.throws(
      () => verifyProductionFreshReceiptInventory({
        layout,
        receipts: [a, { ...a, producerId: 'other' }],
        governanceOutputs: ['summary/undeclared.json']
      }),
      /multiple owners: reports\/a\.json/)
  } finally { value.close() }
})

test('mutable namespace environment has one governance owner across physical bundles', () => {
  const value = fixture()
  try {
    const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' })
    const before = captureProductionFreshOutputInventory(layout)
    write(layout, 'reports/producer.json', 'producer')
    const receipt = verifyProducerOutputDelta({
      layout,
      producerId: 'physical-producer',
      before,
      relativeOutputs: ['reports/producer.json']
    })
    write(layout, 'runtime/acceptance-env/run-a.env', 'FSUSBLOG_TEST_RUN_ID=run-a\n')
    const governance = productionFreshGovernanceOutputs(layout)
    assert.equal(
      governance['runtime/acceptance-env/run-a.env'],
      'runtime-environment-coordinator')
    assert.equal(
      verifyProductionFreshReceiptInventory({
        layout,
        receipts: [receipt],
        governanceOutputs: governance
      }).relativeOutputs.includes('runtime/acceptance-env/run-a.env'),
      true)
  } finally { value.close() }
})

test('forbidden output observation kills summary-only, global-stage-and-move, and global-lock implementations', () => {
  const value = fixture()
  try {
    const summaryOnly = createProductionFreshOutputRoot({ root: value.root, runId: 'summary-only' })
    const summaryObservation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root })
    write(summaryOnly, 'summary/run.json', 'summary')
    assert.throws(
      () => fs.writeFileSync(path.join(value.root, '.tmp/test-results/result.trx'), 'global trx'),
      /EACCES|EPERM/)
    finishProductionFreshForbiddenOutputObservation({
      observation: summaryObservation,
      layout: summaryOnly,
      receiptFile: 'runtime/forbidden-output-observation.json'
    })

    const staged = createProductionFreshOutputRoot({ root: value.root, runId: 'staged' })
    const stagedObservation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root })
    const forbiddenCoverageRoot = path.join(value.root, '.tmp/coverage')
    fs.chmodSync(forbiddenCoverageRoot, 0o755)
    fs.writeFileSync(path.join(forbiddenCoverageRoot, 'Summary.json'), 'global first')
    fs.renameSync(
      path.join(forbiddenCoverageRoot, 'Summary.json'),
      outputPath(staged, 'coverage/Summary.json'))
    fs.chmodSync(forbiddenCoverageRoot, 0o555)
    assert.throws(
      () => finishProductionFreshForbiddenOutputObservation({
        observation: stagedObservation,
        layout: staged,
        receiptFile: 'runtime/forbidden-output-observation.json'
      }),
      /forbidden global correctness output/)

    const locked = createProductionFreshOutputRoot({ root: value.root, runId: 'locked' })
    const lockObservation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root })
    assert.throws(
      () => fs.openSync(path.join(value.root, '.tmp/release-evidence/summary.json.lock'), 'wx'),
      /EACCES|EPERM/)
    finishProductionFreshForbiddenOutputObservation({
      observation: lockObservation,
      layout: locked,
      receiptFile: 'runtime/forbidden-output-observation.json'
    })
  } finally { value.close() }
})

test('forbidden output guards reject bundle, Vitest, TRX, coverage, Playwright, and BenchmarkDotNet defaults', () => {
  const value = fixture()
  try {
    const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'default-output-fixtures' })
    const observation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root })
    for (const relative of [
      '.tmp/local-production/backend-tests/summary.json',
      '.tmp/test-results/vitest/results.json',
      '.tmp/test-results/backend/result.trx',
      '.tmp/coverage/backend/Summary.json',
      'src/frontend/coverage/coverage-final.json',
      'src/frontend/test-results/results.json',
      'src/frontend/playwright-report/index.html',
      'BenchmarkDotNet.Artifacts/results/benchmark.json'
    ]) {
      assert.throws(() => {
        const file = path.join(value.root, relative)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, relative)
      }, /EACCES|EPERM/, relative)
    }
    finishProductionFreshForbiddenOutputObservation({
      observation,
      layout,
      receiptFile: 'runtime/forbidden-output-observation.json'
    })
  } finally { value.close() }
})

test('physical failure and aggregate verifier failure both seal their terminal attempt', async () => {
  const value = fixture()
  try {
    const physicalFailure = createProductionFreshOutputRoot({ root: value.root, runId: 'physical-failure' })
    write(physicalFailure, 'logs/partial.log', 'partial')
    await assert.rejects(
      finalizeProductionFreshAttempt(physicalFailure, async () => {
        throw new Error('physical producer failed')
      }),
      /physical producer failed/)
    assert.equal(verifyTerminalProductionFreshOutputs(physicalFailure).attempts.length, 1)
    assert.equal(fs.statSync(outputPath(physicalFailure, 'logs/partial.log')).mode & 0o777, 0o444)

    const verifierFailure = createProductionFreshOutputRoot({ root: value.root, runId: 'inventory-failure' })
    write(verifierFailure, 'reports/undeclared.json', 'undeclared')
    await assert.rejects(
      finalizeProductionFreshAttempt(verifierFailure, async () => {
        verifyProductionFreshReceiptInventory({ layout: verifierFailure, receipts: [] })
      }),
      /requires producer receipts/)
    assert.equal(verifyTerminalProductionFreshOutputs(verifierFailure).attempts.length, 1)
    const resumed = createProductionFreshOutputRoot({
      root: value.root,
      runId: 'inventory-failure',
      resume: true
    })
    assert.equal(resumed.attemptId, 'attempt-0002')
    assert.notEqual(resumed.outputRoot, verifierFailure.outputRoot)
  } finally { value.close() }
})
