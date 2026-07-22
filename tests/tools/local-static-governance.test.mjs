import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
    readManifestSchedulerResourceGrant,
    resolveAdaptiveManifestWorkers,
    resolveManifestAdmissionSnapshot,
    resolveManifestLiveCapacity,
    runWeightedCommandManifest,
    validateCommandManifest
} from '../../tools/test/run-command-manifest.mjs'
import { loadCommandGroup } from '../../tools/test-matrix/command-groups.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const staticManifest = loadCommandGroup(root, 'frontend-static-governance')
const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))

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
    const expanded = manifest.commands.filter((entry) => entry.id.startsWith('views-constraints:'));
    const declared = staticManifest.commands.find((entry) => entry.id === 'views-constraints').localCommands;

    assert.deepEqual(expanded[0].command, ['node', '../../tests/frontend/checks/static/check-views-constraints.mjs']);
    assert.deepEqual(expanded, declared);
    for (const script of chainedScripts)
{
        assert.equal(
            manifest.commands.filter((entry) => entry.script === script).length,
            1,
            `${script} must have exactly one explicit manifest owner`
        );
    }
    assert.deepEqual(
        manifest.commands.filter((entry) => !entry.id.startsWith('views-constraints:')).map((entry) => entry.id),
        staticManifest.commands.filter((entry) => entry.id !== 'views-constraints').map((entry) => entry.id)
  )
  const writes = expanded.filter((entry) => entry.access === 'write').map((entry) => entry.script)
  assert.deepEqual(writes, [
        'check:dom-depth-static',
        'check:route-asset-budget'
    ]);

    const missingOwner = structuredClone(staticManifest);
    missingOwner.commands = missingOwner.commands.filter((entry) => entry.id !== 'radius-scale-contract');
    assert.throws(
        () => buildLocalStaticManifest(missingOwner, frontendPackage.scripts),
        /check:views-constraints script check:radius-scale-contract must have exactly one explicit manifest owner/u
    );

    const duplicateOwner = structuredClone(staticManifest);
    const layoutOwner = duplicateOwner.commands.find((entry) => entry.id === 'layout-archetype-governance');
    duplicateOwner.commands.find((entry) => entry.id === 'views-constraints').localCommands.push({
        ...layoutOwner,
        id: 'views-constraints:layout-archetype-governance'
    });
    assert.throws(
        () => buildLocalStaticManifest(duplicateOwner, frontendPackage.scripts),
        /check:views-constraints script check:layout-archetype-governance must have exactly one explicit manifest owner/u
    );

    for (const entry of manifest.commands)
{
        assert.ok(entry.reason);
        assert.ok(entry.stage);
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

test('local static manifest produces a complete unique stage partition', () => {
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const plan = planLocalStaticCommands(manifest)
  const summary = summarizeLocalStaticPlan(plan)
  const plannedIds = Object.values(plan).flat().map((entry) => entry.id)

  assert.equal(new Set(plannedIds).size, manifest.commands.length)
  assert.deepEqual(new Set(plannedIds), new Set(manifest.commands.map((entry) => entry.id)))
  assert.equal(summary.total, manifest.commands.length)
  for (const entry of manifest.commands) {
    assert.ok(Object.hasOwn(plan, entry.stage), `unknown stage for ${entry.id}: ${entry.stage}`)
    for (const dependency of entry.dependsOn) {
      assert.ok(plannedIds.includes(dependency), `${entry.id} depends on missing ${dependency}`)
    }
  }
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
    assert.equal(capacity.parentMemoryGiB, 4);
});

test('collect admission binds worker cap and child quotas to one atomic grant snapshot', () =>
{
    let reads = 0;
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'collect-atomic-run',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/collect-atomic-grants.json',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'collect',
        FSUSBLOG_COMMAND_MANIFEST_WORKERS: '4'
    };
    const snapshot = resolveManifestAdmissionSnapshot({
        env,
        maxWorkers: 4,
        cpuCount: 8,
        freeMemoryBytes: 8 * 1024 ** 3,
        totalMemoryBytes: 8 * 1024 ** 3,
        load1: 0,
        workload: 'scheduler-admitted',
        readGrantFile: () =>
{
            reads += 1;
            const cpuUnits = reads === 1 ? 4 : 1;
            return JSON.stringify({
                schema: 'fsusblog.test-matrix.resource-grants.v1',
                runId: 'collect-atomic-run',
                resourceBudget: { cpuUnits: 4, memoryGiB: 8 },
                grants: { collect: { cpuUnits, memoryGiB: cpuUnits * 2 } }
            });
        }
    });

    assert.equal(reads, 1);
    assert.equal(snapshot.workerCap, 4);
    assert.equal(snapshot.capacity.parentCpuUnits, 4);
    assert.equal(snapshot.capacity.parentMemoryGiB, 8);
    assert.equal(snapshot.childEnvironment.FSUSBLOG_STEP_CPU_BUDGET, '1');
    assert.equal(snapshot.childEnvironment.FSUSBLOG_STEP_MEMORY_GIB, '2');
    assert.equal(snapshot.childEnvironment.FSUSBLOG_PARALLEL_ACTIVE_WORKERS, '4');
    assert.equal(snapshot.childEnvironment.FSUSBLOG_COMMAND_MANIFEST_WORKERS, '1');
});

test('direct manifest execution records its fixed fallback mode honestly', async () =>
{
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

test('lane collect support expands and shrinks pending admission from the same live grant contract', async (t) => {
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
    source ${JSON.stringify(path.join(root, 'tools/test/lanes/_lane-collect-support.sh'))}
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
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    assert.equal(evidence.status, 'success');
    assert.deepEqual(evidence.grantHistory.map((entry) => entry.workerCap), [3, 1]);
    assert.deepEqual(evidence.grantHistory.map((entry) => entry.parentCpuUnits), [3, 1]);
    assert.deepEqual(evidence.grantHistory.map((entry) => entry.parentMemoryGiB), [3, 1]);
    assert.deepEqual(evidence.grantHistory.map((entry) => entry.source), [
        'scheduler-resource-grants',
        'scheduler-resource-grants'
    ]);
    assert.deepEqual(evidence.children.map((entry) => entry.status), ['success', 'success', 'success', 'success']);
    assert.ok(evidence.blocked.some((entry) => entry.activeWeight > entry.workerCap));
});
