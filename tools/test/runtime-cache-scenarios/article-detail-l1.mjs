import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

function fixtureArticleId(identity) {
  const fixture = JSON.parse(fs.readFileSync(identity.fixtureFile, 'utf8'))
  const ids = (fixture.entities ?? [])
    .filter((entity) => entity.producerId === 'public-content' && entity.kind === 'article')
    .map((entity) => Number.parseInt(entity.id, 10))
    .filter((id) => Number.isInteger(id) && id > 0)
  const direct = Number.parseInt(fixture.articleId, 10)
  const articleId = ids[0] ?? direct
  if (!Number.isInteger(articleId) || articleId <= 0) {
    throw new Error('article-detail-l1 requires a current prepared public article fixture')
  }
  return articleId
}

function percentile(values, percentage) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)]
}

function qualifiedL1(requests) {
  return requests.filter((request) => request.status >= 200 && request.status < 300 &&
    (request.layerSource === 'l1-object' || request.layerSource === 'l1-frame') &&
    request.redisCommands.length === 0 && request.dbCommands.length === 0).length
}

function balancedBatchSizes(total, batchCount) {
  const quotient = Math.floor(total / batchCount)
  const remainder = total % batchCount
  return Array.from({ length: batchCount }, (_, index) => quotient + (index < remainder ? 1 : 0))
}

export async function produceArticleDetailL1Receipt(options) {
  const { scenario, identity } = options
  const articleId = fixtureArticleId(identity)
  const route = `/api/binary/article/${articleId}.aeds`
  const specs = (count, subcaseId) => Array.from({ length: count }, () => ({
    method: 'GET',
    path: route,
    subcaseId,
    parityGroup: 'article-detail-l1-payload',
    headers: { Cookie: 'runtime-cache-l1-evidence=1' }
  }))

  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect }) => {
      const warmup = specs(scenario.warmupRequests, 'l1-hit')
      const requests = []
      for (const [index, spec] of warmup.entries()) {
        requests.push(await collect(spec, index, 'warmup'))
      }
      return requests
    },
    sample: async ({ collect }) => {
      const perCohort = scenario.requests / 2
      const l1Specs = specs(perCohort, 'l1-hit')
      const faultSpecs = specs(scenario.requests - perCohort, 'redis-fault')
      const injectRedisPause = options.injectRedisPause ?? (() => execFileSync('docker', [
        'exec', '-i', identity.redisContainer, 'redis-cli', 'CLIENT', 'PAUSE', '500', 'ALL'
      ], { stdio: ['ignore', 'pipe', 'pipe'] }))
      const waitForRedisRecovery = options.waitForRedisRecovery ?? ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)))
      const cycleCount = Math.min(10, perCohort, faultSpecs.length)
      const l1BatchSizes = balancedBatchSizes(l1Specs.length, cycleCount)
      const faultBatchSizes = balancedBatchSizes(faultSpecs.length, cycleCount)
      const l1 = []
      const fault = []
      const faultTimeline = []
      let l1Offset = 0
      let faultOffset = 0
      const sampleClock = performance.now()

      const collectL1Batch = async (count) => {
        const offset = l1Offset
        const batch = l1Specs.slice(offset, offset + count)
        l1Offset += count
        l1.push(...await mapConcurrent(batch, scenario.concurrency,
          (spec, index) => collect(spec, offset + index)))
      }
      const collectFaultBatch = async (count) => {
        const offset = faultOffset
        const batch = faultSpecs.slice(offset, offset + count)
        faultOffset += count
        await injectRedisPause(500)
        const injectedAt = performance.now()
        const observed = await mapConcurrent(batch, scenario.concurrency,
          (spec, index) => collect(spec, perCohort + offset + index))
        fault.push(...observed)
        const firstFault = observed[0]
        faultTimeline.push(
          { atMs: injectedAt - sampleClock, kind: 'latency-500ms', state: 'injected', classification: 'fail-open', requestId: firstFault.id, subcaseId: 'redis-fault' },
          { atMs: injectedAt - sampleClock + firstFault.latencyMs, kind: 'latency-500ms', state: 'observed', classification: 'fail-open', requestId: firstFault.id, subcaseId: 'redis-fault' })
        const remainingPauseMs = Math.max(0, 500 - (performance.now() - injectedAt))
        await waitForRedisRecovery(remainingPauseMs)
        faultTimeline.push({
          atMs: performance.now() - sampleClock,
          kind: 'latency-500ms',
          state: 'cleared',
          classification: 'recovered',
          requestId: firstFault.id,
          subcaseId: 'redis-fault'
        })
      }

      for (let cycle = 0; cycle < cycleCount; cycle += 1) {
        if (cycle % 2 === 0) {
          await collectL1Batch(l1BatchSizes[cycle])
          await collectFaultBatch(faultBatchSizes[cycle])
        } else {
          await collectFaultBatch(faultBatchSizes[cycle])
          await collectL1Batch(l1BatchSizes[cycle])
        }
      }
      const requests = [...l1, ...fault]
      const baselineP95 = percentile(l1.map((request) => request.latencyMs), 95)
      const faultP95 = percentile(fault.map((request) => request.latencyMs), 95)
      const ratio = faultP95 / Math.max(baselineP95, 0.001)
      const firstFault = fault[0]
      return {
        requests,
        assertionResults: [
          exactAssertionResult(
            'l1-zero-commands',
            { qualifiedRequests: l1.length },
            { qualifiedRequests: qualifiedL1(l1) },
            l1.find((request) => qualifiedL1([request]) === 0) ?? l1[0]),
          exactAssertionResult(
            'redis-fault-latency',
            { withinRatio: true },
            { withinRatio: ratio <= scenario.requirements.redisFaultLatencyRatioMax },
            firstFault)
        ],
        faultTimeline,
        parameters: { route, redisPauseMs: 500, baselineP95, faultP95, faultLatencyRatio: ratio }
      }
    }
  })
}

export const articleDetailL1ScenarioInternals = Object.freeze({ balancedBatchSizes })
