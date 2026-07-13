import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runner = path.join(root, 'tools/ux/run-local-production-risk.mjs')

function resourcePlan(env) {
  const cleanEnv = { ...process.env }
  for (const name of [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET',
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB',
    'FSUSBLOG_UX_VIEWPORT_WORKERS',
    'FSUSBLOG_PLAYWRIGHT_WORKERS'
  ]) delete cleanEnv[name]
  const result = spawnSync(process.execPath, [runner, '--print-resource-plan'], {
    cwd: root,
    env: { ...cleanEnv, ...env },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('runtime UX workers use browser memory capacity when it exceeds the I/O-heavy CPU grant', () => {
  const plan = resourcePlan({
    FSUSBLOG_STEP_CPU_BUDGET: '2',
    FSUSBLOG_STEP_MEMORY_GIB: '2.6',
    FSUSBLOG_PLAYWRIGHT_WORKERS: '5'
  })
  const hostCpus = os.availableParallelism?.() ?? os.cpus().length
  const expectedMemoryWorkers = Math.max(1, Math.ceil(
    plan.schedulerMemoryGrantGiB / (os.totalmem() / 1024 ** 3 / hostCpus)
  ))
  assert.equal(plan.schedulerManaged, true)
  assert.equal(plan.schedulerCpuGrant, 2)
  assert.equal(plan.memoryWorkerCapacity, expectedMemoryWorkers)
  assert.equal(plan.workers, Math.min(3, Math.max(2, expectedMemoryWorkers)))
})

test('runtime UX explicit worker request remains an exact upper bound', () => {
  const plan = resourcePlan({
    FSUSBLOG_STEP_CPU_BUDGET: '3',
    FSUSBLOG_STEP_MEMORY_GIB: '2',
    FSUSBLOG_PLAYWRIGHT_WORKERS: '1'
  })
  assert.equal(plan.schedulerManaged, true)
  assert.equal(plan.workers, 1)
})
