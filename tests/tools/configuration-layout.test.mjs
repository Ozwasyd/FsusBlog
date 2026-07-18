import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkConfigurationLayout } from '../../tools/configuration/check-configuration-layout.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ownershipManifest = JSON.parse(readFileSync(
  path.join(repositoryRoot, 'config/configuration-ownership.json'),
  'utf8'
))
const temporaryRoots = []

function write(root, relativePath, contents = 'fixture\n') {
  const absolutePath = path.join(root, relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, contents)
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-configuration-layout-'))
  temporaryRoots.push(root)
  write(root, 'config/configuration-ownership.json', `${JSON.stringify(ownershipManifest, null, 2)}\n`)

  for (const entry of ownershipManifest.ownership) {
    if (entry.canonicalPath === 'config/configuration-ownership.json') continue
    if (entry.pathType === 'directory') {
      write(root, `${entry.canonicalPath}/fixture.yaml`)
    } else {
      write(root, entry.canonicalPath, entry.canonicalPath.endsWith('.json') ? '{}\n' : 'fixture\n')
    }
    if (/\.(?:csproj|dcproj|esproj|fsproj|vbproj)$/.test(entry.owner)) {
      write(root, entry.owner, '<Project />\n')
    }
  }

  write(root, 'src/frontend/FsusBlog.Client.esproj', '<Project />\n')
  write(root, 'ops/docker/docker-compose.production.yml')
  write(root, 'ops/docker/docker-compose.development-backend.yml')
  write(root, '.dockerignore')
  write(root, 'ops/docker/docker-compose.dcproj', `
<Project>
  <ItemGroup>
    <None Include="docker-compose.production.yml" />
    <None Include="docker-compose.development-backend.yml" />
    <None Include="..\\..\\.dockerignore" />
    <None Include="Properties\\launchSettings.json" />
  </ItemGroup>
</Project>
`.trimStart())
  write(root, 'FsusBlog.slnx', `
<Solution>
  <Project Path="src/backend/FsusBlog.Server.csproj" />
  <Project Path="src/frontend/FsusBlog.Client.esproj" />
  <Project Path="ops/docker/docker-compose.dcproj" />
</Solution>
`.trimStart())
  write(root, 'FsusBlog.slnLaunch', `${JSON.stringify([
    {
      Name: 'fixture',
      Projects: [
        { Path: 'src\\frontend\\FsusBlog.Client.esproj', Action: 'Start' },
        { Path: 'ops\\docker\\docker-compose.dcproj', Action: 'Start' }
      ]
    }
  ], null, 2)}\n`)
  return root
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

test('accepts the canonical repository and a minimal owned fixture', () => {
  assert.deepEqual(checkConfigurationLayout(repositoryRoot), [])
  assert.deepEqual(checkConfigurationLayout(createFixture()), [])
})

test('reports competing roots, arbitrary root JSON, stale examples, and unowned root Properties together', () => {
  const root = createFixture()
  write(root, 'configs/moderation/legacy.yaml')
  write(root, 'rogue-config.json', '{}\n')
  write(root, 'appsettings.example.json', '{}\n')
  write(root, 'Properties/launchSettings.json', '{}\n')

  const errors = checkConfigurationLayout(root)
  assert.ok(errors.some((error) => error.includes('forbidden competing configuration root exists: configs/')))
  assert.ok(errors.some((error) => error.includes('unapproved repository-root configuration JSON: rogue-config.json')))
  assert.ok(errors.some((error) => error.includes('unapproved repository-root configuration JSON: appsettings.example.json')))
  assert.ok(errors.some((error) => error.includes('repository-root Properties/ has no owning root project')))
  assert.ok(errors.some((error) => error.includes('launch profile is not colocated with an owning project: Properties/launchSettings.json')))
})

test('permits root Properties only when a real root project owns the launch profile', () => {
  const root = createFixture()
  write(root, 'FsusBlog.Root.csproj', '<Project />\n')
  write(root, 'Properties/launchSettings.json', '{}\n')
  assert.deepEqual(checkConfigurationLayout(root), [])
})

test('reports stale solution, Compose, and project-local launch references together', () => {
  const root = createFixture()
  write(root, 'FsusBlog.slnLaunch', `${JSON.stringify([
    { Name: 'stale', Projects: [{ Path: 'src\\frontend\\Missing.esproj', Action: 'Start' }] }
  ], null, 2)}\n`)
  write(root, 'ops/docker/docker-compose.dcproj', `
<Project>
  <ItemGroup>
    <None Include="missing-compose.yml" />
  </ItemGroup>
</Project>
`.trimStart())
  write(root, 'orphan/Properties/launchSettings.json', '{}\n')

  const errors = checkConfigurationLayout(root)
  assert.ok(errors.some((error) => error.includes('is not a project declared by FsusBlog.slnx: src/frontend/Missing.esproj')))
  assert.ok(errors.some((error) => error.includes('does not exist: src/frontend/Missing.esproj')))
  assert.ok(errors.some((error) => error.includes('includes a missing file: ops/docker/missing-compose.yml')))
  assert.ok(errors.some((error) => error.includes('launch profile is not colocated with an owning project: orphan/Properties/launchSettings.json')))
})

test('requires every generic or framework configuration file to have exactly one owner', () => {
  const root = createFixture()
  write(root, 'config/unowned.json', '{}\n')
  write(root, '.config/unowned.json', '{}\n')

  const manifestPath = path.join(root, 'config/configuration-ownership.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.ownership.push({
    ...manifest.ownership.find((entry) => entry.id === 'observability-slo'),
    id: 'duplicate-observability-slo'
  })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const errors = checkConfigurationLayout(root)
  assert.ok(errors.some((error) => error.includes('configuration file must have exactly one canonical owner: config/unowned.json (found 0)')))
  assert.ok(errors.some((error) => error.includes('configuration file must have exactly one canonical owner: .config/unowned.json (found 0)')))
  assert.ok(errors.some((error) => error.includes('duplicate canonical configuration path: config/observability/slo.yml')))
  assert.ok(errors.some((error) => error.includes('config/observability/slo.yml (found 2)')))
})
