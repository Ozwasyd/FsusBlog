#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from './test-matrix/parse-matrix.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const requirementCatalogPath = 'tests/backend/Fixtures/backend-test-requirements.json'
const aedsCatalogPath = 'tests/backend/Fixtures/aeds-golden-catalog.json'
const pathGovernanceFixtureDirectory = 'tests/backend/Fixtures/backend-test-path-governance'
const environmentVariableGovernanceFixtureDirectory = 'tests/backend/Fixtures/environment-variable-governance'
const environmentVariableCollectionPath = 'tests/backend/Fixtures/EnvironmentVariableCollection.cs'
const approvedEnvironmentVariableMutationFiles = new Set([
  'tests/backend/Fixtures/ScopedEnvironmentVariables.cs'
])
const backendPathGovernanceAllowedFiles = new Set([
  'tests/backend/Unit/TestInfrastructure/BackendTestPaths.cs',
  'tests/backend/Unit/TestInfrastructure/BackendTestPathsTests.cs'
])
const requirementCatalog = JSON.parse(readFileSync(resolve(root, requirementCatalogPath), 'utf8'))
const aedsCatalog = JSON.parse(readFileSync(resolve(root, aedsCatalogPath), 'utf8'))
const matrix = readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8')
const matrixTierCommands = new Map(parseMatrix(matrix).tiers.map((tier) => [tier.id, tier.command]))
const testSh = readFileSync(resolve(root, 'tools/test.sh'), 'utf8')
const legacyTest = readFileSync(resolve(root, 'tools/test/lanes/_suite-support.sh'), 'utf8')
const serverProject = readFileSync(resolve(root, 'src/backend/FsusBlog.Server.csproj'), 'utf8')
const dotnetToolManifestPath = '.config/dotnet-tools.json'
const defaultStrykerConfigPath = 'config/testing/mutation/default.json'
const criticalStrykerConfigRepoPath = 'config/testing/mutation/critical.json'
const toolManifest = JSON.parse(readFileSync(resolve(root, dotnetToolManifestPath), 'utf8'))
const strykerConfig = JSON.parse(readFileSync(resolve(root, defaultStrykerConfigPath), 'utf8'))
const criticalStrykerConfigPath = resolve(root, criticalStrykerConfigRepoPath)
const criticalStrykerConfig = existsSync(criticalStrykerConfigPath)
  ? JSON.parse(readFileSync(criticalStrykerConfigPath, 'utf8'))
  : {}
const errors = []
const testShDelegatesToMatrix = testSh.includes('tools/run-test-matrix.mjs')
  && testSh.includes('run "$tier"')

function expectedProfileCommand(profileId) {
  return matrixTierCommands.get(profileId)
}

function fail(message) {
  errors.push(message)
}

function requireFile(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    fail(`invalid file path ${JSON.stringify(path)}`)
    return
  }
  if (!existsSync(resolve(root, path))) {
    fail(`missing file ${path}`)
  }
}

function requireEvidencePath(path) {
  if (path.startsWith('.tmp/')) {
    if (!matrix.includes(path)) {
      fail(`generated backend evidence is not declared by the test matrix: ${path}`)
    }
    return
  }
  requireFile(path)
}

function walk(dir, predicate, results = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      if (entry === 'bin' || entry === 'obj' || entry === 'node_modules' || entry === '.git') {
        continue
      }
      walk(fullPath, predicate, results)
    } else if (predicate(fullPath)) {
      results.push(fullPath)
    }
  }
  return results
}

function toRepoPath(path) {
  return relative(root, path).replace(/\\/g, '/')
}

function lineNumberForIndex(source, index) {
  return source.slice(0, Math.max(0, index)).split('\n').length
}

function addBackendPathViolation(violations, relativePath, rule, source, index, message) {
  violations.push({
    path: relativePath,
    line: lineNumberForIndex(source, index),
    rule,
    message
  })
}

function findRuleMatches(source, regex) {
  const matches = []
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(source)) !== null) {
    matches.push(match.index)
  }
  return matches
}

