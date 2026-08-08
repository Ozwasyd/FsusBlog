import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { produceBehaviorTestEvidence } from '../../tools/test-matrix/produce-behavior-test-evidence.mjs'
import { root } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { observationArtifactSchema } from '../../tools/test-observations/validation.mjs'
import { scanBehaviorTestBindings } from '../../tools/contracts/behavior-test-binding.mjs'
import { createObservationArtifact } from '../../tools/test-observations/ledger.mjs'
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const producerCli = path.join(root, 'tools/test-matrix/produce-behavior-test-evidence.mjs')

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'fsusblog-produce-bte-'))
}

function fixtureRoot() {
  const directory = tempDir()
  for (const relative of [
    'config/contracts/behavior-contracts.json',
    'config/schemas/behavior-contract-catalog.schema.json',
    'tests/coverage-registry.json',
    'config/development/document-lifecycle.json'
  ]) {
    const target = path.join(directory, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(path.join(root, relative), target)
  }
  // Minimal extractor entrypoints referenced by catalog.
  for (const relative of [
    'tools/test/run-test-asset-audit.mjs',
    'tools/governance/check-code-intent.mjs',
    'tools/docs/document-lifecycle.mjs',
    'tools/run-test-matrix.mjs',
    'tools/fact-extractors/openapi-aeds/extract.mjs',
    'tools/fact-extractors/auth-session-permission/extract.mjs',
    'tools/fact-extractors/config-error-security-policy/extract.mjs',
    'tools/fact-extractors/content-lifecycle/extract.mjs'
  ]) {
    const target = path.join(directory, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, '// seed\nexport function seed() {}\n')
  }
  // Install helper modules referenced by imports in fixture tests.
  for (const [relative, source] of [
    ['tools/contracts/behavior-test.mjs', path.join(root, 'tools/contracts/behavior-test.mjs')],
    ['tools/contracts/behavior-contract-catalog.mjs', path.join(root, 'tools/contracts/behavior-contract-catalog.mjs')]
  ]) {
    const target = path.join(directory, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(source, target)
  }
  return directory
}

function makeObservationArtifact({ repositoryRoot, suite, testCases, runId = 'run-1', attemptKind = 'primary', evidenceClass = 'correctness', sourceCommit = '0'.repeat(40), worktreeFingerprint = `sha256:${'0'.repeat(64)}`, closureDigest = `sha256:${'0'.repeat(64)}`, framework = 'node-tap', fileName = null }) {
  const now = new Date().toISOString()

  const observations = testCases.map((tc, i) => ({
    testId: tc.testId,
    suite,
    framework,
    partition: tc.partition ?? 'default',
    outcome: tc.outcome ?? 'passed',
    durationMs: tc.durationMs ?? 10,
    failureSignature: (tc.outcome === 'failed' || tc.outcome === 'blocked')
      ? `sha256:${'0'.repeat(64)}` : null,
    sourceState: { commit: sourceCommit, worktreeFingerprint },
    sourceClosureDigest: closureDigest,
    runner: { os: 'linux', arch: 'x64', runtime: 'node-20', browser: null, project: null },
    run: { id: runId, attemptKind, evidenceClass },
    producer: { reference: fileName ?? 'suite.tap', digest: `sha256:${'0'.repeat(64)}` },
    attempt: 0
  }))

  const reportFile = path.join(repositoryRoot, fileName ?? 'suite.tap')
  mkdirSync(path.dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, 'TAP version 13\n')

  return {
    schema: observationArtifactSchema,
    observedAt: now,
    sourceState: { commit: sourceCommit, worktreeFingerprint },
    sourceClosureDigest: closureDigest,
    runner: { os: 'linux', arch: 'x64', runtime: 'node-20', browser: null, project: null },
    run: { id: runId, attemptKind, evidenceClass },
    producer: {
      framework,
      reference: fileName ?? 'suite.tap',
      digest: sha256('TAP version 13\n')
    },
    observations
  }
}

function writeArtifact(repositoryRoot, artifact, name = 'artifact.json') {
  const p = path.join(repositoryRoot, name)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(artifact, null, 2))
  return p
}

function makeTap(suite, cases) {
  const lines = ['TAP version 13']
  let index = 1
  for (const entry of cases) {
    lines.push(`ok ${index} - ${entry.name}`)
    lines.push(`# duration_ms ${entry.durationMs ?? 1}`)
    index += 1
  }
  lines.push(`1..${cases.length}`)
  return `${lines.join('\n')}\n`
}

function seedAllRequiredBindings(repositoryRoot, catalog) {
  let index = 0
  for (const contract of catalog.contracts) {
    if (contract.status !== 'active') continue
    for (const kind of contract.requiredTestKinds) {
      const args = kind === 'negative' || kind === 'migration'
        ? `{ title: 'seed ${index}', invariantIds: ['seed-${index}-inv'] }`
        : kind === 'concurrency'
          ? `{ title: 'seed ${index}', concurrencyHarness: 'fsusblog.real-concurrency.v1' }`
          : `'seed ${index}'`
      const file = path.join(repositoryRoot, `tests/tools/seed-${index}.test.mjs`)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'\nbehaviorTest('${contract.id}', '${kind}', ${args}, () => {})\n`)
      index += 1
    }
  }
}

function observationsFromScan(repositoryRoot, scan, {
  runId = 'round-1',
  commit = 'a'.repeat(40),
  fingerprint = `sha256:${'b'.repeat(64)}`,
  closure = `sha256:${'c'.repeat(64)}`,
  mutateCase = null,
  retrySuites = new Set()
} = {}) {
  const bySuite = new Map()
  for (const binding of scan.bindings) {
    if (!bySuite.has(binding.sourcePath)) bySuite.set(binding.sourcePath, [])
    bySuite.get(binding.sourcePath).push({ name: binding.fullyQualifiedName })
  }
  if (mutateCase) mutateCase(bySuite)
  const artifacts = []
  let ordinal = 0
  for (const [suite, cases] of bySuite) {
    if (!Array.isArray(cases) || cases.length === 0) continue
    ordinal += 1
    const evidenceDir = path.join(repositoryRoot, '.tmp/observations')
    mkdirSync(evidenceDir, { recursive: true })
    const fileName = `suite-${ordinal}.tap`
    const reportFile = path.join(evidenceDir, fileName)
    writeFileSync(reportFile, makeTap(suite, cases))
    artifacts.push(createObservationArtifact({
      framework: 'node-tap',
      reportFile,
      evidenceReference: path.relative(repositoryRoot, reportFile).split(path.sep).join('/'),
      suite,
      partition: 'fixture',
      metadata: {
        sourceState: { commit, worktreeFingerprint: fingerprint },
        sourceClosureDigest: closure,
        runner: { os: 'linux', arch: 'x64', runtime: 'node-test', browser: null, project: null },
        run: {
          id: runId,
          attemptKind: retrySuites.has(suite) ? 'retry' : 'primary',
          evidenceClass: 'correctness'
        }
      },
      observedAt: '2026-07-28T00:00:00.000Z'
    }))
  }
  return artifacts
}

function preparedFixture(directory, { mutateCase = null, retrySuites = new Set() } = {}) {
  const catalog = JSON.parse(readFileSync(path.join(directory, 'config/contracts/behavior-contracts.json'), 'utf8'))
  seedAllRequiredBindings(directory, catalog)
  const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog })
  assert.equal(scan.errors.length, 0, scan.errors.join('\n'))
  const artifacts = observationsFromScan(directory, scan, {
    mutateCase: mutateCase ? (bySuite) => mutateCase(bySuite, scan) : null,
    retrySuites
  })
  const paths = artifacts.map((artifact, index) => writeArtifact(directory, artifact, `artifact-${index}.json`))
  return { catalog, scan, artifacts, paths }
}

