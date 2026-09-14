import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

const evidenceSecretHeader = 'X-Fsus-Runtime-Evidence-Secret'
const classificationFamily = 'public-hot-read-classification'
const revocationLookupFamily = 'public-artifact-revocation-lookup'
const maximumLookupMilliseconds = 5
const maximumLargeToSmallRatio = 8
const lookupJitterMilliseconds = 2

function fixtureArticleId(identity) {
  const fixture = JSON.parse(fs.readFileSync(identity.fixtureFile, 'utf8'))
  const articleId = (fixture.entities ?? [])
    .filter((entity) => entity.producerId === 'public-content' && entity.kind === 'article')
    .map((entity) => Number.parseInt(entity.id, 10))
    .find((id) => Number.isInteger(id) && id > 0)
  if (!articleId) throw new Error('revocation requires a current prepared public article fixture')
  return articleId
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`revocation control timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function prepareRevocationSize({
  fetchImpl = globalThis.fetch,
  baseUrl,
  secret,
  count,
  timeoutMs = 120000
}) {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/_fsus/testing/runtime-cache/revocation/prepare/${count}`,
    { method: 'POST', headers: { [evidenceSecretHeader]: secret } },
    timeoutMs)
  if (response.status !== 200) {
    throw new Error(`revocation authority returned HTTP ${response.status} for size ${count}`)
  }
  const payload = await response.json()
  const result = {
    requestedCount: payload.requestedCount ?? payload.RequestedCount,
    registrySeededCount: payload.registrySeededCount ?? payload.RegistrySeededCount,
    redisHashLengthBefore: payload.redisHashLengthBefore ?? payload.RedisHashLengthBefore,
    redisHashLengthAfter: payload.redisHashLengthAfter ?? payload.RedisHashLengthAfter,
    redisHashLengthDelta: payload.redisHashLengthDelta ?? payload.RedisHashLengthDelta,
    maximumGeneration: payload.maximumGeneration ?? payload.MaximumGeneration
  }
  for (const [field, value] of Object.entries(result)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`revocation authority ${field} is invalid for size ${count}`)
  }
  if (result.requestedCount !== count || result.registrySeededCount !== count || result.redisHashLengthDelta !== count) {
    throw new Error(`revocation authority did not converge at size ${count}`)
  }
  return result
}

function requestSpec(articleId, runId, index, size) {
  return {
    method: 'GET',
    path: `/api/binary/article/${articleId}.aeds?runtime-cache-evidence=${encodeURIComponent(`${runId}-revocation-${size}-${index + 1}`)}`,
    subcaseId: `size-${size}`,
    parityGroup: `revocation-unrelated-article-${articleId}`,
    headers: {}
  }
}

export function inspectRevocationRequest(request) {
  const classifications = request.cacheEvents.filter((event) => event.family === classificationFamily)
  const lookups = request.cacheEvents.filter((event) => event.family === revocationLookupFamily)
  if (classifications.length !== 1 || classifications[0].outcome !== 'hit') {
    throw new Error(`request ${request.id} did not execute exactly one public hot classification`)
  }
  if (lookups.length !== 1 || !['hit', 'negative'].includes(lookups[0].outcome)) {
    throw new Error(`request ${request.id} did not execute exactly one revocation lookup`)
  }
  if (classifications[0].identityDigest !== lookups[0].identityDigest) {
    throw new Error(`request ${request.id} classification and revocation identities differ`)
  }
  const lookupMilliseconds = lookups[0].elapsedMilliseconds - classifications[0].elapsedMilliseconds
  if (!Number.isFinite(lookupMilliseconds) || lookupMilliseconds < 0) {
    throw new Error(`request ${request.id} revocation lookup timing is invalid`)
  }
  return { classificationCount: classifications.length, lookupMilliseconds }
}

function percentile(values, percentage) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)]
}

