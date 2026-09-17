import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  analyzeLocalExperiment,
  assessMeasuredCandidate,
  baselineConfig,
  createLocalExperimentDesign,
  digestJson,
  proposeLocalCandidate,
  readCatalog,
  rollbackConfig,
  validateCatalog,
  validateConfig
} from '../../tools/perf/app-config-local-tuner.mjs'
import { buildSyntheticEvidence } from '../../tools/perf/run-app-config-local-experiment.mjs'

const catalogFile = new URL('../../config/performance/app-config-knob-catalog.v1.json', import.meta.url)
const catalog = readCatalog(catalogFile)
const identity = {
  sourceCommit: 'a'.repeat(40),
  sourceWorktree: '/fixture/FsusBlog',
  buildArtifactDigest: `sha256:${'b'.repeat(64)}`,
  fixtureDigest: `sha256:${'c'.repeat(64)}`,
  toolchainDigest: `sha256:${'d'.repeat(64)}`,
  containerBudget: { cpu: 4, memoryBytes: 4_294_967_296 },
  securityPolicyDigest: `sha256:${'e'.repeat(64)}`
}

function design(groupId = 'public-aot-capacity', options = {}) {
  return createLocalExperimentDesign({ catalog, groupId, identity, repeats: 2, radius: 0.75, ...options })
}

function runsFor(experiment, surface, { noise = 0, failurePointId } = {}) {
  const byId = new Map(experiment.points.map((point) => [point.id, point]))
  return experiment.order.map((entry) => {
    const point = byId.get(entry.pointId)
    const value = surface(point.normalizedDelta)
    const failed = entry.pointId === failurePointId && entry.repeat === 1
    return {
      pointId: entry.pointId,
      repeat: entry.repeat,
      outcome: failed ? 'failed' : 'success',
      correctness: !failed,
      security: !failed,
      cleanupCompleted: true,
      cooldownCompleted: true,
      measurements: { score: value + (entry.repeat === 1 ? noise : -noise) }
    }
  })
}

test('catalog is the unique fail-closed authority with real PublicAot/PublicHotRead ownership and rollback', () => {
  assert.deepEqual(validateCatalog(catalog), { valid: true, errors: [] })
  assert.equal(catalog.authority, 'config/performance/app-config-knob-catalog.v1.json')
  assert.equal(catalog.productionMutation, false)
  assert.ok(catalog.knobs.some((knob) => knob.configKey === 'PublicAot:SsrWorkerCount'))
  assert.ok(catalog.knobs.some((knob) => knob.configKey === 'PublicAot:BackfillConcurrency'))
  assert.ok(catalog.knobs.some((knob) => knob.configKey === 'PublicAot:BackfillQueueCapacity'))
  assert.ok(catalog.knobs.some((knob) => knob.configKey === 'PublicHotRead:ArticleAdmissionRecentPercent'))
  assert.ok(catalog.knobs.some((knob) => knob.configKey === 'PublicHotRead:MinCompressionSavingsPercent'))
  for (const knob of catalog.knobs) {
    assert.ok(knob.owner)
    assert.ok(knob.correctnessOwner)
    assert.ok(knob.securityOwner)
    assert.ok(knob.observables.length > 0)
    assert.ok(knob.guardrails.length > 0)
    assert.notEqual(knob.rollbackValue, undefined)
  }
  assert.deepEqual(Object.keys(baselineConfig(catalog)), Object.keys(rollbackConfig(catalog)))
})

test('missing owners, guardrails and invalid startup/reload semantics fail closed', () => {
  for (const mutate of [
    (copy) => { delete copy.knobs[0].owner },
    (copy) => { copy.knobs[0].guardrails = [] },
    (copy) => { copy.knobs[0].lifecycle = 'magic-live-reload' },
    (copy) => { copy.knobs[0].range.maximum = 0 },
    (copy) => { copy.knobs[0].rollbackValue = 99 }
  ]) {
    const copy = structuredClone(catalog)
    mutate(copy)
    assert.equal(validateCatalog(copy).valid, false)
  }
})

