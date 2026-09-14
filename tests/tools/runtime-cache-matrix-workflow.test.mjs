import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/runtime-cache-evidence-catalog.json'), 'utf8'))
const matrixSource = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')
const matrix = parseMatrix(matrixSource)
const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
const bundleSteps = fs.readFileSync(path.join(root, 'tools/test/bundles/bundle-steps.mjs'), 'utf8')
const scenarioIds = catalog.scenarios.map((scenario) => scenario.id)
const tierIds = scenarioIds.map((scenarioId) => `runtime-cache-${scenarioId}`)

function jobSource(jobId) {
  const start = workflow.indexOf(`\n    ${jobId}:`)
  assert.notEqual(start, -1, `missing workflow job ${jobId}`)
  const remainder = workflow.slice(start + 1)
  const next = remainder.match(/\n    [a-z0-9-]+:\n/u)
  return workflow.slice(start, next?.index === undefined ? workflow.length : start + 1 + next.index)
}

test('matrix exposes exactly 13 runtime-cache producers and one strict aggregate', () => {
  const producers = matrix.tiers.filter((tier) => tier.id.startsWith('runtime-cache-') && tier.id !== 'runtime-cache-evidence')
  assert.deepEqual(producers.map((tier) => tier.id), tierIds)

  for (const scenarioId of scenarioIds) {
    const tier = matrix.tiers.find((candidate) => candidate.id === `runtime-cache-${scenarioId}`)
    assert.ok(tier, scenarioId)
    assert.equal(tier.command, `node tools/test/run-runtime-cache-evidence.mjs --scenario ${scenarioId}`)
    assert.equal(tier.ciJob, 'backend-qps-collectors')
    assert.equal(tier.smartGateMode, 'conditional')
    assert.equal(tier.prDefault, true)
    assert.deepEqual(tier.artifacts, [`.tmp/perf/runtime-cache/${scenarioId}.json`])
    assert.deepEqual(tier.evidence, [`.tmp/perf/runtime-cache/${scenarioId}.json`])
  }

  const aggregate = matrix.tiers.find((tier) => tier.id === 'runtime-cache-evidence')
  assert.ok(aggregate)
  assert.equal(aggregate.command, 'node tools/test/check-runtime-cache-evidence.mjs')
  assert.equal(aggregate.ciJob, 'backend-qps')
  assert.equal(aggregate.smartGateMode, 'conditional')
  assert.equal(aggregate.prDefault, true)
  assert.deepEqual(new Set(aggregate.executionDependsOn), new Set(['bootstrap', ...tierIds]))
  assert.deepEqual(aggregate.artifacts, ['.tmp/release-evidence/runtime-cache-summary.json'])
  assert.deepEqual(aggregate.evidence, ['.tmp/release-evidence/runtime-cache-summary.json'])

  assert.doesNotMatch(matrixSource, /backend-qps-runtime-sequential|\.tmp\/perf\/backend-qps|backend-qps-runtime-sequential-summary/u)
})

test('quality gate publishes every producer receipt and runs aggregate after failed or missing shards', () => {
  const producers = jobSource('backend-qps-collectors')
  assert.match(producers, /name: Runtime Cache Producer/u)
  assert.match(producers, /if-no-files-found: error/u)
  assert.match(producers, /path: \.tmp\/perf\/runtime-cache\/\*\.json/u)
  assert.doesNotMatch(producers, /\.tmp\/perf\/backend-qps/u)

  const aggregate = jobSource('backend-qps')
  assert.match(aggregate, /name: Runtime Cache Strict Aggregate/u)
  assert.match(aggregate, /if: always\(\) &&/u)
  assert.match(aggregate, /pattern: backend-qps-collectors-\*/u)
  assert.match(aggregate, /if: always\(\)[\s\S]*ci-tier runtime-cache-evidence --no-deps/u)
  assert.match(aggregate, /if-no-files-found: error/u)
  assert.match(aggregate, /path: \.tmp\/release-evidence\/runtime-cache-summary\.json/u)
  assert.doesNotMatch(aggregate, /backend-qps-runtime-sequential-summary|\.tmp\/perf\/backend-qps/u)
})

test('performance bundle consumes only the runtime-cache producer and aggregate tiers', () => {
  for (const tierId of [...tierIds, 'runtime-cache-evidence']) {
    assert.match(bundleSteps, new RegExp(`'${tierId}'`, 'u'))
  }
  assert.doesNotMatch(bundleSteps, /backend-qps-view-count-flush|backend-qps-runtime-sequential|'backend-qps'/u)
})
