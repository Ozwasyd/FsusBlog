import assert from 'node:assert/strict'
import test from 'node:test'

import { loadMatrix, planTier } from '../../tools/docs/lib/matrix.mjs'

test('production DAG reaches every non-manual production-required tier', () => {
  const matrix = loadMatrix()
  const productionTierIds = new Set(planTier(matrix, 'production').map((tier) => tier.id))
  const missingTierIds = matrix.tiers
    .filter((tier) => (
      tier.requiredFor === 'production'
      && tier.manualOnly !== true
      && tier.nightlyOnly !== true
      && tier.localOnly !== true
    ))
    .map((tier) => tier.id)
    .filter((tierId) => !productionTierIds.has(tierId))
    .sort()

  assert.deepEqual(missingTierIds, [])
})
