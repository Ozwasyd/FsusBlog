#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  delegatedSourceLockOwners,
  fixtureReaderOwners,
  replacementOwners,
  selectiveTestMigrations,
  wholeFileMigrations
} from './frontend-source-locking-migration-plan.mjs'
import {
  compactRetentionKey,
  decodeCompactRetentionIndex,
  isCompactRetentionBaseline,
  validateCompactRetentionBaseline
} from '../../../../tools/test-retention/audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const snapshotPath = resolve(root, 'tests/test-retention-before.json')
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const compactBaseline = isCompactRetentionBaseline(snapshot)
if (compactBaseline) validateCompactRetentionBaseline(snapshot)
const recordsById = new Map((snapshot.testRecords ?? []).map((record) => [record.id, record]))
const recordsByPath = new Map()
for (const record of snapshot.testRecords ?? []) {
  const records = recordsByPath.get(record.path) ?? []
  records.push(record)
  recordsByPath.set(record.path, records)
}
const baselineTestKeys = compactBaseline
  ? new Set(decodeCompactRetentionIndex(snapshot.testIndex, 'before snapshot test index'))
  : null
const compactManifests = compactBaseline
  ? [
      resolve(root, 'tests/test-retention-replacements.json'),
      resolve(root, 'tests/issue-1049-retention-replacements.json')
    ]
      .filter(existsSync)
      .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  : []
// Later issue-local declarations intentionally replace an older central entry
// with the same test ID (for example, a stale self-reference). De-duplicate by
// ID before building path counts so the compact handoff remains exact.
const compactById = new Map()
for (const entry of compactManifests.flatMap((manifest) => manifest.deletedTests ?? [])) {
  compactById.set(entry.id, entry)
}
const compactEntries = [...compactById.values()]
const centralById = compactById
const centralByPath = new Map()
for (const entry of compactEntries) {
  const entries = centralByPath.get(entry.path) ?? []
  entries.push(entry)
  centralByPath.set(entry.path, entries)
}
const migrations = []

function replacementIds(owner) {
  const ids = replacementOwners[owner]
  if (!ids || ids.length === 0) throw new Error(`unknown or empty replacement owner: ${owner}`)
  if (!compactBaseline) {
    for (const id of ids) {
      if (!recordsById.has(id)) throw new Error(`replacement ID is absent from retention baseline: ${id}`)
    }
  }
  return ids
}

for (const migration of wholeFileMigrations) {
  const records = compactBaseline
    ? centralByPath.get(migration.path) ?? []
    : recordsByPath.get(migration.path) ?? []
  if (records.length !== migration.expectedRecords) {
    throw new Error(`${migration.path}: expected ${migration.expectedRecords} baseline records, found ${records.length}`)
  }
  for (const record of records) {
    if (compactBaseline && !baselineTestKeys.has(compactRetentionKey(record.id))) {
      throw new Error(`${migration.path}: central deletion ID is absent from compact retention baseline: ${record.id}`)
    }
    migrations.push({
      deletedTestId: compactBaseline ? record.id : record.id,
      deletedPath: migration.path,
      replacementTestIds: compactBaseline ? record.replacementTestIds : replacementIds(migration.replacementOwner),
      replacementOwner: migration.replacementOwner,
      reason: compactBaseline ? record.reason : migration.reason
    })
  }
}

for (const migration of selectiveTestMigrations) {
  const record = compactBaseline
    ? centralById.get(migration.deletedTestId)
    : recordsById.get(migration.deletedTestId)
  if (!record) throw new Error(`selective deletion is absent from retention baseline: ${migration.deletedTestId}`)
  if (compactBaseline && !baselineTestKeys.has(compactRetentionKey(record.id))) {
    throw new Error(`selective deletion is absent from compact retention baseline: ${migration.deletedTestId}`)
  }
  migrations.push({
    deletedTestId: record.id,
    deletedPath: compactBaseline ? record.path : record.path,
    replacementTestIds: compactBaseline ? record.replacementTestIds : replacementIds(migration.replacementOwner),
    replacementOwner: migration.replacementOwner,
    reason: compactBaseline ? record.reason : migration.reason
  })
}

const duplicateDeletedIds = migrations
  .map((migration) => migration.deletedTestId)
  .filter((id, index, ids) => ids.indexOf(id) !== index)
if (duplicateDeletedIds.length > 0) {
  throw new Error(`duplicate deleted test IDs: ${[...new Set(duplicateDeletedIds)].join(', ')}`)
}

const deletedIds = new Set(migrations.map((migration) => migration.deletedTestId))
for (const migration of migrations) {
  const circular = migration.replacementTestIds.filter((id) => deletedIds.has(id))
  if (circular.length > 0) {
    throw new Error(`${migration.deletedTestId}: replacement points to deleted test(s): ${circular.join(', ')}`)
  }
}

const handoff = {
  schema: 'fsusblog.frontend-source-locking-handoff.v1',
  issue: 1049,
  baseline: {
    path: 'tests/test-retention-before.json',
    schema: snapshot.schema,
    sourceState: snapshot.sourceState
  },
  summary: {
    deletedWholeFiles: wholeFileMigrations.length,
    deletedWholeFileTestIds: wholeFileMigrations.reduce((total, item) => total + item.expectedRecords, 0),
    selectivelyDeletedTestIds: selectiveTestMigrations.length,
    totalDeletedTestIds: migrations.length,
    fixtureReaderOwners: fixtureReaderOwners.length,
    delegatedSourceLockOwners: delegatedSourceLockOwners.length
  },
  fixtureReaderOwners,
  delegatedSourceLockOwners,
  migrations: migrations.sort((left, right) => left.deletedTestId.localeCompare(right.deletedTestId))
}

process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`)
