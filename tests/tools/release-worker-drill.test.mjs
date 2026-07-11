import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  validatePlan,
  validateReadSqlOrThrow,
  validateWriteSqlOrThrow
} from '../../tools/deployment/release-worker-drill.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixturePath = path.join(root, 'tests/fixtures/deployment/release-worker-drill-plan.template.json')
const sourcePath = path.join(root, 'tools/deployment/release-worker-drill.mjs')
const requiredKinds = [
  'scheduled-publish',
  'article-mutation-outbox',
  'audit-writer',
  'visit-view-projection',
  'public-hot-aot',
  'upload-cleanup',
  'active-singleton-control',
  'multi-consumer-safe-control',
  'forced-source-recovery'
]

test('worker drill template covers every required durable-work scenario exactly once', () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  assert.equal(fixture.schema, 'fsusblog.release-worker-drill-plan.v1')
  assert.deepEqual(fixture.events.map(event => event.kind).sort(), [...requiredKinds].sort())
  assert.equal(new Set(fixture.events.map(event => event.kind)).size, requiredKinds.length)
  assert.equal(fixture.sourceTermination.type, 'docker-kill')
  assert.equal(fixture.sourceTermination.signal, 'SIGKILL')
  assert.equal(fixture.coordination.mode, 'file-handshake')
  assert.match(fixture.coordination.armedFile, /armed/u)
  assert.match(fixture.coordination.authorizeFile, /terminate-source/u)
  assert.match(fixture.coordination.terminatedFile, /source-terminated/u)

  for (const event of fixture.events) {
    assert.ok(event.prepare.length + event.trigger.length > 0, `${event.kind} must perform a real action`)
    assert.ok(event.beforeTermination.length > 0, `${event.kind} must prove durable pending state`)
    assert.ok(event.observations.length > 0, `${event.kind} must query final state`)
    assert.ok(event.ledger.observedLogicalEventId)
    assert.ok(event.ledger.attemptCount)
    assert.ok(event.ledger.finalEffectCount)
    assert.ok(event.ledger.finalGeneration)
    assert.ok(event.ledger.staleGenerationCommitCount)
    assert.ok(event.ledger.pendingLogicalEventId)
    assert.ok(event.ledger.pendingCountAtDrain)
    assert.ok(event.ledger.durableReplaySource)
    for (const binding of Object.values(event.ledger)) {
      assert.deepEqual(Object.keys(binding).sort(), ['pointer', 'probe', 'type'])
      assert.equal(Object.hasOwn(binding, 'value'), false)
      assert.equal(Object.hasOwn(binding, 'literal'), false)
    }
  }
  assert.ok(fixture.events.find(event => event.kind === 'audit-writer').ledger.expectedAuditCount)
  assert.ok(fixture.events.find(event => event.kind === 'audit-writer').ledger.actualAuditCount)
  assert.ok(fixture.events.find(event => event.kind === 'visit-view-projection').ledger.expectedProjectionCount)
  assert.ok(fixture.events.find(event => event.kind === 'visit-view-projection').ledger.actualProjectionCount)
  assert.ok(fixture.events.find(event => event.kind === 'forced-source-recovery').ledger.recoveredByTarget)
})

