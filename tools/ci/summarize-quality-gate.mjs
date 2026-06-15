#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
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

function loadFlakyEvidence() {
  const roots = [
    path.join(root, '.tmp/release-evidence/flaky'),
    path.join(root, '.tmp/downloaded-artifacts')
  ]
  const evidence = []
  for (const searchRoot of roots) {
    for (const file of findFiles(searchRoot, (candidate) => candidate.endsWith('.json') && candidate.includes(`${path.sep}flaky${path.sep}`))) {
      try {
        const item = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (item.schema !== 'fsusblog.ci.flaky.v1') continue
        evidence.push({ item, file })
      } catch {
        // Ignore unrelated JSON artifacts.
      }
    }
  }
  return evidence.sort((left, right) => `${left.item.suite}:${left.item.test}`.localeCompare(`${right.item.suite}:${right.item.test}`))
}

function latestReleaseManifest() {
  const roots = [
    path.join(root, '.tmp/release-evidence'),
    path.join(root, '.tmp/downloaded-artifacts')
  ]
  const candidates = []
  for (const searchRoot of roots) {
    for (const file of findFiles(searchRoot, (candidate) => candidate.endsWith(`${path.sep}manifest.json`) && candidate.includes('release-evidence'))) {
      try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (manifest.status && manifest.evidenceSummary) {
          candidates.push({ file, manifest, mtimeMs: fs.statSync(file).mtimeMs })
        }
      } catch {
        // Ignore unrelated manifests.
      }
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0] ?? null
}

function evidenceBlockers(manifest) {
  const blockers = []
  if (manifest.status !== 'collected-ok') blockers.push(`manifest.status=${manifest.status}`)
  for (const item of manifest.evidenceSummary?.externalExposure?.blockers ?? []) {
    blockers.push(typeof item === 'string' ? item : JSON.stringify(item))
  }
  for (const source of manifest.evidenceSummary?.externalExposure?.request?.blockerSources ?? []) {
    blockers.push(`externalExposure:${source}`)
  }
  for (const [area, summary] of Object.entries(manifest.evidenceSummary ?? {})) {
    if (!summary || typeof summary !== 'object') continue
    for (const [key, value] of Object.entries(summary)) {
      if (typeof value === 'string' && !['ok', 'present'].includes(value)) blockers.push(`${area}.${key}=${value}`)
      else if (value && typeof value === 'object' && typeof value.status === 'string' && !['ok', 'present'].includes(value.status)) blockers.push(`${area}.${key}.status=${value.status}`)
    }
  }
  return [...new Set(blockers)].sort()
}

function inspectReleaseManifest({ requireOk }) {
  const candidate = latestReleaseManifest()
  if (!candidate) {
    return {
      ok: false,
      file: null,
      status: 'missing',
      blockers: ['release manifest missing'],
      errors: ['release manifest missing']
    }
  }

  const args = ['tools/operations/check-release-evidence-manifest.mjs']
  if (requireOk) args.push('--require-ok')
  args.push(candidate.file)
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  const errors = (result.stderr || result.stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  return {
    ok: result.status === 0,
    file: path.relative(root, candidate.file).replaceAll(path.sep, '/'),
    status: candidate.manifest.status,
    blockers: evidenceBlockers(candidate.manifest),
    errors
  }
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
  if (match.summary.groupDurationsMs && typeof match.summary.groupDurationsMs === 'object') {
    const groups = Object.entries(match.summary.groupDurationsMs)
      .map(([group, duration]) => `${group}=${duration}ms`)
      .join(', ')
    if (groups) lines.push(`  groups: ${groups}`)
  }
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

function writeProductionSummary(status, rootFailures = [], rootCause = null, flakyEvidence = [], releaseEvidence = null) {
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
    flaky: {
      passedAfterRetry: flakyEvidence
        .filter(({ item }) => item.finalStatus === 'passed-after-retry')
        .map(({ item }) => ({
          suite: item.suite,
          test: item.test,
          classification: item.classification,
          retryCount: item.retryCount,
          issue: item.issue
        }))
    },
    releaseEvidence,
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
  const flakyEvidence = loadFlakyEvidence()
  const releaseMode = process.env.FSUSBLOG_PRODUCTION_SUMMARY_REQUIRE_RELEASE_OK === '1'
  const releaseEvidence = inspectReleaseManifest({ requireOk: releaseMode })
  const passedAfterRetry = flakyEvidence.filter(({ item }) => item.finalStatus === 'passed-after-retry')
  const nonSuccess = Object.entries(needs)
    .filter(([, value]) => value.result !== 'success')
    .sort(([left], [right]) => left.localeCompare(right))

  if (nonSuccess.length === 0 && releaseEvidence.ok) {
    console.log('production summary ok')
    const lines = ['## Quality Gate', '', 'All required jobs completed successfully.']
    lines.push('', '### Release Evidence', `- manifest: ${releaseEvidence.status}`, `- artifact: ${releaseEvidence.file}`)
    if (releaseEvidence.blockers.length > 0) {
      lines.push('- blockers:')
      for (const blocker of releaseEvidence.blockers.slice(0, 20)) lines.push(`  - ${blocker}`)
    }
    if (passedAfterRetry.length > 0) {
      lines.push('', '### Passed After Retry')
      for (const { item } of passedAfterRetry) {
        lines.push(`- ${item.suite}: ${item.test ?? 'suite'} (${item.classification}, retries=${item.retryCount})`)
      }
    }
    writeStepSummary(lines)
    writeProductionSummary('success', [], null, flakyEvidence, releaseEvidence)
    return
  }

  if (nonSuccess.length === 0 && !releaseEvidence.ok) {
    const lines = [
      '## Quality Gate',
      '',
      '### Release Evidence Failure',
      `- manifest: ${releaseEvidence.status}`,
      `- artifact: ${releaseEvidence.file ?? 'missing'}`
    ]
    for (const error of releaseEvidence.errors.slice(0, 20)) lines.push(`- ${error}`)
    if (releaseEvidence.blockers.length > 0) {
      lines.push('', '### Evidence Blockers')
      for (const blocker of releaseEvidence.blockers.slice(0, 20)) lines.push(`- ${blocker}`)
    }
    for (const line of lines.filter(Boolean)) console.error(line.replace(/^### /, '').replace(/^## /, ''))
    writeStepSummary(lines)
    writeProductionSummary('failure', [], releaseEvidence.errors.join('; ') || 'release evidence failed', flakyEvidence, releaseEvidence)
    process.exit(1)
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
  if (passedAfterRetry.length > 0) {
    lines.push('### Passed After Retry')
    for (const { item } of passedAfterRetry) {
      lines.push(`- ${item.suite}: ${item.test ?? 'suite'} (${item.classification}, retries=${item.retryCount})`)
    }
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
  writeProductionSummary('failure', rootFailures, null, flakyEvidence, releaseEvidence)
  process.exit(1)
}

try {
  main()
} catch (error) {
  writeProductionSummary('failure', [], error.message, [])
  console.error(`[quality-gate-summary] ${error.message}`)
  process.exit(1)
}
