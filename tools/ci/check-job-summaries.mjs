#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  EVIDENCE_TRANSPORT_MANIFEST_ENV,
  listTransportedArchiveFiles
} from '../test/current-run-evidence-transport.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const releaseEvidenceRoot = path.resolve(process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
  ?? path.join(root, '.tmp/release-evidence'))
const summariesDir = path.join(releaseEvidenceRoot, 'jobs')
const planFile = path.join(releaseEvidenceRoot, 'test-plan.json')
const allowedFailureStages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary']
const releaseBrowsers = ['chromium', 'firefox', 'webkit']
const jobResultSchema = 'fsusblog.ci.job-result.v1'
const productionBuildVerificationSchema = 'fsusblog.ci-production-build-verification.v1'

function tierExecutionDependencies(tier) {
  return tier?.executionDependsOn ?? tier?.dependsOn ?? []
}
const jobSummaryOnlyFields = [
  'jobId',
  'ciJob',
  'tierIds',
  'localReproduction',
  'failureStage',
  'rootCause',
  'stageDurationsMs'
]

function fail(errors) {
  for (const error of errors) console.error(`[job-summary-check] ${error}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listSummaryFiles() {
  const transport = String(process.env[EVIDENCE_TRANSPORT_MANIFEST_ENV] ?? '').trim()
  if (transport) {
    return listTransportedArchiveFiles({
      repositoryRoot: root,
      transportManifestPath: transport,
      authorityId: 'evidence-consumer.ci.check-job-summaries.current-run'
    })
  }
  const explicit = String(process.env.FSUSBLOG_QUALITY_GATE_JOB_SUMMARIES ?? '').trim()
  if (explicit) {
    return JSON.parse(explicit).map((file) => path.resolve(root, file)).sort()
  }
  const files = []
  if (fs.existsSync(summariesDir)) {
    files.push(...fs.readdirSync(summariesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(summariesDir, name)))
  }
  return [...new Set(files)].sort()
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateAuxiliaryEvidence(evidence, file, schema) {
  const errors = []
  for (const field of jobSummaryOnlyFields) {
    if (Object.hasOwn(evidence, field)) {
      errors.push(`${file}: auxiliary schema ${schema} cannot declare job summary field ${field}`)
    }
  }
  return errors
}

const auxiliaryEvidenceContracts = new Map([
  [productionBuildVerificationSchema, {
    category: 'production-build-verification',
    validate: validateAuxiliaryEvidence
  }]
])

export function classifyJobEvidence(document, file) {
  if (!isRecord(document)) {
    return { kind: 'invalid', errors: [`${file}: JSON root must be an object`] }
  }
  if (document.schema === jobResultSchema) return { kind: 'job-summary', errors: [] }
  const auxiliaryContract = auxiliaryEvidenceContracts.get(document.schema)
  if (auxiliaryContract) {
    return {
      kind: 'auxiliary-evidence',
      schema: document.schema,
      category: auxiliaryContract.category,
      errors: auxiliaryContract.validate(document, file, document.schema)
    }
  }
  if (typeof document.schema !== 'string' || document.schema.trim() === '') {
    return { kind: 'invalid', errors: [`${file}: schema is required`] }
  }
  return {
    kind: 'invalid',
    errors: [`${file}: unsupported evidence schema in job summary directory: ${document.schema}`]
  }
}

export function validateJobSummary(summary, file) {
  const errors = []
  if (summary.schema !== jobResultSchema) errors.push(`${file}: schema must be ${jobResultSchema}`)
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
  const target = byId.get(targetId)
  if (!target) throw new Error(`unknown required tier: ${targetId}`)
  if ((target.requiresEvidenceFrom ?? []).length > 0) {
    const included = new Set([targetId])
    for (const producerId of target.requiresEvidenceFrom) {
      if (!byId.has(producerId)) throw new Error(`unknown evidence producer tier: ${producerId}`)
      included.add(producerId)
    }
    return tiers.filter((tier) => included.has(tier.id))
  }
  const included = new Set()
  function visit(id) {
    if (included.has(id)) return
    const tier = byId.get(id)
    if (!tier) throw new Error(`unknown required tier: ${id}`)
    for (const dep of tierExecutionDependencies(tier)) visit(dep)
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

function expectedSummaryEntries(options) {
  const entries = new Map()
  const add = (id, tier) => {
    const tiers = entries.get(id) ?? []
    tiers.push(tier)
    entries.set(id, tiers)
  }
  for (const tier of requiredTiersFromPlan(options)) {
    if (tier.requiresPlaywright === 'all') {
      for (const browser of releaseBrowsers) {
        if (tier.shardable === true && Number(tier.defaultShards) > 1) {
          for (let index = 1; index <= Number(tier.defaultShards); index += 1) {
            add(`${tier.ciJob}-${browser}-${shardId(index, tier.defaultShards)}`, tier)
          }
        } else {
          add(`${tier.ciJob}-${browser}`, tier)
        }
      }
      continue
    }

    if (tier.shardable === true && Number(tier.defaultShards) > 1) {
      for (let index = 1; index <= Number(tier.defaultShards); index += 1) {
        add(`${tier.ciJob}-${shardId(index, tier.defaultShards)}`, tier)
      }
      continue
    }

    add(tier.ciJob, tier)
  }
  return [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function summaryMatchesTier(summary, tier) {
  if (!(summary.tierIds ?? []).includes(tier.id)) return false
  return [summary.ciJob, summary.jobId]
    .filter((value) => typeof value === 'string')
    .some((value) => value === tier.ciJob || value.startsWith(`${tier.ciJob}-`))
}

function producerCommand(tier) {
  return `./tools/test.sh ci-tier ${tier.id}`
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
  const summaries = []
  const auxiliaryEvidence = []

  for (const file of files) {
    const summary = readJson(file)
    const relativeFile = path.relative(root, file)
    const classification = classifyJobEvidence(summary, relativeFile)
    errors.push(...classification.errors)
    if (classification.kind === 'job-summary') summaries.push({ file, summary })
    if (classification.kind === 'auxiliary-evidence') {
      auxiliaryEvidence.push({ file, summary, classification })
    }
  }

  for (const { file, summary } of summaries) {
    errors.push(...validateJobSummary(summary, path.relative(root, file)))
  }

  if (requirePlan) {
    const summaryResultIds = new Set(summaries.map(({ summary }) => summary.jobId))
    for (const tier of requiredTiersFromPlan(options)) {
      if (!summaries.some(({ summary }) => summaryMatchesTier(summary, tier))) {
        errors.push(`missing job summary for required evidence tier: ${tier.id} (CI job ${tier.ciJob}); produce with: ${producerCommand(tier)}`)
      }
    }
    if (options.strictShards) {
      for (const [expectedId, tiers] of expectedSummaryEntries(options)) {
        if (!summaryResultIds.has(expectedId)) {
          const commands = [...new Set(tiers.map(producerCommand))].join(', ')
          errors.push(`missing strict job summary: ${expectedId}; produce with: ${commands}`)
        }
      }
    }
  }

  if (errors.length > 0) fail(errors)
  const auxiliaryCounts = [...auxiliaryEvidence.reduce((counts, entry) => {
    const schema = entry.classification.schema
    counts.set(schema, (counts.get(schema) ?? 0) + 1)
    return counts
  }, new Map()).entries()].map(([schema, count]) => `${schema}:${count}`).join(',') || 'none'
  console.log(`[job-summary-check] ok summaries=${summaries.length} auxiliary=${auxiliaryEvidence.length} auxiliarySchemas=${auxiliaryCounts} required=${requirePlan ? requiredJobsFromPlan(options).length : 0}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    fail([error.message])
  }
}
