import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRolloutState } from '../../tools/deployment/release-rollout-lib.mjs'
import {
  NORMAL_WORKER_COMMAND_SCHEMA,
  NORMAL_WORKER_KINDS,
  WORKER_KINDS,
  assertWorkerObserverEnvironment,
  buildObservationQuery,
  createWorkerObserverApplication,
  deriveWorkerObservation,
  normalizeWorkerObserverServicePlan,
  readPrivateAdminHeader,
  readPrivateEnvironmentFile
} from '../../tools/deployment/release-worker-observer-service.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const planTemplatePath = path.join(root, 'tests/fixtures/deployment/release-worker-observer-service-plan.template.json')
const source = {
  slot: 'blue',
  releaseId: '20260712010101-aaaaaaaaaaaa',
  imageDigest: `sha256:${'1'.repeat(64)}`,
  runtimeGeneration: 41
}
const target = {
  slot: 'green',
  releaseId: '20260712020202-bbbbbbbbbbbb',
  imageDigest: `sha256:${'2'.repeat(64)}`,
  runtimeGeneration: 42
}
const fixedNow = () => new Date('2026-07-12T04:00:00.000Z')
const adminHeader = { name: 'Authorization', value: 'Bearer fixture-worker-observer' }

test('service plan is explicit Test-only wiring and rejects unresolved topology placeholders', () => {
  const template = JSON.parse(fs.readFileSync(planTemplatePath, 'utf8'))
  assert.throws(() => normalizeWorkerObserverServicePlan(template), /unresolved template placeholders/u)

  const plan = materializedPlan()
  assert.deepEqual(plan.workers.map(worker => worker.kind), WORKER_KINDS)
  assert.equal(plan.routes.size, 8)
  assert.equal(plan.listen.host, '127.0.0.1')
  assert.equal(plan.nonProductionOnly, true)
})

test('plan rejects remote listeners, missing acknowledgement and authoritative result fields', () => {
  const remote = materializedPlanValue()
  remote.listen.host = '0.0.0.0'
  assert.throws(() => normalizeWorkerObserverServicePlan(remote), /loopback/u)

  const acknowledgement = materializedPlanValue()
  acknowledgement.acknowledgement = 'yes'
  assert.throws(() => normalizeWorkerObserverServicePlan(acknowledgement), /OBSERVE_ISOLATED_TEST_WORKERS_ONLY/u)

  const authority = materializedPlanValue()
  authority.workers[0].normalStart.staticBody.finalEffectCount = 1
  assert.throws(() => normalizeWorkerObserverServicePlan(authority), /forbidden authoritative result field/u)
})

test('runtime guard requires Test, rehearsal and explicit observer enablement together', () => {
  assert.equal(assertWorkerObserverEnvironment({
    ASPNETCORE_ENVIRONMENT: 'Test',
    FSUSBLOG_ROLLOUT_REHEARSAL: '1',
    FSUSBLOG_WORKER_OBSERVER_ENABLED: '1'
  }), true)
  assert.throws(() => assertWorkerObserverEnvironment({
    ASPNETCORE_ENVIRONMENT: 'Production',
    FSUSBLOG_ROLLOUT_REHEARSAL: '1',
    FSUSBLOG_WORKER_OBSERVER_ENABLED: '1'
  }), /ASPNETCORE_ENVIRONMENT/u)
  assert.throws(() => assertWorkerObserverEnvironment({
    ASPNETCORE_ENVIRONMENT: 'Test',
    FSUSBLOG_ROLLOUT_REHEARSAL: '0',
    FSUSBLOG_WORKER_OBSERVER_ENABLED: '1'
  }), /FSUSBLOG_ROLLOUT_REHEARSAL/u)
})

test('private environment and admin header files require mode 0400 or 0600', t => {
  const directory = temporaryDirectory(t, 'private-files')
  const environmentFile = path.join(directory, 'observer.env')
  const headerFile = path.join(directory, 'admin-header.txt')
  fs.writeFileSync(environmentFile, [
    'FSUSBLOG_WORKER_OBSERVER_PGHOST=127.0.0.1',
    'FSUSBLOG_WORKER_OBSERVER_PGPORT=5432',
    'FSUSBLOG_WORKER_OBSERVER_PGDATABASE=fsusblog_test',
    'FSUSBLOG_WORKER_OBSERVER_PGUSER=fsusblog_test',
    'FSUSBLOG_WORKER_OBSERVER_PGPASSWORD=fixture-secret',
    'FSUSBLOG_WORKER_OBSERVER_REDIS_HOST=127.0.0.1',
    'FSUSBLOG_WORKER_OBSERVER_REDIS_PORT=6379',
    'FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE=15',
    ''
  ].join('\n'), { mode: 0o600 })
  fs.writeFileSync(headerFile, 'Authorization: Bearer fixture-worker-observer\n', { mode: 0o400 })
  assert.equal(readPrivateEnvironmentFile(environmentFile).FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE, '15')
  assert.deepEqual(readPrivateAdminHeader(headerFile), adminHeader)

  fs.chmodSync(environmentFile, 0o644)
  assert.throws(() => readPrivateEnvironmentFile(environmentFile), /0400 or 0600/u)
})

