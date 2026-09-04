import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const checker = join(repoRoot, 'tools/db/check-schema-allowed-extra-links.mjs')
const fixturePaths = [
  'src/backend/Infrastructure/SchemaMigration/SchemaAllowedExtraLinkNames.generated.cs',
  'src/migration/Definitions'
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fsusblog-links-'))
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

test('generated link register matches the migration definitions', t => {
  const root = fixture(t)
  const result = check(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[schema-allowed-extra-links\] ok/)
})

test('a link name not declared in definitions is rejected (drift)', t => {
  const root = fixture(t)
  mutate(root, 'src/backend/Infrastructure/SchemaMigration/SchemaAllowedExtraLinkNames.generated.cs', source =>
    source.replace('        "idx_plugin_registry_runtime_state",\n', '        "idx_nonexistent_link",\n'))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /idx_nonexistent_link is not declared/)
})

test('missing generated register is rejected', t => {
  const root = fixture(t)
  const fullPath = join(root, 'src/backend/Infrastructure/SchemaMigration/SchemaAllowedExtraLinkNames.generated.cs')
  rmSync(fullPath)
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /generated link register is missing/)
})
