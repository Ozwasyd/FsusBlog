import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAfterNavigationSettles, isNavigationContextReset } from '../frontend/checks/perf/route-render-pressure-readiness.mjs'
import { buildDirectDbSeedCacheActions } from '../frontend/fixtures/direct-db-seed-cache-plan.mjs'

test('route pressure evaluates exactly once after navigation readiness', async () => {
  let evaluateCalls = 0
  const page = {
    async evaluate() {
      evaluateCalls += 1
      return { nodeCount: 42 }
    }
  }

  const result = await evaluateAfterNavigationSettles(page, () => null, {})
  assert.deepEqual(result, { nodeCount: 42 })
  assert.equal(evaluateCalls, 1)
  assert.equal(isNavigationContextReset(new Error('ordinary assertion failure')), false)
})

test('route pressure preserves failures and rejects retry configuration', async () => {
  const nonNavigationPage = {
    async evaluate() {
      throw new Error('browser metric contract failed')
    }
  }
  await assert.rejects(
    evaluateAfterNavigationSettles(nonNavigationPage, () => null, null),
    /browser metric contract failed/u
  )

  let attempts = 0
  const navigatingPage = {
    async evaluate() {
      attempts += 1
      throw new Error('Execution context was destroyed, most likely because of a navigation')
    },
    async waitForLoadState() {},
    async waitForTimeout() {}
  }
  await assert.rejects(
    evaluateAfterNavigationSettles(navigatingPage, () => null, null),
    /Execution context was destroyed/u
  )
  assert.equal(attempts, 1)
  await assert.rejects(
    evaluateAfterNavigationSettles(navigatingPage, () => null, null, { maxAttempts: 2 }),
    /permits exactly one attempt/u
  )
  assert.equal(attempts, 1)
})

test('direct DB fixture cache plan invalidates every article before rebuilding AOT', () => {
  assert.deepEqual(buildDirectDbSeedCacheActions({
    articleId: '3',
    articleIds: ['3', '2', '3', 1]
  }), [
    { action: 'output-cache-clear', articleId: 3 },
    { action: 'output-cache-clear', articleId: 2 },
    { action: 'output-cache-clear', articleId: 1 },
    { action: 'public-hot-rebuild', articleId: null }
  ])
  assert.throws(() => buildDirectDbSeedCacheActions({ articleIds: [] }), /at least one article id/u)
})
