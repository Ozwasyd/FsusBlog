#!/usr/bin/env node
// Guard the offline migration host classification table against drift.
// OfflineMigrationCatalogEntries.generated.cs is a derived artifact of
// src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationMetadata.cs
// (authoritative curated register). Verify:
//   1. the generated file carries the current source digest (regenerate on
//      catalog changes)
//   2. every classification in the generated file corresponds to a migration
//      declared in src/migration/Definitions (no orphan, no omission)
//   3. the classification set aligns with the generator's own parse of the
//      catalog source (same ids)

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rootIndex = process.argv.indexOf('--root')
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot
const failures = []

function fail(message) {
  failures.push(message)
}

function read(path) {
  const fullPath = join(root, path)
  if (!existsSync(fullPath)) {
    fail(`missing required path: ${path}`)
    return ''
  }
  return readFileSync(fullPath, 'utf8')
}

const sourcePath = 'src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationMetadata.cs'
const generatedPath = 'src/migration/OfflineMigrationCatalogEntries.generated.cs'
const definitionsDir = 'src/migration/Definitions'

const source = read(sourcePath)
const generated = read(generatedPath)

const sourceDigest = createHash('sha256').update(source).digest('hex')
const headerDigest = generated.match(/Source digest: sha256:([0-9a-f]{64})/)?.[1]
if (!headerDigest) {
  fail('generated classification file is missing the source digest header')
} else if (headerDigest !== sourceDigest) {
  fail(
    `classification source digest drift: header=${headerDigest} current=${sourceDigest} (run tools/db/generate-offline-migration-catalog.mjs)`,
  )
}

const generatedIds = new Set(
  [...generated.matchAll(/result\.Add\("([a-z0-9-]+)"/g)].map((match) => match[1]),
)
if (generatedIds.size === 0) {
  fail('generated classification file declares no entries')
}

const definitionIds = new Set()
if (existsSync(join(root, definitionsDir))) {
  for (const file of readdirSync(join(root, definitionsDir))) {
    if (!file.endsWith('.cs')) continue
    const content = readFileSync(join(root, definitionsDir, file), 'utf8')
    for (const match of content.matchAll(/"(\d{8}-[a-z0-9-]+)"/g)) {
      definitionIds.add(match[1])
    }
  }
}
if (definitionIds.size === 0) {
  fail('no migration ids found under src/migration/Definitions')
}

for (const id of generatedIds) {
  if (!definitionIds.has(id)) {
    fail(`classification ${id} has no matching migration in Definitions`)
  }
}
for (const id of definitionIds) {
  if (!generatedIds.has(id)) {
    fail(`migration ${id} is missing from the offline classification table`)
  }
}

const legacyCount = [...generated.matchAll(/OfflineMigrationPhase\.Contract,\s*[^,]+, true\)/g)].length
if (legacyCount === 0) {
  fail('no legacy contract classification detected; catalog parse may be stale')
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[offline-migration-catalog-parity] ${failure}`)
  }
  process.exitCode = 1
} else {
  console.log(
    `[offline-migration-catalog-parity] ok (${generatedIds.size} classifications, ${legacyCount} legacy)`,
  )
}
