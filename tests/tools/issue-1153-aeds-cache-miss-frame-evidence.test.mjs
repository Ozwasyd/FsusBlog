import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAedsCacheMissFrameEvidence } from '../../tools/operations/check-aeds-cache-miss-frame-evidence.mjs'

const scenarioNames = [
  'ArticleList10',
  'ArticleList50',
  'ArticleList100',
  'ArticleHot',
  'ArticleDetailBackfill',
  'CommentCursor',
  'UserComment',
  'TaxonomyCategory',
  'SystemSeo',
  'MessageConversation',
  'AdminStats'
]

function variant(name) {
  return {
    name,
    logicalBytes: 100,
    capacityBytes: name === 'owned' ? 128 : 100,
    backingOverheadBytes: name === 'owned' ? 28 : 0,
    applicationCopyBytes: name === 'current' ? 300 : 0,
    serializationPasses: name === 'exact' ? 2 : 1,
    measured: {
      p50Ms: 0.1,
      p95Ms: 0.2,
      allocationBytesPerRequest: 1000
    }
  }
}

function validSummary() {
  return {
    schema: 'fsusblog.aeds-cache-miss-frame-cost.v1',
    status: 'ok',
    measurementSource: 'local-real-pod-writer-profiler',
    method: { runtimeLohThresholdBytes: 84976 },
    structuralModel: { downstreamZeroCopyClaimed: false },
    recommendation: {
      cacheOwnedFrame: 'owned',
      publicSnapshotAndFileArtifact: 'exact',
      scenarioCount: scenarioNames.length
    },
    results: scenarioNames.map((scenario, index) => ({
      scenario,
      frameType: scenario,
      frameClass: index >= 5 && index <= 6 ? 'sensitive' : 'public-immutable',
      wireParity: true,
      missFrequency: {
        source: 'synthetic-one-rebuild-per-sample',
        productionFrequencyMetric: 'fsus.cache.owned_frame.build.count'
      },
      variants: ['current', 'exact', 'owned', 'tiered'].map(variant)
    }))
  }
}

test('accepts complete parity, latency, allocation, copy, capacity, and frequency evidence', () => {
  const summary = validSummary()
  assert.equal(validateAedsCacheMissFrameEvidence(summary), summary)
})

test('rejects a writable-lifetime-risk capacity mismatch', () => {
  const summary = validSummary()
  summary.results[0].variants[2].capacityBytes = 99
  assert.throws(() => validateAedsCacheMissFrameEvidence(summary), /capacity must cover logical bytes/u)
})

test('rejects wire drift and downstream zero-copy claims', () => {
  const wireDrift = validSummary()
  wireDrift.results[3].wireParity = false
  assert.throws(() => validateAedsCacheMissFrameEvidence(wireDrift), /wire parity failed/u)

  const falseClaim = validSummary()
  falseClaim.structuralModel.downstreamZeroCopyClaimed = true
  assert.throws(() => validateAedsCacheMissFrameEvidence(falseClaim), /must not claim downstream zero-copy/u)
})
