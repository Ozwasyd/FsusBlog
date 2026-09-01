import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const checker = join(repoRoot, 'tools/db/check-schema-allowed-extra-tables.mjs')
const fixturePaths = [
  'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs',
  'src/backend/Entities',
  'src/migration/Definitions'
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fsusblog-schema-allowed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of fixturePaths) {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(repoRoot, path), destination, { recursive: true })
  }
  return root
}

function mutate(root, path, transform) {
  const fullPath = join(root, path)
  const source = readFileSync(fullPath, 'utf8')
  writeFileSync(fullPath, transform(source))
}

function check(root) {
  return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' })
}

test('canonical allowed-extra-tables register is accepted', t => {
  const root = fixture(t)
  const result = check(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[schema-allowed-extra-tables\] ok/)
})

test('a SugarTable entity listed as allowed extra is rejected (dead entry)', t => {
  const root = fixture(t)
  mutate(root, 'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs', source =>
    source.replace('        "plugin_registry",', '        "comment_moderation_event",\n        "plugin_registry",'))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /comment_moderation_event.*must not be listed/)
})

test('a migration-created table missing from the allowlist is rejected (drift)', t => {
  const root = fixture(t)
  // Remove an allowed migration table from the register; the migration catalog
  // still creates it, so the verifier would treat it as a branded extra table.
  mutate(root, 'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs', source =>
    source.replace('        "plugin_registry",\n', ''))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /plugin_registry.*not listed in s_allowedExtraTables/)
})
