import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildLocalStaticManifest,
  executeStaticStage,
  extractChainedNpmScripts,
  planLocalStaticCommands,
  summarizeLocalStaticPlan
} from '../../tools/test/local-static-governance.mjs'
import {
  planWeightedManifestEntries,
  readManifestSchedulerResourceGrant,
  resolveAdaptiveManifestWorkers,
  resolveManifestLiveCapacity,
  runWeightedCommandManifest,
  validateCommandManifest
} from '../../tools/test/run-command-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const staticManifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/frontend/checks/static/manifest.json'), 'utf8'))
const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))
const localStaticSource = fs.readFileSync(path.join(root, 'tools/test/local-static-governance.mjs'), 'utf8')
const staticLaneSource = fs.readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8')
const legacyLaneSource = fs.readFileSync(path.join(root, 'tools/test/lanes/_legacy.sh'), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('local static manifest expands only the explicit production views plan without omitting a check', () => {
  const chainedScripts = extractChainedNpmScripts(frontendPackage.scripts['check:views-constraints'])
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const expanded = manifest.commands.filter((entry) => entry.id.startsWith('views-constraints:'))
  const declared = staticManifest.commands.find((entry) => entry.id === 'views-constraints').localCommands

  assert.deepEqual(expanded[0].command, ['node', '../../tests/frontend/checks/static/check-views-constraints.mjs'])
  assert.deepEqual(expanded.slice(1).map((entry) => entry.script), chainedScripts)
  assert.deepEqual(expanded, declared)
  assert.deepEqual(
    manifest.commands.filter((entry) => !entry.id.startsWith('views-constraints:')).map((entry) => entry.id),
    staticManifest.commands.filter((entry) => entry.id !== 'views-constraints').map((entry) => entry.id)
  )
  const writes = expanded.filter((entry) => entry.access === 'write').map((entry) => entry.script)
  assert.deepEqual(writes, [
    'check:dom-depth-static',
    'check:route-asset-budget'
  ])
  for (const entry of manifest.commands) {
    assert.ok(entry.reason)
    assert.ok(entry.stage)
    assert.ok(entry.consumedInputs.length > 0)
    assert.ok(Array.isArray(entry.ownedOutputs))
    assert.ok(Array.isArray(entry.dependsOn))
    assert.ok(Array.isArray(entry.resources.exclusiveResources))
  }
})

test('frontend static v2 schema rejects missing stages, reasons, and write ownership', () => {
  const missingStage = structuredClone(staticManifest)
  delete missingStage.commands[0].stage
  assert.ok(validateCommandManifest(missingStage).some((error) => error.includes('.stage must be')))

  const missingReason = structuredClone(staticManifest)
  delete missingReason.commands[0].reason
  assert.ok(validateCommandManifest(missingReason).some((error) => error.includes('.reason must be')))

  const missingOwnership = structuredClone(staticManifest)
  missingOwnership.commands.find((entry) => entry.id === 'asset-size-budget').ownedOutputs = []
  assert.ok(validateCommandManifest(missingOwnership).some((error) => error.includes('ownedOutputs must identify')))
})

test('local static plan derives every stage from manifest metadata', () => {
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const plan = planLocalStaticCommands(manifest)

  assert.deepEqual(plan['blocking-prebuild'].map((entry) => entry.id), [
    'frontend-test-governance',
    'frontend-test-layout',
    'csharp-entrypoint-ownership',
    'test-execution-optimization',
    'views-constraints:fsusui-typecheck-modes'
  ])
  assert.deepEqual(plan.isolated.map((entry) => entry.id), ['views-constraints:dom-depth-static'])
  assert.deepEqual(plan.postbuild.map((entry) => entry.id), [
    'asset-size-budget',
    'public-aot-contracts',
    'views-constraints:route-asset-budget'
  ])
  assert.deepEqual(plan.final.map((entry) => entry.id), ['views-constraints:public-performance-batch'])
})

test('five explicit phases form an exact 70-command partition with timing evidence', () => {
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const plan = planLocalStaticCommands(manifest)
  const summary = summarizeLocalStaticPlan(plan)
  const plannedIds = Object.values(plan).flat().map((entry) => entry.id)

  assert.equal(manifest.commands.length, 70)
  assert.deepEqual(summary, {
    'blocking-prebuild': 5,
    concurrent: 60,
    postbuild: 3,
    isolated: 1,
    final: 1,
    total: 70
  })
  assert.equal(new Set(plannedIds).size, 70)
  assert.deepEqual(new Set(plannedIds), new Set(manifest.commands.map((entry) => entry.id)))
  assert.match(localStaticSource, /staticStages\.map\(\(stage\) => manifest\.execution\[stage\]\)\.join\('\+'\)/u)
  assert.match(localStaticSource, /total=\$\{manifest\.execution\.total\}/u)
  assert.match(localStaticSource, /commandIds: executedCommands\.map\(\(entry\) => entry\.id\)/u)
  assert.match(localStaticSource, /frontend-static-governance-phase\.v2/u)
  assert.match(localStaticSource, /FSUSBLOG_LOCAL_STATIC_EVIDENCE_FILE/u)
  assert.match(localStaticSource, /writeFileSync\(temporary[\s\S]*?renameSync\(temporary, absolute\)/u)
  assert.match(localStaticSource, /waitReason:[\s\S]*?waiting for dependencies/u)
  assert.match(localStaticSource, /stagePlan:[\s\S]*?dependencies:[\s\S]*?exclusiveResources:/u)
  assert.match(localStaticSource, /stageTimings[\s\S]*?commandCount:[\s\S]*?durationMs:[\s\S]*?waitReasons:/u)
  assert.match(localStaticSource, /queuedAtMs[\s\S]*?waitDurationMs[\s\S]*?finishedAtMs[\s\S]*?durationMs/u)
  assert.match(localStaticSource, /runWeightedCommandManifest\([\s\S]*?frontend-static:\$\{stage\}/u)
  assert.match(localStaticSource, /grantHistory:[\s\S]*?admissions:[\s\S]*?blockedReasons:/u)
})

test('static governance propagates bounded dynamic workers and explicit Node test concurrency', () => {
  assert.match(localStaticSource, /workload: 'scheduler-admitted'/u)
  assert.match(localStaticSource, /memoryCostGiB:[\s\S]*?0\.125 \* entry\.resources\.memoryWeight/u)
  assert.match(legacyLaneSource, /nextWorkerCap="\$\(ResolveCollectParallelWorkers "\$total"\)"/u)
  assert.match(legacyLaneSource, /resolveManifestLiveCapacity\(\{ env: process\.env, workload: 'scheduler-admitted' \}\)/u)
  assert.match(legacyLaneSource, /resolveManifestChildEnvironment/u)
  assert.match(legacyLaneSource, /FSUSBLOG_STEP_CPU_BUDGET/u)
  assert.match(legacyLaneSource, /FSUSBLOG_STEP_MEMORY_GIB/u)
  assert.match(staticLaneSource, /RunCollectParallel static-governance-prechecks/u)
  assert.match(staticLaneSource, /runWeightedCommandManifest/u)
  assert.match(staticLaneSource, /FSUSBLOG_ZDT_FIXTURE_SHARD: shard/u)
  assert.match(staticLaneSource, /concurrencyWeight: Number\.MAX_SAFE_INTEGER/u)
  assert.match(staticLaneSource, /\['all', 1_000\]/u)
  assert.match(staticLaneSource, /\['normal', 7_000\]/u)
  assert.match(staticLaneSource, /\['explicit-rollback', 12_000\]/u)
  assert.match(staticLaneSource, /\['post-switch-rollback', 7_000\]/u)
  assert.match(staticLaneSource, /\['sigkill-resume', 16_000\]/u)
})

test('concurrent static failures aggregate after every independent command is attempted', async () => {
  const entries = ['first', 'second', 'third'].map((id) => ({
    id,
    access: 'read',
    command: [id],
    stage: 'concurrent',
    reason: `${id} fixture`,
    consumedInputs: ['fixture'],
    ownedOutputs: [],
    dependsOn: [],
    resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: [] }
  }))
  const attempted = []
  const timings = []
  await assert.rejects(executeStaticStage({
    stage: 'concurrent',
    entries,
    workers: 3,
    frontendRoot: root,
    env: { FSUSBLOG_STEP_CPU_BUDGET: '3', FSUSBLOG_STEP_MEMORY_GIB: '3' },
    timings,
    execute: async (entry) => {
      attempted.push(entry.id)
      if (entry.id !== 'second') throw new Error(`failed-${entry.id}`)
    }
  }), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    return true
  })
  assert.deepEqual(new Set(attempted), new Set(['first', 'second', 'third']))
  assert.deepEqual(new Set(timings.map((entry) => entry.status)), new Set(['success', 'failure']))
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
  assert.ok(childEnvironments.every((env) => Number(env.FSUSBLOG_STEP_CPU_BUDGET) > 0))
  assert.ok(childEnvironments.every((env) => Number(env.FSUSBLOG_STEP_MEMORY_GIB) === 0.125))
  assert.ok(childEnvironments.every((env) => Number(env.FSUSBLOG_STEP_CPU_BUDGET) <= 2))
  assert.ok(childEnvironments.every((env) => env.FSUSBLOG_PARALLEL_ACTIVE_WORKERS === '2'))
  assert.ok(childEnvironments.every((env) => {
    const concurrency = Number(env.FSUSBLOG_NODE_TEST_CONCURRENCY)
    return Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 2
  }))
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
    ['fixture', String(2 / 3), '0.125'],
    ['contract-a', String(1 / 3), '0.125']
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
  assert.throws(
    () => readManifestSchedulerResourceGrant({ env, readFile: () => '{corrupt' }),
    /unreadable/u
  )
  assert.deepEqual(
    resolveManifestLiveCapacity({
      env: {
        FSUSBLOG_STEP_CPU_BUDGET: '2',
        FSUSBLOG_STEP_MEMORY_GIB: '1',
        FSUSBLOG_COMMAND_MANIFEST_WORKERS: '2'
      },
      cpuCount: 8,
      freeMemoryBytes: 8 * 1024 ** 3,
      totalMemoryBytes: 8 * 1024 ** 3,
      load1: 0,
      workload: 'scheduler-admitted'
    }),
    {
      schema: 'fsusblog.live-grant-capacity.v1',
      maxParallel: 2,
      cpuUnits: 2,
      memoryGiB: 1,
      parentCpuUnits: 2,
      parentMemoryGiB: 1,
      source: 'direct-invocation-fallback'
    }
  )
})

test('live capacity resolves workers and parent limits from one atomic grant snapshot', () => {
  let reads = 0
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'atomic-run',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/atomic-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'frontend',
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '4'
  }
  const readGrantFile = () => {
    reads += 1
    const cpuUnits = reads === 1 ? 4 : 1
    return JSON.stringify({
      schema: 'fsusblog.test-matrix.resource-grants.v1',
      runId: 'atomic-run',
      resourceBudget: { cpuUnits: 4, memoryGiB: 4 },
      grants: { frontend: { cpuUnits, memoryGiB: cpuUnits } }
    })
  }

  const capacity = resolveManifestLiveCapacity({
    env,
    cpuCount: 8,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 0,
    readGrantFile,
    workload: 'scheduler-admitted'
  })

  assert.equal(reads, 1)
  assert.equal(capacity.maxParallel, 4)
  assert.equal(capacity.cpuUnits, 4)
  assert.equal(capacity.memoryGiB, 4)
  assert.equal(capacity.parentCpuUnits, 4)
  assert.equal(capacity.parentMemoryGiB, 4)
})

