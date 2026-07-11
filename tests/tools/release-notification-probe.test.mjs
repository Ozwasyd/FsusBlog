import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  NOTIFICATION_EVIDENCE_SCHEMA,
  REPLAY_MISS_CLOSE_CODE,
  REPLAY_MISS_REASON,
  SERVICE_RESTART_CLOSE_CODE,
  SERVICE_RESTART_REASON,
  createState,
  emptyClient,
  expectedDrillEvents,
  finalizeNotificationEvidence,
  normalizeResyncScenario,
  recordClientEvent
} from '../../tools/deployment/release-notification-probe.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scenarioTemplate = path.join(root, 'tests/fixtures/deployment/release-notification-resync-scenario.template.json')
const source = {
  slot: 'blue',
  releaseId: '20260710010101-aaaaaaaaaaaa',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeGeneration: 71
}
const target = {
  slot: 'green',
  releaseId: '20260711010101-bbbbbbbbbbbb',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  runtimeGeneration: 72
}

function readScenario() {
  return JSON.parse(fs.readFileSync(scenarioTemplate, 'utf8'))
}

function published(phase, firstEventId, count = 3) {
  return {
    releaseId: target.releaseId,
    slot: target.slot,
    generation: target.runtimeGeneration,
    drillId: `notification-${phase}-20260711`,
    eventIds: Array.from({ length: count }, (_, index) => firstEventId + index)
  }
}

function fixtureState() {
  const scenario = normalizeResyncScenario(readScenario())
  const state = createState({ rolloutId: 'notification-rollout-20260711', source, target }, scenario)
  state.clients.slow = emptyClient('slow', 'guest')
  state.clients.staleGuest = emptyClient('staleGuest', 'guest')
  state.clients.staleAuth = emptyClient('staleAuth', 'auth')
  state.expected.pre = expectedDrillEvents(published('pre', 101), 'pre-switch')
  state.expected.post = expectedDrillEvents(published('post', 104), 'post-switch')
  state.expected.gap = expectedDrillEvents(published('gap', 107), 'replay-gap')
  state.expected.afterResync = expectedDrillEvents(published('after', 110), 'after-resync')
  return state
}

function addEvent(state, label, expected) {
  recordClientEvent(state, label, {
    type: 'event',
    eventId: expected.eventId,
    businessEventId: expected.businessEventId,
    eventType: 10,
    timestamp: 1_752_192_000_000 + expected.eventId,
    duplicate: false,
    payload: {
      drillId: expected.drillId,
      sequence: expected.sequence,
      releaseId: expected.releaseId,
      slot: expected.slot,
      generation: expected.generation
    }
  })
}

function closeAndReconnect(state, label, code, reason, cursorBeforeClose, reconnectCursor) {
  recordClientEvent(state, label, {
    type: 'close', code, reason, cursorBeforeClose, closedAtUtc: '2026-07-11T02:00:00.000Z'
  })
  recordClientEvent(state, label, {
    type: 'open',
    protocol: 'fsus-aeds.v2',
    reconnect: {
      afterCloseCode: code,
      afterCloseReason: reason,
      cursorBeforeClose,
      reconnectCursor,
      scheduledDelayMs: 500,
      observedDurationMs: 510
    }
  })
}

function addResync(state, label, phase, watermark, hash) {
  recordClientEvent(state, label, {
    type: 'resync',
    phase,
    mode: state.clients[label].mode,
    status: 'pass',
    requestedPath: `/api/release-evidence/notification-state?audience=${state.clients[label].mode}`,
    httpStatus: 200,
    contentType: 'application/json; charset=utf-8',
    bytes: 128,
    watermark,
    contentSha256: hash,
    declaredContentSha256: hash,
    releaseId: target.releaseId,
    releaseSlot: target.slot,
    observedAtUtc: phase === 'final' ? '2026-07-11T02:00:03.000Z' : '2026-07-11T02:00:01.000Z',
    errors: []
  })
}