test('unknown keys, illegal values and conflicting derived constraints fail closed', () => {
  const baseline = baselineConfig(catalog)
  const unknown = validateConfig(catalog, { ...baseline, 'Unknown:Capacity': 2 })
  assert.match(unknown.errors.join('\n'), /unknown configuration key/u)

  const range = validateConfig(catalog, { ...baseline, 'PublicAot:BackfillConcurrency': 9 })
  assert.match(range.errors.join('\n'), /within/u)

  const derived = validateConfig(catalog, {
    ...baseline,
    'PublicAot:SsrWorkerCount': 1,
    'PublicAot:BackfillConcurrency': 8,
    'PublicAot:BackfillQueueCapacity': 32
  })
  assert.match(derived.errors.join('\n'), /aot-concurrency-worker-bound/u)

  const shares = validateConfig(catalog, {
    ...baseline,
    'PublicHotRead:ExpectedBrotliClientSharePercent': 90,
    'PublicHotRead:ExpectedGzipClientSharePercent': 20
  })
  assert.match(shares.errors.join('\n'), /hotread-client-share-budget/u)
})

test('notification candidates remain synthetic-only until issue 1451 delivery semantics exist', () => {
  assert.doesNotThrow(() => design('notification-synthetic-only'))
  assert.throws(() => design('notification-synthetic-only', { evidenceKind: 'real' }), /synthetic-only until issue #1451/u)
})

test('single-group design is deterministic, balanced, identity-bound and cheaper than a grid', () => {
  const first = design()
  const second = design()
  assert.deepEqual(first, second)
  assert.equal(first.identityDigest, digestJson(identity))
  assert.equal(first.catalogDigest, digestJson(catalog))
  assert.ok(first.points.length >= 10)
  assert.ok(first.physicalSampleCount < first.fullThreeLevelGridSampleCount)
  assert.ok(first.order.every((entry) => entry.cleanupRequired && entry.cooldownRequired))
  assert.deepEqual([...new Set(first.order.map((entry) => entry.repeat))], [1, 2])
  assert.ok(first.points.every((point) =>
    Object.keys(point.normalizedDelta).every((knobId) =>
      catalog.interactionGroups.find((group) => group.id === first.groupId).knobIds.includes(knobId)
    )
  ))
})

test('known synthetic surface recovers first-order direction and pairwise interaction', () => {
  const experiment = design()
  const analysis = analyzeLocalExperiment({
    catalog,
    design: experiment,
    runs: runsFor(experiment, (x) =>
      100 - 20 * x['public-aot-ssr-workers'] +
      10 * x['public-aot-backfill-concurrency'] +
      500 * x['public-aot-ssr-workers'] * x['public-aot-backfill-concurrency']),
    targetMetrics: ['score']
  })
  assert.equal(analysis.status, 'ok')
  assert.ok(analysis.metrics.score.jacobian['public-aot-ssr-workers'] < 0)
  assert.ok(analysis.metrics.score.jacobian['public-aot-backfill-concurrency'] > 0)
  assert.ok(analysis.metrics.score.pairwiseInteraction[
    'public-aot-ssr-workers*public-aot-backfill-concurrency'
  ] > 100)
})

test('local quadratic model marks high curvature and a failed candidate as a cliff', () => {
  const experiment = design()
  const failurePointId = experiment.points.find((point) =>
    Math.abs(point.normalizedDelta['public-aot-backfill-queue']) > 0)?.id
  const analysis = analyzeLocalExperiment({
    catalog,
    design: experiment,
    runs: runsFor(experiment, (x) =>
      10 + 1000 * x['public-aot-backfill-queue'] ** 2, { failurePointId }),
    targetMetrics: ['score']
  })
  assert.equal(analysis.metrics.score.capacityCliff, true)
  assert.ok(analysis.failedRuns.length > 0)
})

test('high repeat noise returns insufficient-evidence and no pseudo-optimal profile', () => {
  const experiment = design()
  const analysis = analyzeLocalExperiment({
    catalog,
    design: experiment,
    runs: runsFor(experiment, () => 100, { noise: 40 }),
    targetMetrics: ['score']
  })
  assert.equal(analysis.status, 'insufficient-evidence')
  const proposal = proposeLocalCandidate({
    catalog,
    design: experiment,
    analysis,
    targetMetric: 'score'
  })
  assert.equal(proposal.status, 'insufficient-evidence')
  assert.equal(proposal.profile, undefined)
  assert.ok(proposal.rollbackProfile)
})

test('bounded proposal stays feasible and predicted guardrail failure shrinks the region', () => {
  const experiment = design()
  const analysis = analyzeLocalExperiment({
    catalog,
    design: experiment,
    runs: runsFor(experiment, (x) =>
      100 + 20 * x['public-aot-ssr-workers'] - 5 * x['public-aot-backfill-concurrency']),
    targetMetrics: ['score']
  })
  const proposal = proposeLocalCandidate({
    catalog,
    design: experiment,
    analysis,
    targetMetric: 'score',
    guardrailPredictions: { rss: 90 },
    guardrailLimits: { rss: 100 }
  })
  assert.equal(proposal.status, 'proposed')
  assert.equal(proposal.productionMutation, false)
  assert.equal(validateConfig(catalog, proposal.profile.config, {
    groupId: experiment.groupId,
    evidenceKind: experiment.evidenceKind
  }).valid, true)
  assert.ok(proposal.rollbackProfile)

  const blocked = proposeLocalCandidate({
    catalog,
    design: experiment,
    analysis,
    targetMetric: 'score',
    guardrailPredictions: { rss: 101 },
    guardrailLimits: { rss: 100 }
  })
  assert.equal(blocked.status, 'rejected')
  assert.equal(blocked.nextRadius, experiment.radius / 2)
  assert.match(blocked.reason, /guardrail/u)
})

test('measured direction, correctness and security decide acceptance and rollback', () => {
  const proposal = {
    status: 'proposed',
    radius: 0.5,
    profile: { name: 'candidate', config: {}, configDigest: `sha256:${'1'.repeat(64)}` },
    rollbackProfile: { name: 'rollback', config: {}, configDigest: `sha256:${'2'.repeat(64)}` }
  }
  const accepted = assessMeasuredCandidate({
    proposal,
    predictedDelta: -5,
    actualDelta: -4,
    guardrailsPassed: true,
    correctnessPassed: true,
    securityPassed: true
  })
  assert.equal(accepted.status, 'accepted')
  assert.ok(accepted.nextRadius > proposal.radius)
  assert.equal(accepted.productionMutation, false)

  for (const override of [
    { actualDelta: 2 },
    { guardrailsPassed: false },
    { correctnessPassed: false },
    { securityPassed: false }
  ]) {
    const rejected = assessMeasuredCandidate({
      proposal,
      predictedDelta: -5,
      actualDelta: -4,
      guardrailsPassed: true,
      correctnessPassed: true,
      securityPassed: true,
      ...override
    })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.nextRadius, proposal.radius / 2)
    assert.ok(rejected.rollbackProfile)
  }
})