test('direct manifest execution records its fixed fallback mode honestly', async () => {
  const evidence = await runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'direct-fixed',
    commands: [{ id: 'only', access: 'read', command: ['only'] }]
  }, {
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '1',
      FSUSBLOG_STEP_MEMORY_GIB: '1',
      FSUSBLOG_COMMAND_MANIFEST_WORKERS: '1'
    },
    execute: async () => {}
  })

  assert.equal(evidence.executionMode, 'fixed')
  assert.deepEqual(evidence.grantHistory.map((entry) => entry.source), ['direct-invocation-fallback'])
})

test('live grant growth admits pending commands before the first child settles', async () => {
  let grant = { cpuUnits: 1, memoryGiB: 1 }
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'growth-run',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/growth-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'static',
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '4'
  }
  const readGrantFile = () => JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'growth-run',
    resourceBudget: { cpuUnits: 4, memoryGiB: 4 },
    grants: { static: grant }
  })
  const release = deferred()
  const active = new Set()
  const started = []
  const execution = runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'growth',
    commands: ['one', 'two', 'three', 'four'].map((id) => ({
      id,
      access: 'read',
      command: [id],
      memoryCostGiB: 0.25
    }))
  }, {
    env,
    workload: 'scheduler-admitted',
    readGrantFile,
    execute: async (entry) => {
      started.push(entry.id)
      active.add(entry.id)
      await release.promise
      active.delete(entry.id)
    }
  })

  await waitFor(() => active.size === 1)
  grant = { cpuUnits: 4, memoryGiB: 4 }
  await waitFor(() => active.size === 4)
  assert.equal(started.length, 4)
  release.resolve()
  const evidence = await execution
  assert.deepEqual(evidence.grantHistory.map((entry) => entry.maxParallel), [1, 4])
})

