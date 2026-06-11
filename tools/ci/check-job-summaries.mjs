#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const summariesDir = path.join(root, '.tmp/release-evidence/jobs')
const planFile = path.join(root, '.tmp/release-evidence/test-plan.json')
const allowedFailureStages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary']

function fail(errors) {
  for (const error of errors) console.error(`[job-summary-check] ${error}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listSummaryFiles() {
  if (!fs.existsSync(summariesDir)) return []
  return fs.readdirSync(summariesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(summariesDir, name))
    .sort()
}

function validateSummary(summary, file) {
  const errors = []
  if (summary.schema !== 'fsusblog.ci.job-result.v1') errors.push(`${file}: schema must be fsusblog.ci.job-result.v1`)
  for (const field of ['jobId', 'status', 'tierIds', 'localReproduction', 'commit', 'runId', 'attempt']) {
    if (summary[field] === undefined || summary[field] === null || summary[field] === '') errors.push(`${file}: ${field} is required`)
  }
  if (!['success', 'failure', 'cancelled', 'skipped'].includes(summary.status)) errors.push(`${file}: status is invalid`)
  if (!Array.isArray(summary.tierIds) || summary.tierIds.length === 0) errors.push(`${file}: tierIds must be non-empty`)
  if (!Array.isArray(summary.artifacts)) errors.push(`${file}: artifacts must be an array`)
  if (typeof summary.durationMs !== 'number') errors.push(`${file}: durationMs must be a number`)
  if (summary.status !== 'success' && !summary.failureStage) errors.push(`${file}: failureStage is required for non-success`)
  if (summary.failureStage && !allowedFailureStages.includes(summary.failureStage)) {
    errors.push(`${file}: failureStage must be one of ${allowedFailureStages.join(', ')}`)
  }
  if (summary.status !== 'success' && !summary.rootCause) errors.push(`${file}: rootCause is required for non-success`)
  if (!summary.stageDurationsMs || typeof summary.stageDurationsMs !== 'object' || Array.isArray(summary.stageDurationsMs)) {
    errors.push(`${file}: stageDurationsMs is required`)
  } else {
    for (const stage of allowedFailureStages) {
      if (typeof summary.stageDurationsMs[stage] !== 'number') errors.push(`${file}: stageDurationsMs.${stage} must be a number`)
    }
  }
  return errors
}

function requiredJobsFromPlan() {
  if (!fs.existsSync(planFile)) return []
  const plan = readJson(planFile)
  const jobs = new Set()
  for (const tier of plan.tiers ?? []) {
    if (tier.localOnly === true || tier.nightlyOnly === true || tier.manualOnly === true) continue
    jobs.add(tier.ciJob)
  }
  return [...jobs].sort()
}

function main() {
  const requirePlan = process.argv.includes('--require-plan')
  const files = listSummaryFiles()
  const errors = []
  const summaries = files.map((file) => ({ file, summary: readJson(file) }))

  for (const { file, summary } of summaries) {
    errors.push(...validateSummary(summary, path.relative(root, file)))
  }

  if (requirePlan) {
    const summaryIds = new Set(summaries.map(({ summary }) => summary.ciJob ?? summary.jobId))
    const summaryResultIds = new Set(summaries.map(({ summary }) => summary.jobId))
    for (const jobId of requiredJobsFromPlan()) {
      const hasBase = summaryIds.has(jobId) || summaryResultIds.has(jobId)
      const hasShard = [...summaryResultIds].some((id) => id.startsWith(`${jobId}-`))
      if (!hasBase && !hasShard) errors.push(`missing job summary for required CI job: ${jobId}`)
    }
  }

  if (errors.length > 0) fail(errors)
  console.log(`[job-summary-check] ok summaries=${summaries.length} required=${requirePlan ? requiredJobsFromPlan().length : 0}`)
}

try {
  main()
} catch (error) {
  fail([error.message])
}
