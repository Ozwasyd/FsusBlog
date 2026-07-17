import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  executeElasticUxGroupPool,
  executePersistentUxWorkerPool
} from '../../tools/ux/ux-risk-elastic-pool.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for elastic UX pool')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('UX route-theme pool expands 1 to 2 to 4 without restarting completed or active groups', async () => {
  const groups = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
  const gates = new Map(groups.map((group) => [group.id, deferred()]))
  const starts = []
  let capacity = 1
  const execution = executeElasticUxGroupPool(groups, {
    capacityProvider: () => capacity,
    pollMs: 10,
    execute: async (group, workerIndex) => {
      starts.push({ id: group.id, workerIndex })
      await gates.get(group.id).promise
    }
  })

  await waitFor(() => starts.length === 1)
  assert.deepEqual(starts.map((entry) => entry.id), ['a'])
  capacity = 2
  await waitFor(() => starts.length === 2)
  assert.deepEqual(starts.map((entry) => entry.id), ['a', 'b'])
  capacity = 4
  await waitFor(() => starts.length === 4)
  assert.deepEqual(starts.map((entry) => entry.id), ['a', 'b', 'c', 'd'])

  gates.get('a').resolve()
  await waitFor(() => starts.length === 5)
  assert.deepEqual(starts.map((entry) => entry.id), ['a', 'b', 'c', 'd', 'e'])
  for (const id of ['b', 'c', 'd', 'e']) gates.get(id).resolve()
  const result = await execution
  assert.equal(result.maximumWorkers, 4)
  assert.deepEqual(result.completedGroupIds.sort(), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(new Set(starts.map((entry) => entry.id)).size, groups.length)
})

test('UX execution group filtering leaves the complete risk plan and progress evidence intact', () => {
  const source = fs.readFileSync(
    path.join(root, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts'),
    'utf8'
  )
  const plan = source.indexOf('const plan = buildUxViewportPlan')
  const progress = source.indexOf('openUxViewportProgress({')
  const executionFilter = source.indexOf('const testGroups = executionGroupIds.size > 0')
  assert.ok(plan >= 0 && plan < progress && progress < executionFilter)
  assert.match(source, /plannedTestGroups\.filter\(\(group\) => executionGroupIds\.has\(group\.id\)\)/u)
  assert.match(source, /recordUxViewportGroupResult\(\{[\s\S]*?groupId: group\.id/u)
})

test('persistent UX workers reuse one browser while capacity grows and shrinks between groups', async () => {
  const groups = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
  const gates = new Map(groups.map((group) => [group.id, deferred()]))
  const created = []
  const destroyed = []
  const executions = []
  let capacity = 1
  const execution = executePersistentUxWorkerPool(groups, {
    capacityProvider: () => capacity,
    pollMs: 10,
    createWorker: async (workerIndex) => {
      const worker = { workerIndex, browserId: `browser-${workerIndex}` }
      created.push(worker)
      return worker
    },
    destroyWorker: async (worker, reason) => destroyed.push({ ...worker, reason }),
    execute: async (group, worker) => {
      executions.push({ groupId: group.id, browserId: worker.browserId })
      await gates.get(group.id).promise
    }
  })

  await waitFor(() => executions.length === 1)
  gates.get('a').resolve()
  await waitFor(() => executions.length === 2)
  capacity = 3
  await waitFor(() => executions.length === 4)
  capacity = 1
  gates.get('b').resolve()
  gates.get('c').resolve()
  gates.get('d').resolve()
  await waitFor(() => executions.length === 5)
  gates.get('e').resolve()

  const result = await execution
  assert.equal(result.maximumWorkers, 3)
  assert.equal(result.browserLaunchCount, created.length)
  assert.ok(created.length < groups.length, 'at least one browser must execute multiple groups')
  assert.equal(new Set(executions.map((entry) => entry.groupId)).size, groups.length)
  assert.equal(destroyed.length, created.length)
  assert.ok(destroyed.some((entry) => entry.reason === 'capacity-shrink'))
})

test('persistent UX pool retries only a browser crash and never repeats a successful group', async () => {
  const executions = []
  const result = await executePersistentUxWorkerPool([{ id: 'a' }, { id: 'b' }], {
    capacityProvider: () => 1,
    pollMs: 10,
    createWorker: async (workerIndex) => ({ workerIndex }),
    destroyWorker: async () => {},
    classifyError: (error) => ({ retryable: error.code === 'BROWSER_CRASH' }),
    execute: async (group, worker, attempt) => {
      executions.push({ groupId: group.id, workerIndex: worker.workerIndex, attempt: attempt.attempt })
      if (group.id === 'a' && attempt.attempt === 1) {
        const error = new Error('browser disconnected')
        error.code = 'BROWSER_CRASH'
        throw error
      }
    }
  })

  assert.equal(result.retryCount, 1)
  assert.deepEqual(result.completedGroupIds.sort(), ['a', 'b'])
  assert.equal(executions.filter((entry) => entry.groupId === 'a').length, 2)
  assert.equal(executions.filter((entry) => entry.groupId === 'b').length, 1)
  assert.equal(new Set(result.completedGroupIds).size, 2)
})

test('persistent UX pool cancellation destroys active workers and stops dispatch', async () => {
  const controller = new AbortController()
  let created = 0
  let destroyed = 0
  const running = executePersistentUxWorkerPool([{ id: 'a' }, { id: 'b' }], {
    capacityProvider: () => 1,
    pollMs: 10,
    signal: controller.signal,
    createWorker: async () => {
      created += 1
      return { close: deferred() }
    },
    destroyWorker: async (worker) => {
      destroyed += 1
      worker.close.resolve()
    },
    execute: async (_group, worker) => await worker.close.promise
  })
  await waitFor(() => created === 1)
  controller.abort('test cancellation')
  await assert.rejects(running, /cancelled/u)
  assert.equal(destroyed, 1)
})

test('production UX risk defaults to public-API persistent browsers with isolated group evidence and CLI fallback', () => {
  const runner = fs.readFileSync(path.join(root, 'tools/ux/run-local-production-risk.mjs'), 'utf8')
  const spec = fs.readFileSync(
    path.join(root, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts'),
    'utf8'
  )
  assert.match(runner, /resolveExecutionMode\(process\.env\.FSUSBLOG_UX_RISK_EXECUTION_MODE\)/u)
  assert.match(runner, /executionMode === 'cli'[\s\S]*runDirectCliPool\(\)[\s\S]*runPersistentBrowserPool\(\)/u)
  assert.match(runner, /executePersistentUxWorkerPool\(pendingGroups/u)
  assert.match(runner, /playwright\.chromium\.launch\(/u)
  assert.match(runner, /server\.ssrLoadModule/u)
  assert.match(runner, /buildUxRiskSessionPlan\(maximumWorkerCapacity/u)
  assert.match(runner, /FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE = sessionPlan\.bootstrapFixtureFile/u)
  assert.match(runner, /availableSessions = \[\.\.\.sessionPlan\.sessionIds\]/u)
  assert.doesNotMatch(runner, /playwright\/lib\/|_connection|_channel|_initializer/u)
  assert.match(runner, /worker-\$\{worker\.workerIndex\}[\s\S]*groupSlug[\s\S]*attempt-\$\{attempt\.attempt\}/u)
  assert.match(runner, /schema: 'fsusblog\.local-production\.ux-risk\.v2'/u)
  assert.match(runner, /browserLaunchCount: pool\.browserLaunchCount/u)
  assert.match(runner, /wallClockMs: Date\.now\(\) - uxStartedAtMs/u)
  assert.match(runner, /peakProcessTreeRssBytes/u)

  const directPool = runner.slice(
    runner.indexOf('async function runDirectCliPool()'),
    runner.indexOf('function baseRiskEnvironment()')
  )
  assert.match(directPool, /const sessionPlan = buildUxRiskSessionPlan\(maximumWorkerCapacity/u)
  assert.match(directPool, /await preparePlaywrightSessions\(maximumWorkerCapacity\)/u)
  assert.match(directPool, /FSUSBLOG_TEST_SESSION: sessionId/u)
  assert.match(directPool, /FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE: fixtureFile/u)
  assert.match(directPool, /FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP: '1'/u)
  assert.match(directPool, /parseUxRiskCliTimingLine\(line\)/u)
  assert.match(directPool, /schema: 'fsusblog\.ux-risk\.cli-group\.v1'/u)
  assert.match(directPool, /directAttempts\.set\(group\.id/u)
  assert.match(directPool, /without an exact-once group evidence receipt/u)
  assert.doesNotMatch(directPool, /FSUSBLOG_TEST_SESSION: 'pw-0'/u)

  assert.match(spec, /export async function runPersistentUxViewportGroup/u)
  assert.match(spec, /runUxRouteThemeGroup\(browser, group, timing, options\.outputDir, options\.sessionId\)/u)
  assert.match(spec, /openThemedAuditedContext\(browser, group\.theme, storageState, riskMatrix, testSession\)/u)
  assert.match(spec, /await timing\.measure\('context\.close'/u)
  assert.match(spec, /context cleanup left pages behind/u)
  assert.match(spec, /sessionNamespace: `\$\{options\.sessionId\}:context:\$\{group\.id\}:attempt-\$\{options\.attempt\}`/u)
  assert.match(spec, /logicalTestId: logicalTestId\(group\)/u)
  assert.match(spec, /caseTestIds: group\.viewports\.flatMap/u)
})
