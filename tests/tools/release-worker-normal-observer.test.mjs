import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  completeRolloutStage,
  createRolloutState,
  startRolloutStage,
  writeRolloutStateAtomic
} from '../../tools/deployment/release-rollout-lib.mjs'
import {
  NORMAL_WORKER_KINDS,
  NORMAL_WORKER_LEDGER_SCHEMA,
  NORMAL_WORKER_OBSERVER_PLAN_SCHEMA,
  NORMAL_WORKER_OBSERVER_SCHEMA,
  NormalWorkerObserverError,
  normalizeNormalWorkerObserverPlan,
  runNormalWorkerObserver,
  validateCompletedNormalEvents
} from '../../tools/deployment/release-worker-normal-observer.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const planTemplate = path.join(root, 'tests/fixtures/deployment/release-worker-normal-observer-plan.template.json')
const source = {
  slot: 'blue',
  releaseId: '20260711010101-aaaaaaaaaaaa',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeGeneration: 71
}
const target = {
  slot: 'green',
  releaseId: '20260711020202-bbbbbbbbbbbb',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  runtimeGeneration: 72
}
const armedAtUtc = '2026-07-11T00:06:00.000Z'
const drainAtUtc = '2026-07-11T00:10:00.000Z'
const completedAtUtc = '2026-07-11T00:10:02.000Z'

test('normal observer plan template is registered with the producer schema', () => {
  assert.equal(JSON.parse(fs.readFileSync(planTemplate, 'utf8')).schema, NORMAL_WORKER_OBSERVER_PLAN_SCHEMA)
})

test('normal observer plan rejects every unsafe field and any destructive ninth kind together', () => {
  assert.throws(
    () => normalizeNormalWorkerObserverPlan({
      schema: 'wrong.schema',
      baseUrl: 'https://example.com/escaped',
      startPath: '//attacker.example/start',
      statusPath: '/../status',
      finalizePath: 'relative/finalize',
      requiredKinds: [...NORMAL_WORKER_KINDS, 'forced-source-recovery'],
      timeoutMs: 1,
      pollMs: 100_000
    }),
    error => {
      assert.ok(error instanceof NormalWorkerObserverError)
      assert.ok(error.errors.length >= 8)
      assert.ok(error.errors.some(item => item.includes('plan schema')))
      assert.ok(error.errors.some(item => item.includes('loopback')))
      assert.ok(error.errors.some(item => item.includes('plan.startPath')))
      assert.ok(error.errors.some(item => item.includes('plan.statusPath')))
      assert.ok(error.errors.some(item => item.includes('plan.finalizePath')))
      assert.ok(error.errors.some(item => item.includes('exact ordered normal set')))
      assert.ok(error.errors.some(item => item.includes('plan.timeoutMs')))
      assert.ok(error.errors.some(item => item.includes('plan.pollMs')))
      return true
    })
})