function populatePassingState(state) {
  const all = Object.values(state.expected).flat()
  for (const label of ['guest', 'auth']) {
    for (const expected of all) addEvent(state, label, expected)
    const cursor = state.expected.post.at(-1).eventId
    closeAndReconnect(state, label, SERVICE_RESTART_CLOSE_CODE, SERVICE_RESTART_REASON, cursor, cursor)
  }
  const beforeWatermark = state.expected.gap.at(-1).eventId
  const finalWatermark = state.expected.afterResync.at(-1).eventId
  for (const [label, hash] of [['staleGuest', `sha256:${'c'.repeat(64)}`], ['staleAuth', `sha256:${'d'.repeat(64)}`]]) {
    recordClientEvent(state, label, {
      type: 'close',
      code: REPLAY_MISS_CLOSE_CODE,
      reason: REPLAY_MISS_REASON,
      cursorBeforeClose: 1,
      closedAtUtc: '2026-07-11T02:00:00.000Z'
    })
    addResync(state, label, 'replay-miss', beforeWatermark, hash)
    recordClientEvent(state, label, { type: 'full-resync', watermark: beforeWatermark, contentSha256: hash })
    recordClientEvent(state, label, {
      type: 'open',
      protocol: 'fsus-aeds.v2',
      reconnect: {
        afterCloseCode: REPLAY_MISS_CLOSE_CODE,
        afterCloseReason: REPLAY_MISS_REASON,
        cursorBeforeClose: 1,
        reconnectCursor: beforeWatermark,
        scheduledDelayMs: 500,
        observedDurationMs: 520
      }
    })
    for (const expected of state.expected.afterResync) addEvent(state, label, expected)
    addResync(state, label, 'final', finalWatermark, hash)
  }
  recordClientEvent(state, 'slow', {
    type: 'close',
    code: SERVICE_RESTART_CLOSE_CODE,
    reason: SERVICE_RESTART_REASON,
    cursorBeforeClose: state.expected.pre.at(-1).eventId,
    closedAtUtc: '2026-07-11T02:00:00.500Z'
  })
}

function makeDrain(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-notification-evidence-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'source-drain-gate.json')
  fs.writeFileSync(file, `${JSON.stringify({
    schema: 'fsusblog.release-rollout-gate.v1',
    gate: 'source-drain',
    status: 'pass',
    durationMs: 2500,
    observations: { blockers: [] },
    errors: [],
    ...overrides
  }, null, 2)}\n`)
  return file
}

test('resync scenario requires separate real guest/auth snapshot calls, response watermark/hash bindings, and bounded reconnect/drain budgets', () => {
  const scenario = normalizeResyncScenario(readScenario())
  assert.equal(scenario.stableContentHashRequired, true)
  assert.equal(scenario.modes.guest.path.includes('audience=guest'), true)
  assert.equal(scenario.modes.auth.path.includes('audience=auth'), true)
  assert.equal(scenario.modes.guest.watermarkHeader, 'X-Fsus-Notification-Watermark')
  assert.equal(scenario.modes.auth.contentHashHeader, 'X-Fsus-Content-Sha256')
  assert.deepEqual(scenario.reconnectDelayMs, { scheduled: 500, minimum: 250, maximum: 1250 })
  assert.equal(scenario.slowClientDrainDeadlineMs, 45000)
})

test('resync scenario returns every independent validation error without a maximum-error cap', () => {
  const broken = readScenario()
  broken.schema = 'wrong'
  broken.hashAlgorithm = 'none'
  broken.stableContentHashRequired = false
  broken.reconnectDelayMs = { scheduled: 1, minimum: 5000, maximum: 2 }
  broken.slowClientDrainDeadlineMs = 1
  for (const mode of ['guest', 'auth']) {
    broken.modes[mode] = {
      path: 'https://attacker.example/state',
      method: 'POST',
      accept: '',
      expectedContentType: '',
      watermarkHeader: 'Authorization',
      contentHashHeader: 'Authorization',
      minimumBytes: 100,
      maximumBytes: 1
    }
  }
  assert.throws(
    () => normalizeResyncScenario(broken),
    error => Array.isArray(error.errors)
      && error.errors.length >= 20
      && error.errors.some(item => item.includes('stableContentHashRequired'))
      && error.errors.some(item => item.includes('auth.path')))
})

