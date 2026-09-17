import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  finalizeAedsFrameCostSummary,
  readAedsFrameCostPolicy,
  validateAedsFrameCostSummary
} from '../../tools/operations/aeds-frame-cost-evidence.mjs'
import {
  buildAedsFrameCostRawFixture,
  createAedsFrameCostArtifactSet,
  fixtureCommitSha
} from './fixtures/aeds-frame-cost-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const policyFile = path.join(root, 'tests/performance/perf-policy.yml')
const policy = readAedsFrameCostPolicy(policyFile)

function context(options = {}) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-aeds-frame-cost-artifacts-'))
  const artifactSet = createAedsFrameCostArtifactSet(artifactRoot)
  return {
    artifactRoot,
    raw: buildAedsFrameCostRawFixture({ artifactSet, ...options })
  }
}

function finalize(fixture) {
  return finalizeAedsFrameCostSummary(fixture.raw, policy, fixtureCommitSha, {
    artifactRoot: fixture.artifactRoot,
    requireReleaseArtifacts: true
  })
}

function validate(summary, fixture, options = {}) {
  return validateAedsFrameCostSummary(summary, policy, fixtureCommitSha, {
    artifactRoot: fixture.artifactRoot,
    requireReleaseArtifacts: true,
    ...options
  })
}

test('representative dynamic frames bind an actual artifact set and raw multi-round samples', () => {
  const fixture = context()
  const summary = finalize(fixture)
  assert.equal(summary.structuralConclusion, 'improved')
  assert.equal(summary.measuredConclusion, 'improved')
  assert.equal(summary.overallConclusion, 'improved')
  assert.equal(summary.status, 'ok')
  assert.equal(summary.measuredEvidence.authority.authoritative, true)
  assert.deepEqual(summary.source.artifactSet.artifacts.map((item) => item.id), ['benchmark', 'core'])
  assert.match(summary.source.artifactSet.digest, /^sha256:[0-9a-f]{64}$/u)
  assert.ok(summary.measuredEvidence.results.every((item) => item.before.rounds.every((round) => round.samplesMs.length === 30)))
  assert.equal(summary.structuralEvidence.copyBytesCounterKind, 'payload-length-derived-not-hardware-counter')
  assert.ok(summary.structuralEvidence.results.every((item) => item.hardwareCounter === false))
  assert.deepEqual(
    summary.policy.requiredRepresentativeScenarios,
    ['ArticleList10', 'ArticleList50', 'ArticleList100', 'ArticleDetailLarge', 'CommentCursor', 'ConversationDetail', 'PublicAotBootstrap']
  )
  assert.equal(summary.policy.authoritativeMeanAggregation, 'median-of-round-means')
  assert.equal(summary.policy.authoritativeP95Aggregation, 'median-of-round-p95')
  assert.equal(validate(summary, fixture), summary)
})

test('copy reduction cannot hide representative p95 or allocation regression', () => {
  const p95Fixture = context({ p95RegressionScenario: 'ArticleDetailLarge' })
  const p95 = finalize(p95Fixture)
  assert.equal(p95.structuralConclusion, 'improved')
  assert.equal(p95.measuredConclusion, 'regressed')
  assert.deepEqual(
    p95.measuredEvidence.results.find((item) => item.scenario === 'ArticleDetailLarge').assessment.regressionReasons,
    ['p95-regressed']
  )
  assert.throws(() => validate(p95, p95Fixture), /authoritative gate requires overall improved/u)

  const allocationFixture = context({ allocationRegressionScenario: 'CommentCursor' })
  const allocation = finalize(allocationFixture)
  assert.equal(allocation.overallConclusion, 'regressed')
  assert.deepEqual(
    allocation.measuredEvidence.results.find((item) => item.scenario === 'CommentCursor').assessment.regressionReasons,
    ['allocation-regressed']
  )
})

test('missing runtime or hardware identity can only produce structural-only evidence', () => {
  const fixture = context({ missingIdentity: 'cpu' })
  const summary = finalize(fixture)
  assert.equal(summary.measuredConclusion, 'blocked')
  assert.equal(summary.overallConclusion, 'structural-only')
  assert.equal(summary.status, 'blocked')
  assert.deepEqual(summary.measuredEvidence.authority.blockedReasons, ['cpu-identity-unavailable'])
  validate(summary, fixture, { requireAuthoritative: false })
  assert.throws(() => validate(summary, fixture), /measured evidence is non-authoritative/u)
})

