#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const workflowPath = path.join(root, '.github/workflows/quality-gate.yml')

function findFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(file, predicate, results)
    else if (predicate(file)) results.push(file)
  }
  return results
}

function loadJobSummaries() {
  const roots = [
    path.join(root, '.tmp/release-evidence/jobs'),
    path.join(root, '.tmp/downloaded-artifacts')
  ]
  const summaries = new Map()
  for (const searchRoot of roots) {
    for (const file of findFiles(searchRoot, (candidate) => candidate.endsWith('.json') && candidate.includes(`${path.sep}jobs${path.sep}`))) {
      try {
        const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (summary.schema !== 'fsusblog.ci.job-result.v1') continue
        summaries.set(summary.jobId, { summary, file })
        if (summary.ciJob) summaries.set(summary.ciJob, { summary, file })
      } catch {
        // Ignore unrelated JSON artifacts.
      }
    }
  }
  return summaries
}

function parseInlineList(value) {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return [trimmed]
}

function parseWorkflowNeeds(text) {
  const jobs = new Map()
  let inJobs = false
  let currentJob = null
  let collectingNeeds = null

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(rawLine)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue

    const jobMatch = rawLine.match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (jobMatch) {
      currentJob = jobMatch[1]
      collectingNeeds = null
      jobs.set(currentJob, new Set())
      continue
    }
    if (!currentJob) continue

    const needsMatch = rawLine.match(/^    needs:\s*(.*?)\s*$/)
    if (needsMatch) {
      const value = needsMatch[1]
      collectingNeeds = value === '' ? currentJob : null
      for (const need of parseInlineList(value)) jobs.get(currentJob).add(need)
      continue
    }

    if (collectingNeeds === currentJob) {
      const itemMatch = rawLine.match(/^      -\s+([A-Za-z0-9_-]+)\s*$/)
      if (itemMatch) {
        jobs.get(currentJob).add(itemMatch[1])
        continue
      }
      if (!/^\s*$/.test(rawLine)) collectingNeeds = null
    }
  }

  return jobs
}

function dependencyDepth(job, workflowNeeds, seen = new Set()) {
  if (seen.has(job)) return 0
  seen.add(job)
  const needs = workflowNeeds.get(job) ?? new Set()
  if (needs.size === 0) return 0
  return 1 + Math.max(...[...needs].map((need) => dependencyDepth(need, workflowNeeds, new Set(seen))))
}

function formatJob(name, value) {
  return `${name}: ${value.result}`
}

function rootFailureLines(item, jobSummaries) {
  const lines = [`- ${formatJob(item.name, item.value)}`]
  const match = jobSummaries.get(item.name)
  if (!match) return lines
  const rel = path.relative(root, match.file).replaceAll(path.sep, '/')
  if (match.summary.failureStage) lines.push(`  failureStage: ${match.summary.failureStage}`)
  if (match.summary.rootCause) lines.push(`  rootCause: ${match.summary.rootCause}`)
  if (match.summary.localReproduction) lines.push(`  reproduce: ${match.summary.localReproduction}`)
  lines.push(`  artifact: ${rel}`)
  return lines
}

function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

function writeProductionSummary(status, rootFailures = [], rootCause = null) {
  const outFile = path.join(root, '.tmp/release-evidence/jobs/production-summary.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const stageDurationsMs = {
    setup: 0,
    restore: 0,
    install: 0,
    bootstrap: 0,
    test: 0,
    artifact: 0,
    summary: 0
  }
  fs.writeFileSync(outFile, `${JSON.stringify({
    schema: 'fsusblog.ci.job-result.v1',
    jobId: 'production-summary',
    ciJob: 'production-summary',
    tierIds: ['production'],
    status,
    failureStage: status === 'success' ? null : 'summary',
    rootCause: status === 'success' ? null : (rootCause ?? rootFailures.map((item) => `${item.name}:${item.value.result}`).join(', ')),
    durationMs: 0,
    stageDurationsMs,
    artifacts: ['.tmp/release-evidence/jobs/production-summary.json'],
    localReproduction: './tools/test.sh ci-production --plan-only',
    commit: process.env.GITHUB_SHA ?? 'unknown',
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? '0',
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
}

function main() {
  const rawNeeds = process.env.QUALITY_GATE_NEEDS_JSON
  if (!rawNeeds) {
    throw new Error('missing QUALITY_GATE_NEEDS_JSON; pass GitHub Actions needs JSON to the summary step')
  }

  const needs = JSON.parse(rawNeeds)
  const workflowNeeds = parseWorkflowNeeds(fs.readFileSync(workflowPath, 'utf8'))
  const jobSummaries = loadJobSummaries()
  const nonSuccess = Object.entries(needs)
    .filter(([, value]) => value.result !== 'success')
    .sort(([left], [right]) => left.localeCompare(right))

  if (nonSuccess.length === 0) {
    console.log('production summary ok')
    writeStepSummary(['## Quality Gate', '', 'All required jobs completed successfully.'])
    writeProductionSummary('success')
    return
  }

  const rootFailures = []
  const downstreamFanout = []
  for (const [name, value] of nonSuccess) {
    const upstreamFailures = [...(workflowNeeds.get(name) ?? new Set())]
      .filter((need) => needs[need]?.result && needs[need].result !== 'success')
      .sort()

    if (upstreamFailures.length === 0) {
      rootFailures.push({ name, value, depth: dependencyDepth(name, workflowNeeds) })
    } else {
      downstreamFanout.push({ name, value, upstreamFailures })
    }
  }

  rootFailures.sort((left, right) => left.depth - right.depth || left.name.localeCompare(right.name))
  downstreamFanout.sort((left, right) => left.name.localeCompare(right.name))

  const lines = ['## Quality Gate', '']
  if (rootFailures.length > 0) {
    lines.push('### Earliest root non-success jobs')
    for (const item of rootFailures) lines.push(...rootFailureLines(item, jobSummaries))
    lines.push('')
  }
  if (downstreamFanout.length > 0) {
    lines.push('### Downstream fan-out')
    for (const item of downstreamFanout) {
      const upstream = item.upstreamFailures.map((name) => `${name}:${needs[name].result}`).join(', ')
      lines.push(`- ${formatJob(item.name, item.value)} (upstream: ${upstream})`)
    }
    lines.push('')
  }

  for (const line of lines.filter(Boolean)) console.error(line.replace(/^### /, '').replace(/^## /, ''))
  writeStepSummary(lines)
  writeProductionSummary('failure', rootFailures)
  process.exit(1)
}

try {
  main()
} catch (error) {
  writeProductionSummary('failure', [], error.message)
  console.error(`[quality-gate-summary] ${error.message}`)
  process.exit(1)
}