test('live grant shrink pauses new admission until active weight returns below the new cap', async () => {
  let grant = { cpuUnits: 4, memoryGiB: 4 }
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'shrink-run',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/shrink-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'static',
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '4'
  }
  const readGrantFile = () => JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'shrink-run',
    resourceBudget: { cpuUnits: 4, memoryGiB: 4 },
    grants: { static: grant }
  })
  const releases = new Map()
  const active = new Set()
  const started = []
  const execution = runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'shrink',
    commands: ['one', 'two', 'three', 'four', 'five'].map((id) => ({
      id,
      access: 'read',
      command: [id],
      memoryCostGiB: 0.25
    }))
  }, {
    env,
    workload: 'scheduler-admitted',
    readGrantFile,
    execute: async (entry) => {
      const release = deferred()
      releases.set(entry.id, release)
      active.add(entry.id)
      started.push(entry.id)
      await release.promise
      active.delete(entry.id)
    }
  })

  await waitFor(() => active.size === 4)
  grant = { cpuUnits: 1, memoryGiB: 1 }
  for (const id of started.slice(0, 3)) releases.get(id).resolve()
  await waitFor(() => active.size === 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(started.includes('five'), false)
  releases.get(started[3]).resolve()
  await waitFor(() => started.includes('five'))
  releases.get('five').resolve()
  await execution
})

