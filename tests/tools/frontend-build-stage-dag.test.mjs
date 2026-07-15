import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  runFrontendBuildStageDag,
  validateFrontendBuildStages
} from '../../tools/frontend/build-stage-dag.mjs'
import { createFrontendBuildStages } from '../../tools/frontend/build.mjs'

function resources(overrides = {}) {
  return {
    cpuWeight: 1,
    memoryWeight: 1,
    minCpuUnits: 1,
    minMemoryGiB: 0.25,
    exclusiveResources: [],
    ...overrides
  }
}

function stage(id, overrides = {}) {
  return {
    id,
    command: ['internal', id],
    dependsOn: [],
    consumedInputs: [],
    ownedOutputs: [],
    resources: resources(),
    estimatedDurationMs: 1,
    ...overrides
  }
}

function grantDocument(runId, cpuUnits, memoryGiB = cpuUnits) {
  return JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId,
    resourceBudget: { cpuUnits: Math.max(8, cpuUnits), memoryGiB: Math.max(8, memoryGiB) },
    grants: { frontend: { cpuUnits, memoryGiB } }
  })
}

function schedulerEnv(runId) {
  return {
    ...process.env,
    FSUSBLOG_TEST_RUN_ID: runId,
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/virtual/frontend-grant.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'frontend'
  }
}