function evaluateLookupGrowth(evaluationsBySize) {
  const p95BySize = Object.fromEntries([...evaluationsBySize].map(([size, evaluations]) => [
    size,
    percentile(evaluations.map((item) => item.lookupMilliseconds), 95)
  ]))
  const smallMaximum = Math.max(...Object.entries(p95BySize)
    .filter(([size]) => Number(size) <= 100)
    .map(([, value]) => value))
  const largeMaximum = Math.max(...Object.entries(p95BySize)
    .filter(([size]) => Number(size) >= 1000)
    .map(([, value]) => value))
  const allMaximum = Math.max(...Object.values(p95BySize))
  return {
    constant: allMaximum <= maximumLookupMilliseconds &&
      largeMaximum <= smallMaximum * maximumLargeToSmallRatio + lookupJitterMilliseconds,
    p95BySize,
    smallMaximum,
    largeMaximum,
    allMaximum
  }
}

export async function runRevocationSample({ scenario, collect, prepare, runId, articleId }) {
  const sizes = scenario.requirements.sizes
  if (scenario.requests !== sizes.length * 3 ||
      scenario.subcases.some((subcaseId, index) => subcaseId !== `size-${sizes[index]}`)) {
    throw new Error('revocation scenario requires three requests for each exact catalog size')
  }

  const requests = []
  const authorityBySize = {}
  const evaluationsBySize = new Map()
  const invalid = []
  let ordinal = 0
  try {
    for (const size of sizes) {
      authorityBySize[size] = await prepare(size)
      const specs = Array.from({ length: 3 }, (_, index) => requestSpec(articleId, runId, index, size))
      const batch = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, ordinal + index))
      ordinal += batch.length
      requests.push(...batch)
      const evaluations = []
      for (const request of batch) {
        try {
          evaluations.push(inspectRevocationRequest(request))
        } catch (error) {
          invalid.push({ request, error: error.message })
        }
      }
      evaluationsBySize.set(size, evaluations)
    }
  } finally {
    await prepare(0)
  }

  const completeEvaluation = invalid.length === 0 && [...evaluationsBySize.values()].every((items) => items.length === 3)
  const growth = completeEvaluation
    ? evaluateLookupGrowth(evaluationsBySize)
    : { constant: false, p95BySize: {}, smallMaximum: 0, largeMaximum: 0, allMaximum: 0 }
  const classificationCount = completeEvaluation && [...evaluationsBySize.values()]
    .flat()
    .every((item) => item.classificationCount === 1)
    ? 1
    : 0
  const authoritativeSizes = sizes.filter((size) => {
    const authority = authorityBySize[size]
    return authority?.requestedCount === size && authority.registrySeededCount === size && authority.redisHashLengthDelta === size
  })
  return {
    requests,
    assertionResults: [
      exactAssertionResult(
        'lookup-growth-constant',
        { constant: true, authoritativeSizes: sizes },
        { constant: growth.constant, authoritativeSizes },
        invalid[0]?.request ?? requests[0]),
      exactAssertionResult(
        'classification-count',
        scenario.requirements.classificationCount,
        classificationCount,
        invalid[0]?.request ?? requests[0])
    ],
    parameters: {
      articleId,
      sizes,
      authorityBySize,
      lookupP95MillisecondsBySize: growth.p95BySize,
      lookupBounds: {
        maximumMilliseconds: maximumLookupMilliseconds,
        maximumLargeToSmallRatio,
        jitterMilliseconds: lookupJitterMilliseconds
      }
    }
  }
}

export async function produceRevocationReceipt(options) {
  const { scenario, identity, baseUrl, secret } = options
  const articleId = fixtureArticleId(identity)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const prepare = options.prepareRevocation ?? ((count) => prepareRevocationSize({
    fetchImpl,
    baseUrl,
    secret,
    count,
    timeoutMs: options.revocationControlTimeoutMs
  }))
  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect, runId }) => {
      const specs = Array.from({ length: scenario.warmupRequests }, (_, index) =>
        requestSpec(articleId, runId, index, 1))
      return mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
    },
    sample: ({ collect, runId }) => runRevocationSample({ scenario, collect, prepare, runId, articleId })
  })
}
