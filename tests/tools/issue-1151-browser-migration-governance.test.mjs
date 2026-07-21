import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  expandBrowserTestMigrationManifest,
  historicalDeletedRecords,
  validateReplacementTargets,
  validateBrowserTestMigration
} from '../../tools/check-browser-test-migration.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const fixture = JSON.parse(readFileSync(
  path.join(root, 'tests/fixtures/issue-1151-browser-migration/valid-case.json'),
  'utf8'
))

function expanded(value = fixture) {
  return expandBrowserTestMigrationManifest(value.manifest, () => {
    throw new Error('the focused fixture has no imports')
  })
}

function validate(value = fixture, records = expanded(value)) {
  return validateBrowserTestMigration({
    manifest: value.manifest,
    records,
    acceptanceBaseline: value.acceptanceBaseline,
    acceptanceReplacements: value.acceptanceReplacements,
    diagnosticsMigration: value.diagnosticsMigration,
    historicalDeletedRecords: value.historicalDeletedRecords,
    currentRecords: value.currentRecords
  })
}

test('repository migration manifest resolves every old Browser test identity', () => {
  const result = spawnSync(process.execPath, [
    'tools/check-browser-test-migration.mjs',
    '--root',
    root
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /ok records=71 historicalDeleted=44 diagnosticSources=15/u)
})

test('frozen history catches a test deleted inside a surviving Browser spec', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  const deleted = historicalDeletedRecords(root, manifest)
  assert.ok(deleted.some((record) => record.sourceTestId
    === 'vitest:tests/frontend/e2e/acceptance/cross-browser-smoke.spec.ts#public-shell-auth-entry-passkey-capability-pwa-cache-and-51fe04687b'))
})

test('frozen history also covers removed browser resource and elastic-pool orchestration tests', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  const deleted = historicalDeletedRecords(root, manifest)
  assert.ok(deleted.some((record) => record.sourceFile
    === 'tests/tools/runtime-browser-resource-plan.test.mjs'))
  assert.equal(deleted.filter((record) => record.sourceFile
    === 'tests/tools/ux-risk-elastic-pool.test.mjs').length, 6)
})

test('frozen history rejects deleting one approved retired identity from its authority', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  manifest.historyBaseline.retiredRecords.pop()
  assert.throws(
    () => historicalDeletedRecords(root, manifest),
    /frozen Browser test baseline drifted/u
  )
})

test('frozen history rejects substituting an unrelated historical identity for a retired one', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  const unrelatedTestId = 'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#visible-admin-routes-render-cleanly-c3e6ee4f99'
  const unrelatedSourceFile = 'tests/frontend/e2e/acceptance/admin-console.spec.ts'
  manifest.historyBaseline.retiredRecords[0] = {
    sourceFileSha256: createHash('sha256').update(unrelatedSourceFile).digest('hex'),
    sourceTestIdSha256: createHash('sha256').update(unrelatedTestId).digest('hex'),
    issue: '#1368',
    reason: 'An unrelated historical Browser test must never substitute for the approved retired identity.'
  }
  assert.throws(
    () => historicalDeletedRecords(root, manifest),
    /frozen Browser test baseline drifted/u
  )
})

test('frozen history rejects an invalid retired identity digest', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  manifest.historyBaseline.retiredRecords[0].sourceTestIdSha256 = 'not-a-sha256-digest'
  assert.throws(
    () => historicalDeletedRecords(root, manifest),
    /frozen Browser test baseline drifted/u
  )
})

test('frozen history rejects duplicate retired identity digests', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  manifest.historyBaseline.retiredRecords[1] = structuredClone(
    manifest.historyBaseline.retiredRecords[0]
  )
  assert.throws(
    () => historicalDeletedRecords(root, manifest),
    /frozen Browser test baseline drifted/u
  )
})

test('frozen history requires the manifest digest pairs in pinned authority order', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  manifest.historyBaseline.retiredRecords.reverse()
  assert.throws(
    () => historicalDeletedRecords(root, manifest),
    /frozen Browser test baseline drifted/u
  )
})

