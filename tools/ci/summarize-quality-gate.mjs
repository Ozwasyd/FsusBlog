#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const workflowPath = path.join(root, '.github/workflows/quality-gate.yml')

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

function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

function main() {
  const rawNeeds = process.env.QUALITY_GATE_NEEDS_JSON
  if (!rawNeeds) {
    throw new Error('missing QUALITY_GATE_NEEDS_JSON; pass GitHub Actions needs JSON to the summary step')
  }

  const needs = JSON.parse(rawNeeds)
  const workflowNeeds = parseWorkflowNeeds(fs.readFileSync(workflowPath, 'utf8'))
  const nonSuccess = Object.entries(needs)
    .filter(([, value]) => value.result !== 'success')
    .sort(([left], [right]) => left.localeCompare(right))

  if (nonSuccess.length === 0) {
    console.log('production summary ok')
    writeStepSummary(['## Quality Gate', '', 'All required jobs completed successfully.'])
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
    for (const item of rootFailures) lines.push(`- ${formatJob(item.name, item.value)}`)
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
  process.exit(1)
}

try {
  main()
} catch (error) {
  console.error(`[quality-gate-summary] ${error.message}`)
  process.exit(1)
}
