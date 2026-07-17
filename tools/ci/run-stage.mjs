#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const allowedStages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary']

function usage() {
  console.error('Usage: node tools/ci/run-stage.mjs --stage <stage> [--job <job>] -- <command> [args...]')
}

function parseArgs(args) {
  const options = {
    stage: null,
    job: process.env.GITHUB_JOB || process.env.MATRIX_JOB || 'local'
  }
  let index = 0
  for (; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      index += 1
      break
    }
    if (arg === '--stage') options.stage = args[++index]
    else if (arg.startsWith('--stage=')) options.stage = arg.slice('--stage='.length)
    else if (arg === '--job') options.job = args[++index]
    else if (arg.startsWith('--job=')) options.job = arg.slice('--job='.length)
    else throw new Error(`unknown option: ${arg}`)
  }
  const command = args.slice(index)
  if (!allowedStages.includes(options.stage)) throw new Error(`stage must be one of ${allowedStages.join(', ')}`)
  if (command.length === 0) throw new Error('missing command after --')
  return { ...options, command }
}

function summaryPath(jobId) {
  return path.join(root, '.tmp/release-evidence/jobs', `${jobId}.json`)
}

function stageDurations(existing, stage, durationMs) {
  const durations = Object.fromEntries(allowedStages.map((name) => [name, Number(existing?.stageDurationsMs?.[name] ?? 0)]))
  durations[stage] += Math.max(0, durationMs)
  return durations
}

function evidenceClassification(jobId) {
  const diagnostic = jobId === 'browser-diagnostics'
  return {
    evidenceClass: diagnostic ? 'diagnostic' : 'correctness',
    affectsCorrectness: !diagnostic
  }
}

function writeSummary(jobId, stage, status, durationMs, rootCause = null) {
  const file = summaryPath(jobId)
  let existing = null
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      existing = null
    }
  }
  const summary = {
    schema: 'fsusblog.ci.job-result.v1',
    jobId,
    ciJob: existing?.ciJob ?? jobId,
    tierIds: existing?.tierIds?.length ? existing.tierIds : [jobId],
    status: status === 'success' && existing?.status ? existing.status : status,
    ...evidenceClassification(jobId),
    failureStage: status === 'success' ? (existing?.failureStage ?? null) : stage,
    rootCause: status === 'success' ? (existing?.rootCause ?? null) : rootCause,
    durationMs: Math.max(0, Number(existing?.durationMs ?? 0)) + Math.max(0, durationMs),
    stageDurationsMs: stageDurations(existing, stage, durationMs),
    artifacts: existing?.artifacts ?? [],
    localReproduction: existing?.localReproduction ?? `./tools/test.sh ci-job ${jobId}`,
    commit: process.env.GITHUB_SHA || existing?.commit || 'unknown',
    runId: process.env.GITHUB_RUN_ID ?? existing?.runId ?? 'local',
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? existing?.attempt ?? '0',
    generatedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
}

function main() {
  const { stage, job, command } = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()
  console.error(`[ci-stage:${job}] ${stage}: ${command.join(' ')}`)
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  })
  const durationMs = Date.now() - startedAt
  if (result.status !== 0) {
    writeSummary(job, stage, 'failure', durationMs, `${command.join(' ')} exited ${result.status ?? 1}`)
    process.exit(result.status ?? 1)
  }
  writeSummary(job, stage, 'success', durationMs)
}

try {
  main()
} catch (error) {
  usage()
  console.error(`[ci-stage] ${error.message}`)
  process.exit(2)
}
