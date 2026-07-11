import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const checker = path.join(root, 'tools/perf/check-backend-benchmark-regression.mjs')

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
}

function runFixture({ currentMean = 80, currentAllocation = 40 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-backend-benchmark-'))
  const reports = path.join(temp, 'reports')
  const output = path.join(reports, 'regression.json')
  const releaseSummary = path.join(temp, 'release-summary.json')
  const budgets = path.join(temp, 'budgets.json')
  writeJson(path.join(reports, 'Benchmark-report.json'), {
    Benchmarks: [
      {
        Type: 'FixtureHotPathBenchmarks',
        Method: 'Before',
        Parameters: { Size: 10 },
        Statistics: { Mean: 100 },
        Memory: { BytesAllocatedPerOperation: 100 }
      },
      {
        Type: 'FixtureHotPathBenchmarks',
        Method: 'After',
        Parameters: { Size: 10 },
        Statistics: { Mean: currentMean },
        Memory: { BytesAllocatedPerOperation: currentAllocation }
      }
    ]
  })
  writeJson(budgets, {
    schema: 'fsusblog.backend-hotpath-budgets.v1',
    policy: { requireAllocationEvidence: true },
    budgets: [{
      id: 'fixture',
      benchmark: 'FixtureHotPathBenchmarks',
      method: 'After',
      baselineMethod: 'Before',
      maxMeanRatio: 1,
      maxAllocatedRatio: 0.5
    }]
  })
  const result = spawnSync(process.execPath, [
    checker,
    '--reports', reports,
    '--budgets', budgets,
    '--output', output,
    '--release-summary', releaseSummary
  ], { encoding: 'utf8' })
  return { result, output: JSON.parse(fs.readFileSync(output, 'utf8')), releaseSummary: JSON.parse(fs.readFileSync(releaseSummary, 'utf8')) }
}

test('emits measured before-after evidence when every budget passes', () => {
  const fixture = runFixture()
  assert.equal(fixture.result.status, 0, fixture.result.stderr)
  assert.equal(fixture.output.status, 'ok')
  assert.equal(fixture.output.measurementCount, 2)
  assert.equal(fixture.output.results[0].comparisons[0].checks[0].actual, 0.8)
  assert.equal(fixture.output.results[0].comparisons[0].checks[1].actual, 0.4)
  assert.equal(fixture.releaseSummary.status, 'ok')
})

test('fails the lane and names the measured regression instead of writing a synthetic ok', () => {
  const fixture = runFixture({ currentMean: 125, currentAllocation: 80 })
  assert.equal(fixture.result.status, 1)
  assert.equal(fixture.output.status, 'failed')
  assert.match(fixture.output.results[0].failures.join('\n'), /mean ratio 1\.2500 > 1/u)
  assert.match(fixture.output.results[0].failures.join('\n'), /allocation ratio 0\.8000 > 0\.5/u)
  assert.deepEqual(fixture.releaseSummary.failedBudgetIds, ['fixture'])
})
