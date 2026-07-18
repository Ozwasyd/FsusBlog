import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validatePodBinaryCodecBatchEvidence } from '../../tools/operations/check-pod-binary-codec-batch-evidence.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const itemCounts = [0, 1, 10, 50, 100]
const tagCounts = [0, 2, 8]
const textLengths = ['short', 'medium', 'long']
const textEncodings = ['ascii', 'cjk', 'mixed']
const auditCodecs = [
  'CommentCursor',
  'UserCommentCursor',
  'CommentReplyCursor',
  'CommentThreadCursor',
  'ConversationDetail',
  'ConversationList',
  'SiteStats',
  'CategoryList',
  'TagWithCountList'
]

function measured(allocationBytesPerRequest, p95Ms = 0.1) {
  return {
    meanMs: p95Ms * 0.8,
    arithmeticMeanMs: p95Ms * 0.8,
    meanAggregation: 'median-of-round-means',
    p50Ms: p95Ms * 0.7,
    p95Ms,
    pooledP95Ms: p95Ms,
    p95Aggregation: 'median-of-round-p95',
    standardDeviationMs: 0.01,
    allocationBytesPerRequest,
    sampleCount: 6,
    rounds: [1, 2, 3].map((round) => ({
      round,
      meanMs: p95Ms * 0.8,
      p50Ms: p95Ms * 0.7,
      p95Ms,
      standardDeviationMs: 0.01,
      sampleCount: 2,
      samplesMs: [p95Ms * 0.7, p95Ms],
      allocatedBytesTotal: allocationBytesPerRequest * 2,
      allocationBytesPerRequest
    })),
    allocationRangeBytes: {
      min: allocationBytesPerRequest,
      max: allocationBytesPerRequest
    }
  }
}

function variant(name, allocation, p95, copyBytes) {
  return {
    name,
    storage: name,
    managedTemporaryCollectionCount: name.includes('list') ? 3 : 0,
    pooledBufferCount: name.includes('pool') ? 2 : 0,
    capacityWasteBytes: 0,
    blobCapacity: 0,
    tagRecordCapacity: 0,
    itemRecordCapacity: 0,
    copyBytes,
    measured: measured(allocation, p95),
    allocatedBytesPerFrame: allocation,
    allocatedBytesPerItem: allocation
  }
}

function frequency() {
  return {
    source: 'synthetic-one-rebuild-per-sample',
    productionFrequencyMetric: 'fsus.cache.owned_frame.build.count',
    cacheHitPathMeasured: false
  }
}

function pageResult(itemCount, tagsPerItem, textEncoding, textLength) {
  const blobBytes = itemCount * (tagsPerItem + 3) * 20
  return {
    scenario: `article-list-${itemCount}-tags-${tagsPerItem}-${textEncoding}-${textLength}`,
    itemCount,
    tagsPerItem,
    tagRecordCount: itemCount * tagsPerItem,
    textLength,
    textEncoding,
    outputBytes: 100 + blobBytes,
    blobBytes,
    wireParity: true,
    encodeFrequency: frequency(),
    variants: [
      variant('legacy-list', 1000, 0.1, blobBytes),
      variant('exact-capacity-list', 900, 0.09, blobBytes),
      variant('two-pass-direct', 800, 0.09, 0),
      variant('array-pool-records', 700, 0.09, 0),
      variant('adaptive-stack-pool', 700, 0.09, 0)
    ]
  }
}

function detailResult(scenario, contentBytes, tagCount) {
  const directAllocation = contentBytes >= 8 * 1024 ? 700 : 1100
  const adaptive = variant(
    'adaptive-detail',
    directAllocation,
    0.09,
    contentBytes >= 8 * 1024 ? 0 : contentBytes
  )
  adaptive.managedTemporaryCollectionCount = contentBytes >= 8 * 1024 ? 0 : 2
  return {
    scenario,
    itemCount: 1,
    tagCount,
    contentBytes,
    outputBytes: contentBytes + 300,
    wireParity: true,
    encodeFrequency: frequency(),
    variants: [
      variant('legacy-list', 1000, 0.1, contentBytes),
      adaptive
    ]
  }
}

