import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const matrix = parseMatrix(read('tests/matrix.yml'))
const tiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]))

function dependencyClosure(id, seen = new Set()) {
  if (seen.has(id)) return seen
  const tier = tiers.get(id)
  assert.ok(tier, `missing matrix tier ${id}`)
  seen.add(id)
  for (const dependency of tier.dependsOn ?? []) dependencyClosure(dependency, seen)
  return seen
}

function shellFunction(source, name) {
  const marker = `${name}() {`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing shell function ${name}`)
  const remaining = source.slice(start + marker.length)
  const next = remaining.search(/^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/mu)
  return next === -1 ? source.slice(start) : source.slice(start, start + marker.length + next)
}

function workflowJob(source, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const marker = source.match(new RegExp(`^(?<indent>[ \\t]+)${escapedId}:[ \\t]*$`, 'mu'))
  assert.ok(marker?.groups?.indent, `missing workflow job ${id}`)
  const start = marker.index
  const bodyStart = start + marker[0].length
  const next = source
    .slice(bodyStart)
    .search(new RegExp(`^${marker.groups.indent}[A-Za-z0-9_-]+:[ \\t]*$`, 'mu'))
  return next === -1 ? source.slice(start) : source.slice(start, bodyStart + next)
}

function runSmartGatePlan(changedFile) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1150-smart-gate-'))
  const changedFiles = path.join(directory, 'changed-files.txt')
  const output = path.join(directory, 'plan.json')
  fs.writeFileSync(changedFiles, `${changedFile}\n`)
  const result = spawnSync(process.execPath, [
    'tools/run-test-matrix.mjs',
    'ci-pr-plan',
    '--changed-files', changedFiles,
    '--event-name', 'pull_request',
    '--out', output
  ], { cwd: root, encoding: 'utf8' })
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(fs.readFileSync(output, 'utf8'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function runTierPlan(tierId) {
  const result = spawnSync(process.execPath, [
    'tools/run-test-matrix.mjs',
    'run',
    tierId,
    '--plan-only'
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

test('production correctness dependency closure is completely browserless', () => {
  const production = tiers.get('production-correctness')
  assert.ok(production)
  assert.equal(production.requiresPlaywright, 'none')
  assert.equal(production.requiredFor, 'production')

  const closure = dependencyClosure('production-correctness')
  const browserTiers = [...closure]
    .map((id) => tiers.get(id))
    .filter((tier) => tier.requiresPlaywright !== 'none')
    .map((tier) => tier.id)
  assert.deepEqual(browserTiers, [])

  const forbidden = [
    'acceptance',
    'browser-contract',
    'browser-diagnostics',
    'browser-diagnostics-nightly',
    'browser-diagnostics-manual',
    'browser-runtime-risk-diagnostics',
    'cross-browser-smoke',
    'visual-public',
    'visual-console',
    'visual',
    'ux-viewport-smoke',
    'ux-viewport-visual',
    'ux-viewport-boundaries',
    'frontend-render-pressure',
    'browser-performance-regression'
  ]
  assert.deepEqual(forbidden.filter((id) => closure.has(id)), [])

  for (const buildConsumer of ['frontend-static-governance', 'wasm-fuzz-regression']) {
    assert.ok(
      tiers.get(buildConsumer)?.dependsOn?.includes('frontend-build'),
      `${buildConsumer} must not race its immutable frontend dist consumer`
    )
  }

  const legacyAlias = tiers.get('production')
  assert.ok(legacyAlias)
  assert.deepEqual(legacyAlias.dependsOn, ['production-correctness'])
  assert.equal(legacyAlias.requiresPlaywright, 'none')
})

test('release final contains exactly one declared browser tier', () => {
  const contract = tiers.get('browser-contract')
  assert.ok(contract)
  assert.equal(contract.ciJob, 'browser-contract')
  assert.equal(contract.resourceClass, 'browser')
  assert.equal(contract.parallelizable, false)
  assert.equal(contract.requiresPlaywright, 'chromium')
  assert.equal(contract.requiredFor, 'release-final')
  assert.equal(contract.timeoutMinutes, 10)
  assert.equal(contract.shardable, false)
  assert.equal(contract.selfBootstraps, true)
  assert.deepEqual(contract.dependsOn, ['production-build-artifacts'])

  const releaseFinal = tiers.get('release-final')
  assert.ok(releaseFinal)
  assert.equal(releaseFinal.requiresPlaywright, 'none')
  assert.equal(releaseFinal.manualOnly, true)
  assert.equal(releaseFinal.cadence, 'release-manual')
  assert.equal(releaseFinal.ciJob, 'release-final')

  const releaseClosure = dependencyClosure('release-final')
  for (const required of [
    'production-correctness',
    'browser-contract',
    'release-evidence',
    'release-closeout'
  ]) assert.ok(releaseClosure.has(required), `release-final missed ${required}`)

  const browserTiers = [...releaseClosure]
    .map((id) => tiers.get(id))
    .filter((tier) => tier.requiresPlaywright !== 'none')
    .map((tier) => tier.id)
    .sort()
  assert.deepEqual(browserTiers, ['browser-contract'])
  assert.equal(tiers.get(browserTiers[0]).ciJob, 'browser-contract')
})

test('direct correctness runs observe duration without truncating tests', () => {
  const correctnessPlan = runTierPlan('production-correctness')
  assert.match(correctnessPlan, /static-governance \[[^\n]*timeout=observe-only/u)
  assert.doesNotMatch(correctnessPlan, /timeout=10m/u)

  const releasePlan = runTierPlan('release-final')
  assert.match(releasePlan, /static-governance \[[^\n]*timeout=observe-only/u)
  assert.match(releasePlan, /browser-contract \[[^\n]*timeout=10m/u)
})

test('every browser-launching tier declares the browser resource boundary', () => {
  for (const tier of matrix.tiers.filter((entry) => entry.requiresPlaywright !== 'none')) {
    assert.equal(tier.resourceClass, 'browser', `${tier.id} must declare resourceClass=browser`)
  }

  for (const id of [
    'acceptance',
    'browser-diagnostics-nightly',
    'browser-diagnostics-manual',
    'browser-runtime-risk-diagnostics',
    'visual-public',
    'visual-console',
    'cross-browser-smoke',
    'ux-viewport-smoke',
    'ux-viewport-visual',
    'ux-viewport-boundaries'
  ]) {
    const tier = tiers.get(id)
    assert.ok(tier, `missing migrated diagnostic tier ${id}`)
    assert.equal(tier.requiredFor, 'none', `${id} must not count as correctness`)
    assert.ok(tier.nightlyOnly === true || tier.manualOnly === true, `${id} must be scheduled/manual only`)
  }
})

test('canonical correctness leaves cannot hide direct Chromium launch scripts or a second production DAG', () => {
  const source = read('tools/test/lanes/_suite-support.sh')
  const integration = shellFunction(source, 'RunIntegrationOnly')
  const security = shellFunction(source, 'RunSecurityRuntimeCoreOnly')
  const resilience = shellFunction(source, 'RunResilienceOnly')
  const acceptance = shellFunction(source, 'RunAcceptanceOnly')

  for (const forbidden of ['check:pow-runtime', 'check:search-runtime']) {
    assert.doesNotMatch(integration, new RegExp(forbidden.replace(':', '\\:')))
  }
  assert.doesNotMatch(security, /check:security:permissions/u)
  assert.doesNotMatch(resilience, /check:search-runtime/u)
  assert.match(acceptance, /browser-diagnostics/u)
  assert.ok(
    acceptance.indexOf('acceptance is diagnostics-only') < acceptance.indexOf('PrepareSessionFixturesOnce'),
    'acceptance must fail closed outside the diagnostics job before preparing browser fixtures'
  )
  assert.doesNotMatch(source, /RunProductionCorrectness\(\)|RunProduction\(\)/u)

  assert.equal(
    tiers.get('cross-stack-contract')?.command,
    'tools/test/lanes/cross-stack-contract.sh static'
  )

  const diagnostics = read('tools/test/lanes/browser-runtime-risk-diagnostics.sh')
  for (const migrated of [
    'check:pow-runtime',
    'check:search-runtime',
    'check:security:permissions',
    'check:auth-zero-probe'
  ]) {
    assert.match(diagnostics, new RegExp(migrated.replaceAll(':', '\\:')), `diagnostics must retain ${migrated}`)
  }
})

test('ordinary quality gate has one conditional zero-retry Chromium job', () => {
  const workflow = read('.github/workflows/quality-gate.yml')
  assert.doesNotMatch(workflow, /^ {4}acceptance-playwright:/mu)
  assert.doesNotMatch(workflow, /^ {4}frontend-render-pressure:/mu)
  assert.equal(workflow.match(/playwright install/g)?.length ?? 0, 1)
  assert.equal(workflow.match(/\.cache\/ms-playwright/g)?.length ?? 0, 1)

  const contract = workflowJob(workflow, 'browser-contract')
  assert.match(contract, /timeout-minutes: 10/u)
  assert.match(contract, /FSUSBLOG_PLAYWRIGHT_WORKERS: ["']1["']/u)
  assert.match(contract, /playwright install --with-deps chromium/u)
  assert.match(contract, /uses: \.\/\.github\/actions\/consume-production-build/u)
  assert.match(contract, /\.\/tools\/test\.sh ci-tier browser-contract --no-deps/u)
  assert.match(contract, /needs\.plan-pr-risk\.outputs\.browser_contract/u)
  assert.match(contract, /github\.event_name == 'workflow_dispatch'/u)
  assert.match(contract, /github\.event_name == 'push'[\s\S]*?refs\/heads\/(?:main|master)/u)
  assert.match(contract, /github\.event_name == 'pull_request'[\s\S]*?needs\.plan-pr-risk\.outputs\.browser_contract == 'true'/u)
  assert.doesNotMatch(contract, /run-flaky-governed|--shard|matrix\.shard|firefox|webkit/u)

  for (const browserlessAggregate of ['release-evidence', 'production-summary']) {
    assert.doesNotMatch(workflowJob(workflow, browserlessAggregate), /- browser-contract/u)
  }

  for (const buildConsumer of ['frontend-static-governance', 'security-static-fuzz']) {
    const job = workflowJob(workflow, buildConsumer)
    assert.match(job, /needs: (?:\[[^\]]*frontend-build[^\]]*\]|frontend-build)/u)
    assert.match(job, /actions\/download-artifact@[\s\S]*name: frontend-build[\s\S]*path: \./u)
  }

  const diagnostics = read('.github/workflows/browser-diagnostics.yml')
  assert.match(diagnostics, /^ {4}schedule:/mu)
  assert.match(diagnostics, /^ {4}workflow_dispatch:/mu)
  assert.doesNotMatch(diagnostics, /^ {4}(?:pull_request|push):/mu)
})

test('smart gate selects Browser Contract only for its explicit boundary', () => {
  const ordinary = runSmartGatePlan('docs/testing.md')
  assert.ok(!ordinary.selectedTierIds.includes('browser-contract'))
  for (const tierId of ordinary.selectedTierIds) {
    assert.equal(tiers.get(tierId)?.requiresPlaywright, 'none', `ordinary PR selected browser tier ${tierId}`)
  }

  for (const boundaryPath of [
    'src/frontend/src/router/index.ts',
    'src/frontend/src/api/auth.ts',
    'src/frontend/src/adapters/binary/passkeyAdapter.ts',
    'src/frontend/src/composables/usePasskeyLogin.ts',
    'src/frontend/src/composables/usePasskeyManagement.ts',
    'src/frontend/src/components/ui/PasskeyRegisterModal.vue',
    'src/frontend/src/copy/auth.ts',
    'src/frontend/public/sw.js',
    'src/frontend/public/manifest.webmanifest',
    '.github/workflows/quality-gate.yml',
    '.github/actions/consume-production-build/action.yml'
  ]) {
    const boundary = runSmartGatePlan(boundaryPath)
    assert.ok(boundary.selectedTierIds.includes('browser-contract'), `${boundaryPath} missed Browser Contract`)
    assert.ok(boundary.selectedTierIds.includes('production-build-artifacts'), `${boundaryPath} missed immutable build producer`)
    assert.ok(boundary.selectedJobs.includes('browser-contract'), `${boundaryPath} missed Browser Contract job`)
  }

  for (const adjacentPath of [
    'src/frontend/src/api/article.ts',
    'src/frontend/src/composables/usePagedListState.ts',
    'src/frontend/src/components/PublicArticleCover.vue',
    'src/frontend/public/unrelated-browser-file.txt',
    '.github/workflows/browser-diagnostics.yml',
    '.github/actions/unrelated/action.yml'
  ]) {
    const adjacent = runSmartGatePlan(adjacentPath)
    assert.ok(!adjacent.selectedTierIds.includes('browser-contract'), `${adjacentPath} over-selected Browser Contract`)
    assert.ok(!adjacent.selectedJobs.includes('browser-contract'), `${adjacentPath} over-selected Browser Contract job`)
  }
})
