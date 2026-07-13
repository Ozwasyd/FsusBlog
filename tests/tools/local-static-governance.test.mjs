import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildLocalStaticManifest,
  extractChainedNpmScripts,
  planLocalStaticCommands,
  summarizeLocalStaticPlan
} from '../../tools/test/local-static-governance.mjs'
import {
  planWeightedManifestEntries,
  readManifestSchedulerResourceGrant,
  resolveAdaptiveManifestWorkers,
  runWeightedCommandManifest
} from '../../tools/test/run-command-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const staticManifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/frontend/checks/static/manifest.json'), 'utf8'))
const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))
const localStaticSource = fs.readFileSync(path.join(root, 'tools/test/local-static-governance.mjs'), 'utf8')
const staticLaneSource = fs.readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8')
const legacyLaneSource = fs.readFileSync(path.join(root, 'tools/test/lanes/_legacy.sh'), 'utf8')

test('local static manifest expands the production views chain without omitting a check', () => {
  const chainedScripts = extractChainedNpmScripts(frontendPackage.scripts['check:views-constraints'])
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const expanded = manifest.commands.filter((entry) => entry.id.startsWith('views-constraints:'))

  assert.deepEqual(expanded[0].command, ['node', '../../tests/frontend/checks/static/check-views-constraints.mjs'])
  assert.deepEqual(expanded.slice(1).map((entry) => entry.script), chainedScripts)
  assert.deepEqual(
    manifest.commands.filter((entry) => !entry.id.startsWith('views-constraints:')).map((entry) => entry.id),
    staticManifest.commands.filter((entry) => entry.id !== 'views-constraints').map((entry) => entry.id)
  )
  const writes = expanded.filter((entry) => entry.access === 'write').map((entry) => entry.script)
  assert.deepEqual(writes, [
    'check:dom-depth-static',
    'check:route-asset-budget',
    'check:public-performance-batch'
  ])
})

test('local static plan saturates independent work before the dynamically parallel asset check', () => {
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const plan = planLocalStaticCommands(manifest)

  assert.deepEqual(plan.initial.slice(0, 6).map((entry) => entry.id), [
    'views-constraints:dom-depth-static',
    'historical-residue-fixture',
    'views-constraints:fsusui-typecheck-modes',
    'test-execution-optimization',
    'frontend-test-governance',
    'api-parity'
  ])
  assert.deepEqual(plan.isolated.map((entry) => entry.id), [
    'asset-size-budget',
    'views-constraints:route-asset-budget'
  ])
  assert.deepEqual(plan.postbuild.map((entry) => entry.id), ['public-aot-contracts'])
  assert.deepEqual(plan.final.map((entry) => entry.id), ['views-constraints:public-performance-batch'])
})

