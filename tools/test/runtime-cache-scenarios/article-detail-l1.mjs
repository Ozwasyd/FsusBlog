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
    request.layerSource === 'l1-frame' && request.redisCommands.length === 0 && request.dbCommands.length === 0).length
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
      return mapConcurrent(warmup, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
    },
    sample: async ({ collect }) => {
      const l1Specs = specs(scenario.requests / 2, 'l1-hit')
      const l1 = await mapConcurrent(l1Specs, scenario.concurrency, (spec, index) => collect(spec, index))

      const injectRedisPause = options.injectRedisPause ?? (() => execFileSync('docker', [
        'exec', '-i', identity.redisContainer, 'redis-cli', 'CLIENT', 'PAUSE', '500', 'ALL'
      ], { stdio: ['ignore', 'pipe', 'pipe'] }))
      await injectRedisPause(500)
      const faultSpecs = specs(scenario.requests - l1.length, 'redis-fault')
      const fault = await mapConcurrent(faultSpecs, scenario.concurrency, (spec, index) => collect(spec, l1.length + index))
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
        faultTimeline: [
          { atMs: 0, kind: 'latency-500ms', state: 'injected', classification: 'fail-open', requestId: firstFault.id, subcaseId: 'redis-fault' },
          { atMs: firstFault.latencyMs, kind: 'latency-500ms', state: 'observed', classification: 'fail-open', requestId: firstFault.id, subcaseId: 'redis-fault' },
          { atMs: 500, kind: 'latency-500ms', state: 'cleared', classification: 'recovered', requestId: firstFault.id, subcaseId: 'redis-fault' }
        ],
        parameters: { route, redisPauseMs: 500, baselineP95, faultP95, faultLatencyRatio: ratio }
      }
    }
  })
}