function scanBackendTestPathSource(relativePath, source) {
  if (backendPathGovernanceAllowedFiles.has(relativePath)) {
    return []
  }

  const violations = []
  const literalRules = [
    {
      rule: 'private-repo-root-resolver',
      regex: /\bprivate\s+static\s+[A-Za-z0-9_<>,.?[\]\s]+\s+Find(?:Repo|Repository)Root\s*\(/g,
      message: 'use BackendTestPaths instead of a private repo-root resolver'
    },
    {
      rule: 'low-context-repo-root-error',
      regex: /["']Unable to locate repository root\.?["']/g,
      message: 'use BackendTestPaths for consistent repository-root failure context'
    },
    {
      rule: 'direct-slnx-root-marker',
      regex: /["']FsusBlog\.slnx["']/g,
      message: 'use BackendTestPaths instead of walking for FsusBlog.slnx'
    }
  ]

  for (const { rule, regex, message } of literalRules) {
    for (const index of findRuleMatches(source, regex)) {
      addBackendPathViolation(violations, relativePath, rule, source, index, message)
    }
  }

  const appContextIndex = source.search(/\bAppContext\.BaseDirectory\b/)
  if (appContextIndex >= 0 && /\bDirectory\.GetParent\s*\(|\.Parent\b/.test(source)) {
    addBackendPathViolation(
      violations,
      relativePath,
      'appcontext-parent-traversal',
      source,
      appContextIndex,
      'use BackendTestPaths instead of AppContext.BaseDirectory parent traversal'
    )
  }

  return violations
}

function verifyBackendTestPathGovernanceFixtures() {
  const positiveFixture = `${pathGovernanceFixtureDirectory}/shared-helper-usage.fixture.cs.txt`
  const negativeFixture = `${pathGovernanceFixtureDirectory}/private-find-repo-root.fixture.cs.txt`

  requireFile(positiveFixture)
  requireFile(negativeFixture)

  const positiveViolations = scanBackendTestPathSource(
    positiveFixture,
    readFileSync(resolve(root, positiveFixture), 'utf8')
  )
  if (positiveViolations.length > 0) {
    fail(`backend-test-path-governance positive fixture emitted violations: ${positiveViolations.map(v => v.rule).join(', ')}`)
  }

  const negativeViolations = scanBackendTestPathSource(
    negativeFixture,
    readFileSync(resolve(root, negativeFixture), 'utf8')
  )
  const negativeRules = new Set(negativeViolations.map(violation => violation.rule))
  for (const expectedRule of [
    'private-repo-root-resolver',
    'low-context-repo-root-error',
    'direct-slnx-root-marker',
    'appcontext-parent-traversal'
  ]) {
    if (!negativeRules.has(expectedRule)) {
      fail(`backend-test-path-governance negative fixture did not trigger ${expectedRule}`)
    }
  }
}

function verifyBackendTestPathGovernance() {
  verifyBackendTestPathGovernanceFixtures()

  const backendTestFiles = walk(
    resolve(root, 'tests/backend'),
    path => path.endsWith('.cs')
  )
    .map(path => ({ fullPath: path, relativePath: toRepoPath(path) }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  for (const { fullPath, relativePath } of backendTestFiles) {
    const source = readFileSync(fullPath, 'utf8')
    for (const violation of scanBackendTestPathSource(relativePath, source)) {
      fail(
        `backend-test-path-governance ${violation.path}:${violation.line} ` +
        `${violation.rule}: ${violation.message}`
      )
    }
  }
}

function scanEnvironmentVariableMutations(relativePath, source) {
  if (approvedEnvironmentVariableMutationFiles.has(relativePath)) {
    return []
  }

  const mutationIndexes = findRuleMatches(
    source,
    /\bEnvironment\s*\.\s*SetEnvironmentVariable\s*\(/g
  )
  if (mutationIndexes.length === 0) {
    return []
  }

  const approvedCollectionPattern =
    /\[\s*Collection\s*\(\s*nameof\s*\(\s*EnvironmentVariableCollection\s*\)\s*\)\s*\]\s*(?:(?:public|internal|private|protected|sealed|abstract|partial)\s+)*class\s+[A-Za-z_][A-Za-z0-9_]*/u
  if (approvedCollectionPattern.test(source)) {
    return []
  }

  return mutationIndexes.map(index => ({
    path: relativePath,
    line: lineNumberForIndex(source, index),
    rule: 'unisolated-environment-variable-mutation',
    message:
      'use ScopedEnvironmentVariables and annotate the test class with EnvironmentVariableCollection'
  }))
}

function formatEnvironmentVariableViolation(violation) {
  return `backend-environment-variable-governance ${violation.path}:${violation.line} ` +
    `${violation.rule}: ${violation.message}`
}

function verifyEnvironmentVariableGovernanceFixtures() {
  const positiveFixture =
    `${environmentVariableGovernanceFixtureDirectory}/approved-scoped-helper.fixture.cs.txt`
  const negativeFixture =
    `${environmentVariableGovernanceFixtureDirectory}/unapproved-direct-mutation.fixture.cs.txt`

  requireFile(positiveFixture)
  requireFile(negativeFixture)

  const positiveViolations = scanEnvironmentVariableMutations(
    positiveFixture,
    readFileSync(resolve(root, positiveFixture), 'utf8')
  )
  if (positiveViolations.length > 0) {
    fail(
      'backend-environment-variable-governance positive fixture emitted violations: ' +
      positiveViolations.map(violation => violation.rule).join(', ')
    )
  }

  const negativeViolations = scanEnvironmentVariableMutations(
    negativeFixture,
    readFileSync(resolve(root, negativeFixture), 'utf8')
  )
  if (negativeViolations.length !== 1) {
    fail(
      'backend-environment-variable-governance negative fixture must emit exactly one violation'
    )
    return
  }

  const diagnostic = formatEnvironmentVariableViolation(negativeViolations[0])
  if (!diagnostic.includes(`${negativeFixture}:5 `)) {
    fail(
      'backend-environment-variable-governance negative fixture diagnostic must include file and line'
    )
  }
}

function verifyEnvironmentVariableGovernance() {
  requireFile(environmentVariableCollectionPath)
  const collectionSource = readFileSync(resolve(root, environmentVariableCollectionPath), 'utf8')
  if (
    !/\[\s*CollectionDefinition\s*\(\s*nameof\s*\(\s*EnvironmentVariableCollection\s*\)\s*,\s*DisableParallelization\s*=\s*true\s*\)\s*\]/u
      .test(collectionSource)
  ) {
    fail(
      `${environmentVariableCollectionPath} must keep EnvironmentVariableCollection ` +
      'DisableParallelization = true'
    )
  }

  verifyEnvironmentVariableGovernanceFixtures()

  const backendTestFiles = walk(
    resolve(root, 'tests/backend'),
    path => path.endsWith('.cs')
  )
    .map(path => ({ fullPath: path, relativePath: toRepoPath(path) }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  for (const { fullPath, relativePath } of backendTestFiles) {
    const source = readFileSync(fullPath, 'utf8')
    for (const violation of scanEnvironmentVariableMutations(relativePath, source)) {
      fail(formatEnvironmentVariableViolation(violation))
    }
  }
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
      requireEvidencePath(path)
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
  'backend-benchmark-regression',
  'backend-mutation',
  'backend-nightly'
])

for (const profile of requirementCatalog.profiles || []) {
  requiredProfiles.delete(profile.id)

  const expectedCommand = expectedProfileCommand(profile.id)
  if (!expectedCommand) {
    fail(`tests/matrix.yml lacks tier command for backend profile ${profile.id}`)
    continue
  }
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

const endpointFamilyIds = new Set()
for (const endpoint of requirementCatalog.endpointFamilies || []) {
  if (typeof endpoint.id !== 'string' || endpoint.id.trim() === '') {
    fail(`endpoint family lacks a non-empty id: ${JSON.stringify(endpoint)}`)
  } else if (endpointFamilyIds.has(endpoint.id)) {
    fail(`duplicate endpoint family id ${endpoint.id}`)
  } else {
    endpointFamilyIds.add(endpoint.id)
  }
  const routePrefixes = Array.isArray(endpoint.routePrefixes) ? endpoint.routePrefixes : []
  const routePatterns = Array.isArray(endpoint.routePatterns) ? endpoint.routePatterns : []
  if (routePrefixes.length + routePatterns.length === 0) {
    fail(`endpoint family ${endpoint.id ?? '<missing>'} must declare routePrefixes or routePatterns`)
  }
  for (const route of [...routePrefixes, ...routePatterns]) {
    if (typeof route !== 'string' || !route.startsWith('/')) {
      fail(`endpoint family ${endpoint.id ?? '<missing>'} has invalid route ${JSON.stringify(route)}`)
    }
  }
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

if (toolManifest.version !== 1 || toolManifest.isRoot !== true) {
  fail(`${dotnetToolManifestPath} must remain a root .NET local-tool manifest`)
}
if (!toolManifest.tools?.['dotnet-stryker']) {
  fail(`${dotnetToolManifestPath} lacks dotnet-stryker`)
}

const stryker = strykerConfig['stryker-config'] || {}
for (const key of ['solution', 'test-case-filter', 'mutate']) {
  if (!stryker[key]) {
    fail(`${defaultStrykerConfigPath} lacks ${key}`)
  }
}
if ('project' in stryker) {
  fail('solution-scoped mutation must not pin Stryker project to a test-project path')
}
if (stryker.configuration !== 'Debug') {
  fail('solution-scoped mutation must use the tested Debug solution configuration')
}
const strykerThresholds = stryker.thresholds || {}
if ((strykerThresholds.break ?? 0) < 70 || (strykerThresholds.high ?? 0) < 85) {
  fail('Stryker thresholds are below issue #40 minimums')
}
for (const legacyKey of ['threshold-high', 'threshold-low', 'threshold-break', 'output']) {
  if (legacyKey in stryker) {
    fail(`Stryker.NET 4.14 config must not contain unsupported key ${legacyKey}`)
  }
}
if (!legacyTest.includes('--output "$outputDir"')) {
  fail('backend mutation runner must pass the report output directory through the supported CLI option')
}
if (!/cd "\$ROOT_DIR"\n\s+Run dotnet tool restore/u.test(legacyTest)) {
  fail('backend mutation runner must restore .config/dotnet-tools.json through standard repository-root discovery')
}
for (const configPath of [defaultStrykerConfigPath, criticalStrykerConfigRepoPath]) {
  if (!legacyTest.includes(`$ROOT_DIR/${configPath}`)) {
    fail(`backend mutation runner must pass the explicit Stryker config path ${configPath}`)
  }
}
if (!legacyTest.includes('export FSUSBLOG_MUTATION_BUILD')) {
  fail('backend mutation runner must export the dedicated MSBuild marker')
}
if (!legacyTest.includes('check-stryker-report.mjs')) {
  fail('backend mutation runner must reject reports that execute no mutants')
}
if (stryker.mutate.some((pattern) => pattern.startsWith('src/'))) {
  fail('solution-scoped Stryker mutate globs must be relative to each project root')
}

const criticalStryker = criticalStrykerConfig['stryker-config'] || {}
const expectedCriticalMutationFiles = [
  'Algorithms/AedsEncoder.cs'
]
if ('solution' in criticalStryker || criticalStryker.configuration !== 'Debug' ||
    JSON.stringify(criticalStryker['test-projects'] || []) !== JSON.stringify(['../../tests/backend/FsusBlog.Server.Tests.csproj'])) {
  fail('critical Stryker config must run from the Core source-project context with the backend test project')
}
if (JSON.stringify(criticalStryker.mutate || []) !== JSON.stringify(expectedCriticalMutationFiles)) {
  fail('critical Stryker config must retain the reviewed AEDS v2 wire-frame scope')
}
if (criticalStryker['test-case-filter'] !== 'FullyQualifiedName~FsusBlog.Server.Tests.Unit.AedsEncoderTests') {
  fail('critical Stryker config must select the direct AedsEncoder unit-test slice without unrelated release-evidence prerequisites')
}
if ((criticalStryker.thresholds?.break ?? 0) < 70 || criticalStryker['report-file-name'] !== 'backend-mutation-critical') {
  fail('critical Stryker config must fail below 70 and write the dedicated report name')
}
if (!legacyTest.includes('backend-mutation-critical')) {
  fail('legacy test runner must expose the dedicated critical mutation tier')
}
if (!legacyTest.includes('"$ROOT_DIR/src/core"')) {
  fail('critical mutation runner must execute from the Core source-project directory')
}
for (const contract of [
  'PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="10.0.9" GeneratePathProperty="true"',
  'Target Name="DisableCompileTimeOpenApiXmlGeneratorForMutation"',
  "Condition=\"'$(FSUSBLOG_MUTATION_BUILD)' == '1'\"",
  'Analyzer Remove="$(PkgMicrosoft_AspNetCore_OpenApi)/analyzers/dotnet/cs/Microsoft.AspNetCore.OpenApi.SourceGenerators.dll"'
]) {
  if (!serverProject.includes(contract)) {
    fail(`Stryker build must disable only the incompatible OpenAPI XML source generator: missing ${contract}`)
  }
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

verifyBackendTestPathGovernance()
verifyEnvironmentVariableGovernance()

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[backend-test-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[backend-test-governance] ok profiles=${requirementCatalog.profiles.length} requirements=${requirementCatalog.requirements.length} frames=${aedsCatalog.frames.length}`)