test('prebuild and postbuild phases form an exact 66-command partition', () => {
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const plan = planLocalStaticCommands(manifest)
  const summary = summarizeLocalStaticPlan(plan)
  const plannedIds = [
    ...plan.initial,
    ...plan.postbuild,
    ...plan.isolated,
    ...plan.final
  ].map((entry) => entry.id)

  assert.equal(manifest.commands.length, 66)
  assert.deepEqual(summary, { prebuild: 62, postbuild: 4, total: 66 })
  assert.equal(new Set(plannedIds).size, 66)
  assert.deepEqual(new Set(plannedIds), new Set(manifest.commands.map((entry) => entry.id)))
  assert.match(localStaticSource, /split=\$\{manifest\.execution\.prebuild\}\+\$\{manifest\.execution\.postbuild\}/u)
  assert.match(localStaticSource, /total=\$\{manifest\.execution\.total\}/u)
  assert.match(localStaticSource, /commandIds: executedCommands\.map\(\(entry\) => entry\.id\)/u)
  assert.match(localStaticSource, /frontend-static-governance-phase\.v1/u)
  assert.match(localStaticSource, /FSUSBLOG_LOCAL_STATIC_EVIDENCE_FILE/u)
  assert.match(localStaticSource, /writeFileSync\(temporary[\s\S]*?renameSync\(temporary, absolute\)/u)
  assert.match(
    localStaticSource,
    /executeLimitedWave\(\s*\[\.\.\.plan\.postbuild, \.\.\.plan\.isolated\],\s*workers,/u,
    'independent postbuild readers and distinct evidence writers must share the dynamic worker pool'
  )
})

test('static governance propagates bounded dynamic workers and explicit Node test concurrency', () => {
  assert.match(localStaticSource, /resolveManifestChildEnvironment\(\{ env, workers, concurrent: true \}\)/u)
  assert.match(localStaticSource, /resolveManifestChildEnvironment\(\{ env, workers, concurrent: false \}\)/u)
  assert.match(legacyLaneSource, /worker_cap="\$\(resolve_collect_parallel_workers "\$total"\)"/u)
  assert.match(legacyLaneSource, /resolveManifestWorkers\(\{ env: process\.env \}\)/u)
  assert.match(legacyLaneSource, /resolveManifestChildEnvironment/u)
  assert.match(legacyLaneSource, /FSUSBLOG_STEP_CPU_BUDGET/u)
  assert.match(legacyLaneSource, /FSUSBLOG_STEP_MEMORY_GIB/u)
  assert.match(staticLaneSource, /run_collect_parallel static-governance-prechecks/u)
  assert.match(staticLaneSource, /runWeightedCommandManifest/u)
  assert.match(staticLaneSource, /FSUSBLOG_ZDT_FIXTURE_SHARD: shard/u)
  assert.match(staticLaneSource, /concurrencyWeight: Number\.MAX_SAFE_INTEGER/u)
  assert.match(staticLaneSource, /\['all', 1_000\]/u)
  assert.match(staticLaneSource, /\['normal', 7_000\]/u)
  assert.match(staticLaneSource, /\['explicit-rollback', 12_000\]/u)
  assert.match(staticLaneSource, /\['post-switch-rollback', 7_000\]/u)
  assert.match(staticLaneSource, /\['sigkill-resume', 16_000\]/u)
})

test('weighted contract planner starts historical long tails first and aggregates every failure', async () => {
  const commands = [
    { id: 'short', access: 'read', command: ['short'], estimatedDurationMs: 1 },
    { id: 'long', access: 'read', command: ['long'], estimatedDurationMs: 30 },
    { id: 'middle', access: 'read', command: ['middle'], estimatedDurationMs: 10 }
  ]
  assert.deepEqual(planWeightedManifestEntries(commands).map(entry => entry.id), ['long', 'middle', 'short'])

  const attempted = []
  const childEnvironments = []
  await assert.rejects(
    runWeightedCommandManifest({
      schema: 'fsusblog.test-command-manifest.v1',
      lane: 'fixture',
      commands
    }, {
      resolveWorkers: () => 2,
      env: {
        FSUSBLOG_STEP_CPU_BUDGET: '2',
        FSUSBLOG_STEP_MEMORY_GIB: '1'
      },
      execute: async (entry, options) => {
        attempted.push(entry.id)
        childEnvironments.push(options.env)
        if (entry.id !== 'middle') throw new Error(`failed-${entry.id}`)
      }
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      assert.match(error.message, /long: failed-long/u)
      assert.match(error.message, /short: failed-short/u)
      return true
    }
  )
  assert.deepEqual(new Set(attempted), new Set(['long', 'middle', 'short']))
  assert.ok(childEnvironments.every((env) => env.FSUSBLOG_STEP_CPU_BUDGET === '1'))
  assert.ok(childEnvironments.every((env) => env.FSUSBLOG_STEP_MEMORY_GIB === '0.5'))
  assert.ok(childEnvironments.every((env) => env.FSUSBLOG_NODE_TEST_CONCURRENCY === '1'))
})

test('weighted fixture admission keeps the exact CPU grant while using a third process slot', async () => {
  const active = []
  const observations = []
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const run = runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'weighted-fixture',
    commands: [
      { id: 'fixture', access: 'read', command: ['fixture'], concurrencyWeight: 2, estimatedDurationMs: 30 },
      { id: 'contract-a', access: 'read', command: ['contract-a'], estimatedDurationMs: 20 },
      { id: 'contract-b', access: 'read', command: ['contract-b'], estimatedDurationMs: 10 }
    ]
  }, {
    resolveWorkers: () => 3,
    env: { FSUSBLOG_STEP_CPU_BUDGET: '1', FSUSBLOG_STEP_MEMORY_GIB: '1' },
    execute: async (entry, options) => {
      active.push(entry.id)
      observations.push({
        id: entry.id,
        cpu: options.env.FSUSBLOG_STEP_CPU_BUDGET,
        memory: options.env.FSUSBLOG_STEP_MEMORY_GIB,
        active: [...active]
      })
      await barrier
      active.splice(active.indexOf(entry.id), 1)
    }
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(new Set(active), new Set(['fixture', 'contract-a']))
  assert.deepEqual(observations.map(entry => [entry.id, entry.cpu, entry.memory]), [
    ['fixture', String(2 / 3), String(2 / 3)],
    ['contract-a', String(1 / 3), String(1 / 3)]
  ])
  release()
  await run
  assert.equal(observations.at(-1).id, 'contract-b')
})

test('late static contract wave consumes only a valid live scheduler grant and current host headroom', () => {
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'run-live',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'frontend',
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_MEMORY_GIB: '1',
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '22'
  }
  const document = JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'run-live',
    resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
    grants: { frontend: { cpuUnits: 8, memoryGiB: 8 } }
  })

  assert.deepEqual(
    readManifestSchedulerResourceGrant({ env, readFile: () => document }),
    { cpuUnits: 8, memoryGiB: 8, budgetCpuUnits: 8, budgetMemoryGiB: 8 }
  )
  assert.equal(resolveAdaptiveManifestWorkers({
    env,
    cpuCount: 8,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 2.2,
    readGrantFile: () => document
  }), 8)
  assert.equal(resolveAdaptiveManifestWorkers({
    env,
    cpuCount: 8,
    freeMemoryBytes: 2 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 0,
    readGrantFile: () => document
  }), 8)
  assert.equal(resolveAdaptiveManifestWorkers({
    env: { ...env, FSUSBLOG_COMMAND_MANIFEST_WORKERS: '3' },
    cpuCount: 8,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 7,
    readGrantFile: () => JSON.stringify({
      ...JSON.parse(document),
      grants: { frontend: { cpuUnits: 1, memoryGiB: 1 } }
    }),
    workload: 'orchestration',
    orchestrationWorkersPerCpu: 3
  }), 3)
  assert.throws(
    () => readManifestSchedulerResourceGrant({
      env,
      readFile: () => JSON.stringify({ ...JSON.parse(document), runId: 'stale-run' })
    }),
    /runId mismatch/u
  )
})