test('SQL boundary accepts only one bounded read or one receipted INSERT/UPDATE', () => {
  const reads = new Set(['article', 'article_mutation_outbox'])
  const writes = new Set(['article_mutation_outbox'])
  assert.equal(
    validateReadSqlOrThrow("SELECT json_build_object('count', COUNT(*)) FROM article", reads),
    "SELECT json_build_object('count', COUNT(*)) FROM article")
  assert.equal(
    validateWriteSqlOrThrow(
      "UPDATE article_mutation_outbox SET status = 'pending' WHERE id = 7 RETURNING json_build_object('id', id)",
      writes),
    "UPDATE article_mutation_outbox SET status = 'pending' WHERE id = 7 RETURNING json_build_object('id', id)")

  assert.throws(
    () => validateReadSqlOrThrow('WITH removed AS (DELETE FROM article RETURNING id) SELECT json_build_object(\'id\', id) FROM removed', reads),
    /must start with SELECT|mutating/u)
  assert.throws(
    () => validateReadSqlOrThrow("SELECT json_build_object('value', pg_read_file('/etc/passwd')) FROM article", reads),
    /forbidden PostgreSQL function/u)
  assert.throws(
    () => validateReadSqlOrThrow("SELECT json_build_object('count', COUNT(*)) FROM sys_user", reads),
    /outside the declared table boundary/u)
  assert.throws(
    () => validateWriteSqlOrThrow("DELETE FROM article_mutation_outbox WHERE id = 7 RETURNING json_build_object('id', id)", writes),
    /single INSERT or UPDATE/u)
  assert.throws(
    () => validateWriteSqlOrThrow("UPDATE article_mutation_outbox SET status = 'pending' WHERE id = 7", writes),
    /RETURNING one json_build_object receipt/u)
  assert.throws(
    () => validateWriteSqlOrThrow("UPDATE article_mutation_outbox SET status = 'pending' RETURNING json_build_object('id', id); SELECT 1", writes),
    /multiple SQL statements/u)
})

test('plan validation aggregates independent failures and rejects literal ledger claims', () => {
  const { plan, rollout, variables, environment } = validPlan()
  const accepted = validatePlan(plan, rollout, variables, environment)
  assert.deepEqual(accepted.errors, [])
  assert.equal(accepted.events.length, requiredKinds.length)

  const invalid = structuredClone(plan)
  invalid.schema = 'wrong'
  invalid.security.allowedWriteTables.push('pg_authid')
  invalid.sourceTermination.signal = 'SIGTERM'
  invalid.coordination.armedFile = '../escape.json'
  invalid.events[0].ledger.attemptCount = { value: 1 }
  invalid.events[1].kind = invalid.events[0].kind
  const rejected = validatePlan(invalid, rollout, variables, environment)
  assert.ok(rejected.errors.length >= 6)
  assert.ok(rejected.errors.some(error => error.includes('schema must be')))
  assert.ok(rejected.errors.some(error => error.includes('unsupported table')))
  assert.ok(rejected.errors.some(error => error.includes('SIGKILL')))
  assert.ok(rejected.errors.some(error => error.includes('relative work-directory path')))
  assert.ok(rejected.errors.some(error => error.includes('may only contain probe, pointer and type')))
  assert.ok(rejected.errors.some(error => error.includes('duplicated')))
})

