import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MIGRATION_QUALIFICATION_SCENARIO_SCHEMA,
  REQUIRED_MIGRATION_CASES,
  evaluateMigrationCase,
  normalizeMigrationScenario,
  parseMigrationQualificationArgs
} from '../../tools/deployment/release-migration-qualification.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const template = path.join(root, 'tests/fixtures/deployment/release-migration-qualification-scenario.template.json')

function scenario() {
  const value = JSON.parse(fs.readFileSync(template, 'utf8'))
  value.topology.origins = {
    source: 'http://127.0.0.1:5111',
    target: 'http://127.0.0.1:5222'
  }
  return value
}
function command(role, parsed, start = 0, end = 100) {
  return { role, type: 'command', status: 'pass', parsed, startedAtUtc: new Date(start).toISOString(), completedAtUtc: new Date(end).toISOString(), errors: [] }
}
function http(role, releaseId, status = 200, parsed = {}, start = 0, end = 100) {
  return { role, type: 'http', status: 'pass', response: { releaseId, status }, parsed, startedAtUtc: new Date(start).toISOString(), completedAtUtc: new Date(end).toISOString(), errors: [] }
}

test('scenario fixes the complete ten-case migration qualification topology and exact role order', () => {
  const value = normalizeMigrationScenario(scenario())
  assert.equal(value.schema, MIGRATION_QUALIFICATION_SCENARIO_SCHEMA)
  assert.equal(value.topology.environment, 'Test')
  assert.equal(value.topology.destructiveFaultsAgainstProduction, false)
  assert.equal(value.cases.length, 10)
  assert.deepEqual(value.cases.map(item => item.id), REQUIRED_MIGRATION_CASES.map(item => item[0]))
  assert.deepEqual(
    value.cases.map(item => item.actions.map(action => action.role)),
    REQUIRED_MIGRATION_CASES.map(item => item[1].map(role => role[0])))
  assert.equal(value.cases[1].actions.every(item => item.parallelGroup === 'dual-slot-rw'), true)
})

test('scenario validation exposes all malformed topology, case, role, action, command and HTTP errors without a cap', () => {
  const value = scenario()
  value.schema = 'wrong'
  value.topology = {
    environment: 'Production',
    destructiveFaultsAgainstProduction: true,
    databaseIsolationId: 'production',
    origins: { source: 'https://production.example', target: 'https://production.example' }
  }
  for (const item of value.cases) {
    for (const action of item.actions) {
      action.id = '?'
      if (action.type === 'command') {
        action.argv = []
        action.inputFiles = []
        action.expect = {}
      } else {
        action.origin = 'internet'
        action.path = 'https://attacker.example/?token=secret'
        action.method = 'TRACE'
        action.expect = {}
      }
    }
  }
  assert.throws(
    () => normalizeMigrationScenario(value),
    error => Array.isArray(error.errors)
      && error.errors.length >= 80
      && error.errors.some(item => item.includes('destructiveFaultsAgainstProduction'))
      && error.errors.some(item => item.includes('history-check.argv')))
})

test('semantic evaluator proves Expand with old active, overlapping Blue/Green read-write and checkpointed Backfill resume', () => {
  const expand = evaluateMigrationCase('expand-with-old-active', [
    http('source-before-expand', 'source-release'),
    command('expand', { status: 'ok' }),
    http('source-after-expand-read', 'source-release')
  ])
  assert.deepEqual(expand.errors, [])

  const overlap = evaluateMigrationCase('blue-green-concurrent-read-write', [
    http('source-read', 'source', 200, {}, 0, 200),
    http('source-write', 'source', 200, {}, 10, 210),
    http('target-read', 'target', 200, {}, 20, 220),
    http('target-write', 'target', 200, {}, 30, 230)
  ])
  assert.equal(overlap.overlapMs, 170)
  assert.deepEqual(overlap.errors, [])

  const backfill = evaluateMigrationCase('backfill-checkpoint-resume', [
    command('backfill-start', { status: 'paused' }),
    command('checkpoint-paused', { checkpoint: { status: 'paused', resumeTokenHash: `sha256:${'a'.repeat(64)}`, rowsProcessed: 10, failureCount: 0 } }),
    command('backfill-resume', { status: 'ok' }),
    command('checkpoint-completed', { checkpoint: { status: 'completed', resumeTokenHash: `sha256:${'b'.repeat(64)}`, rowsProcessed: 20, failureCount: 0 } })
  ])
  assert.deepEqual(backfill.errors, [])
})