test('frozen history rejects a coordinated fallback, authority, count, and expected-total rewrite', (t) => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  const fallback = JSON.parse(readFileSync(
    path.join(root, manifest.historyBaseline.fallback),
    'utf8'
  ))
  const [unapproved, ...remainingRecords] = fallback.records
  fallback.records = remainingRecords
  fallback.recordCount = remainingRecords.length
  manifest.historyBaseline.retiredRecordCount = 3
  manifest.historyBaseline.retiredRecords.unshift({
    sourceFileSha256: createHash('sha256').update(unapproved.sourceFile).digest('hex'),
    sourceTestIdSha256: createHash('sha256').update(unapproved.sourceTestId).digest('hex'),
    issue: '#1368',
    reason: 'A coordinated rewrite must not expand the independently pinned retirement authority.'
  })

  const forgedExpectedHistoricalDeleted = 43
  assert.equal(forgedExpectedHistoricalDeleted, 44 - 1)
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'fsusblog-browser-history-'))
  t.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }))
  const fallbackPath = path.join(fixtureDirectory, 'historical-deleted-tests.json')
  writeFileSync(fallbackPath, `${JSON.stringify(fallback, null, 2)}\n`)
  manifest.historyBaseline.fallback = path.relative(root, fallbackPath)

  assert.throws(
    () => historicalDeletedRecords(root, manifest),
    /frozen Browser test baseline drifted/u
  )
})

test('frozen fallback record-set authority remains pinned when git history is unavailable', (t) => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  const fallback = JSON.parse(readFileSync(
    path.join(root, manifest.historyBaseline.fallback),
    'utf8'
  ))
  fallback.records.shift()
  fallback.recordCount = fallback.records.length
  const unavailableBaseline = 'f'.repeat(40)
  fallback.sourceCommit = unavailableBaseline
  manifest.historyBaseline.commit = unavailableBaseline

  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'fsusblog-browser-history-'))
  t.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }))
  const fallbackPath = path.join(fixtureDirectory, 'historical-deleted-tests.json')
  writeFileSync(fallbackPath, `${JSON.stringify(fallback, null, 2)}\n`)
  manifest.historyBaseline.fallback = path.relative(root, fallbackPath)

  assert.throws(
    () => historicalDeletedRecords(root, manifest),
    /frozen Browser test baseline drifted/u
  )
})

test('every declared replacement target resolves to a current file, test, contract, or diagnostic category', () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/browser-test-migration.json'),
    'utf8'
  ))
  const records = expandBrowserTestMigrationManifest(manifest, (relativePath) => JSON.parse(
    readFileSync(path.join(root, relativePath), 'utf8')
  ))
  assert.deepEqual(validateReplacementTargets(root, records), [])
  records[0].replacementTestIds = ['vitest:tests/frontend/unit/does-not-exist.test.ts#missing']
  assert.ok(validateReplacementTargets(root, records).some((error) => error.includes('does not exist')))
})

test('focused fixture accepts correctness, Browser Contract, diagnostics, in-place and approved removal records', () => {
  assert.equal(expanded().length, 5)
  assert.deepEqual(validate(), [])
})

test('an old Browser test cannot disappear without a source-ID mapping', () => {
  const records = expanded().filter((record) => record.sourceTestId !== 'vitest:tests/frontend/e2e/old.spec.ts#old')
  const errors = validate(fixture, records)
  assert.ok(errors.some((error) => error.includes('unmapped Acceptance baseline test')))
  assert.ok(errors.some((error) => error.includes('deleted since the frozen baseline without a mapping')))
})

test('a retained diagnostic identity cannot be silently deleted', () => {
  const value = structuredClone(fixture)
  value.currentRecords = value.currentRecords.filter(
    (record) => record.sourceTestId !== 'vitest:tests/frontend/e2e/visual.spec.ts#visual'
  )
  const errors = validate(value)
  assert.ok(errors.some((error) => error.includes('was deleted without changing its migration mapping')))
  assert.ok(errors.some((error) => error.includes('diagnostics migration source has no active test identity')))
})

test('replacement none fails closed without an issue-bound reason and approval', () => {
  const records = expanded()
  const obsolete = records.find((record) => record.replacementLayer === 'none')
  obsolete.removalReason = ''
  obsolete.approval = null
  const errors = validate(fixture, records)
  assert.ok(errors.some((error) => error.includes('requires an explicit reason and issue-bound approval')))
})

test('browser-only risk cannot be declared equivalent to happy-dom', () => {
  const records = expanded()
  const visual = records.find((record) => record.sourceTestId === 'vitest:tests/frontend/e2e/visual.spec.ts#visual')
  visual.replacementTestIds.push('vitest:happy-dom-equivalence')
  const errors = validate(fixture, records)
  assert.ok(errors.some((error) => error.includes('cannot claim happy-dom equivalence')))
})

test('#1146 replacement IDs cannot drift behind the composed authority', () => {
  const records = expanded()
  const old = records.find((record) => record.sourceTestId === 'vitest:tests/frontend/e2e/old.spec.ts#old')
  old.replacementTestIds = ['vitest:tests/frontend/unit/other.test.ts#other']
  const errors = validate(fixture, records)
  assert.ok(errors.some((error) => error.includes('replacement IDs drifted from the #1146 retention authority')))
})
