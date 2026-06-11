#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const summariesDir = path.join(root, '.tmp/release-evidence/jobs')
const planFile = path.join(root, '.tmp/release-evidence/test-plan.json')
const downloadedArtifactsDir = path.join(root, '.tmp/downloaded-artifacts')
const allowedFailureStages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary']
const releaseBrowsers = ['chromium', 'firefox', 'webkit']

function fail(errors) {
  for (const error of errors) console.error(`[job-summary-check] ${error}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listSummaryFiles() {
  const files = []
  if (fs.existsSync(summariesDir)) {
    files.push(...fs.readdirSync(summariesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(summariesDir, name)))
  }

  if (fs.existsSync(downloadedArtifactsDir)) {
    const stack = [downloadedArtifactsDir]
    while (stack.length > 0) {
      const current = stack.pop()
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(file)
        } else if (entry.name.endsWith('.json') && file.includes(`${path.sep}release-evidence${path.sep}jobs${path.sep}`)) {
          files.push(file)
        }
      }
    }
  }

  return [...new Set(files)].sort()
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

function tierClosure(tiers, targetId) {
  if (!targetId) return tiers
  const byId = new Map(tiers.map((tier) => [tier.id, tier]))
  const included = new Set()
  function visit(id) {
    if (included.has(id)) return
    const tier = byId.get(id)
    if (!tier) throw new Error(`unknown required tier: ${id}`)
    for (const dep of tier.dependsOn ?? []) visit(dep)
    included.add(id)
  }
  visit(targetId)
  return tiers.filter((tier) => included.has(tier.id))
}

function parseOption(name) {
  const flag = `--${name}`
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

function requiredTiersFromPlan(options) {
  if (!fs.existsSync(planFile)) return []
  const plan = readJson(planFile)
  return tierClosure(plan.tiers ?? [], options.tier).filter((tier) => {
    if (options.tier && tier.id === options.tier) return false
    if (tier.localOnly === true && options.includeLocal !== true) return false
    if (tier.nightlyOnly === true && options.includeNightly !== true) return false
    if (tier.manualOnly === true && options.includeManual !== true) return false
    return true
  })
}

function requiredJobsFromPlan(options) {
  return [...new Set(requiredTiersFromPlan(options).map((tier) => tier.ciJob))].sort()
}

function shardId(index, total) {
  return `${index}-of-${total}`
}

function expectedSummaryIds(options) {
  const ids = new Set()
  for (const tier of requiredTiersFromPlan(options)) {
    if (tier.requiresPlaywright === 'all') {
      for (const browser of releaseBrowsers) {
        if (tier.shardable === true && Number(tier.defaultShards) > 1) {
          for (let index = 1; index <= Number(tier.defaultShards); index += 1) {
            ids.add(`${tier.ciJob}-${browser}-${shardId(index, tier.defaultShards)}`)
          }
        } else {
          ids.add(`${tier.ciJob}-${browser}`)
        }
      }
      continue
    }

    if (tier.shardable === true && Number(tier.defaultShards) > 1) {
      for (let index = 1; index <= Number(tier.defaultShards); index += 1) {
        ids.add(`${tier.ciJob}-${shardId(index, tier.defaultShards)}`)
      }
      continue
    }

    ids.add(tier.ciJob)
  }
  return [...ids].sort()
}

function main() {
  const requirePlan = process.argv.includes('--require-plan')
  const options = {
    tier: parseOption('tier'),
    includeLocal: process.argv.includes('--include-local'),
    includeNightly: process.argv.includes('--include-nightly'),
    includeManual: process.argv.includes('--include-manual'),
    strictShards: process.argv.includes('--strict-shards')
  }
  const files = listSummaryFiles()
  const errors = []
  const summaries = files.map((file) => ({ file, summary: readJson(file) }))

  for (const { file, summary } of summaries) {
    errors.push(...validateSummary(summary, path.relative(root, file)))
  }

  if (requirePlan) {
    const summaryIds = new Set(summaries.map(({ summary }) => summary.ciJob ?? summary.jobId))
    const summaryResultIds = new Set(summaries.map(({ summary }) => summary.jobId))
    for (const jobId of requiredJobsFromPlan(options)) {
      const hasBase = summaryIds.has(jobId) || summaryResultIds.has(jobId)
      const hasShard = [...summaryResultIds].some((id) => id.startsWith(`${jobId}-`))
      if (!hasBase && !hasShard) errors.push(`missing job summary for required CI job: ${jobId}`)
    }
    if (options.strictShards) {
      for (const expectedId of expectedSummaryIds(options)) {
        if (!summaryResultIds.has(expectedId)) {
          errors.push(`missing strict job summary: ${expectedId}`)
        }
      }
    }
  }

  if (errors.length > 0) fail(errors)
  console.log(`[job-summary-check] ok summaries=${summaries.length} required=${requirePlan ? requiredJobsFromPlan(options).length : 0}`)
}

try {
  main()
} catch (error) {
  fail([error.message])
}
