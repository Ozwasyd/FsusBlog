#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const requirementCatalogPath = 'tests/backend/Fixtures/backend-test-requirements.json'
const aedsCatalogPath = 'tests/backend/Fixtures/aeds-golden-catalog.json'
const requirementCatalog = JSON.parse(readFileSync(resolve(root, requirementCatalogPath), 'utf8'))
const aedsCatalog = JSON.parse(readFileSync(resolve(root, aedsCatalogPath), 'utf8'))
const matrix = readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8')
const testSh = readFileSync(resolve(root, 'tools/test.sh'), 'utf8')
const toolManifest = JSON.parse(readFileSync(resolve(root, 'dotnet-tools.json'), 'utf8'))
const strykerConfig = JSON.parse(readFileSync(resolve(root, 'stryker-config.json'), 'utf8'))
const errors = []
const testShDelegatesToMatrix = testSh.includes('tools/run-test-matrix.mjs')
  && testSh.includes('run "$tier"')

function expectedProfileCommand(profileId) {
  if (profileId === 'backend-perf') {
    return 'tools/test/lanes/perf-regression.sh'
  }

  return `tools/test/legacy-test.sh ${profileId}`
}

function fail(message) {
  errors.push(message)
}

function requireFile(path) {
  if (!existsSync(resolve(root, path))) {
    fail(`missing file ${path}`)
  }
}

function walk(dir, predicate, results = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      walk(fullPath, predicate, results)
    } else if (predicate(fullPath)) {
      results.push(fullPath)
    }
  }
  return results
}

function extractAedsEnumValues() {
  const source = readFileSync(resolve(root, 'src/core/Algorithms/AedsFrameType.cs'), 'utf8')
  const values = []
  const regex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/gm
  let match
  while ((match = regex.exec(source)) !== null) {
    values.push({ name: match[1], value: Number(match[2]) })
  }
  return values
}

if (requirementCatalog.version !== 'fsusblog-backend-test-governance-v1') {
  fail('backend requirement catalog version drifted')
}

if (aedsCatalog.version !== 'fsusblog-aeds-golden-catalog-v1') {
  fail('AEDS golden catalog version drifted')
}

if (!testShDelegatesToMatrix) {
  fail('tools/test.sh does not delegate backend tiers to tools/run-test-matrix.mjs')
}

const requirementIds = new Set()
for (const requirement of requirementCatalog.requirements || []) {
  if (requirementIds.has(requirement.id)) {
    fail(`duplicate backend requirement ${requirement.id}`)
  }
  requirementIds.add(requirement.id)

  if (!/^BACKEND-[A-Z0-9-]+$/.test(requirement.id)) {
    fail(`invalid backend requirement id ${requirement.id}`)
  }
  if (!requirement.risk || !requirement.coverage) {
    fail(`backend requirement ${requirement.id} lacks risk/coverage`)
  }
  if (!Array.isArray(requirement.evidencePaths) || requirement.evidencePaths.length === 0) {
    fail(`backend requirement ${requirement.id} lacks evidence paths`)
  } else {
    for (const path of requirement.evidencePaths) {
      requireFile(path)
    }
  }
}

const requiredProfiles = new Set([
  'backend-api-integration',
  'backend-auth-state-machine',
  'backend-concurrency',
  'backend-property',
  'backend-golden',
  'backend-test-governance',
  'backend-perf',
  'backend-mutation',
  'backend-chaos',
  'backend-nightly'
])

for (const profile of requirementCatalog.profiles || []) {
  requiredProfiles.delete(profile.id)

  const expectedCommand = expectedProfileCommand(profile.id)
  if (profile.command !== expectedCommand) {
    fail(`backend profile ${profile.id} has invalid command ${profile.command}; expected ${expectedCommand}`)
  }
  if (!matrix.includes(`id: ${profile.id}`)) {
    fail(`tests/matrix.yml lacks tier ${profile.id}`)
  }
  if (!matrix.includes(`command: ${profile.command}`)) {
    fail(`tests/matrix.yml lacks command ${profile.command}`)
  }

  for (const requirement of profile.requirements || []) {
    if (!requirementIds.has(requirement)) {
      fail(`profile ${profile.id} references unknown requirement ${requirement}`)
    }
  }

  for (const path of profile.evidencePaths || []) {
    requireFile(path)
  }
}

for (const missing of requiredProfiles) {
  fail(`missing backend profile ${missing}`)
}

const endpointFiles = walk(
  resolve(root, 'src/backend/Modules/Endpoints'),
  path => path.endsWith('.cs') && !path.endsWith('Adapters.cs')
)
  .map(path => relative(root, path).replace(/\\/g, '/'))
  .sort()

const endpointCatalogPaths = (requirementCatalog.endpointFamilies || [])
  .map(entry => entry.path)
  .sort()

if (JSON.stringify(endpointFiles) !== JSON.stringify(endpointCatalogPaths)) {
  fail(`endpoint family catalog drifted: expected ${endpointFiles.join(', ')} got ${endpointCatalogPaths.join(', ')}`)
}

for (const endpoint of requirementCatalog.endpointFamilies || []) {
  requireFile(endpoint.path)
  for (const requirement of endpoint.requirements || []) {
    if (!requirementIds.has(requirement)) {
      fail(`endpoint ${endpoint.path} references unknown requirement ${requirement}`)
    }
  }
}

const enumValues = extractAedsEnumValues()
const catalogByName = new Map((aedsCatalog.frames || []).map(frame => [frame.name, frame]))
const catalogValues = new Set()
for (const frame of aedsCatalog.frames || []) {
  if (catalogValues.has(frame.value)) {
    fail(`duplicate AEDS golden frame value ${frame.value}`)
  }
  catalogValues.add(frame.value)
  if (!frame.family) {
    fail(`AEDS golden frame ${frame.name} lacks family`)
  }
}

for (const frame of enumValues) {
  const catalogEntry = catalogByName.get(frame.name)
  if (!catalogEntry) {
    fail(`AEDS golden catalog misses frame ${frame.name}`)
    continue
  }
  if (catalogEntry.value !== frame.value) {
    fail(`AEDS golden catalog value mismatch for ${frame.name}: ${catalogEntry.value} != ${frame.value}`)
  }
}

if (!toolManifest.tools?.['dotnet-stryker']) {
  fail('dotnet-tools.json lacks dotnet-stryker')
}

const stryker = strykerConfig['stryker-config'] || {}
for (const key of ['solution', 'project', 'test-case-filter', 'mutate']) {
  if (!stryker[key]) {
    fail(`stryker-config.json lacks ${key}`)
  }
}
if ((stryker['threshold-break'] ?? 0) < 70 || (stryker['threshold-high'] ?? 0) < 85) {
  fail('Stryker thresholds are below issue #40 minimums')
}

for (const path of [
  'tests/backend/Unit/BackendApiIntegrationContractTests.cs',
  'tests/backend/Unit/BackendAuthStateMachineTests.cs',
  'tests/backend/Unit/BackendConcurrencyModelTests.cs',
  'tests/backend/Unit/BackendGoldenCatalogTests.cs',
  'tests/backend/Unit/BackendPropertyTests.cs',
  'tests/backend/Unit/BackendTestGovernanceTests.cs',
  'benchmarks/core/FsusBlog.Core.Benchmarks.csproj'
]) {
  requireFile(path)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[backend-test-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[backend-test-governance] ok profiles=${requirementCatalog.profiles.length} requirements=${requirementCatalog.requirements.length} frames=${aedsCatalog.frames.length}`)
