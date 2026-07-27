import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  consumeResetPostconditionReceipt,
  consumeResetReceiptsForStep,
  produceResetPostconditionReceipt,
  resetPostconditionReceiptFile,
  resetReceiptsProducedByStep,
  resolveRuntimeResetContext
} from '../../tools/test-matrix/reset-postcondition-verifier.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const identity = {
  runId: 'run-reset-test',
  namespace: 'reset-test',
  sourceState: {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
  }
}
const producerStep = { id: 'bootstrap', command: 'tools/bootstrap-acceptance-env.sh' }
const reset = {
  producer: 'bootstrap',
  producerCommand: producerStep.command,
  receiptSchema: 'fsusblog.runtime-reset-postcondition.v1',
  assertionId: 'bootstrap-runtime-ready'
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'reset-receipt-'))
  const environmentFile = path.join(root, '.tmp/env/reset-test.env')
  const fixtureManifest = path.join(root, '.tmp/fixtures/reset-test/manifest.json')
  const logFile = path.join(root, '.tmp/local-production/runtime-browser/steps/bootstrap.log')
  for (const file of [environmentFile, fixtureManifest, logFile]) mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(environmentFile, 'FSUSBLOG_TEST_NAMESPACE=reset-test\nFSUSBLOG_TEST_RUN_ID=run-reset-test\n')
  writeFileSync(fixtureManifest, '{"status":"ready"}\n')
  writeFileSync(logFile, 'acceptance environment ready\n')
  return {
    root,
    environmentFile,
    result: { code: 0, signal: null, finishedAtMs: Date.now(), logFile }
  }
}

function resultFor(root, stepId) {
  const logFile = path.join(root, `.tmp/local-production/runtime-browser/steps/${stepId}.log`)
  mkdirSync(path.dirname(logFile), { recursive: true })
  writeFileSync(logFile, `${stepId} completed\n`)
  return { code: 0, signal: null, finishedAtMs: Date.now(), logFile }
}