test('tiny dynamic frame variation inside its centralized noise band stays neutral', () => {
  const fixture = context()
  const summary = finalize(fixture)
  const tiny = summary.measuredEvidence.results.find((item) => item.scenario === 'ApiError')
  const staticReference = summary.measuredEvidence.results.find((item) => item.scenario === 'EmptySuccess')
  assert.equal(tiny.assessment.policyGroup, 'tiny')
  assert.equal(tiny.assessment.outcome, 'neutral')
  assert.equal(staticReference.assessment.gating, false)
  assert.equal(staticReference.assessment.outcome, 'reference-only')
  assert.equal(summary.overallConclusion, 'improved')
})

test('stale SHA and mismatched Core artifact bytes are rejected', () => {
  const staleFixture = context()
  assert.throws(
    () => finalizeAedsFrameCostSummary(staleFixture.raw, policy, 'c'.repeat(40), { artifactRoot: staleFixture.artifactRoot }),
    /does not match/u
  )

  const mismatchFixture = context()
  const core = mismatchFixture.raw.source.artifactSet.artifacts.find((item) => item.id === 'core')
  fs.writeFileSync(path.join(mismatchFixture.artifactRoot, core.path), 'different core bytes')
  assert.throws(() => finalize(mismatchFixture), /release artifact core (byte length|SHA-256) mismatch/u)
})

test('conclusions are recomputed from evidence fields instead of trusted', () => {
  const fixture = context({ meanRegressionScenario: 'ConversationDetail' })
  const summary = finalize(fixture)
  summary.status = 'ok'
  summary.measuredConclusion = 'improved'
  summary.measuredEvidence.conclusion = 'improved'
  summary.overallConclusion = 'improved'
  assert.throws(() => validate(summary, fixture), /status must be field-driven \(regressed\)/u)
})

test('all pooled and variability statistics are recomputed from raw samples', () => {
  const cases = [
    ['pooledP95Ms', (item) => { item.after.pooledP95Ms += 0.1 }, /pooledP95Ms does not match raw samples/u],
    ['p50Ms', (item) => { item.after.p50Ms -= 0.001 }, /p50Ms does not match raw samples/u],
    ['standardDeviationMs', (item) => { item.after.standardDeviationMs += 0.1 }, /standardDeviationMs does not match raw samples/u],
    ['variability', (item) => { item.variability.afterCoefficientOfVariation += 0.1 }, /afterCoefficientOfVariation does not match samplesMs/u],
    ['samplesMs', (item) => { item.after.rounds[0].samplesMs[0] += 0.123 }, /meanMs does not match samplesMs/u],
    ['allocation', (item) => { item.after.rounds[0].allocatedBytesTotal += 30 }, /allocationBytesPerRequest does not match allocatedBytesTotal/u]
  ]
  for (const [name, tamper, pattern] of cases) {
    const fixture = context()
    const item = fixture.raw.measuredEvidence.results.find((result) => result.scenario === 'ArticleList50')
    tamper(item)
    assert.throws(() => finalize(fixture), pattern, name)
  }
})

test('authoritative median-of-round statistics cannot disagree with retained rounds', () => {
  const fixture = context()
  fixture.raw.measuredEvidence.results.find((item) => item.scenario === 'ArticleList50').after.meanMs = 0.7
  assert.throws(() => finalize(fixture), /meanMs does not match raw samples\/rounds/u)
})

test('profiler and validator share deterministic sixth-decimal midpoint rounding', () => {
  const fixture = context({ roundingBoundaryScenario: 'EmptySuccess' })
  const before = fixture.raw.measuredEvidence.results.find((item) => item.scenario === 'EmptySuccess').before
  assert.equal(before.rounds[0].meanMs, 0.038523)
  assert.equal(finalize(fixture).overallConclusion, 'improved')
  const profiler = fs.readFileSync(path.join(root, 'benchmarks/core/Program.cs'), 'utf8')
  assert.match(profiler, /Math\.Floor\(value \* MetricScale \+ 0\.5d\)/u)
  assert.match(profiler, /samples = rounds\.SelectMany[^;]+\.ToArray\(\);\s+double\[\] orderedSamples = samples\.Order\(\)\.ToArray\(\)/u)
})

