import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveAdaptiveManifestWorkers } from '../../tools/test/run-command-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const legacy = fs.readFileSync(path.join(root, 'tools/test/legacy-test.sh'), 'utf8')
const browserDiagnostics = fs.readFileSync(path.join(root, 'tools/test/lanes/browser-runtime-risk-diagnostics.sh'), 'utf8')
const integration = legacy.slice(
  legacy.indexOf('run_integration_only()'),
  legacy.indexOf('\nrun_integration()', legacy.indexOf('run_integration_only()'))
)

function countShellToken(source, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return [...source.matchAll(new RegExp(`${escaped}(?=["\\s])`, 'gu'))].length
}

test('runtime integration retains every check exactly once while parallelizing only shared-state-safe work', () => {
  const parallelStart = integration.indexOf('run_parallel "integration-runtime-checks"')
  const authenticated = integration.indexOf('run_integration_stage "binary-smoke-auth"')
  const distribution = integration.indexOf('run_integration_stage "distribution-version-coherence"')

  assert.ok(parallelStart >= 0)
  assert.ok(parallelStart < authenticated && authenticated < distribution)
  for (const script of [
    'check:auth-session-smoke',
    'check:binary-smoke',
    'check:binary-smoke:auth',
    'check:notification-stream-runtime',
    'check:notification-stream-live',
    'check:api-contracts',
    'check:binary-contract-smoke',
    'check:distribution-version-coherence',
    'check:sw-search-runtime'
  ]) assert.equal(countShellToken(integration, script), 1, `${script} must run exactly once`)
  assert.doesNotMatch(integration, /check:pow-runtime|check:search-runtime/u)

  const pool = integration.slice(parallelStart, authenticated)
  assert.doesNotMatch(pool, /check:binary-smoke:auth|check:distribution-version-coherence/u)
  assert.match(integration, /FSUSBLOG_ADAPTIVE_PARALLEL=1/u)
  assert.match(integration, /FSUSBLOG_PARALLEL_WORKLOAD=orchestration/u)
})

test('diagnostics-only pow runtime parallelizes isolated browser contexts with a machine-derived bounded pool', () => {
  assert.match(browserDiagnostics, /check:pow-runtime/u)
  assert.match(browserDiagnostics, /check:search-runtime/u)
  const powRuntime = fs.readFileSync(
    path.join(root, 'tests/frontend/checks/runtime/pow-runtime-regression.mjs'),
    'utf8'
  )
  assert.match(powRuntime, /resolveAdaptiveManifestWorkers/u)
  assert.match(powRuntime, /workload: 'orchestration'/u)
  assert.match(powRuntime, /Math\.min\(scenarios\.length/u)
  assert.match(powRuntime, /Promise\.all\(Array\.from\(\{ length: scenarioWorkers \}/u)
  assert.match(powRuntime, /results\[index\] = await runScenario\(browser, scenarios\[index\]\)/u)
})

test('runtime integration collects independent pool and stateful failures before failing the lane', () => {
  assert.match(integration, /local -a integration_failures=\(\)/u)
  assert.match(integration, /integration_failures\+=\("\$label:\$status"\)/u)
  assert.match(integration, /run_integration_stage "runtime-parallel"[\s\S]*run_integration_stage "binary-smoke-auth"[\s\S]*run_integration_stage "distribution-version-coherence"/u)
  assert.match(integration, /if \(\( \$\{#integration_failures\[@\]\} > 0 \)\); then[\s\S]*fail "integration runtime failures/u)
  assert.doesNotMatch(integration, /max[-_]?errors?|fail-fast/u)
})

test('orchestration pool shares one admitted CPU between two bounded children', () => {
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'runtime-integration-live',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/runtime-integration-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_MEMORY_GIB: '3',
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '9'
  }
  const document = JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'runtime-integration-live',
    resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
    grants: { runtime: { cpuUnits: 1, memoryGiB: 3 } }
  })

  assert.equal(resolveAdaptiveManifestWorkers({
    env,
    cpuCount: 8,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 7,
    readGrantFile: () => document,
    workload: 'orchestration'
  }), 2)
})

test('direct focused orchestration uses the inherited step grant without requiring a live grant file', () => {
  assert.equal(resolveAdaptiveManifestWorkers({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '1',
      FSUSBLOG_STEP_MEMORY_GIB: '3',
      FSUSBLOG_COMMAND_MANIFEST_WORKERS: '9'
    },
    cpuCount: 8,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 7,
    workload: 'orchestration'
  }), 2)
})

test('distribution coherence reuses only current-run taxonomy and keeps every lifecycle assertion', () => {
  const distribution = fs.readFileSync(
    path.join(root, 'tests/frontend/checks/runtime/distribution-version-coherence-smoke.mjs'),
    'utf8'
  )
  assert.match(distribution, /readPublicFixtureIds\(\{\}, \{ requireCurrent: true \}\)/u)
  assert.match(distribution, /resolveRuntimeBrowserTimeoutPlan\(\)/u)
  assert.match(distribution, /timeoutMs \* 6/u)
  assert.match(distribution, /150_000 \* timeoutPlan\.contentionMultiplier/u)
  assert.doesNotMatch(distribution, /findEventuallyNamedTaxonomyId|fetchTaxonomy/u)
  assert.equal(distribution.match(/warmPublicSurfaces\(/gu)?.length, 2, 'one definition and one pre-mutation warm remain')
  for (const label of [
    'draft-hidden', 'scheduled-hidden', 'archived-hidden', 'create', 'update',
    'delete', 'restore-draft-hidden', 'restore-republish', 'permanent-delete'
  ]) assert.ok(distribution.includes(`ok: ${label}`), `missing lifecycle assertion ${label}`)
})
