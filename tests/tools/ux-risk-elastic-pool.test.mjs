import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { executeElasticUxGroupPool } from '../../tools/ux/ux-risk-elastic-pool.mjs'

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