test('PostgreSQL query is generated from identifiers and bound selectors rather than plan SQL', () => {
  const plan = materializedPlan()
  const sql = buildObservationQuery(plan.observation, {
    kind: 'scheduled-publish',
    rolloutId: 'rollout-query-20260712',
    logicalEventId: null,
    articleId: 99
  })
  assert.match(sql, /FROM "public"\."release_worker_attempt_observation"/u)
  assert.match(sql, /"rollout_id" = 'rollout-query-20260712'/u)
  assert.match(sql, /"article_id" = 99/u)
  assert.doesNotMatch(sql, /REPLACE_/u)
})

test('pending and final values are derived from real attempt rows and accepted receipts', () => {
  const plan = materializedPlan()
  const rollout = rolloutState()
  const worker = plan.workers.find(value => value.kind === 'audit-writer')
  const logicalEventId = 'logical-event-audit-0001'
  const pending = attemptRow({
    logicalEventId,
    kind: worker.kind,
    attemptKey: 'attempt-source-audit-0001',
    status: 'pending',
    identity: source,
    expectedEffectCount: 1,
    auditCount: 0
  })
  const armed = deriveWorkerObservation({
    phase: 'pending',
    kind: worker.kind,
    worker,
    rollout,
    rows: [pending],
    logicalEventId,
    actionReceiptCount: 1,
    now: fixedNow
  })
  assert.equal(armed.ready, true)
  assert.equal(armed.pendingCountAtDrain, 1)
  assert.equal(armed.sourceReleaseId, source.releaseId)

  const committed = attemptRow({
    logicalEventId,
    kind: worker.kind,
    attemptKey: 'attempt-target-audit-0001',
    status: 'committed',
    identity: target,
    effectKey: 'effect-audit-00000001',
    expectedEffectCount: 1,
    auditCount: 1
  })
  const final = deriveWorkerObservation({
    phase: 'final',
    kind: worker.kind,
    worker,
    rollout,
    rows: [pending, committed],
    logicalEventId,
    actionReceiptCount: 1,
    now: fixedNow
  })
  assert.equal(final.ready, true)
  assert.equal(final.attemptCount, 2)
  assert.equal(final.finalEffectCount, 1)
  assert.equal(final.finalEffectKey, committed.effectKey)
  assert.equal(final.finalReleaseId, target.releaseId)
  assert.equal(final.finalGeneration, target.runtimeGeneration)
  assert.equal(final.staleGenerationCommitCount, 0)
  assert.equal(final.expectedAuditCount, 1)
  assert.equal(final.actualAuditCount, 1)
})

test('multiple effects and stale generation commits fail closed from observed rows', () => {
  const plan = materializedPlan()
  const rollout = rolloutState()
  const worker = plan.workers.find(value => value.kind === 'article-mutation-outbox')
  const logicalEventId = 'logical-event-stale-0001'
  const rows = [
    attemptRow({
      logicalEventId,
      kind: worker.kind,
      attemptKey: 'attempt-target-stale-0001',
      status: 'committed',
      identity: target,
      effectKey: 'effect-target-stale-0001'
    }),
    attemptRow({
      logicalEventId,
      kind: worker.kind,
      attemptKey: 'attempt-source-stale-0001',
      status: 'committed',
      identity: source,
      effectKey: 'effect-source-stale-0001'
    })
  ]
  const result = deriveWorkerObservation({
    phase: 'final', kind: worker.kind, worker, rollout, rows, logicalEventId, now: fixedNow
  })
  assert.equal(result.ready, false)
  assert.equal(result.fatal, true)
  assert.equal(result.finalEffectCount, 2)
  assert.equal(result.staleGenerationCommitCount, 1)
  assert.match(result.errors.join('\n'), /more than one durable final effect/u)
  assert.match(result.errors.join('\n'), /stale release\/generation/u)
})

