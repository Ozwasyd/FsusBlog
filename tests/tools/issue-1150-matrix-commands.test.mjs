import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { browserDiagnosticCatalog } from '../browser-diagnostics/catalog.mjs'
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const matrix = parseMatrix(read('tests/matrix.yml'))
const tiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]))
const coverageRegistry = JSON.parse(read('tests/coverage-registry.json'))
const coverageEntries = new Map(coverageRegistry.entries.map((entry) => [entry.id, entry]))

function requireTier(id) {
  const tier = tiers.get(id)
  assert.ok(tier, `missing matrix tier: ${id}`)
  return tier
}

function requireCoverage(id) {
  const entry = coverageEntries.get(id)
  assert.ok(entry, `missing coverage registry entry: ${id}`)
  return entry
}

function dependencyClosure(id) {
  const visited = new Set()
  const ordered = []
  const visit = (tierId) => {
    if (visited.has(tierId)) return
    const tier = requireTier(tierId)
    for (const dependency of tier.dependsOn) visit(dependency)
    visited.add(tierId)
    ordered.push(tier)
  }
  visit(id)
  return ordered
}

function functionBody(source, name, nextName) {
  const start = source.indexOf(`${name}() {`)
  const end = source.indexOf(`\n${nextName}() {`, start)
  assert.ok(start >= 0 && end > start, `unable to isolate ${name}`)
  return source.slice(start, end)
}

test('local entrypoints expose the four issue 1150 commands explicitly', () => {
  const script = read('tools/test.sh')
  assert.match(
    script,
    /production-correctness\s*\|\s*browser-contract\s*\|\s*browser-diagnostics\s*\|\s*release-final[\s\S]*?run "\$tier"/u
  )

  for (const id of ['production-correctness', 'browser-contract', 'browser-diagnostics', 'release-final']) {
    requireTier(id)
  }
})

test('logical native measurements hold a machine-quiet benchmark window', () => {
  for (const id of [
    'backend-perf',
    'backend-benchmark-regression',
    'privacy-zk-comment-matrix'
  ]) {
    const tier = requireTier(id)
    assert.equal(tier.parallelizable, false, `${id} must not measure under peer CPU load`)
    assert.equal(tier.maxParallel, 1)
    assert.ok(tier.exclusiveResources.includes('benchmark-window'))
  }

  const perfInputs = requireTier('backend-perf').cacheInputs
  assert.ok(perfInputs.includes('tools/architecture/FsusBlog.DiLifetimeAnalyzer'))
  assert.ok(perfInputs.includes('tools/security/ZkCommentV2MclFixture'))
  assert.ok(
    requireTier('backend-benchmark-regression').cacheInputs
      .includes('tools/architecture/FsusBlog.DiLifetimeAnalyzer')
  )
})

test('matrix governance has one run-bound output owner across every consumer', () => {
  const validate = requireTier('validate-matrix')
  assert.equal(
    validate.command,
    'tools/test/run-matrix-governance-once.sh validate-matrix'
  )

  const wrapper = read('tools/test/run-matrix-governance-once.sh')
  assert.match(wrapper, /--key matrix-governance/u)
  assert.match(wrapper, /--projection-directory \.tmp\/physical-execution-projections/u)
  assert.match(wrapper, /--output \.tmp\/release-evidence\/test-plan\.json/u)
  assert.match(wrapper, /--output \.tmp\/docs\/browser-contract-matrix\.json/u)
  assert.doesNotMatch(wrapper, /acceptance-playwright-matrix/u)
  assert.match(wrapper, /-- node tools\/check-test-matrix\.mjs/u)
  const wrapperPaths = [...wrapper.matchAll(/--path ([^ ]+) \\/gu)].map((match) => match[1]).sort()
  assert.deepEqual([...validate.cacheInputs].sort(), wrapperPaths)
  assert.ok(
    validate.evidence.includes('.tmp/physical-execution-projections/validate-matrix-matrix-governance.json')
  )
  assert.ok(
    requireTier('release-evidence').evidence.includes(
      '.tmp/physical-execution-projections/release-evidence-plan-matrix-governance.json'
    )
  )

  const workflow = read('.github/workflows/quality-gate.yml')
  const validateJob = workflow.slice(
    workflow.indexOf('  validate-matrix:\n'),
    workflow.indexOf('\n  plan-pr-risk:\n')
  )
  assert.match(validateJob, /tools\/test\/run-matrix-governance-once\.sh validate-matrix/u)
  assert.match(
    validateJob,
    /node tools\/test\/check-physical-execution-consumer-evidence\.mjs \.tmp\/physical-execution-projections\/validate-matrix-matrix-governance\.json/u
  )
  assert.ok(
    validateJob.indexOf('run-matrix-governance-once.sh validate-matrix') <
      validateJob.indexOf('check-physical-execution-consumer-evidence.mjs'),
    'the independent verifier must consume the wrapper output after it is sealed'
  )
  assert.doesNotMatch(validateJob, /run-test-matrix\.mjs (?:preflight|validate|evidence-plan)/u)
  assert.match(validateJob, /\.tmp\/physical-execution-projections\/validate-matrix-matrix-governance\.json/u)
  assert.match(validateJob, /\.tmp\/physical-executions\/\*\*/u)
  for (const artifact of [
    'browser-contract-matrix.json',
    'fast-backend-matrix.json',
    'fast-frontend-unit-matrix.json'
  ]) assert.match(validateJob, new RegExp(`\\.tmp/docs/${artifact.replace('.', '\\.')}\\b`, 'u'))

  const deterministicRunner = read('tools/test/run-deterministic-command.mjs')
  assert.match(deterministicRunner, /validateRunBoundProjection/u)
  assert.match(deterministicRunner, /validateRunBoundConsumerEvidence/u)
  assert.match(deterministicRunner, /buildRunBoundConsumerEvidence/u)
})

