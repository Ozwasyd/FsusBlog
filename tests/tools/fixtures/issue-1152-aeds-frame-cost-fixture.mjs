import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const fixtureCommitSha = 'a'.repeat(40)

const scenarios = [
  ['EmptySuccess', 'EmptySuccess', 'static-preencoded', 0, 0],
  ['ApiError', 'ApiError', 'tiny-dynamic', 768, 1],
  ['ArticleList10', 'ArticleList', 'representative-dynamic', 3_840, 10],
  ['ArticleList50', 'ArticleList', 'representative-dynamic', 19_200, 50],
  ['ArticleList100', 'ArticleList', 'representative-dynamic', 38_400, 100],
  ['ArticleDetailSmall', 'ArticleDetail', 'supplemental-dynamic', 12_288, 1],
  ['ArticleDetailMedium', 'ArticleDetail', 'supplemental-dynamic', 81_920, 1],
  ['ArticleDetailLarge', 'ArticleDetail', 'representative-dynamic', 327_680, 1],
  ['CommentCursor', 'CommentArticleCursor', 'representative-dynamic', 10_240, 40],
  ['ConversationDetail', 'ConversationDetail', 'representative-dynamic', 32_768, 64],
  ['UploadStatus', 'UploadStatus', 'supplemental-dynamic', 2_048, 1],
  ['PublicAotBootstrap', 'PublicAotBootstrap', 'representative-dynamic', 98_304, 1]
]

const round6 = (value) => Math.round(value * 1_000_000) / 1_000_000

function derived(samples) {
  const ordered = [...samples].sort((left, right) => left - right)
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length
  const variance = samples.reduce((total, value) => total + ((value - mean) ** 2), 0) / samples.length
  const standardDeviation = Math.sqrt(variance)
  const percentile = (quantile) => round6(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)])
  return {
    meanMs: round6(mean),
    p50Ms: percentile(0.50),
    p95Ms: percentile(0.95),
    standardDeviationMs: round6(standardDeviation),
    coefficientOfVariation: mean > 0 ? round6(standardDeviation / mean) : 0
  }
}

function measurement(samples, allocationBytesPerRequest, { outlierRound = null } = {}) {
  const rounds = [1, 2, 3, 4, 5].map((round) => {
    const samplesMs = round === outlierRound ? meanRegressionSamples() : [...samples]
    return {
      round,
      ...derived(samplesMs),
      sampleCount: samplesMs.length,
      samplesMs,
      allocatedBytesTotal: allocationBytesPerRequest * samplesMs.length,
      allocationBytesPerRequest
    }
  })
  const pooled = derived(rounds.flatMap((item) => item.samplesMs))
  const median = (values) => [...values].sort((left, right) => left - right)[values.length >> 1]
  return {
    evidence: {
      meanMs: median(rounds.map((item) => item.meanMs)),
      arithmeticMeanMs: pooled.meanMs,
      meanAggregation: 'median-of-round-means',
      p50Ms: pooled.p50Ms,
      p95Ms: median(rounds.map((item) => item.p95Ms)),
      pooledP95Ms: pooled.p95Ms,
      p95Aggregation: 'median-of-round-p95',
      standardDeviationMs: pooled.standardDeviationMs,
      allocationBytesPerRequest: median(rounds.map((item) => item.allocationBytesPerRequest)),
      sampleCount: rounds.length * samples.length,
      rounds,
      allocationRangeBytes: {
        min: Math.min(...rounds.map((item) => item.allocationBytesPerRequest)),
        max: Math.max(...rounds.map((item) => item.allocationBytesPerRequest))
      }
    },
    p95RangeMs: round6(Math.max(...rounds.map((item) => item.p95Ms)) - Math.min(...rounds.map((item) => item.p95Ms))),
    coefficientOfVariation: pooled.coefficientOfVariation
  }
}

function uniform(value) {
  return Array(30).fill(value)
}

function p95RegressionSamples() {
  return [...Array(28).fill(0.6), 2, 2]
}

function meanRegressionSamples() {
  return [...Array(29).fill(0.6), 30]
}

function roundingBoundarySamples() {
  return [...Array(15).fill(0.0385), ...Array(15).fill(0.038545)]
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

export function createAedsFrameCostArtifactSet(root) {
  const definitions = [
    ['benchmark', 'benchmarks/core/bin/Release/net10.0/FsusBlog.Core.Benchmarks.dll', 'fixture benchmark dll'],
    ['core', 'benchmarks/core/bin/Release/net10.0/FsusBlog.Core.dll', 'fixture core dll']
  ]
  const artifacts = definitions.map(([id, relativePath, content]) => {
    const bytes = Buffer.from(content)
    const file = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    return { id, path: relativePath, bytes: bytes.length, sha256: sha256(bytes) }
  })
  const canonical = [...artifacts]
    .sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0))
    .map(({ id, path: artifactPath, bytes, sha256: digest }) => ({ id, path: artifactPath, bytes, sha256: digest }))
  return {
    schema: 'fsusblog.aeds-frame-cost-artifact-set.v1',
    digest: sha256(Buffer.from(JSON.stringify(canonical))),
    artifacts
  }
}