test('catalog is valid JSON and no tool writes production appsettings', () => {
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(catalogFile, 'utf8')))
  for (const toolFile of [
    '../../tools/perf/app-config-catalog.mjs',
    '../../tools/perf/app-config-local-tuner.mjs',
    '../../tools/perf/app-config-local-model.mjs'
  ]) {
    const tool = fs.readFileSync(new URL(toolFile, import.meta.url), 'utf8')
    assert.doesNotMatch(tool, /writeFileSync|appendFileSync|appsettings\.Production/u)
  }
})

test('repo-local runner selects groups and retains success, failure, cleanup, model, profiles and rollback evidence', () => {
  const fixture = JSON.parse(fs.readFileSync(
    new URL('../performance/fixtures/app-config-local-surfaces.v1.json', import.meta.url),
    'utf8'
  ))
  const evidence = buildSyntheticEvidence({ catalog, fixture })
  assert.equal(evidence.schema, 'fsusblog.app-config-local-experiment.v1')
  assert.equal(evidence.productionMutation, false)
  assert.deepEqual(evidence.experiments.map((experiment) => experiment.groupId), [
    'public-aot-capacity',
    'public-hotread-residency'
  ])
  for (const experiment of evidence.experiments) {
    assert.equal(experiment.model.status, 'ok')
    assert.equal(experiment.conclusion.status, 'accepted')
    assert.ok(experiment.rawMeasurements.every((run) => run.cleanup.completed && run.cooldown.completed))
    assert.ok(experiment.rawMeasurements.every((run) => run.configDigest.startsWith('sha256:')))
    assert.ok(experiment.namedProfile)
    assert.ok(experiment.rollbackProfile)
    assert.equal(experiment.proposal.productionMutation, false)
    assert.equal(experiment.predictedVsActual.directionMatches, true)
    assert.ok(experiment.design.physicalSampleCount < experiment.design.fullThreeLevelGridSampleCount)
  }
  assert.ok(evidence.experiments[0].rawMeasurements.some((run) => run.outcome === 'failed'))

  const selected = buildSyntheticEvidence({ catalog, fixture, selectedGroup: 'public-hotread-residency' })
  assert.deepEqual(selected.experiments.map((experiment) => experiment.groupId), ['public-hotread-residency'])

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-app-config-evidence-'))
  fs.writeFileSync(path.join(temporary, 'evidence.json'), `${JSON.stringify(selected)}\n`)
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'evidence.json'), 'utf8')).experiments.length, 1)
})