test('ordinary backend discovery cannot overlap Coverlet instrumentation of the shared assembly', () => {
  const backendUnit = requireTier('backend-unit')
  assert.ok(backendUnit.exclusiveResources.includes('backend-coverlet-instrumentation'))

  for (const id of [
    'integrity-proof-verification',
    'backend-api-integration',
    'backend-auth-state-machine',
    'backend-concurrency',
    'backend-property',
    'backend-golden',
    'coverage-backend'
  ]) {
    assert.ok(
      requireTier(id).exclusiveResources.includes('backend-coverlet-instrumentation'),
      `${id} must share the Coverlet instrumentation exclusion`
    )
  }
})

test('ordinary and coverage Vitest executions cannot race the same unit transform graph', () => {
  for (const id of ['frontend-unit-shard', 'coverage-frontend']) {
    assert.ok(requireTier(id).exclusiveResources.includes('frontend-vitest-unit'))
  }
})

test('production correctness dependency closure is browserless and retains immutable build identity', () => {
  const production = requireTier('production-correctness')
  const closure = dependencyClosure(production.id)
  const ids = new Set(closure.map((tier) => tier.id))

  assert.equal(production.requiresPlaywright, 'none')
  assert.equal(production.prDefault, true)
  assert.ok(production.coverage.includes('browserless-production-correctness'))
  assert.ok(ids.has('production-build-artifacts'))
  assert.ok(ids.has('release-evidence'))
  assert.ok(ids.has('frontend-render-structure'))

  for (const excluded of [
    'acceptance',
    'browser-contract',
    'browser-diagnostics',
    'cross-browser-smoke',
    'visual-public',
    'visual-console',
    'visual',
    'ux-viewport-smoke',
    'ux-viewport-visual',
    'ux-viewport-boundaries',
    'frontend-render-pressure'
  ]) assert.equal(ids.has(excluded), false, `${excluded} leaked into production correctness`)

  assert.deepEqual(
    closure.filter((tier) => tier.requiresPlaywright !== 'none').map((tier) => tier.id),
    []
  )
  assert.deepEqual(
    closure.filter((tier) => tier.resourceClass === 'browser').map((tier) => tier.id),
    []
  )
  assert.deepEqual(requireTier('production').dependsOn, ['production-correctness'])

  const localProfile = matrix.localProfiles.production
  const runtimeBundle = localProfile.bundles.find((bundle) => bundle.id === 'runtime-browser')
  const frontendBundle = localProfile.bundles.find((bundle) => bundle.id === 'frontend-tests')
  assert.equal(runtimeBundle.resourceClass, 'database')
  assert.equal(runtimeBundle.members.includes('acceptance'), false)
  assert.equal(runtimeBundle.members.includes('frontend-render-pressure'), false)
  assert.ok(frontendBundle.members.includes('frontend-render-structure'))
})