test('manifest memory costs prevent CPU-only over-admission and child quotas stay within the parent grant', async () => {
  const release = deferred()
  const active = new Set()
  const childEnvironments = []
  const execution = runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'memory-bound',
    commands: ['one', 'two', 'three'].map((id) => ({
      id,
      access: 'read',
      command: [id],
      memoryCostGiB: 0.5
    }))
  }, {
    resolveWorkers: () => 4,
    env: { FSUSBLOG_STEP_CPU_BUDGET: '4', FSUSBLOG_STEP_MEMORY_GIB: '0.5' },
    execute: async (entry, options) => {
      active.add(entry.id)
      childEnvironments.push(options.env)
      await release.promise
      active.delete(entry.id)
    }
  })

  await waitFor(() => active.size === 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(active.size, 1)
  assert.equal(Number(childEnvironments[0].FSUSBLOG_STEP_MEMORY_GIB), 0.5)
  release.resolve()
  const evidence = await execution
  assert.equal(evidence.children.length, 3)
  assert.ok(evidence.blocked.some((entry) => entry.capacity?.memory === true))
})

test('manifest cancellation stops active work and persists partial evidence', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-manifest-cancel-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const evidenceFile = path.join(tempRoot, 'cancel.json')
  const controller = new AbortController()
  const started = []
  const active = deferred()
  const execution = runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'cancel',
    commands: ['active', 'pending'].map((id) => ({ id, access: 'read', command: [id] }))
  }, {
    resolveWorkers: () => 1,
    env: { FSUSBLOG_STEP_CPU_BUDGET: '1', FSUSBLOG_STEP_MEMORY_GIB: '1' },
    signal: controller.signal,
    evidenceFile,
    execute: async (entry, options) => {
      started.push(entry.id)
      active.resolve()
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
  })
  await active.promise
  controller.abort(new Error('cancel fixture'))
  await assert.rejects(execution, (error) => {
    assert.equal(error.liveGrantEvidence.status, 'cancelled')
    return true
  })
  assert.deepEqual(started, ['active'])
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
  assert.equal(evidence.status, 'cancelled')
  assert.deepEqual(evidence.children.map((entry) => entry.id), ['active'])
  assert.ok(Number.isFinite(evidence.finishedAtMs))
})