test('semantic evaluator covers every negative and irreversible boundary with exact stable codes', () => {
  const cases = new Map([
    ['missing-expand-candidate-not-ready', [
      command('prepare-missing-expand', { status: 'prepared' }),
      command('candidate-check', { status: 'not_ready', issues: [{ code: 'schema_expand_pending' }] }),
      http('candidate-readiness', 'target', 503, { status: 'not_ready', code: 'schema_incompatible' }),
      command('expand-recover', { status: 'ok' })
    ]],
    ['contract-rollback-window-rejected', [
      command('contract-rejected', { status: 'failed', codes: ['schema_contract_previous_release_dependency', 'schema_contract_rollback_manifest_open'] })
    ]],
    ['contract-applied-non-rollback-compatible', [
      command('contract-apply', { status: 'ok' }),
      command('rollback-marker', { status: 'ok', contractApplied: true, rollbackCompatible: false })
    ]],
    ['advisory-lock-timeout', [command('advisory-lock-timeout', { status: 'failed', code: 'schema_advisory_lock_timeout' })]],
    ['database-disconnect', [command('database-disconnect', { status: 'failed', code: 'schema_database_unavailable' })]],
    ['partial-failure-recovery', [
      command('partial-failure', { status: 'failed' }),
      command('checkpoint-failed', { checkpoint: { status: 'failed', resumeTokenHash: `sha256:${'c'.repeat(64)}`, rowsProcessed: 10, failureCount: 1 } }),
      command('partial-recovery', { status: 'ok' }),
      command('checkpoint-recovered', { checkpoint: { status: 'completed', resumeTokenHash: `sha256:${'d'.repeat(64)}`, rowsProcessed: 20, failureCount: 1 } })
    ]],
    ['history-integrity-rejected', [
      command('history-check', { status: 'not_ready', issues: [{ code: 'schema_history_checksum_mismatch' }, { code: 'schema_history_unknown' }] })
    ]]
  ])
  for (const [caseId, reports] of cases) assert.deepEqual(evaluateMigrationCase(caseId, reports).errors, [], caseId)
})

test('semantic evaluator refuses partial or forged success markers and reports independent defects together', () => {
  const failures = [
    evaluateMigrationCase('expand-with-old-active', [http('source-before-expand', 'old'), command('expand', { status: 'failed' }), http('source-after-expand-read', 'changed')]),
    evaluateMigrationCase('blue-green-concurrent-read-write', [
      http('source-read', 'source', 200, {}, 0, 1), http('source-write', 'source', 200, {}, 2, 3),
      http('target-read', 'target', 200, {}, 4, 5), http('target-write', 'target', 200, {}, 6, 7)
    ]),
    evaluateMigrationCase('backfill-checkpoint-resume', [command('backfill-start', { status: 'ok' }), command('checkpoint-paused', {}), command('backfill-resume', {}), command('checkpoint-completed', { checkpoint: { status: 'failed', rowsProcessed: 0 } })]),
    evaluateMigrationCase('contract-applied-non-rollback-compatible', [command('contract-apply', { status: 'failed' }), command('rollback-marker', { contractApplied: false, rollbackCompatible: true })]),
    evaluateMigrationCase('history-integrity-rejected', [command('history-check', { issues: [] })])
  ]
  const errors = failures.flatMap(item => item.errors)
  assert.ok(errors.length >= 10)
  assert.ok(errors.some(item => item.includes('old active source identity changed')))
  assert.ok(errors.some(item => item.includes('did not overlap')))
  assert.ok(errors.some(item => item.includes('checkpoint hashes are missing')))
  assert.ok(errors.some(item => item.includes('non-rollback marker')))
  assert.ok(errors.some(item => item.includes('schema_history_unknown')))
})

test('CLI requires exact scenario, rollout, manifest, work directory, output and run identity in one pass', () => {
  const parsed = parseMigrationQualificationArgs([
    '--scenario', template,
    '--rollout-state', '/tmp/rollout.json',
    '--release-manifest', '/tmp/release.json',
    '--work-dir', '/tmp/migration-work',
    '--out', '/tmp/migration-evidence.json',
    '--run-id', 'migration-qualification-run-001'
  ])
  assert.equal(parsed.runId, 'migration-qualification-run-001')
  assert.equal(parsed.scenario, template)
  assert.throws(
    () => parseMigrationQualificationArgs(['--scenario', template, '--unknown', 'x']),
    error => Array.isArray(error.errors) && error.errors.length >= 6)
})