test('release final introduces exactly one explicit single-Chromium Browser Contract', () => {
  const releaseClosure = dependencyClosure('release-final')
  assert.deepEqual(
    releaseClosure.filter((tier) => tier.requiresPlaywright !== 'none').map((tier) => tier.id),
    ['browser-contract']
  )

  const contract = requireTier('browser-contract')
  assert.equal(contract.ciJob, 'browser-contract')
  assert.equal(contract.resourceClass, 'browser')
  assert.equal(contract.requiresPlaywright, 'chromium')
  assert.equal(contract.parallelizable, false)
  assert.equal(contract.maxParallel, 1)
  assert.equal(contract.timeoutMinutes, 10)
  assert.equal(contract.selfBootstraps, true)
  assert.equal(contract.workflowBootstraps, undefined)
  assert.equal(contract.cadence, 'push')
  assert.equal(contract.manualOnly, undefined)
  assert.equal(contract.smartGateMode, 'conditional')
  assert.deepEqual(contract.dependsOn, ['production-build-artifacts'])
  assert.deepEqual(contract.artifacts, ['.tmp/browser-contract/receipt.json'])
  assert.ok(!contract.evidence.includes('.tmp/browser-contract/runs'))

  const frontendScripts = JSON.parse(read('src/frontend/package.json')).scripts
  for (const scriptName of ['check:acceptance:console', 'check:acceptance:auth']) {
    assert.match(frontendScripts[scriptName], /vitest run/u)
    assert.doesNotMatch(frontendScripts[scriptName], /playwright|chromium|firefox|webkit/u)
  }
  assert.doesNotMatch(read('tools/test/lanes/release-runtime-flow.sh'), /PLAYWRIGHT_OUTPUT_DIR/u)
  for (const tierId of [
    'release-admin-console',
    'release-auth-flow',
    'release-authoring-flow',
    'release-private-preview',
    'release-error-boundary'
  ]) assert.equal(requireTier(tierId).requiresPlaywright, 'none')
})

test('release admin and auth flows own browserless Vitest evidence', () => {
  const expected = new Map([
    ['release-admin-console', [
      'tests/frontend/unit/router/index.test.ts',
      'tests/frontend/unit/components/user/MessagesStateMachine.test.ts',
      'tests/frontend/unit/components/account/AccountNavigationPanel.test.ts',
      'tests/frontend/unit/components/admin/AdminDashboardTaskWorkbench.test.ts'
    ]],
    ['release-auth-flow', [
      'tests/frontend/unit/components/AuthFlowStates.test.ts'
    ]]
  ])

  for (const [tierId, evidencePaths] of expected) {
    const tier = requireTier(tierId)
    assert.equal(tier.owner, 'InteropGlueAgent')
    assert.equal(tier.requiresPlaywright, 'none')
    assert.equal(tier.resourceClass, 'cpu')
    assert.deepEqual(tier.artifacts, [])
    assert.deepEqual(tier.evidence, evidencePaths)
    assert.doesNotMatch(JSON.stringify([tier.artifacts, tier.evidence]), /playwright|test-results/u)

    const coverage = requireCoverage(tierId)
    assert.equal(coverage.owner, tier.owner)
    assert.equal(coverage.assertionType, 'unit')
    assert.deepEqual(coverage.tierIds, [tierId])
    assert.deepEqual(coverage.evidencePaths, evidencePaths)
    assert.doesNotMatch(JSON.stringify(coverage), /playwright|test-results/u)
  }
})

