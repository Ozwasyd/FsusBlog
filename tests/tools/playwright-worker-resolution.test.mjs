import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolvePlaywrightWorkerCount } from '../../tools/test/resolve-playwright-workers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const gib = 1024 ** 3

test('complete scheduler grant remains capped by proportional browser memory', () => {
  const plan = resolvePlaywrightWorkerCount({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '2',
      FSUSBLOG_STEP_MEMORY_GIB: '2'
    },
    cpuCount: 8,
    availableMemoryBytes: 8 * gib,
    totalMemoryBytes: 16 * gib,
    load1: 7,
    busyCpus: 7
  })

  assert.equal(plan.schedulerManaged, true)
  assert.equal(plan.grantedCpus, 2)
  assert.equal(plan.grantedMemoryGiB, 2)
  assert.equal(plan.workers, 1)
  assert.equal(plan.measuredBusyCpus, null)
})

test('fractional second memory share rounds up without exceeding the CPU grant', () => {
  const twoWorkerPlan = resolvePlaywrightWorkerCount({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '2',
      FSUSBLOG_STEP_MEMORY_GIB: '2.6'
    },
    cpuCount: 8,
    availableMemoryBytes: 8 * gib,
    totalMemoryBytes: 16 * gib
  })
  const threeWorkerPlan = resolvePlaywrightWorkerCount({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '5',
      FSUSBLOG_STEP_MEMORY_GIB: '4.3'
    },
    cpuCount: 8,
    availableMemoryBytes: 8 * gib,
    totalMemoryBytes: 16 * gib
  })

  assert.equal(twoWorkerPlan.workers, 2)
  assert.equal(threeWorkerPlan.workers, 3)
})

test('direct invocation retains host free-memory and pressure protection', () => {
  const plan = resolvePlaywrightWorkerCount({
    env: {},
    cpuCount: 8,
    availableMemoryBytes: 2 * gib,
    totalMemoryBytes: 16 * gib,
    load1: 0,
    busyCpus: 0
  })

  assert.equal(plan.schedulerManaged, false)
  assert.equal(plan.workers, 1)
})

test('Playwright config applies proportional memory and preserves explicit worker caps', () => {
  const source = fs.readFileSync(path.join(root, 'src/frontend/playwright.config.ts'), 'utf8')
  assert.match(source, /schedulerCpuGrant !== undefined && schedulerMemoryGrantGiB !== undefined/u)
  assert.match(source, /const memoryCap = Math\.max\(1, Math\.ceil\(grantedMemoryBytes \/ machineMemoryPerCpuBytes\)\)/u)
  assert.match(source, /Math\.min\(Math\.floor\(configuredWorkers\), dynamicWorkerCap\)/u)
})
