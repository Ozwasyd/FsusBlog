#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outputFile = path.join(
  process.env.FSUSBLOG_UX_OUTPUT_ROOT ?? path.join(root, '.tmp/ux'),
  'viewport-plan-progress.json')

export const viewportPlanProgressTestFiles = Object.freeze([
  'tests/tools/ux-viewport-plan.test.mjs',
  'tests/tools/ux-viewport-progress.test.mjs',
  'tests/tools/ux-viewport-risk-settle.test.mjs',
  'tests/tools/ux-viewport-runtime-contract.test.mjs'
])

function sourceStateFromEnvironment(env) {
  const commit = String(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '')
  const worktreeFingerprint = String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '')
  return /^[0-9a-f]{40}$/u.test(commit) && /^[0-9a-f]{64}$/u.test(worktreeFingerprint)
    ? { commit, worktreeFingerprint }
    : null
}

export function buildViewportPlanProgressSummary({
  env = process.env,
  generatedAt = new Date().toISOString()
} = {}) {
  const schedulerRunId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim() || null
  const sourceState = sourceStateFromEnvironment(env)
  return {
    schema: 'fsusblog.ux-viewport-plan-progress.v1',
    tierId: 'ux-viewport-plan-progress',
    status: 'success',
    executionSource: schedulerRunId && sourceState ? 'fresh' : 'standalone',
    schedulerRunId,
    sourceState,
    testFiles: [...viewportPlanProgressTestFiles],
    generatedAt
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function main() {
  fs.rmSync(outputFile, { force: true })
  const result = spawnSync(process.execPath, ['--test', ...viewportPlanProgressTestFiles], {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0 || result.signal) {
    throw new Error(`viewport plan/progress tests failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})`)
  }
  writeJsonAtomic(outputFile, buildViewportPlanProgressSummary())
  console.log(`[ux-viewport-plan-progress] ok tests=${viewportPlanProgressTestFiles.length} summary=${path.relative(root, outputFile)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[ux-viewport-plan-progress] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
