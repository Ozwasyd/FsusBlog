import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const checker = join(repoRoot, 'tools/db/check-migration-assembly-boundary.mjs')
const fixturePaths = [
  'FsusBlog.slnx',
  'src/backend/FsusBlog.Server.csproj',
  'src/backend/GlobalUsings.Migration.cs',
  'src/migration',
  'src/shared',
  'tests/migration',
  'artifacts/schema-migration/migration-assembly-receipt.json',
  'artifacts/schema-migration/migration-assembly-binding.json'
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fsusblog-migration-boundary-'))
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

test('canonical migration assembly boundary is accepted', t => {
  const result = check(fixture(t))
  assert.equal(result.status, 0, result.stderr)
})

test('reverse Server reference and missing provider are rejected', t => {
  const root = fixture(t)
  mutate(root, 'src/migration/FsusBlog.Migration.csproj', source => source
    .replace('<PackageReference Include="SqlSugarCoreNoDrive" />', '')
    .replace('</ItemGroup>\n</Project>', '<ProjectReference Include="../backend/FsusBlog.Server.csproj" />\n  </ItemGroup>\n</Project>'))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /provider package is missing/)
  assert.match(result.stderr, /may reference only FsusBlog\.Shared|forbidden framework or application reference/)
})

test('project graph cycle is rejected', t => {
  const root = fixture(t)
  mutate(root, 'src/shared/FsusBlog.Shared.csproj', source => source.replace(
    '</Project>',
    '  <ItemGroup><ProjectReference Include="../migration/FsusBlog.Migration.csproj" /></ItemGroup>\n</Project>'))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /project graph contains a cycle/)
})

test('shared legacy column and Server linked duplicate are rejected', t => {
  const root = fixture(t)
  const sharedFixture = join(root, 'src/shared/LegacyLeak.cs')
  writeFileSync(sharedFixture, 'public sealed class LegacyLeak { public string LastUsernameUpdateTime { get; set; } = ""; }\n')
  mutate(root, 'src/backend/FsusBlog.Server.csproj', source => source.replace(
    '</Project>',
    '  <ItemGroup><Compile Include="../migration/SchemaMigrationPrimitives.cs" Link="SchemaMigrationPrimitives.cs" /></ItemGroup>\n</Project>'))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /legacy-only column/)
  assert.match(result.stderr, /links or duplicates migration source/)
})

test('an arbitrary project linked source and an arbitrary Server duplicate are rejected', t => {
  const root = fixture(t)
  const rogueProject = join(root, 'tests/rogue/Rogue.csproj')
  mkdirSync(dirname(rogueProject), { recursive: true })
  writeFileSync(rogueProject, '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../../src/migration/SchemaMigrationManifest.cs" Link="Other.cs" /></ItemGroup></Project>\n')
  const duplicate = join(root, 'src/backend/Other/UnrelatedName.cs')
  mkdirSync(dirname(duplicate), { recursive: true })
  cpSync(join(root, 'src/migration/SchemaMigrationRegistry.cs'), duplicate)
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /links or duplicates migration source outside Migration/)
  assert.match(result.stderr, /duplicate migration source at an arbitrary path/)
})

test('compatibility namespace, type forwarder, and provider current mapping are rejected', t => {
  const root = fixture(t)
  writeFileSync(
    join(root, 'src/migration/CompatibilityLeak.cs'),
    'using System.Runtime.CompilerServices;\n[assembly: TypeForwardedTo(typeof(FsusBlog.Migration.SchemaMigrationRegistry))]\nnamespace FsusBlog.Server.Infrastructure.SchemaMigration;\n[SugarTable("leak")] public sealed class Leak {}\n')
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /duplicate current-schema field mapping/)
  assert.match(result.stderr, /compatibility namespace or type forwarder/)
})

test('a second provider field mapping is rejected outside migration-owned source rows', t => {
  const root = fixture(t)
  writeFileSync(
    join(root, 'src/migration/DuplicateProviderMapping.cs'),
    'using SqlSugar;\nnamespace FsusBlog.Migration;\n[SugarTable("comment")] internal sealed class DuplicateProviderMapping { [SugarColumn(ColumnName = "id")] public long Id { get; set; } }\n')
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /duplicate current-schema field mapping/)
})

test('migration test Web host and old Server definition tree are rejected', t => {
  const root = fixture(t)
  mutate(root, 'tests/migration/MigrationAssemblyBoundaryTests.cs', source => `${source}\n// WebApplicationFactory forbidden fixture\n`)
  const oldPath = join(root, 'src/backend/Infrastructure/SchemaMigration/Definitions/Legacy.cs')
  mkdirSync(dirname(oldPath), { recursive: true })
  writeFileSync(oldPath, 'namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;\n')
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Migration tests start or reference the Server web host/)
  assert.match(result.stderr, /Legacy definitions remain in Server/)
})

test('solution registration and receipt symbol digest tamper are rejected', t => {
  const root = fixture(t)
  mutate(root, 'FsusBlog.slnx', source => source.replace('    <Project Path="src/migration/FsusBlog.Migration.csproj" />\n', ''))
  mutate(root, 'artifacts/schema-migration/migration-assembly-receipt.json', source => source.replace('FsusBlog.Migration', 'FsusBlog.Migration.Tampered'))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not registered exactly once in the solution/)
  assert.match(result.stderr, /receipt content or symbol inventory is stale/)
  assert.match(result.stderr, /binding manifest is stale or tampered/)
})

test('old/new dual registration and Server publish legacy source are rejected', t => {
  const root = fixture(t)
  mutate(root, 'FsusBlog.slnx', source => source.replace(
    '    <Project Path="src/migration/FsusBlog.Migration.csproj" />',
    '    <Project Path="src/migration/FsusBlog.Migration.csproj" />\n    <Project Path="src/migration/FsusBlog.Migration.csproj" />'))
  mutate(root, 'src/backend/FsusBlog.Server.csproj', source => source.replace(
    '</Project>',
    '  <ItemGroup><Content Include="../migration/SchemaMigrationManifest.cs" CopyToPublishDirectory="Always" /></ItemGroup>\n</Project>'))
  const duplicateProject = join(root, 'src/legacy/FsusBlog.LegacyMigration.csproj')
  mkdirSync(dirname(duplicateProject), { recursive: true })
  writeFileSync(duplicateProject, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><AssemblyName>FsusBlog.Migration</AssemblyName></PropertyGroup></Project>\n')
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /assembly identity is registered more than once/)
  assert.match(result.stderr, /registered exactly once in the solution/)
  assert.match(result.stderr, /Server build\/publish includes legacy migration source/)
})

test('missing actual provider build result is rejected', t => {
  const root = fixture(t)
  mutate(root, 'artifacts/schema-migration/migration-assembly-receipt.json', source => source.replace(
    '"status": "passed"',
    '"status": "not-run"'))
  const result = check(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /actual independent build\/test results are failed or stale/)
})