export function buildAedsFrameCostRawFixture({
  artifactSet,
  missingIdentity = null,
  p95RegressionScenario = null,
  allocationRegressionScenario = null,
  meanRegressionScenario = null,
  roundingBoundaryScenario = null,
  singleOutlierScenario = null
} = {}) {
  if (!artifactSet) throw new Error('fixture artifactSet is required')
  const structuralResults = scenarios.map(([scenario, frameType, pathGroup, rawPayloadBytes, itemCount]) => ({
    scenario,
    frameType,
    pathGroup,
    itemCount,
    rawPayloadBytes,
    copyCountBefore: rawPayloadBytes === 0 ? 0 : 1,
    copyCountAfter: 0,
    copyBytesBefore: rawPayloadBytes,
    copyBytesAfter: 0,
    derivation: rawPayloadBytes === 0
      ? 'static/pre-encoded frame has no dynamic payload copy'
      : 'fixture models the old payload copy and the reserved-header in-place seal',
    counterKind: 'implementation-derived-payload-length',
    hardwareCounter: false
  }))
  const measuredResults = scenarios.map(([scenario, frameType, pathGroup, rawPayloadBytes, itemCount]) => {
    const tiny = pathGroup === 'tiny-dynamic'
    const staticReference = pathGroup === 'static-preencoded'
    const before = measurement(
      scenario === roundingBoundaryScenario ? roundingBoundarySamples() : uniform(staticReference ? 0.001 : (tiny ? 0.006 : 0.8)),
      staticReference ? 0 : (tiny ? 100 : 1_000)
    )
    let afterSamples = uniform(staticReference ? 0.001 : (tiny ? 0.009 : 0.6))
    if (scenario === p95RegressionScenario) afterSamples = p95RegressionSamples()
    if (scenario === meanRegressionScenario) afterSamples = meanRegressionSamples()
    const after = measurement(
      afterSamples,
      staticReference ? 0 : (tiny ? 150 : (scenario === allocationRegressionScenario ? 1_200 : 800)),
      { outlierRound: scenario === singleOutlierScenario ? 3 : null }
    )
    const crc = measurement(uniform(0.1), 0)
    return {
      scenario,
      frameType,
      pathGroup,
      itemCount,
      rawPayloadBytes,
      rawFrameBytes: rawPayloadBytes + 16,
      before: before.evidence,
      after: after.evidence,
      crc: crc.evidence,
      variability: {
        beforeP95RangeMs: before.p95RangeMs,
        afterP95RangeMs: after.p95RangeMs,
        beforeCoefficientOfVariation: before.coefficientOfVariation,
        afterCoefficientOfVariation: after.coefficientOfVariation
      }
    }
  })
  const environment = {
    machineName: 'issue-1152-fixture-host',
    cpu: 'fixture-cpu',
    os: 'fixture-os',
    osArchitecture: 'X64',
    processArchitecture: 'X64',
    processorCount: 8,
    runtime: '.NET fixture',
    runtimeVersion: '10.0.0',
    gc: { server: true, latencyMode: 'Interactive' },
    affinity: '0-7'
  }
  if (missingIdentity) environment[missingIdentity] = null
  return {
    schema: 'fsusblog.aeds-frame-cost.raw.v2',
    status: 'raw',
    conclusionsFinalized: false,
    generatedAt: '2026-07-18T00:00:00.000Z',
    measurementSource: 'local-aeds-frame-cost-profiler',
    source: {
      commitSha: fixtureCommitSha,
      buildConfiguration: 'Release',
      artifactSet: structuredClone(artifactSet)
    },
    implementation: {
      dynamicWriter: 'AedsFrameBufferWriter',
      oldPath: 'payload-buffer-then-AedsEncoder.WriteFrame',
      newPath: 'reserved-header-single-pooled-frame-buffer'
    },
    structuralEvidence: {
      evidenceKind: 'executable-implementation-derivation',
      copyBytesCounterKind: 'payload-length-derived-not-hardware-counter',
      results: structuralResults
    },
    measuredEvidence: {
      evidenceKind: 'same-process-release-artifact-multi-round',
      authority: { authoritative: true, blockedReasons: [] },
      environment,
      method: {
        warmupIterations: 8,
        iterationsPerRound: 30,
        roundCount: 5,
        sampleCountPerVariant: 150,
        ordering: 'alternating-before-after-by-round',
        authoritativeMeanAggregation: 'median-of-round-means',
        authoritativeP95Aggregation: 'median-of-round-p95'
      },
      results: measuredResults
    }
  }
}