test('driver has a closed external-command set and never invokes a shell', () => {
  const source = fs.readFileSync(sourcePath, 'utf8')
  assert.match(source, /externalCommandAllowlist = new Set\(\['docker', 'psql'\]\)/u)
  assert.match(source, /default_transaction_read_only=on/u)
  assert.match(source, /sourceTerminationPreconditionsPassed/u)
  assert.match(source, /writeJsonExclusive\(options\.out, ledger\)/u)
  assert.match(source, /fsusblog\.release-worker-drill-signal\.v1/u)
  assert.match(source, /timed out waiting for the exact terminate-source authorization signal/u)
  assert.doesNotMatch(source, /shell:\s*true/u)
  assert.doesNotMatch(source, /execSync|execFileSync|eval\s*\(/u)
  assert.doesNotMatch(source, /max[-_]?errors/iu)
})

function validPlan() {
  const rollout = {
    rolloutId: 'rollout-worker-drill-test',
    source: { releaseId: 'release-source', slot: 'blue', runtimeGeneration: 40 },
    target: { releaseId: 'release-target', slot: 'green', runtimeGeneration: 41 }
  }
  const variables = {
    runId: 'worker-drill-test-run',
    rolloutId: rollout.rolloutId,
    'source.releaseId': rollout.source.releaseId,
    'source.slot': rollout.source.slot,
    'source.generation': rollout.source.runtimeGeneration,
    'target.releaseId': rollout.target.releaseId,
    'target.slot': rollout.target.slot,
    'target.generation': rollout.target.runtimeGeneration
  }
  const environment = { TEST_WORKER_DRILL_DATABASE_URL: 'postgresql://worker:secret@127.0.0.1:5432/fsusblog' }
  const plan = {
    schema: 'fsusblog.release-worker-drill-plan.v1',
    rolloutId: rollout.rolloutId,
    database: { connectionEnv: 'TEST_WORKER_DRILL_DATABASE_URL', timeoutMs: 5000 },
    security: {
      allowedHttpOrigins: ['http://127.0.0.1:8082'],
      allowedReadTables: ['article'],
      allowedWriteTables: ['article']
    },
    source: { container: 'fsus-app-blue' },
    target: {
      container: 'fsus-app-green',
      releaseId: rollout.target.releaseId,
      generation: rollout.target.runtimeGeneration,
      readinessProbe: healthProbe('/health/ready'),
      takeoverProbe: healthProbe('/api/operations/deployment/active-fence')
    },
    sourceTermination: { type: 'docker-kill', container: 'fsus-app-blue', signal: 'SIGKILL', timeoutMs: 5000 },
    coordination: {
      mode: 'file-handshake',
      armedFile: 'signals/armed.json',
      authorizeFile: 'signals/terminate.json',
      terminatedFile: 'signals/terminated.json',
      timeoutMs: 5000,
      pollMs: 100
    },
    events: requiredKinds.map(kind => eventDefinition(kind))
  }
  return { plan, rollout, variables, environment }
}

function healthProbe(urlPath) {
  return {
    type: 'http-json',
    url: `http://127.0.0.1:8082${urlPath}`,
    method: 'GET',
    expectedStatuses: [200],
    assertions: [{ pointer: '/releaseId', equalsVariable: 'target.releaseId' }],
    timeoutMs: 1000,
    pollMs: 100
  }
}

function eventDefinition(kind) {
  const ledger = Object.fromEntries([
    ['observedLogicalEventId', 'string'],
    ['observedKind', 'string'],
    ['attemptCount', 'integer'],
    ['finalEffectCount', 'integer'],
    ['finalEffectKey', 'string'],
    ['finalReleaseId', 'string'],
    ['finalGeneration', 'integer'],
    ['staleGenerationCommitCount', 'integer'],
    ['pendingLogicalEventId', 'string'],
    ['pendingCountAtDrain', 'integer'],
    ['durableReplaySource', 'string']
  ].map(([field, type]) => [field, { probe: 'final', pointer: `/${field}`, type }]))
  if (kind === 'audit-writer') {
    ledger.expectedAuditCount = { probe: 'final', pointer: '/expectedAuditCount', type: 'integer' }
    ledger.actualAuditCount = { probe: 'final', pointer: '/actualAuditCount', type: 'integer' }
  }
  if (kind === 'visit-view-projection') {
    ledger.expectedProjectionCount = { probe: 'final', pointer: '/expectedProjectionCount', type: 'integer' }
    ledger.actualProjectionCount = { probe: 'final', pointer: '/actualProjectionCount', type: 'integer' }
  }
  if (kind === 'forced-source-recovery') ledger.recoveredByTarget = { probe: 'final', pointer: '/recoveredByTarget', type: 'boolean' }
  const observation = id => ({
    id,
    type: 'sql-json',
    sql: "SELECT json_build_object('ok', true) FROM article WHERE id = 1",
    assertions: [{ pointer: '/ok', equals: true }],
    timeoutMs: 1000,
    pollMs: 100
  })
  return {
    kind,
    identity: { mode: 'generated', template: `worker-drill-{{runId}}-${kind}` },
    prepare: [{
      id: 'prepare-event',
      type: 'sql-exec',
      sql: "UPDATE article SET views = views WHERE id = 1 RETURNING json_build_object('ok', true)",
      assertions: [{ pointer: '/ok', equals: true }]
    }],
    trigger: [],
    beforeTermination: [observation('pending')],
    afterTermination: [],
    observations: [observation('final')],
    ledger
  }
}