test('real bootstrap postcondition produces and consumes a run/source-bound receipt', () => {
  const context = fixture()
  try {
    const catalog = {
      steps: [
        { stepId: producerStep.id, resetBefore: [], resetAfter: [] },
        { stepId: 'runtime-consumer', resetBefore: [reset], resetAfter: [] }
      ]
    }
    const [produced] = resetReceiptsProducedByStep({
      root: context.root,
      catalog,
      step: producerStep,
      result: context.result,
      runIdentity: identity
    })
    const [consumed] = consumeResetReceiptsForStep({
      root: context.root,
      catalog,
      steps: [producerStep, { id: 'runtime-consumer', command: 'runtime-consumer.sh' }],
      stepId: 'runtime-consumer',
      phase: 'resetBefore',
      runIdentity: identity
    })
    assert.equal(consumed.file, produced.file)
    assert.equal(consumed.receipt.schedulerRunId, identity.runId)
    assert.deepEqual(consumed.receipt.sourceState, identity.sourceState)
    assert.deepEqual(consumed.receipt.observations.map((entry) => entry.label), [
      'producer-log',
      'runtime-environment',
      'fixture-manifest'
    ])
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('Production Fresh bootstrap postcondition binds only attempt-root environment, fixture, and log files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'reset-receipt-fresh-'))
  const outputRoot = path.join(root, '.tmp/test-runs/run-reset-test/outputs/attempts/attempt-0001')
  const environmentRoot = path.join(outputRoot, 'runtime/acceptance-env')
  const fixtureRoot = path.join(outputRoot, 'runtime/acceptance-fixtures')
  const logFile = path.join(outputRoot, 'bundles/runtime-browser/steps/bootstrap.log')
  const previous = {
    outputRoot: process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT,
    environmentRoot: process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT,
    fixtureRoot: process.env.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT
  }
  try {
    process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT = outputRoot
    process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT = environmentRoot
    process.env.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT = fixtureRoot
    for (const file of [
      path.join(environmentRoot, 'reset-test.env'),
      path.join(fixtureRoot, 'reset-test/manifest.json'),
      logFile
    ]) mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      path.join(environmentRoot, 'reset-test.env'),
      'FSUSBLOG_TEST_NAMESPACE=reset-test\nFSUSBLOG_TEST_RUN_ID=run-reset-test\n')
    writeFileSync(path.join(fixtureRoot, 'reset-test/manifest.json'), '{"status":"ready"}\n')
    writeFileSync(logFile, 'acceptance environment ready\n')

    const produced = produceResetPostconditionReceipt({
      root,
      assertionId: 'bootstrap-runtime-ready',
      producerStep,
      result: { code: 0, signal: null, finishedAtMs: Date.now(), logFile },
      runIdentity: identity
    })
    assert.deepEqual(produced.receipt.observations.map((entry) => entry.path), [
      '.tmp/test-runs/run-reset-test/outputs/attempts/attempt-0001/bundles/runtime-browser/steps/bootstrap.log',
      '.tmp/test-runs/run-reset-test/outputs/attempts/attempt-0001/runtime/acceptance-env/reset-test.env',
      '.tmp/test-runs/run-reset-test/outputs/attempts/attempt-0001/runtime/acceptance-fixtures/reset-test/manifest.json'
    ])
    assert.equal(
      produced.file,
      path.join(outputRoot, 'runtime/runtime-state-reset/bootstrap/bootstrap-runtime-ready.json'))
    assert.equal(consumeResetPostconditionReceipt({
      root,
      reset,
      producerStep,
      runIdentity: identity
    }).receipt.status, 'ok')
    assert.equal(existsSync(path.join(root, '.tmp/env')), false)
  } finally {
    if (previous.outputRoot == null) delete process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT
    else process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT = previous.outputRoot
    if (previous.environmentRoot == null) delete process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT
    else process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT = previous.environmentRoot
    if (previous.fixtureRoot == null) delete process.env.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT
    else process.env.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT = previous.fixtureRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test('ZAP postcondition rejects a real residual labeled container', () => {
  const context = fixture()
  try {
    assert.throws(() => produceResetPostconditionReceipt({
      root: context.root,
      assertionId: 'zap-container-removed',
      producerStep: { id: 'zap-baseline', command: 'tools/security/run-zap-baseline.sh' },
      result: resultFor(context.root, 'zap-baseline'),
      runIdentity: identity,
      commandRunner: () => ({ status: 0, stdout: 'residual-container-id\n' })
    }), /residual ZAP container/)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('ZAP postcondition includes stopped containers in exact-label qualification', () => {
  const context = fixture()
  try {
    const dockerSemantics = (_command, args) => ({
      status: 0,
      stdout: args.includes('--all') ? 'stopped-zap-id\n' : ''
    })
    assert.throws(() => produceResetPostconditionReceipt({
      root: context.root,
      assertionId: 'zap-container-removed',
      producerStep: { id: 'zap-baseline', command: 'tools/security/run-zap-baseline.sh' },
      result: resultFor(context.root, 'zap-baseline'),
      runIdentity: identity,
      commandRunner: dockerSemantics
    }), /residual ZAP container/)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('release hydration and clean ZAP postconditions produce consumable receipts', () => {
  const context = fixture()
  try {
    const releaseMarker = path.join(context.root, '.tmp/test-runs/run-reset-test/release-preview-ready.json')
    mkdirSync(path.dirname(releaseMarker), { recursive: true })
    writeFileSync(releaseMarker, JSON.stringify({
      schema: 'fsusblog.release-preview-ready.v1',
      status: 'ready',
      schedulerRunId: identity.runId
    }))
    const releaseStep = { id: 'release-public-hydration', command: 'tools/test/lanes/release-public-hydration.sh' }
    produceResetPostconditionReceipt({
      root: context.root,
      assertionId: 'release-public-hydration-ready',
      producerStep: releaseStep,
      result: resultFor(context.root, releaseStep.id),
      runIdentity: identity
    })
    assert.equal(consumeResetPostconditionReceipt({
      root: context.root,
      reset: {
        producer: releaseStep.id,
        producerCommand: releaseStep.command,
        receiptSchema: 'fsusblog.runtime-reset-postcondition.v1',
        assertionId: 'release-public-hydration-ready'
      },
      producerStep: releaseStep,
      runIdentity: identity
    }).receipt.status, 'ok')

    const zapStep = { id: 'zap-baseline', command: 'tools/security/run-zap-baseline.sh' }
    let allContainerQueries = 0
    const cleanDocker = (_command, args) => {
      assert.ok(args.includes('--all'))
      allContainerQueries += 1
      return { status: 0, stdout: '' }
    }
    produceResetPostconditionReceipt({
      root: context.root,
      assertionId: 'zap-container-removed',
      producerStep: zapStep,
      result: resultFor(context.root, zapStep.id),
      runIdentity: identity,
      commandRunner: cleanDocker
    })
    assert.deepEqual(consumeResetPostconditionReceipt({
      root: context.root,
      reset: {
        producer: zapStep.id,
        producerCommand: zapStep.command,
        receiptSchema: 'fsusblog.runtime-reset-postcondition.v1',
        assertionId: 'zap-container-removed'
      },
      producerStep: zapStep,
      runIdentity: identity,
      commandRunner: cleanDocker
    }).receipt.observations.at(-1).residualContainerIds, [])
    assert.equal(allContainerQueries, 2)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('consumer rejects a missing reset receipt', () => {
  const context = fixture()
  try {
    assert.throws(() => consumeResetPostconditionReceipt({
      root: context.root,
      reset,
      producerStep,
      runIdentity: identity
    }), /receipt is missing/)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('consumer rejects receipt identity tampering and changed observations', () => {
  const context = fixture()
  try {
    produceResetPostconditionReceipt({
      root: context.root,
      assertionId: reset.assertionId,
      producerStep,
      result: context.result,
      runIdentity: identity
    })
    const receiptFile = resetPostconditionReceiptFile(context.root, {
      runId: identity.runId,
      producer: producerStep.id,
      assertionId: reset.assertionId
    })
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
    receipt.sourceState.commit = 'c'.repeat(40)
    writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`)
    assert.throws(() => consumeResetPostconditionReceipt({
      root: context.root,
      reset,
      producerStep,
      runIdentity: identity
    }), /stale or tampered/)

    receipt.sourceState.commit = identity.sourceState.commit
    writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`)
    writeFileSync(context.environmentFile, 'FSUSBLOG_TEST_NAMESPACE=reset-test\nFSUSBLOG_TEST_RUN_ID=another-run\n')
    assert.throws(() => consumeResetPostconditionReceipt({
      root: context.root,
      reset,
      producerStep,
      runIdentity: identity
    }), /observation changed/)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('consumer rejects forged, incomplete, additional, and label-tampered observations', () => {
  const context = fixture()
  try {
    const produce = () => produceResetPostconditionReceipt({
      root: context.root,
      assertionId: reset.assertionId,
      producerStep,
      result: context.result,
      runIdentity: identity
    })
    const consume = () => consumeResetPostconditionReceipt({
      root: context.root,
      reset,
      producerStep,
      runIdentity: identity
    })
    const { file } = produce()
    const mutateReceipt = (change) => {
      const receipt = JSON.parse(readFileSync(file, 'utf8'))
      change(receipt)
      writeFileSync(file, `${JSON.stringify(receipt)}\n`)
    }

    mutateReceipt((receipt) => { receipt.observations = [{}] })
    assert.throws(consume, /observation contract is invalid/)

    produce()
    mutateReceipt((receipt) => { delete receipt.observations[0].digest })
    assert.throws(consume, /observation contract is invalid/)

    produce()
    mutateReceipt((receipt) => { receipt.observations[0].unexpected = true })
    assert.throws(consume, /observation contract is invalid/)

    produce()
    mutateReceipt((receipt) => { receipt.observations[0].label = 'fixture-manifest' })
    assert.throws(consume, /observation contract is invalid/)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('ZAP receipt binds exact run/step labels and is re-qualified live', () => {
  const context = fixture()
  const zapStep = { id: 'zap-baseline', command: 'tools/security/run-zap-baseline.sh' }
  const zapReset = {
    producer: zapStep.id,
    producerCommand: zapStep.command,
    receiptSchema: 'fsusblog.runtime-reset-postcondition.v1',
    assertionId: 'zap-container-removed'
  }
  try {
    const produced = produceResetPostconditionReceipt({
      root: context.root,
      assertionId: zapReset.assertionId,
      producerStep: zapStep,
      result: resultFor(context.root, zapStep.id),
      runIdentity: identity,
      commandRunner: () => ({ status: 0, stdout: '' })
    })
    const receipt = JSON.parse(readFileSync(produced.file, 'utf8'))
    receipt.observations.at(-1).runLabel = 'fsusblog.test-run=forged'
    writeFileSync(produced.file, `${JSON.stringify(receipt)}\n`)
    assert.throws(() => consumeResetPostconditionReceipt({
      root: context.root,
      reset: zapReset,
      producerStep: zapStep,
      runIdentity: identity,
      commandRunner: () => ({ status: 0, stdout: '' })
    }), /observation contract is invalid/)

    const digestReceipt = produceResetPostconditionReceipt({
      root: context.root,
      assertionId: zapReset.assertionId,
      producerStep: zapStep,
      result: resultFor(context.root, zapStep.id),
      runIdentity: identity,
      commandRunner: () => ({ status: 0, stdout: '' })
    })
    const digestTampered = JSON.parse(readFileSync(digestReceipt.file, 'utf8'))
    digestTampered.observations.at(-1).observationDigest = `sha256:${'0'.repeat(64)}`
    writeFileSync(digestReceipt.file, `${JSON.stringify(digestTampered)}\n`)
    assert.throws(() => consumeResetPostconditionReceipt({
      root: context.root,
      reset: zapReset,
      producerStep: zapStep,
      runIdentity: identity,
      commandRunner: () => ({ status: 0, stdout: '' })
    }), /observation contract is invalid/)

    produceResetPostconditionReceipt({
      root: context.root,
      assertionId: zapReset.assertionId,
      producerStep: zapStep,
      result: resultFor(context.root, zapStep.id),
      runIdentity: identity,
      commandRunner: () => ({ status: 0, stdout: '' })
    })
    assert.throws(() => consumeResetPostconditionReceipt({
      root: context.root,
      reset: zapReset,
      producerStep: zapStep,
      runIdentity: identity,
      commandRunner: () => ({ status: 0, stdout: 'late-residual-container\n' })
    }), /residual ZAP container/)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
})

test('runtime bundle produces, artifacts, and consumes catalog reset receipts', () => {
  const runner = readFileSync(path.join(repositoryRoot, 'tools/test/bundles/run-bundle.mjs'), 'utf8')
  for (const token of [
    'resetReceiptsProducedByStep',
    'consumeResetReceiptsForStep',
    'resetReceiptArtifactsProducedByStep',
    'resolveRuntimeResetContext',
    "phase: 'resetBefore'",
    "phase: 'resetAfter'"
  ]) assert.ok(runner.includes(token), token)
})

test('build-static steps bypass runtime catalog while runtime steps remain fail-closed', () => {
  let catalogLoads = 0
  let stepLoads = 0
  const catalogLoader = () => {
    catalogLoads += 1
    return { steps: [{ stepId: 'bootstrap' }] }
  }
  const stepsLoader = () => {
    stepLoads += 1
    return [{ id: 'bootstrap', command: 'tools/bootstrap-acceptance-env.sh' }]
  }
  assert.equal(resolveRuntimeResetContext({
    bundleId: 'build-static',
    stepId: 'frontend-build',
    catalogLoader,
    stepsLoader
  }), null)
  assert.equal(catalogLoads, 0)
  assert.equal(stepLoads, 0)

  assert.equal(resolveRuntimeResetContext({
    bundleId: 'runtime-browser',
    stepId: 'bootstrap',
    catalogLoader,
    stepsLoader
  }).catalog.steps[0].stepId, 'bootstrap')
  assert.equal(catalogLoads, 1)
  assert.equal(stepLoads, 1)
  assert.throws(() => resolveRuntimeResetContext({
    bundleId: 'runtime-browser',
    stepId: 'unregistered-runtime-step',
    catalogLoader,
    stepsLoader
  }), /requires a registered runtime step/)
})