test('final evidence binds guest/auth streams to real snapshot watermark and content hashes, preserves 1012 cursor replay, and reconciles business IDs exactly once', (t) => {
  const state = fixtureState()
  populatePassingState(state)
  const report = finalizeNotificationEvidence(state, { drainEvidence: makeDrain(t) })
  assert.equal(report.schema, NOTIFICATION_EVIDENCE_SCHEMA)
  assert.equal(report.contractVersion, 2)
  assert.equal(report.status, 'pass')
  assert.equal(report.serviceRestartObserved, true)
  assert.equal(report.cursorReplayVerified, true)
  assert.equal(report.replayMissFullResyncVerified, true)
  assert.equal(report.businessEventsExactlyOnce, true)
  assert.equal(report.slowClientDidNotBlockDrain, true)
  assert.equal(report.missingEventCount, 0)
  assert.equal(report.duplicateAppliedEventCount, 0)
  assert.equal(report.duplicateBusinessEventCount, 0)
  assert.equal(report.expectedEventIds.length, 12)
  assert.equal(report.expectedBusinessEventIds.length, 12)
  assert.equal(report.resync.staleGuest.length, 2)
  assert.equal(report.resync.staleAuth.length, 2)
  assert.match(report.evidenceSha256, /^sha256:[0-9a-f]{64}$/u)
})

test('final evidence cannot pass local-set clearing, stale/fake snapshots, event loss, duplicate business IDs, or slow drain and keeps all errors', (t) => {
  const state = fixtureState()
  populatePassingState(state)
  state.clients.staleGuest.resyncSnapshots[0].status = 'fail'
  state.clients.staleGuest.resyncSnapshots[0].watermark = 1
  state.clients.staleGuest.resyncSnapshots[0].declaredContentSha256 = `sha256:${'e'.repeat(64)}`
  state.clients.staleGuest.resyncSnapshots[1].contentSha256 = `sha256:${'f'.repeat(64)}`
  state.clients.staleGuest.reconnects[0].reconnectCursor = 0
  state.clients.auth.events = []
  state.clients.staleAuth.events.push({ ...state.clients.staleAuth.events[0] })
  state.clients.staleAuth.duplicateBusinessEventCount = 1
  for (let index = 0; index < 80; index += 1) state.clients.guest.errors.push(`uncapped-notification-error-${index}`)
  const report = finalizeNotificationEvidence(state, {
    drainEvidence: makeDrain(t, {
      status: 'fail',
      durationMs: 60000,
      observations: { blockers: ['notification-stream:1'] },
      errors: Array.from({ length: 40 }, (_, index) => `drain-error-${index}`)
    })
  })
  assert.equal(report.status, 'fail')
  assert.equal(report.replayMissFullResyncVerified, false)
  assert.equal(report.businessEventsExactlyOnce, false)
  assert.equal(report.slowClientDidNotBlockDrain, false)
  assert.ok(report.errors.length >= 100)
  for (let index = 0; index < 80; index += 1) {
    assert.ok(report.errors.includes(`guest:uncapped-notification-error-${index}`))
  }
  assert.ok(report.errors.some(item => item.includes('actual snapshot watermark')))
  assert.ok(report.errors.some(item => item.includes('content hash changed')))
  assert.ok(report.errors.some(item => item.includes('missing business event')))
  assert.ok(report.errors.some(item => item.includes('duplicate applied business events')))
  assert.ok(report.errors.some(item => item.includes('slow-client deadline')))
})