test('manifest entry environment cannot override live resource safety boundaries', () => {
  const errors = validateCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'unsafe-env',
    commands: [{
      id: 'unsafe',
      access: 'read',
      command: ['unsafe'],
      environment: { FSUSBLOG_STEP_CPU_BUDGET: '999' }
    }]
  })
  assert.ok(errors.some((error) => error.includes('must not override resource safety boundaries')))
})

test('disjoint manifest writers run concurrently without a global write lock', async () => {
  const release = deferred()
  const active = new Set()
  const execution = runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'disjoint-writes',
    commands: [
      { id: 'alpha', access: 'write', command: ['alpha'], ownedOutputs: ['alpha.json'] },
      { id: 'beta', access: 'write', command: ['beta'], ownedOutputs: ['beta.json'] }
    ]
  }, {
    resolveWorkers: () => 2,
    env: { FSUSBLOG_STEP_CPU_BUDGET: '2', FSUSBLOG_STEP_MEMORY_GIB: '1' },
    execute: async (entry) => {
      active.add(entry.id)
      await release.promise
      active.delete(entry.id)
    }
  })

  await waitFor(() => active.size === 2)
  release.resolve()
  const evidence = await execution
  assert.deepEqual(evidence.children.map((entry) => entry.id).sort(), ['alpha', 'beta'])
})

test('manifest deadline cancels active work and retains partial timeout evidence', async () => {
  const started = deferred()
  const execution = runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'deadline',
    commands: [{ id: 'slow', access: 'read', command: ['slow'] }]
  }, {
    resolveWorkers: () => 1,
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '1',
      FSUSBLOG_STEP_MEMORY_GIB: '1',
      FSUSBLOG_EXECUTION_DEADLINE_AT_MS: String(Date.now() + 100)
    },
    execute: async (_entry, options) => {
      started.resolve()
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
  })

  await started.promise
  await assert.rejects(execution, (error) => {
    assert.equal(error.liveGrantEvidence.status, 'timed-out')
    assert.equal(error.liveGrantEvidence.children[0].status, 'timed-out')
    assert.match(error.message, /deadline exceeded/u)
    return true
  })
})