test('drill action records only a real receipt and observation remains fail-closed without rows', async () => {
  const plan = materializedPlan()
  const rollout = rolloutState()
  const journals = memoryJournals()
  const calls = []
  const app = createWorkerObserverApplication({ plan, adminHeader, stateDir: '/unused' }, {
    now: fixedNow,
    readRollout: () => rollout,
    recordProvider: { query: async () => [] },
    infrastructureReader: { verify: async () => ({ ok: true, checks: [] }) },
    actionExecutor: {
      async execute(_action, context) {
        calls.push(context)
        return {
          accepted: true,
          receiptId: 'real-admin-receipt-0001',
          logicalEventId: context.body.logicalEventId,
          rolloutId: rollout.rolloutId,
          observedAtUtc: fixedNow().toISOString(),
          backend: 'protected-admin-http'
        }
      }
    },
    journals
  })
  const logicalEventId = 'logical-event-action-0001'
  const action = await app.dispatch(localRequest('POST', '/actions/audit-writer', {
    logicalEventId,
    rolloutId: rollout.rolloutId
  }))
  assert.equal(action.statusCode, 202)
  assert.equal(action.body.status, 'accepted')
  assert.equal(action.body.actionReceiptId, 'real-admin-receipt-0001')
  assert.equal(Object.hasOwn(action.body, 'finalEffectCount'), false)
  assert.equal(calls.length, 1)

  const observation = await app.dispatch(localRequest(
    'GET',
    `/observations/audit-writer/final?logicalEventId=${logicalEventId}&rolloutId=${rollout.rolloutId}`))
  assert.equal(observation.statusCode, 200)
  assert.equal(observation.body.ready, false)
  assert.equal(observation.body.finalEffectCount, 0)
  assert.match(observation.body.waiting.join('\n'), /no real worker attempt/u)
})

test('normal start arms eight real pending events and finalize passes only after target effects exist', async t => {
  const plan = materializedPlan()
  const rollout = rolloutState()
  const journals = memoryJournals()
  let completed = false
  const app = createWorkerObserverApplication({ plan, adminHeader, stateDir: '/unused' }, {
    now: fixedNow,
    readRollout: () => rollout,
    infrastructureReader: { verify: async () => ({ ok: true, checks: [] }) },
    actionExecutor: {
      async execute(_action, context) {
        return {
          accepted: true,
          receiptId: `real-${context.kind}-${crypto.createHash('sha256').update(context.body.logicalEventId).digest('hex').slice(0, 12)}`,
          logicalEventId: context.body.logicalEventId,
          rolloutId: rollout.rolloutId,
          observedAtUtc: fixedNow().toISOString(),
          backend: 'protected-admin-http'
        }
      }
    },
    recordProvider: {
      async query(selector) {
        const pending = normalPendingRow(selector)
        return completed ? [pending, normalCommittedRow(selector)] : [pending]
      }
    },
    journals
  })
  const runId = 'normal-observer-run-20260712'
  const start = await app.dispatch(localRequest('POST', '/api/ops/release/workers/normal/start', {
    ...normalCommand(rollout, runId),
    action: 'start-normal-worker-observation',
    requiredKinds: NORMAL_WORKER_KINDS
  }))
  assert.equal(start.statusCode, 200)
  assert.equal(start.body.status, 'armed')
  assert.equal(start.body.events.length, NORMAL_WORKER_KINDS.length)
  assert.equal(start.body.events.every(event => event.pendingCountAtDrain === 1), true)

  const directory = temporaryDirectory(t, 'normal-finalize')
  const drainPath = path.join(directory, 'source-drain.json')
  fs.writeFileSync(drainPath, `${JSON.stringify({
    schema: 'fsusblog.release-rollout-gate.v1',
    gate: 'source-drain',
    status: 'pass',
    observations: { blockers: [] },
    observedAtUtc: '2026-07-12T03:59:00.000Z',
    errors: []
  })}\n`)
  const drain = {
    path: drainPath,
    bytes: fs.statSync(drainPath).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(drainPath)).digest('hex')
  }
  completed = true
  const finalized = await app.dispatch(localRequest('POST', '/api/ops/release/workers/normal/finalize', {
    ...normalCommand(rollout, runId),
    action: 'finalize-after-graceful-drain',
    sourceDrain: drain
  }))
  assert.equal(finalized.statusCode, 200)
  assert.equal(finalized.body.status, 'pass')
  assert.equal(finalized.body.events.every(event => event.finalEffectCount === 1), true)
  assert.equal(finalized.body.events.every(event => event.finalReleaseId === target.releaseId), true)
})

test('missing topology readback prevents action execution', async () => {
  const plan = materializedPlan()
  const rollout = rolloutState()
  let actionCalls = 0
  const app = createWorkerObserverApplication({ plan, adminHeader, stateDir: '/unused' }, {
    now: fixedNow,
    readRollout: () => rollout,
    recordProvider: { query: async () => [] },
    infrastructureReader: { verify: async () => ({ ok: false, errors: ['target fence missing'], checks: [] }) },
    actionExecutor: { execute: async () => { actionCalls += 1 } },
    journals: memoryJournals()
  })
  const result = await app.dispatch(localRequest('POST', '/actions/public-hot-aot', {
    logicalEventId: 'logical-event-no-fence-0001',
    rolloutId: rollout.rolloutId
  }))
  assert.equal(result.statusCode, 503)
  assert.equal(result.body.status, 'fail')
  assert.equal(actionCalls, 0)
})

