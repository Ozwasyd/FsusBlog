#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  APP_CONFIG_EVIDENCE_SCHEMA,
  analyzeLocalExperiment,
  assessMeasuredCandidate,
  createLocalExperimentDesign,
  digestJson,
  proposeLocalCandidate,
  readCatalog
} from './app-config-local-tuner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}

function surfaceValue(surface, normalizedDelta) {
  let value = surface.intercept
  for (const [knobId, coefficient] of Object.entries(surface.linear ?? {})) {
    value += coefficient * (normalizedDelta[knobId] ?? 0)
  }
  for (const [knobId, coefficient] of Object.entries(surface.quadratic ?? {})) {
    value += coefficient * (normalizedDelta[knobId] ?? 0) ** 2
  }
  for (const [pair, coefficient] of Object.entries(surface.pairwise ?? {})) {
    const [left, right] = pair.split('*')
    value += coefficient * (normalizedDelta[left] ?? 0) * (normalizedDelta[right] ?? 0)
  }
  return value
}

function buildSyntheticRuns(design, experiment) {
  const points = new Map(design.points.map((point) => [point.id, point]))
  return design.order.map((entry) => {
    const point = points.get(entry.pointId)
    const failure = experiment.forcedFailure
    const failed = failure &&
      entry.repeat === failure.repeat &&
      Math.abs(point.normalizedDelta[failure.knobId] ?? 0) >= failure.absoluteNormalizedDeltaAtLeast
    const noise = experiment.surface.repeatNoise?.[entry.repeat - 1] ?? 0
    return {
      sequence: entry.sequence,
      pointId: entry.pointId,
      repeat: entry.repeat,
      config: point.config,
      configDigest: digestJson(point.config),
      outcome: failed ? 'failed' : 'success',
      failureReason: failed ? failure.reason : null,
      correctness: !failed,
      security: !failed,
      cleanup: { completed: true, dynamicOutcomeReused: false },
      cooldown: { completed: true },
      measurements: {
        [experiment.targetMetric]: surfaceValue(experiment.surface, point.normalizedDelta) + noise
      }
    }
  })
}

export function buildSyntheticEvidence({ catalog, fixture, selectedGroup }) {
  if (fixture.schema !== 'fsusblog.app-config-synthetic-surfaces.v1') throw new Error('unsupported synthetic fixture schema')
  const fixturePayloadDigest = digestJson({ schema: fixture.schema, experiments: fixture.experiments })
  if (fixture.identity?.fixtureDigest !== fixturePayloadDigest) {
    throw new Error(`fixture identity drift: expected ${fixturePayloadDigest}`)
  }
  if (fixture.identity?.securityPolicyDigest !== digestJson(catalog)) {
    throw new Error('fixture security policy digest does not match the catalog guardrail authority')
  }
  const experiments = fixture.experiments.filter((experiment) => !selectedGroup || experiment.groupId === selectedGroup)
  if (experiments.length === 0) throw new Error(`fixture has no experiment for ${selectedGroup ?? '<all>'}`)

  const results = experiments.map((experiment) => {
    const design = createLocalExperimentDesign({
      catalog,
      groupId: experiment.groupId,
      identity: fixture.identity,
      radius: experiment.radius,
      repeats: experiment.repeats,
      evidenceKind: 'synthetic'
    })
    const runs = buildSyntheticRuns(design, experiment)
    const analysis = analyzeLocalExperiment({
      catalog,
      design,
      runs,
      targetMetrics: [experiment.targetMetric]
    })
    const proposal = proposeLocalCandidate({
      catalog,
      design,
      analysis,
      targetMetric: experiment.targetMetric,
      objective: experiment.objective,
      guardrailPredictions: experiment.guardrails.predictions,
      guardrailLimits: experiment.guardrails.limits
    })
    const metric = analysis.metrics[experiment.targetMetric]
    const proposedPoint = proposal.status === 'proposed'
      ? design.points.find((point) => digestJson(point.config) === proposal.profile.configDigest)
      : null
    const predictedDelta = proposal.status === 'proposed'
      ? Object.entries(metric.jacobian).reduce((sum, [knobId, gradient]) => {
          const knob = catalog.knobs.find((candidate) => candidate.id === knobId)
          const baselineValue = catalog.knobs.find((candidate) => candidate.id === knobId).baseline
          const candidateValue = proposal.profile.config[knob.configKey]
          return sum + gradient * ((candidateValue - baselineValue) / (knob.range.maximum - knob.range.minimum))
        }, 0)
      : null
    const actualDelta = predictedDelta === null ? null : predictedDelta * experiment.actualDeltaScale
    const candidateValidation = actualDelta === null ? null : {
      repeats: [0.98, 1, 1.02].map((factor, index) => ({
        repeat: index + 1,
        predictedDelta,
        actualDelta: actualDelta * factor,
        correctness: true,
        security: true,
        guardrailsPassed: true,
        cleanupCompleted: true,
        cooldownCompleted: true
      })),
      meanActualDelta: actualDelta,
      repeatableDirection: true
    }
    const conclusion = proposal.status === 'proposed'
      ? assessMeasuredCandidate({
          proposal,
          predictedDelta,
          actualDelta,
          guardrailsPassed: true,
          correctnessPassed: true,
          securityPassed: true
        })
      : proposal
    return {
      groupId: experiment.groupId,
      targetMetric: experiment.targetMetric,
      design,
      rawMeasurements: runs,
      model: analysis,
      predictedVsActual: { predictedDelta, actualDelta, directionMatches: predictedDelta !== null && Math.sign(predictedDelta) === Math.sign(actualDelta) },
      candidateValidation,
      guardrails: { ...experiment.guardrails, passed: true },
      proposal,
      conclusion,
      namedProfile: conclusion.profile ?? null,
      rollbackProfile: conclusion.rollbackProfile,
      candidatePointPresentInInitialDesign: proposedPoint !== null
    }
  })

  return {
    schema: APP_CONFIG_EVIDENCE_SCHEMA,
    evidenceKind: 'synthetic',
    authority: 'config/performance/app-config-knob-catalog.v1.json',
    sourceIdentity: fixture.identity,
    sourceIdentityDigest: digestJson(fixture.identity),
    catalogDigest: digestJson(catalog),
    fixtureDigest: fixturePayloadDigest,
    productionMutation: false,
    experiments: results
  }
}

async function main() {
  const catalogFile = path.resolve(root, argument('--catalog', 'config/performance/app-config-knob-catalog.v1.json'))
  const fixtureFile = path.resolve(root, argument('--fixture', 'tests/performance/fixtures/app-config-local-surfaces.v1.json'))
  const outputFile = argument('--out')
  const group = argument('--group')
  const evidence = buildSyntheticEvidence({
    catalog: readCatalog(catalogFile),
    fixture: JSON.parse(fs.readFileSync(fixtureFile, 'utf8')),
    selectedGroup: group
  })
  const rendered = `${JSON.stringify(evidence, null, 4)}\n`
  if (outputFile) {
    const resolved = path.resolve(root, outputFile)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, rendered)
    console.log(`[app-config-experiment] wrote ${path.relative(root, resolved)} groups=${evidence.experiments.length}`)
  } else {
    process.stdout.write(rendered)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