test('_legacy collect pool expands and shrinks pending admission from the same live grant contract', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-collect-live-grant-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const grantFile = path.join(tempRoot, 'grant.json')
  const markerFile = path.join(tempRoot, 'markers.txt')
  const releasePrefix = path.join(tempRoot, 'release')
  const evidenceFile = path.join(tempRoot, 'collect-evidence.json')
  const writeGrant = (cpuUnits, memoryGiB) => {
    const temporary = `${grantFile}.next`
    fs.writeFileSync(temporary, `${JSON.stringify({
      schema: 'fsusblog.test-matrix.resource-grants.v1',
      runId: 'collect-live-run',
      resourceBudget: { cpuUnits: 3, memoryGiB: 3 },
      grants: { collect: { cpuUnits, memoryGiB } }
    })}\n`)
    fs.renameSync(temporary, grantFile)
  }
  writeGrant(3, 3)
  const script = `
    set -euo pipefail
    source ${JSON.stringify(path.join(root, 'tools/test/lanes/_legacy.sh'))}
    pool_job() {
      local id="$1"
      printf '%s:start\\n' "$id" >> "$MARKER_FILE"
      while [[ ! -f "$RELEASE_PREFIX-$id" ]]; do sleep 0.02; done
      printf '%s:end\\n' "$id" >> "$MARKER_FILE"
    }
    job_a() { pool_job a; }
    job_b() { pool_job b; }
    job_c() { pool_job c; }
    job_d() { pool_job d; }
    RunCollectParallel collect-live a job_a b job_b c job_c d job_d
    FinishCollect
  `
  const child = spawn('bash', ['-c', script], {
    cwd: root,
    env: {
      ...process.env,
      FSUSBLOG_TEST_RUN_ID: 'collect-live-run',
      FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: grantFile,
      FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'collect',
      FSUSBLOG_COMMAND_MANIFEST_WORKERS: '3',
      FSUSBLOG_STEP_CPU_BUDGET: '3',
      FSUSBLOG_STEP_MEMORY_GIB: '3',
      FSUSBLOG_COLLECT_LIVE_GRANT_EVIDENCE_FILE: evidenceFile,
      MARKER_FILE: markerFile,
      RELEASE_PREFIX: releasePrefix
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  await waitFor(() => fs.existsSync(markerFile)
    && fs.readFileSync(markerFile, 'utf8').match(/:start/gu)?.length === 3)
  writeGrant(1, 1)
  for (const id of ['a', 'b']) fs.writeFileSync(`${releasePrefix}-${id}`, '')
  await waitFor(() => fs.readFileSync(markerFile, 'utf8').includes('b:end'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(fs.readFileSync(markerFile, 'utf8').includes('d:start'), false)
  fs.writeFileSync(`${releasePrefix}-c`, '')
  await waitFor(() => fs.readFileSync(markerFile, 'utf8').includes('d:start'))
  fs.writeFileSync(`${releasePrefix}-d`, '')
  const result = await exit
  assert.deepEqual(result, { code: 0, signal: null }, stderr)
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
  assert.equal(evidence.status, 'success')
  assert.deepEqual(evidence.grantHistory.map((entry) => entry.workerCap), [3, 1])
  assert.deepEqual(evidence.children.map((entry) => entry.status), ['success', 'success', 'success', 'success'])
  assert.ok(evidence.blocked.some((entry) => entry.activeWeight > entry.workerCap))
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
  ]) assert.match(staticLaneSource, new RegExp(`\\n\\s+${label} Static`, 'u'))
  assert.match(staticLaneSource, /RunCollect node-contracts StaticNodeContracts/u)
  assert.match(staticLaneSource, /orchestrationWorkersPerCpu: 3/u)
  assert.match(staticLaneSource, /delete manifestEnv\.FSUSBLOG_COMMAND_MANIFEST_WORKERS/u)
  assert.match(staticLaneSource, /env: manifestEnv/u)
  assert.match(staticLaneSource, /process\.memoryUsage\(\)\.rss \/ 1024 \*\* 3/u)
  assert.match(staticLaneSource, /orchestrationMemoryGiBPerWorker: measuredNodeOrchestratorGiB/u)
  assert.match(staticLaneSource, /concurrencyWeight: Number\.MAX_SAFE_INTEGER/u)
  assert.match(staticLaneSource, /node-contracts\)\s*RunStaticNodeContractsPhase/u)
  assert.match(staticLaneSource, /RunStaticPostVitestPhase\(\) \{\s*RunCollect retention StaticRetention\s*\}/u)
  assert.match(staticLaneSource, /concurrent\)\s*RunStaticConcurrentPhase/u)
  assert.match(staticLaneSource, /post-vitest\)\s*RunStaticPostVitestPhase/u)
  assert.match(staticLaneSource, /all\)\s*RunStaticConcurrentPhase\s*RunStaticPostVitestPhase/u)
  assert.match(staticLaneSource, /FinishCollect\s*$/u)
  assert.doesNotMatch(staticLaneSource, /max[-_]?errors?|fail-fast/u)
})

test('retention remains isolated from concurrent Vitest report writes', () => {
  const concurrentPhase = staticLaneSource.match(/RunStaticConcurrentPhase\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const postVitestPhase = staticLaneSource.match(/RunStaticPostVitestPhase\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? ''

  assert.doesNotMatch(concurrentPhase, /StaticRetention/u)
  assert.match(postVitestPhase, /RunCollect retention StaticRetention/u)
  assert.match(staticLaneSource, /Retention intentionally stays post-Vitest/u)
})