function deferred() {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fsusblog-frontend-dag-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('frontend build stage validation rejects unknown dependencies and cycles', () => {
  assert.throws(
    () => validateFrontendBuildStages([stage('a', { dependsOn: ['missing'] })]),
    /unknown stage/u
  )
  assert.throws(
    () => validateFrontendBuildStages([
      stage('a', { dependsOn: ['b'] }),
      stage('b', { dependsOn: ['a'] })
    ]),
    /contains a cycle/u
  )
})

test('release build declares independent prebuild stages and explicit postbuild joins', () => {
  const stages = validateFrontendBuildStages(createFrontendBuildStages([], 'generate'))
  const byId = new Map(stages.map((entry) => [entry.id, entry]))

  assert.deepEqual(byId.get('generate-public-page-manifest').dependsOn, [])
  assert.deepEqual(byId.get('generate-public-shell-emergency').dependsOn, [])
  assert.deepEqual(byId.get('ensure-wasm').dependsOn, [])
  assert.deepEqual(byId.get('vite-public-ssr-build').dependsOn, ['vue-tsc', 'vite-build'])
  assert.deepEqual(byId.get('sync-backend-wwwroot').dependsOn, [
    'sync-stable-spa-entry',
    'sync-fsusui-markdown-runtime-assets'
  ])
  assert.match(
    byId.get('sync-fsusui-markdown-runtime-assets').consumedInputs[0],
    /(?:FsusUI\/vue\/packages\/wasm\/dist|node_modules\/@ozwasyd\/element-plus\/es\/wasm\/dist)$/u
  )
})

test('live grant growth admits additional ready frontend stages without restarting the DAG', async (t) => {
  const cwd = await temporaryDirectory(t)
  const runId = 'frontend-growth'
  let liveGrant = grantDocument(runId, 2, 2)
  const started = []
  const gates = new Map(['a', 'b', 'c', 'd'].map((id) => [id, deferred()]))
  const running = runFrontendBuildStageDag([...gates.keys()].map((id) => stage(id)), {
    cwd,
    env: schedulerEnv(runId),
    receiptFile: path.join(cwd, 'receipt.json'),
    readGrantFile: () => liveGrant,
    execute: async (entry, { env }) => {
      started.push({ id: entry.id, cpu: Number(env.FSUSBLOG_STEP_CPU_BUDGET) })
      await gates.get(entry.id).promise
    }
  })

  await waitFor(() => started.length === 2, 'initial two-CPU grant did not admit two stages')
  liveGrant = grantDocument(runId, 4, 4)
  await waitFor(() => started.length === 4, 'grown grant did not admit remaining stages')
  for (const gate of gates.values()) gate.resolve()
  const receipt = await running

  assert.equal(receipt.status, 'success')
  assert.deepEqual(receipt.grantHistory.map((entry) => entry.cpuUnits), [2, 4])
  assert.ok(started.every((entry) => entry.cpu >= 1))
})

test('live grant shrink pauses new frontend admission until active usage fits', async (t) => {
  const cwd = await temporaryDirectory(t)
  const runId = 'frontend-shrink'
  let liveGrant = grantDocument(runId, 4, 4)
  const started = []
  const gates = new Map(['a', 'b', 'c', 'd', 'e'].map((id) => [id, deferred()]))
  const running = runFrontendBuildStageDag([...gates.keys()].map((id) => stage(id)), {
    cwd,
    env: schedulerEnv(runId),
    receiptFile: path.join(cwd, 'receipt.json'),
    readGrantFile: () => liveGrant,
    execute: async (entry) => {
      started.push(entry.id)
      await gates.get(entry.id).promise
    }
  })

  await waitFor(() => started.length === 4, 'initial four-CPU grant did not admit four stages')
  liveGrant = grantDocument(runId, 1, 1)
  for (const id of started.slice(0, 3)) gates.get(id).resolve()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(started.length, 4, 'new work started while active usage exceeded the shrunken grant')
  gates.get(started[3]).resolve()
  await waitFor(() => started.length === 5, 'pending stage did not resume after capacity became free')
  gates.get('e').resolve()
  const receipt = await running

  assert.deepEqual(receipt.grantHistory.map((entry) => entry.cpuUnits), [4, 1])
  assert.ok(receipt.blocked.some((entry) => entry.id === 'e'))
})

test('stage children receive only their exact admitted CPU and memory share', async (t) => {
  const cwd = await temporaryDirectory(t)
  const seen = []
  const receipt = await runFrontendBuildStageDag([
    stage('left', { resources: resources({ cpuWeight: 2, memoryWeight: 3 }) }),
    stage('right', { resources: resources({ cpuWeight: 1, memoryWeight: 1 }) })
  ], {
    cwd,
    env: {
      ...process.env,
      FSUSBLOG_STEP_CPU_BUDGET: '3',
      FSUSBLOG_STEP_MEMORY_GIB: '4'
    },
    receiptFile: path.join(cwd, 'receipt.json'),
    execute: async (entry, { env }) => seen.push({
      id: entry.id,
      cpu: Number(env.FSUSBLOG_STEP_CPU_BUDGET),
      memory: Number(env.FSUSBLOG_STEP_MEMORY_GIB),
      workers: Number(env.FSUSBLOG_NODE_TEST_CONCURRENCY),
      uv: Number(env.UV_THREADPOOL_SIZE)
    })
  })

  assert.equal(seen.reduce((sum, entry) => sum + entry.cpu, 0), 3)
  assert.ok(seen.reduce((sum, entry) => sum + entry.memory, 0) <= 4)
  for (const entry of seen) {
    assert.equal(entry.workers, Math.max(1, Math.floor(entry.cpu)))
    assert.equal(entry.uv, entry.workers)
    const recorded = receipt.stages.find((stage) => stage.id === entry.id)
    assert.equal(entry.cpu, recorded.grant.cpuUnits)
    assert.equal(entry.memory, recorded.grant.memoryGiB)
  }
})

test('successful receipt records deterministic output digests and direct fallback', async (t) => {
  const cwd = await temporaryDirectory(t)
  const receiptFile = path.join(cwd, 'receipt.json')
  const receipt = await runFrontendBuildStageDag([
    stage('write-output', { ownedOutputs: ['dist/result.txt'] })
  ], {
    cwd,
    env: {
      ...process.env,
      FSUSBLOG_STEP_CPU_BUDGET: '1',
      FSUSBLOG_STEP_MEMORY_GIB: '1'
    },
    receiptFile,
    execute: async () => {
      await fs.mkdir(path.join(cwd, 'dist'), { recursive: true })
      await fs.writeFile(path.join(cwd, 'dist/result.txt'), 'frontend-stage-output\n')
    }
  })

  assert.equal(receipt.executionMode, 'direct-fallback')
  assert.equal(receipt.grantSource, 'direct-invocation-fallback')
  assert.match(receipt.stages[0].outputs['dist/result.txt'].sha256, /^sha256:[a-f0-9]{64}$/u)
  assert.deepEqual(JSON.parse(await fs.readFile(receiptFile, 'utf8')), receipt)
})

test('failure preserves the original error, writes a partial receipt, and cleans partial outputs', async (t) => {
  const cwd = await temporaryDirectory(t)
  const receiptFile = path.join(cwd, 'receipt.json')
  const output = path.join(cwd, 'dist/partial.txt')
  let cleanupCalled = false

  await assert.rejects(runFrontendBuildStageDag([
    stage('failing-stage', { ownedOutputs: ['dist/partial.txt'] })
  ], {
    cwd,
    env: { ...process.env, FSUSBLOG_STEP_CPU_BUDGET: '1', FSUSBLOG_STEP_MEMORY_GIB: '1' },
    receiptFile,
    execute: async () => {
      await fs.mkdir(path.dirname(output), { recursive: true })
      await fs.writeFile(output, 'partial')
      throw new Error('intentional stage failure')
    },
    cleanupPartialOutputs: async () => {
      cleanupCalled = true
      await fs.rm(path.join(cwd, 'dist'), { recursive: true, force: true })
      return { status: 'success' }
    }
  }), /intentional stage failure/u)

  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
  assert.equal(cleanupCalled, true)
  assert.equal(receipt.status, 'partial')
  assert.equal(receipt.stages[0].status, 'failure')
  assert.match(receipt.stages[0].outputs['dist/partial.txt'].sha256, /^sha256:/u)
  await assert.rejects(fs.stat(output), { code: 'ENOENT' })
})

test('wrong-run live grants fail closed before any frontend stage starts', async (t) => {
  const cwd = await temporaryDirectory(t)
  const receiptFile = path.join(cwd, 'receipt.json')
  let executions = 0
  await assert.rejects(runFrontendBuildStageDag([stage('never-started')], {
    cwd,
    env: schedulerEnv('expected-run'),
    receiptFile,
    readGrantFile: () => grantDocument('stale-run', 2, 2),
    execute: async () => { executions += 1 }
  }), /runId mismatch/u)

  assert.equal(executions, 0)
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
  assert.equal(receipt.status, 'partial')
  assert.equal(receipt.stages[0].status, 'blocked-or-not-admitted')
})

test('corrupt live grants fail closed and replace any stale successful receipt', async (t) => {
  const cwd = await temporaryDirectory(t)
  const receiptFile = path.join(cwd, 'receipt.json')
  await fs.writeFile(receiptFile, '{"status":"success","stale":true}\n')
  let executions = 0

  await assert.rejects(runFrontendBuildStageDag([stage('never-started')], {
    cwd,
    env: schedulerEnv('corrupt-run'),
    receiptFile,
    readGrantFile: () => '{not-json',
    execute: async () => { executions += 1 }
  }), /grant is unreadable/u)

  assert.equal(executions, 0)
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
  assert.equal(receipt.status, 'partial')
  assert.equal(receipt.stale, undefined)
})