test('five-round median resists one scheduler outlier without widening policy', () => {
  const fixture = context({ singleOutlierScenario: 'ArticleList50' })
  const summary = finalize(fixture)
  const result = summary.measuredEvidence.results.find((item) => item.scenario === 'ArticleList50')
  assert.equal(result.after.rounds.length, 5)
  assert.ok(result.after.rounds[2].meanMs > result.before.meanMs)
  assert.equal(result.after.meanMs, 0.6)
  assert.equal(result.assessment.outcome, 'improved')
  assert.equal(summary.overallConclusion, 'improved')
})

test('checker CLI stages exact artifact bytes and validates release or downloaded snapshot', () => {
  const fixture = context()
  const rawFile = path.join(fixture.artifactRoot, 'raw.json')
  const summaryFile = path.join(fixture.artifactRoot, 'summary.json')
  fs.writeFileSync(rawFile, `${JSON.stringify(fixture.raw)}\n`)
  const common = ['--expected-commit', fixtureCommitSha, '--artifact-root', fixture.artifactRoot]
  const finalized = spawnSync(process.execPath, [
    'tools/operations/check-evidence-metrics.mjs',
    '--finalize-aeds-frame-cost', rawFile, summaryFile,
    ...common
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(finalized.status, 0, `${finalized.stdout}\n${finalized.stderr}`)
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
  assert.ok(summary.source.artifactSet.artifacts.every((item) => item.evidencePath?.startsWith('.tmp/perf/aeds-frame-cost/artifacts/')))
  const validated = spawnSync(process.execPath, [
    'tools/operations/check-evidence-metrics.mjs',
    '--validate-aeds-frame-cost', summaryFile,
    ...common
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`)
  for (const artifact of summary.source.artifactSet.artifacts) {
    fs.rmSync(path.join(fixture.artifactRoot, artifact.path))
  }
  const snapshot = spawnSync(process.execPath, [
    'tools/operations/check-evidence-metrics.mjs',
    '--validate-aeds-frame-cost', summaryFile,
    '--allow-artifact-snapshot',
    ...common
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(snapshot.status, 0, `${snapshot.stdout}\n${snapshot.stderr}`)
})

test('lane remains browserless and uses the centralized policy and artifact gate', () => {
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/aeds-frame-cost.sh'), 'utf8')
  const profiler = fs.readFileSync(path.join(root, 'benchmarks/core/Program.cs'), 'utf8')
  const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'))
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
  const policySource = fs.readFileSync(policyFile, 'utf8')
  const snapshots = [
    '.tmp/perf/aeds-frame-cost/artifacts/benchmark/FsusBlog.Core.Benchmarks.dll',
    '.tmp/perf/aeds-frame-cost/artifacts/core/FsusBlog.Core.dll'
  ]
  assert.match(lane, /--finalize-aeds-frame-cost/u)
  assert.match(lane, /--validate-aeds-frame-cost/u)
  assert.match(lane, /--repo-root/u)
  assert.match(lane, /tests\/performance\/perf-policy\.yml/u)
  assert.doesNotMatch(lane, /playwright|chromium|firefox|webkit/ui)
  assert.match(profiler, /same-process-release-artifact-multi-round/u)
  assert.match(profiler, /samplesMs/u)
  assert.match(profiler, /ArtifactIdentity\("benchmark"/u)
  assert.match(profiler, /ArtifactIdentity\("core"/u)
  assert.match(profiler, /payload-length-derived-not-hardware-counter/u)
  assert.match(profiler, /OptionValue\(args, "--rounds", 5\)/u)
  assert.match(policySource, /minimumRounds: 5/u)
  const coverage = registry.entries.find((entry) => entry.id === 'aeds-single-buffer-copy-crc-cost')
  for (const snapshot of snapshots) {
    assert.ok(matrix.includes(snapshot), `matrix must retain ${snapshot}`)
    assert.ok(coverage.evidencePaths.includes(snapshot), `coverage registry must retain ${snapshot}`)
  }
  assert.match(workflow, /\.tmp\/perf\/aeds-frame-cost\/\*\*/u)
})