test('normal producer binds real observer start/finalize responses to rollout and graceful drain evidence', async t => {
  const fixture = makeFixture(t, 'pass')
  const rollout = rolloutAtCandidateStart(fixture)
  const drain = passingDrain()
  writeJson(fixture.drain, drain)
  fs.writeFileSync(fixture.adminHeader, 'Authorization: Bearer fixture-normal-observer\n', { mode: 0o600 })

  const runId = 'normal-worker-run-20260711'
  const armedEvents = buildArmedEvents(rollout)
  const completedEvents = buildCompletedEvents(rollout)
  const requests = []
  const fetchImpl = async (urlValue, options) => {
    const url = new URL(urlValue)
    const body = options.body === undefined ? null : JSON.parse(options.body)
    requests.push({ url, method: options.method, headers: options.headers, body })
    if (url.pathname.endsWith('/start')) {
      return jsonResponse(observerEnvelope(rollout, runId, 'armed', armedAtUtc, armedEvents))
    }
    if (url.pathname.endsWith('/finalize')) {
      return jsonResponse(observerEnvelope(rollout, runId, 'pass', completedAtUtc, completedEvents))
    }
    throw new Error(`unexpected observer request: ${options.method} ${url.pathname}`)
  }
  const times = ['2026-07-11T00:05:30.000Z', '2026-07-11T00:10:03.000Z']
  let timeIndex = 0

  const ledger = await runNormalWorkerObserver({
    plan: planTemplate,
    rolloutState: fixture.state,
    sourceDrain: fixture.drain,
    adminHeaderFile: fixture.adminHeader,
    out: fixture.output,
    runId,
    startStage: 'candidate-start',
    timeoutMs: 10_000
  }, {
    fetchImpl,
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)])
  })

  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map(item => [item.method, item.url.pathname]), [
    ['POST', '/api/ops/release/workers/normal/start'],
    ['POST', '/api/ops/release/workers/normal/finalize']
  ])
  assert.equal(requests[0].headers.Authorization, 'Bearer fixture-normal-observer')
  assert.equal(requests[0].body.destructive, false)
  assert.deepEqual(requests[0].body.requiredKinds, [...NORMAL_WORKER_KINDS])
  assert.equal(requests[1].body.destructive, false)
  assert.match(requests[1].body.sourceDrain.sha256, /^sha256:[0-9a-f]{64}$/u)

  assert.equal(ledger.schema, NORMAL_WORKER_LEDGER_SCHEMA)
  assert.equal(ledger.mode, 'normal')
  assert.equal(ledger.status, 'pass')
  assert.equal(ledger.rolloutId, rollout.rolloutId)
  assert.deepEqual(ledger.source, releaseIdentity(rollout.source))
  assert.deepEqual(ledger.target, releaseIdentity(rollout.target))
  assert.equal(ledger.drill.destructive, false)
  assert.equal(ledger.drill.forcedSourceTermination, false)
  assert.equal(ledger.drill.drainCompletedAtUtc, drainAtUtc)
  assert.deepEqual(ledger.events.map(item => item.kind), [...NORMAL_WORKER_KINDS])
  assert.ok(ledger.events.every(item => item.pendingCountAtDrain === 1))
  assert.ok(ledger.events.every(item => item.finalEffectCount === 1))
  assert.ok(ledger.events.every(item => item.finalReleaseId === target.releaseId))
  assert.ok(ledger.events.every(item => item.finalGeneration === target.runtimeGeneration))
  assert.ok(ledger.events.every(item => item.staleGenerationCommitCount === 0))
  assert.deepEqual(ledger.errors, [])
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.output, 'utf8')), ledger)
})

test('normal event validation keeps all observer errors and rejects destructive recovery fields', t => {
  const fixture = makeFixture(t, 'errors')
  const rollout = rolloutAtCandidateStart(fixture)
  const armedEvents = buildArmedEvents(rollout)
  const completedEvents = buildCompletedEvents(rollout)
  completedEvents[0].recoveredByTarget = false
  completedEvents[1].forcedSourceTermination = true
  for (let eventIndex = 0; eventIndex < completedEvents.length; eventIndex += 1) {
    completedEvents[eventIndex].errors = Array.from(
      { length: 12 },
      (_, errorIndex) => `observer-error-${eventIndex}-${errorIndex}`)
  }

  const result = validateCompletedNormalEvents(completedEvents, armedEvents, rollout, passingDrain())
  assert.ok(result.errors.some(item => item.includes('destructive qualification field')))
  for (let eventIndex = 0; eventIndex < completedEvents.length; eventIndex += 1) {
    for (let errorIndex = 0; errorIndex < 12; errorIndex += 1) {
      assert.ok(result.errors.some(item => item.includes(`observer-error-${eventIndex}-${errorIndex}`)))
    }
  }
  assert.ok(result.errors.length >= 98)
})

function makeFixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-normal-worker-observer-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    state: path.join(directory, 'rollout-state.json'),
    drain: path.join(directory, 'source-drain-gate.json'),
    adminHeader: path.join(directory, 'admin-header.txt'),
    output: path.join(directory, 'normal-worker-ledger.json')
  }
}