function writePlan(repositoryRoot, scan, { commit = 'a'.repeat(40), tiers = null } = {}) {
  const files = [...new Set(scan.bindings.map((binding) => binding.sourcePath))].sort()
  const plan = {
    schema: 'fsusblog.release-evidence.test-plan.v1',
    generatedAt: '2026-07-28T00:00:00.000Z',
    commit,
    namespace: null,
    tiers: tiers ?? [{ id: 'fixture-tier', evidence: files }]
  }
  const planPath = path.join(repositoryRoot, 'test-plan.json')
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
  return planPath
}

// =============================================================================
// Tests
// =============================================================================

test('producer rejects observation artifact not found', () => {
  const directory = fixtureRoot()
  try {
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [path.join(directory, 'nonexistent.json')],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('not found')), 'should report missing artifact')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects observation artifact spanning multiple runs', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a', runId: 'run-1',
      testCases: [{ testId: 'tap:t1', outcome: 'passed' }]
    })
    const a2 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-b', runId: 'run-2',
      testCases: [{ testId: 'tap:t2', outcome: 'passed' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')
    const p2 = writeArtifact(directory, a2, 'a2.json')

    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1, p2],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('span multiple run identities')), 'should reject multi-run artifacts')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects skipped test as evidence', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: [{ testId: 'tap:t1', outcome: 'skipped' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')

    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('skipped')), 'should reject skipped test')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects blocked test as evidence', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: [{ testId: 'tap:t1', outcome: 'blocked' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')

    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('blocked')), 'should reject blocked test')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects diagnostic evidence', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a', attemptKind: 'diagnostic',
      testCases: [{ testId: 'tap:t1', outcome: 'passed' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')

    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('diagnostic')), 'should reject diagnostic evidence')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects source commit mismatch across artifacts', () => {
  const directory = fixtureRoot()
  try {
    const commit1 = 'a'.repeat(40)
    const commit2 = 'b'.repeat(40)
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a', sourceCommit: commit1,
      testCases: [{ testId: 'tap:t1', outcome: 'passed' }]
    })
    const a2 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-b', sourceCommit: commit2,
      testCases: [{ testId: 'tap:t2', outcome: 'passed' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')
    const p2 = writeArtifact(directory, a2, 'a2.json')

    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1, p2],
      evidenceRoot: directory,
      expectedSourceCommit: commit1,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('source commit')), 'should reject source commit mismatch')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects duplicate testId across artifacts', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: [{ testId: 'tap:t1', outcome: 'passed' }]
    })
    const a2 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-b',
      testCases: [{ testId: 'tap:t1', outcome: 'passed' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')
    const p2 = writeArtifact(directory, a2, 'a2.json')

    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1, p2],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('duplicate testId')), 'should reject duplicate testId')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects missing static admission receipt', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: []
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')

    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`,
      staticAdmissionReceipt: path.join(directory, 'nonexistent-static.json')
    })
    assert.ok(errors.some((e) => e.includes('static admission')), 'should reject missing static admission receipt')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer creates receipt with runtimeCandidateSpawnCount=0', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: []
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')

    const { receipt } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.equal(receipt.runtimeCandidateSpawnCountBeforeReceipt, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('receipt includes contentDigest that survives round-trip', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: []
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')

    const { receipt: r1 } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    const { receipt: r2 } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(r1.contentDigest, 'receipt must have contentDigest')
    assert.equal(r1.contentDigest, r2.contentDigest, 'contentDigest must be deterministic')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('receipt schema is the canonical evidence receipt schema', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: []
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')

    const { receipt } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.equal(receipt.schema, 'fsusblog.behavior-test-evidence-receipt.v1')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer exports canonical tier ID and receipt path', async () => {
  const mod = await import('../../tools/test-matrix/produce-behavior-test-evidence.mjs')
  assert.equal(mod.produceBehaviorTestEvidenceTierId, 'produce-behavior-test-evidence')
  assert.equal(mod.produceBehaviorTestEvidenceCommand, 'node tools/test-matrix/produce-behavior-test-evidence.mjs')
  assert.ok(mod.produceBehaviorTestEvidenceReceiptPath)
})

test('producer seals an exact receipt from this-round observations (happy path)', () => {
  const directory = fixtureRoot()
  try {
    const { paths } = preparedFixture(directory)
    const scan = scanBehaviorTestBindings({ repositoryRoot: directory })
    const planPath = writePlan(directory, scan)
    const { receipt, errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      plan: planPath,
      evidenceRoot: directory,
      expectedSourceCommit: 'a'.repeat(40),
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`,
      expectedClosureDigest: `sha256:${'c'.repeat(64)}`
    })
    assert.deepEqual(errors, [])
    assert.equal(receipt.schema, 'fsusblog.behavior-test-evidence-receipt.v1')
    assert.ok(receipt.coverage.length >= 8, 'every active behavior should be covered')
    assert.ok(receipt.coverage.every((row) => row.status === 'ok'), 'all behaviors ok')
    assert.ok(receipt.evidence.length >= 12, 'every bound test observed')
    assert.equal(receipt.testPlanCommit, 'a'.repeat(40), 'receipt must seal the plan commit')
    assert.match(receipt.testPlanDigest, /^sha256:[a-f0-9]{64}$/u, 'receipt must seal the plan digest')
    assert.equal(receipt.unplannedBoundTestIds.length, 0, 'no bound test may be missing from the plan')
    assert.equal(receipt.extraExecutedTestIds.length, 0, 'no executed test may fall outside the plan closure')
    assert.equal(receipt.plannedTestIds.length, scan.bindings.length, 'every bound test must be planned')
    assert.equal(receipt.producer.command, 'node tools/test-matrix/produce-behavior-test-evidence.mjs')
    const schema = JSON.parse(readFileSync(path.join(root, 'config/schemas/behavior-test-evidence.schema.json'), 'utf8'))
    assert.deepEqual(validateJsonSchema(receipt, schema), [], 'receipt must satisfy canonical schema')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('global suite success cannot mask a required test that was not executed this round', () => {
  const directory = fixtureRoot()
  try {
    const { paths, scan } = preparedFixture(directory, {
      mutateCase: (bySuite, scan) => {
        const dropped = scan.bindings[0]
        bySuite.set(dropped.sourcePath, [])
      }
    })
    const { receipt, errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
    })
    assert.ok(receipt.coverage.some((row) => row.status === 'failed'), 'missing required kind must fail coverage')
    assert.ok(errors.some((e) => /missing this-round passed evidence|not covered by this round/u.test(e)),
      'missing required test must fail closed despite observed suites passing')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects historical TRX / default-branch raw result paths', () => {
  const directory = fixtureRoot()
  try {
    const trx = path.join(directory, 'TestResults', 'latest', 'run.trx')
    mkdirSync(path.dirname(trx), { recursive: true })
    writeFileSync(trx, '<ResultSummary outcome="Passed" />')
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [trx],
      evidenceRoot: directory
    })
    assert.ok(errors.some((e) => e.includes('historical raw result path')),
      'TRX/latest raw results must fail closed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects retry evidence after first failure (#1603)', () => {
  const directory = fixtureRoot()
  try {
    const { scan } = preparedFixture(directory)
    const retryArtifacts = observationsFromScan(directory, scan, {
      retrySuites: new Set([scan.bindings[0].sourcePath])
    })
    const paths = retryArtifacts.map((artifact, index) => writeArtifact(directory, artifact, `retry-${index}.json`))
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('retry attempt') || e.includes('retry evidence')),
      'recovered retry success cannot be clean behavior evidence')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer fails closed on source/binding drift after observations', () => {
  const directory = fixtureRoot()
  try {
    const { paths, scan, catalog } = preparedFixture(directory)
    // Rename one bound test in source after observations were gathered.
    const drifted = scan.bindings[0]
    const sourcePath = path.join(directory, drifted.sourcePath)
    const source = readFileSync(sourcePath, 'utf8')
    writeFileSync(sourcePath, source.replace(drifted.fullyQualifiedName, 'renamed title'), 'utf8')
    const rescan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog })
    assert.ok(rescan.errors.length === 0, rescan.errors.join('\n'))
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
    })
    assert.ok(errors.some((e) => /missing this-round passed evidence|not covered by this round|rename/u.test(e)),
      'binding drift must fail closed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docs-only closure digest does not skip required tests', () => {
  const directory = fixtureRoot()
  try {
    const { paths, scan } = preparedFixture(directory, {
      mutateCase: (bySuite, scan) => bySuite.set(scan.bindings[0].sourcePath, [])
    })
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`,
      expectedClosureDigest: `sha256:${'d'.repeat(64)}`
    })
    assert.ok(errors.some((e) => /missing this-round passed evidence|not covered by this round/u.test(e)),
      'docs-only closure input must not skip required behavior tests')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer rejects unsupported framework adapter instead of defaulting to success', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a', framework: 'not-a-framework',
      testCases: [{ testId: 'tap:t1', outcome: 'passed' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('framework is invalid')),
      'adapter mismatch must fail closed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer fails closed when the current-run test plan is missing', () => {
  const directory = fixtureRoot()
  try {
    const a1 = makeObservationArtifact({
      repositoryRoot: directory, suite: 'suite-a',
      testCases: [{ testId: 'tap:t1', outcome: 'passed' }]
    })
    const p1 = writeArtifact(directory, a1, 'a1.json')
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [p1],
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('test plan input is required')),
      'missing plan must fail closed instead of silently skipping exact-match')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer fails closed on test plan schema mismatch', () => {
  const directory = fixtureRoot()
  try {
    const { scan } = preparedFixture(directory)
    const planPath = writePlan(directory, scan)
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    plan.schema = 'fsusblog.release-evidence.test-plan.legacy'
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: [writeArtifact(directory, makeObservationArtifact({
        repositoryRoot: directory, suite: 'suite-a',
        testCases: []
      }), 'a1.json')],
      plan: planPath,
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('test plan schema mismatch')),
      'plan schema mismatch must fail closed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer fails closed on test plan commit mismatch', () => {
  const directory = fixtureRoot()
  try {
    const { paths, scan } = preparedFixture(directory)
    const planPath = writePlan(directory, scan, { commit: 'b'.repeat(40) })
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      plan: planPath,
      evidenceRoot: directory,
      expectedSourceCommit: 'a'.repeat(40),
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('test plan commit mismatch')),
      'plan/source identity drift must fail closed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer fails closed when the plan omits a required bound test', () => {
  const directory = fixtureRoot()
  try {
    const { paths, scan } = preparedFixture(directory)
    const files = [...new Set(scan.bindings.map((binding) => binding.sourcePath))].sort()
    const planPath = writePlan(directory, scan, {
      tiers: [{ id: 'fixture-tier', evidence: files.slice(0, Math.max(1, files.length - 1)) }]
    })
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      plan: planPath,
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('not planned by test plan')),
      'a bound test missing from the plan must fail closed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer fails closed on extra executed tests beyond the plan closure (overrun)', () => {
  const directory = fixtureRoot()
  try {
    const { paths, scan } = preparedFixture(directory, {
      mutateCase: (bySuite) => {
        bySuite.set('tests/tools/unplanned-extra.test.mjs', [{ name: 'unplanned extra test' }])
      }
    })
    const planPath = writePlan(directory, scan)
    const { errors } = produceBehaviorTestEvidence({
      repositoryRoot: directory,
      observations: paths,
      plan: planPath,
      evidenceRoot: directory,
      expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
    })
    assert.ok(errors.some((e) => e.includes('extra executed test(s) beyond plan closure')),
      'a test executed outside the planned closure must fail closed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI missing evidence exits 1, never auto-reruns, and reports canonical command', () => {
  const directory = fixtureRoot()
  try {
    const { paths, scan } = preparedFixture(directory, {
      mutateCase: (bySuite) => {
        const first = [...bySuite.keys()][0]
        bySuite.set(first, [])
      }
    })
    const planPath = writePlan(directory, scan)
    const out = path.join(directory, 'receipt.json')
    const result = spawnSync(process.execPath, [
      producerCli,
      ...paths.flatMap((item) => ['--observations', item]),
      '--plan', planPath,
      '--out', out,
      '--evidence-root', directory,
      '--repository-root', directory,
      '--worktree-fingerprint', `sha256:${'b'.repeat(64)}`
    ], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(result.stderr.includes('canonical command: node tools/test-matrix/produce-behavior-test-evidence.mjs'),
      'missing evidence must report the exact canonical producer command')
    assert.ok(result.stderr.includes(`--plan ${planPath}`),
      'canonical command must include the explicit test plan input')
    const receipt = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(receipt.runtimeCandidateSpawnCountBeforeReceipt, 0)
    const producerSource = readFileSync(producerCli, 'utf8')
    assert.ok(!/spawnSync|child_process/u.test(producerSource),
      'producer must never spawn a test rerun')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