test('static governance parallel group preserves every named check and the aggregate finish', () => {
  for (const label of [
    'evidence-plan',
    'aeds-policy',
    'community-workflow',
    'label-governance',
    'integrity-docs',
    'dead-code-index',
    'background-services',
    'suite-convergence',
    'backend-governance',
    'gate-integrity',
    'flaky-registry',
    'matrix-contract',
    'matrix-schema',
    'implementation-drift'
  ]) assert.match(staticLaneSource, new RegExp(`\\n\\s+${label} static_`, 'u'))
  assert.match(staticLaneSource, /run_collect node-contracts static_node_contracts/u)
  assert.match(staticLaneSource, /orchestrationWorkersPerCpu: 3/u)
  assert.match(staticLaneSource, /delete manifestEnv\.FSUSBLOG_COMMAND_MANIFEST_WORKERS/u)
  assert.match(staticLaneSource, /env: manifestEnv/u)
  assert.match(staticLaneSource, /process\.memoryUsage\(\)\.rss \/ 1024 \*\* 3/u)
  assert.match(staticLaneSource, /orchestrationMemoryGiBPerWorker: measuredNodeOrchestratorGiB/u)
  assert.match(staticLaneSource, /concurrencyWeight: Number\.MAX_SAFE_INTEGER/u)
  assert.match(staticLaneSource, /node-contracts\)\s*run_static_node_contracts_phase/u)
  assert.match(staticLaneSource, /run_static_post_vitest_phase\(\) \{\s*run_collect retention static_retention\s*\}/u)
  assert.match(staticLaneSource, /concurrent\)\s*run_static_concurrent_phase/u)
  assert.match(staticLaneSource, /post-vitest\)\s*run_static_post_vitest_phase/u)
  assert.match(staticLaneSource, /all\)\s*run_static_concurrent_phase\s*run_static_post_vitest_phase/u)
  assert.match(staticLaneSource, /finish_collect\s*$/u)
  assert.doesNotMatch(staticLaneSource, /max[-_]?errors?|fail-fast/u)
})

test('retention remains isolated from concurrent Vitest report writes', () => {
  const concurrentPhase = staticLaneSource.match(/run_static_concurrent_phase\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const postVitestPhase = staticLaneSource.match(/run_static_post_vitest_phase\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? ''

  assert.doesNotMatch(concurrentPhase, /static_retention/u)
  assert.match(postVitestPhase, /run_collect retention static_retention/u)
  assert.match(staticLaneSource, /Retention intentionally stays post-Vitest/u)
})