function materializedPlanValue() {
  const text = fs.readFileSync(planTemplatePath, 'utf8')
    .replaceAll('REPLACE_SOURCE_CONTAINER', 'fsusblog_test_blue')
    .replaceAll('REPLACE_TARGET_CONTAINER', 'fsusblog_test_green')
    .replaceAll('REPLACE_REAL_WORKER_ATTEMPT_VIEW', 'release_worker_attempt_observation')
    .replaceAll('REPLACE_REAL_TEST_ACTION_PREFIX', 'api/ops/test/release/workers/actions')
  return JSON.parse(text)
}

function materializedPlan() {
  return normalizeWorkerObserverServicePlan(materializedPlanValue())
}

function rolloutState() {
  return createRolloutState({
    ...createCurrentRolloutFixtureBinding(),
    rolloutId: 'worker-observer-rollout-20260712',
    kind: 'deploy',
    manifestPath: '/tmp/fsusblog-worker-observer-release-manifest.json',
    source,
    target,
    createdAtUtc: '2026-07-12T03:00:00.000Z'
  })
}

function attemptRow({ logicalEventId, kind, attemptKey, status, identity, effectKey = null, ...extra }) {
  return {
    logicalEventId,
    rolloutId: 'worker-observer-rollout-20260712',
    kind,
    attemptKey,
    status,
    releaseId: identity.releaseId,
    generation: identity.runtimeGeneration,
    effectKey,
    workerIdentity: `worker-${identity.slot}-${kind}`,
    durableReplaySource: kind === 'upload-cleanup' ? 'durable-upload-session' : 'postgres-outbox',
    observedAtUtc: '2026-07-12T03:30:00.000Z',
    ...extra
  }
}

function normalPendingRow(selector) {
  return attemptRow({
    logicalEventId: selector.logicalEventId,
    kind: selector.kind,
    attemptKey: `attempt-source-${selector.kind}-0001`,
    status: 'pending',
    identity: source,
    expectedEffectCount: 1,
    auditCount: selector.kind === 'audit-writer' ? 0 : null,
    projectionCount: selector.kind === 'visit-view-projection' ? 0 : null,
    ownerCount: selector.kind === 'active-singleton-control' ? 1 : null,
    consumerCount: selector.kind === 'multi-consumer-safe-control' ? 2 : null
  })
}

function normalCommittedRow(selector) {
  return attemptRow({
    logicalEventId: selector.logicalEventId,
    kind: selector.kind,
    attemptKey: `attempt-target-${selector.kind}-0001`,
    status: 'committed',
    identity: target,
    effectKey: `effect-${selector.kind}-0001`,
    expectedEffectCount: 1,
    auditCount: selector.kind === 'audit-writer' ? 1 : null,
    projectionCount: selector.kind === 'visit-view-projection' ? 1 : null,
    ownerCount: selector.kind === 'active-singleton-control' ? 1 : null,
    consumerCount: selector.kind === 'multi-consumer-safe-control' ? 2 : null
  })
}

function normalCommand(rollout, runId) {
  return {
    schema: NORMAL_WORKER_COMMAND_SCHEMA,
    runId,
    rolloutId: rollout.rolloutId,
    destructive: false,
    source: binding(rollout.source),
    target: binding(rollout.target)
  }
}

function binding(value) {
  return {
    releaseId: value.releaseId,
    imageDigest: value.imageDigest,
    slot: value.slot,
    generation: value.runtimeGeneration
  }
}

function localRequest(method, url, body = {}) {
  return {
    method,
    url,
    headers: { Authorization: adminHeader.value },
    body,
    remoteAddress: '127.0.0.1'
  }
}

function memoryJournals() {
  const runs = new Map()
  const events = new Map()
  return {
    getRun(runId) { return runs.get(runId) ?? null },
    putRun(run) { runs.set(run.runId, run) },
    getEvent(kind, logicalEventId) { return events.get(`${kind}\u0000${logicalEventId}`) ?? null },
    appendEventReceipt(kind, logicalEventId, receipt) {
      const key = `${kind}\u0000${logicalEventId}`
      const journal = events.get(key) ?? { kind, logicalEventId, receipts: [] }
      if (!journal.receipts.some(value => value.receiptId === receipt.receiptId)) journal.receipts.push(receipt)
      events.set(key, journal)
      return journal
    }
  }
}

function temporaryDirectory(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-worker-observer-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
