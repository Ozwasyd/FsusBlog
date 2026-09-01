import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const checker = join(repoRoot, 'tools/db/check-server-migration-cutover.mjs')
const fixturePaths = [
  'src/backend/FsusBlog.Server.csproj',
  'src/backend/Infrastructure/SchemaMigration',
  'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs',
  'src/migration/Properties/AssemblyInfo.cs'
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fsusblog-server-cutover-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of fixturePaths) {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(repoRoot, path), destination, { recursive: true })
  }
  return root
}

function check(root) {
  return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' })
}

test('canonical Server migration cutover is accepted', t => {
  const result = check(fixture(t))
  assert.equal(result.status, 0, result.stderr)
})

test('explicit Server→Migration reference is rejected', t => {
  const root = fixture(t)
  writeFileSync(
    join(root, 'src/backend/FsusBlog.Server.csproj'),
    `${readFileSync(join(root, 'src/backend/FsusBlog.Server.csproj'), 'utf8')}\n<ProjectReference Include="../migration/FsusBlog.Migration.csproj" />\n`)
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /explicit Server→Migration project reference/)
})

test('DI registry registration and InternalsVisibleTo Server are rejected', t => {
  const root = fixture(t)
  writeFileSync(
    join(root, 'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs'),
    'services.AddSingleton<ISchemaMigrationRegistry, SchemaMigrationRegistry>();\n')
  writeFileSync(
    join(root, 'src/migration/Properties/AssemblyInfo.cs'),
    '[assembly: InternalsVisibleTo("FsusBlog.Server")]\n')
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /DI still registers migration registry/)
  assert.match(result.stderr, /InternalsVisibleTo Server remains/)
})