test('every declared Playwright tier owns a browser resource and diagnostics owns migrated probes', () => {
  for (const tier of matrix.tiers.filter((candidate) => candidate.requiresPlaywright !== 'none')) {
    assert.equal(tier.resourceClass, 'browser', `${tier.id} hides Playwright outside a browser resource`)
  }

  const acceptance = requireTier('acceptance')
  assert.equal(acceptance.requiredFor, 'none')
  assert.equal(acceptance.cadence, 'nightly')
  assert.equal(acceptance.nightlyOnly, true)
  assert.equal(acceptance.ciJob, 'browser-diagnostics')

  const diagnostics = requireTier('browser-runtime-risk-diagnostics')
  assert.equal(diagnostics.requiredFor, 'none')
  assert.equal(diagnostics.ciJob, 'browser-diagnostics')
  assert.equal(diagnostics.requiresPlaywright, 'chromium')
  for (const entryTierId of ['browser-diagnostics-nightly', 'browser-diagnostics-manual']) {
    const entryTier = requireTier(entryTierId)
    assert.match(entryTier.command, /browser-diagnostics\.sh/u)
    assert.equal(entryTier.dependsOn.includes(diagnostics.id), false)
  }

  const lane = read('tools/test/lanes/browser-diagnostics-risk.sh')
  for (const command of [
    'check:pow-runtime',
    'check:search-runtime',
    'check:auth-zero-probe',
    'check:security:permissions'
  ]) assert.match(lane, new RegExp(command.replaceAll(':', '\\:')))
  assert.match(lane, /FSUSBLOG_PLAYWRIGHT_WORKERS=1/u)
  assert.match(lane, /MATRIX_JOB:-.*browser-diagnostics/u)

  const entry = read('tools/test/lanes/browser-diagnostics.sh')
  assert.match(entry, /export FSUSBLOG_BROWSER_DIAGNOSTICS=1/u)
  assert.doesNotMatch(entry, /browser-runtime-risk-diagnostics\.sh|browser-diagnostics-risk\.sh/u)
  assert.equal(entry.match(/tests\/browser-diagnostics\/run\.mjs/gu)?.length, 1)
})

test('migrated Acceptance and release browser probes are reachable only through diagnostics', () => {
  const categories = new Map(browserDiagnosticCatalog.map((category) => [category.id, category]))
  const expectedProbes = new Map([
    ['acceptance', ['full-suite']],
    ['release-runtime', ['release-rbac-negative', 'release-aot-consumption']],
    ['runtime-risk', ['pow-runtime', 'search-runtime', 'zero-auth-probe', 'permission-matrix']]
  ])

  for (const [categoryId, probeIds] of expectedProbes) {
    const category = categories.get(categoryId)
    assert.ok(category, `missing browser diagnostics category ${categoryId}`)
    for (const probeId of probeIds) {
      const probe = category.probes.find((candidate) => candidate.id === probeId)
      assert.ok(probe, `missing browser diagnostics probe ${categoryId}/${probeId}`)
      assert.match(probe.command.join(' '), /browser-diagnostics-risk\.sh/u)
    }
  }

  const diagnosticsTiers = new Map([
    ['acceptance', 'playwright-acceptance'],
    ['release-rbac-negative', 'release-rbac-negative'],
    ['release-aot-consumption', 'release-aot-consumption']
  ])
  for (const [tierId, coverageId] of diagnosticsTiers) {
    const tier = requireTier(tierId)
    assert.equal(tier.owner, 'InteropGlueAgent')
    assert.equal(tier.requiredFor, 'none')
    assert.equal(tier.ciJob, 'browser-diagnostics')
    assert.equal(tier.resourceClass, 'browser')
    assert.notEqual(tier.requiresPlaywright, 'none')
    assert.equal(tier.smartGateMode, 'full-only')
    assert.equal(tier.retentionClass, 'conditional')
    assert.ok(tier.nightlyOnly === true || tier.manualOnly === true)

    const coverage = requireCoverage(coverageId)
    assert.equal(coverage.owner, tier.owner)
    assert.equal(coverage.assertionType, 'browser')
    assert.ok(coverage.tierIds.includes(tierId))
  }
})

test('canonical correctness leaves do not hide browser launches or a second production DAG', () => {
  const support = read('tools/test/lanes/_suite-support.sh')
  const integration = functionBody(support, 'RunIntegrationOnly', 'RunCoverageBackendOnly')
  const security = functionBody(support, 'RunSecurityRuntimeCoreOnly', 'RunSecurityOnly')
  const resilience = functionBody(support, 'RunResilienceOnly', 'RunLoadOnly')

  assert.doesNotMatch(integration, /check:(?:pow-runtime|search-runtime)/u)
  assert.doesNotMatch(security, /check:security:permissions/u)
  assert.doesNotMatch(resilience, /check:search-runtime/u)
  assert.doesNotMatch(support, /RunProductionCorrectness\(\)|RunProduction\(\)/u)

  assert.match(support, /RunCrossStackContractOnly\(\) \{\n\s+local phase="\$\{1:-static\}"/u)
  assert.equal(requireTier('cross-stack-contract').command, 'tools/test/lanes/cross-stack-contract.sh static')
})