function rolloutAtCandidateStart(fixture) {
  const state = createRolloutState({
    ...createCurrentRolloutFixtureBinding(),
    rolloutId: `normal-observer-${path.basename(fixture.directory)}`.slice(0, 120),
    kind: 'deploy',
    manifestPath: path.join(fixture.directory, 'release-manifest.json'),
    source,
    target,
    createdAtUtc: '2026-07-11T00:00:00.000Z'
  })
  const stages = [
    'manifest-validate',
    'capacity-preflight',
    'backup-restore-gate',
    'current-schema-admission',
    'asset-materialize'
  ]
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]
    startRolloutStage(state, stage, `2026-07-11T00:0${index}:00.000Z`)
    completeRolloutStage(state, stage, { completedAtUtc: `2026-07-11T00:0${index}:01.000Z` })
  }
  startRolloutStage(state, 'candidate-start', '2026-07-11T00:05:00.000Z')
  writeRolloutStateAtomic(fixture.state, state)
  return state
}

function passingDrain() {
  return {
    schema: 'fsusblog.release-rollout-gate.v1',
    gate: 'source-drain',
    status: 'pass',
    observations: { blockers: [] },
    observedAtUtc: drainAtUtc,
    errors: []
  }
}

function observerEnvelope(rollout, runId, status, observedAtUtc, events) {
  return {
    schema: NORMAL_WORKER_OBSERVER_SCHEMA,
    status,
    runId,
    rolloutId: rollout.rolloutId,
    destructive: false,
    source: releaseIdentity(rollout.source),
    target: releaseIdentity(rollout.target),
    observedAtUtc,
    events,
    errors: []
  }
}

function buildArmedEvents(rollout) {
  const replaySources = ['postgres-outbox', 'postgres-row-lock', 'redis-stream', 'durable-upload-session']
  return NORMAL_WORKER_KINDS.map((kind, index) => {
    const event = {
      logicalEventId: `normal-event-${index}-${kind}`,
      kind,
      pendingCountAtDrain: 1,
      durableReplaySource: replaySources[index % replaySources.length],
      sourceReleaseId: rollout.source.releaseId,
      sourceGeneration: rollout.source.runtimeGeneration,
      observedAtUtc: armedAtUtc
    }
    event.observationBindings = bindings(event, [
      'logicalEventId',
      'pendingCountAtDrain',
      'durableReplaySource',
      'sourceReleaseId',
      'sourceGeneration'
    ], index, armedAtUtc)
    return event
  })
}

function buildCompletedEvents(rollout) {
  return NORMAL_WORKER_KINDS.map((kind, index) => {
    const event = {
      logicalEventId: `normal-event-${index}-${kind}`,
      kind,
      attemptCount: index % 2 === 0 ? 1 : 2,
      finalEffectCount: 1,
      finalEffectKey: `normal-effect-${index}-${kind}`,
      finalReleaseId: rollout.target.releaseId,
      finalGeneration: rollout.target.runtimeGeneration,
      staleGenerationCommitCount: 0,
      observationSource: index === 6 ? 'runtime-control' : index === 7 ? 'redis' : 'postgres',
      observedAtUtc: completedAtUtc,
      errors: []
    }
    const fields = [
      'attemptCount',
      'finalEffectCount',
      'finalEffectKey',
      'finalReleaseId',
      'finalGeneration',
      'staleGenerationCommitCount'
    ]
    if (kind === 'audit-writer') {
      event.expectedAuditCount = 1
      event.actualAuditCount = 1
      fields.push('expectedAuditCount', 'actualAuditCount')
    }
    if (kind === 'visit-view-projection') {
      event.expectedProjectionCount = 1
      event.actualProjectionCount = 1
      fields.push('expectedProjectionCount', 'actualProjectionCount')
    }
    event.observationBindings = bindings(event, fields, index, completedAtUtc)
    return event
  })
}

function bindings(event, fields, index, observedAtUtc) {
  return Object.fromEntries(fields.map(field => [field, {
    probe: event.observationSource === 'redis' ? 'redis-worker-observer' : 'postgres-worker-observer',
    pointer: `/events/${index}/${field}`,
    observedAtUtc,
    valueSha256: sha256Value(event[field])
  }]))
}

function releaseIdentity(value) {
  return {
    releaseId: value.releaseId,
    imageDigest: value.imageDigest,
    slot: value.slot,
    generation: value.runtimeGeneration
  }
}

function sha256Value(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(value) }
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}