function validSummary() {
  const articlePageResults = []
  for (const itemCount of itemCounts) {
    for (const tagsPerItem of tagCounts) {
      for (const textLength of textLengths) {
        for (const textEncoding of textEncodings) {
          articlePageResults.push(pageResult(itemCount, tagsPerItem, textEncoding, textLength))
        }
      }
    }
  }
  const representativeCount = articlePageResults.filter((result) => result.itemCount >= 50).length
  const smallCount = articlePageResults.filter((result) => result.itemCount <= 1).length
  const articleDetailResults = [
    detailResult('detail-short', 10, 0),
    detailResult('detail-medium-cjk', 27_000, 8),
    detailResult('detail-large-ascii', 128 * 1024, 32)
  ]
  return {
    schema: 'fsusblog.pod-binary-codec-batch.v1',
    status: 'ok',
    measurementSource: 'local-real-codec-profiler',
    method: {
      warmupIterations: 1,
      iterationsPerRound: 2,
      roundCount: 3,
      ordering: 'rotating-candidate-order',
      allocationCounter: 'GC.GetAllocatedBytesForCurrentThread',
      scenarioCount: 135
    },
    recommendation: {
      articlePage: {
        selected: 'adaptive-stack-pool',
        pageAllocationPolicyMet: true,
        pageSmallLatencyPolicyMet: true,
        representativeAllocationWins: representativeCount,
        representativeCount,
        smallP95WithinPolicy: smallCount,
        smallCount
      },
      articleDetail: {
        selected: 'adaptive-detail',
        detailAllocationPolicyMet: true,
        detailLatencyPolicyMet: true,
        detailAllocationWins: 2,
        detailRepresentativeCount: 2,
        detailP95WithinPolicy: 3,
        scenarioCount: 3
      }
    },
    runtimeClaim: {
      affectedPath: 'cache miss and background rebuild encoding',
      cacheHitQpsClaimed: false,
      productionFrequencyMetric: 'fsus.cache.owned_frame.build.count'
    },
    articlePageResults,
    articleDetailResults,
    auditResults: auditCodecs.map((codec, index) => ({
      codec,
      scenario: `${codec}-${index}`,
      itemCount: 10,
      outputBytes: 100,
      allocatedBytesPerFrame: 1000,
      allocatedBytesPerItem: 100,
      managedTemporaryCollectionCount: 1,
      capacityPolicy: 'fixture',
      copyBytes: 0,
      measured: measured(1000),
      encodeFrequency: frequency(),
      decision: 'keep-current-baseline-only',
      decisionReason: 'fixture baseline only'
    }))
  }
}

test('accepts the full 135-scenario matrix, differential candidates, audit scope, and rebuild-only claim', () => {
  const summary = validSummary()
  assert.equal(validatePodBinaryCodecBatchEvidence(summary), summary)
})

test('rejects missing matrix cells and wire drift', () => {
  const missing = validSummary()
  missing.articlePageResults.pop()
  assert.throws(() => validatePodBinaryCodecBatchEvidence(missing), /scenario matrix is incomplete/u)

  const drift = validSummary()
  drift.articlePageResults[10].wireParity = false
  assert.throws(() => validatePodBinaryCodecBatchEvidence(drift), /wire parity failed/u)
})

test('recomputes allocation and small-page latency policy instead of trusting recommendation fields', () => {
  const allocation = validSummary()
  const representative = allocation.articlePageResults.find((result) => result.itemCount === 100)
  representative.variants.find((item) => item.name === 'adaptive-stack-pool').allocatedBytesPerFrame = 900
  representative.variants.find((item) => item.name === 'adaptive-stack-pool').measured.allocationBytesPerRequest = 900
  assert.throws(() => validatePodBinaryCodecBatchEvidence(allocation), /allocation win count is not evidence-derived/u)

  const latency = validSummary()
  latency.recommendation.articlePage.smallP95WithinPolicy -= 1
  assert.throws(() => validatePodBinaryCodecBatchEvidence(latency), /small p95 count is not evidence-derived/u)
})

test('rejects intermediate-copy regression and cache-hit QPS claims', () => {
  const copy = validSummary()
  copy.articlePageResults[0].variants.find((item) => item.name === 'adaptive-stack-pool').copyBytes = 1
  assert.throws(() => validatePodBinaryCodecBatchEvidence(copy), /must remove the intermediate blob copy/u)

  const falseClaim = validSummary()
  falseClaim.runtimeClaim.cacheHitQpsClaimed = true
  assert.throws(() => validatePodBinaryCodecBatchEvidence(falseClaim), /must not claim cache-hit QPS/u)
})

test('checker CLI validates a serialized evidence file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-issue-1154-'))
  const file = path.join(directory, 'summary.json')
  fs.writeFileSync(file, `${JSON.stringify(validSummary())}\n`)
  const result = spawnSync(process.execPath, [
    'tools/operations/check-pod-binary-codec-batch-evidence.mjs',
    file
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /pod-binary-codec-batch-evidence/u)
})
