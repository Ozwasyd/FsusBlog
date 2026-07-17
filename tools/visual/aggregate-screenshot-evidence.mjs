#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const downloadedArtifactsRoot = path.join(root, '.tmp/downloaded-artifacts')
const diagnosticMode = process.env.FSUSBLOG_BROWSER_DIAGNOSTICS === '1'
const diagnosticArtifactRoot = process.env.FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT
  ? path.resolve(process.env.FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT)
  : null
const groups = [
  {
    id: 'public',
    ciJob: 'visual-public-playwright',
    summaryPath: '.tmp/visual/public/summary.json',
    outputPath: 'src/frontend/test-results/playwright/visual-public'
  },
  {
    id: 'console',
    ciJob: 'visual-console-playwright',
    summaryPath: '.tmp/visual/console/summary.json',
    outputPath: 'src/frontend/test-results/playwright/visual-console'
  }
]

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function findFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(file, predicate, results)
    else if (predicate(file)) results.push(file)
  }
  return results
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/')
}

function findAllRelative(relPath) {
  const normalized = relPath.replaceAll('/', path.sep)
  const matches = []
  const direct = path.join(root, normalized)
  if (fs.existsSync(direct)) matches.push(direct)

  const suffix = `${path.sep}${normalized}`
  for (const file of findFiles(downloadedArtifactsRoot, (candidate) => candidate.endsWith(suffix))) {
    matches.push(file)
  }

  return [...new Set(matches.map((file) => path.resolve(file)))].sort()
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function jobSummaryFiles(jobId) {
  const local = findAllRelative(`.tmp/release-evidence/jobs/${jobId}.json`)
  const sharded = findFiles(path.join(root, '.tmp/release-evidence/jobs'), (candidate) =>
    path.basename(candidate).startsWith(`${jobId}-`) && candidate.endsWith('.json')
  )
  const downloaded = findFiles(downloadedArtifactsRoot, (candidate) =>
    candidate.includes(`${path.sep}.tmp${path.sep}release-evidence${path.sep}jobs${path.sep}`)
    && path.basename(candidate).startsWith(`${jobId}-`)
    && candidate.endsWith('.json')
  )
  return [...new Set([...local, ...sharded, ...downloaded].map((file) => path.resolve(file)))].sort()
}

function jobSummaryFilesForId(summaryId) {
  return findAllRelative(`.tmp/release-evidence/jobs/${summaryId}.json`)
}

function expectedSummaryIds(jobId) {
  const result = spawnSync(process.execPath, ['tools/run-test-matrix.mjs', 'ci-job-matrix', jobId], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    throw new Error(`failed to build matrix for ${jobId}: ${result.stderr.trim() || `exit ${result.status}`}`)
  }

  const payload = JSON.parse(result.stdout)
  return payload.matrix.include.map((entry) => entry.artifact_name).filter(Boolean)
}

function diagnosticGroupOutputPath(group) {
  if (!diagnosticArtifactRoot) return null
  return path.join(path.dirname(diagnosticArtifactRoot), group.id, 'playwright', `visual-${group.id}`)
}

function validateGroupSummary({ group, summary, file, requiredStatus, expectedOutputPath, strictContract }) {
  const errors = []
  if (!requiredStatus.includes(summary.status)) {
    errors.push(`${relative(file)} status=${summary.status ?? 'missing'}`)
  }
  if (strictContract && summary.schema !== 'fsusblog.visual.screenshot-group.v1') {
    errors.push(`${relative(file)} schema=${summary.schema ?? 'missing'}`)
  }
  if (strictContract && summary.group !== group.id) {
    errors.push(`${relative(file)} group=${summary.group ?? 'missing'}`)
  }
  if (strictContract && (!Number.isFinite(Number(summary.durationMs)) || Number(summary.durationMs) < 0)) {
    errors.push(`${relative(file)} durationMs=${summary.durationMs ?? 'missing'}`)
  }
  if (strictContract && expectedOutputPath) {
    const actualOutputPath = typeof summary.outputDir === 'string' && summary.outputDir.length > 0
      ? path.resolve(root, summary.outputDir)
      : null
    if (actualOutputPath !== expectedOutputPath) {
      errors.push(`${relative(file)} outputDir does not match current diagnostic probe`)
    } else if (!fs.existsSync(actualOutputPath)) {
      errors.push(`missing diagnostic screenshot output: ${relative(actualOutputPath)}`)
    }
  }
  return errors
}

function summarizeGroup(group) {
  const directSummary = path.join(root, group.summaryPath)
  const summaryFiles = diagnosticMode
    ? (fs.existsSync(directSummary) ? [directSummary] : [])
    : findAllRelative(group.summaryPath)
  const parsedSummaries = []
  const errors = []
  const expectedOutputPath = diagnosticMode ? diagnosticGroupOutputPath(group) : null

  if (summaryFiles.length === 0) {
    errors.push(`missing screenshot group summary: ${group.summaryPath}`)
  }

  for (const file of summaryFiles) {
    try {
      const summary = readJson(file)
      parsedSummaries.push({ summary, file })
      errors.push(...validateGroupSummary({
        group,
        summary,
        file,
        requiredStatus: diagnosticMode ? ['success'] : ['success', 'skipped'],
        expectedOutputPath,
        strictContract: diagnosticMode
      }))
    } catch (error) {
      errors.push(`${relative(file)} is not valid JSON: ${error.message}`)
    }
  }

  const jobSummaries = []
  let expectedJobSummaries = []
  if (!diagnosticMode) {
    try {
      expectedJobSummaries = expectedSummaryIds(group.ciJob)
    } catch (error) {
      errors.push(error.message)
    }
    for (const summaryId of expectedJobSummaries) {
      const files = jobSummaryFilesForId(summaryId)
      if (files.length === 0) {
        errors.push(`missing job summary artifact: ${summaryId}`)
        continue
      }
      for (const file of files) {
        try {
          const summary = readJson(file)
          jobSummaries.push({ summary, file })
          if (summary.status !== 'success') {
            errors.push(`${relative(file)} status=${summary.status ?? 'missing'}`)
          }
        } catch (error) {
          errors.push(`${relative(file)} is not valid JSON: ${error.message}`)
        }
      }
    }

    for (const file of jobSummaryFiles(group.ciJob)) {
      if (jobSummaries.some((entry) => path.resolve(entry.file) === path.resolve(file))) continue
      try {
        const summary = readJson(file)
        jobSummaries.push({ summary, file })
        if (summary.status !== 'success') {
          errors.push(`${relative(file)} status=${summary.status ?? 'missing'}`)
        }
      } catch (error) {
        errors.push(`${relative(file)} is not valid JSON: ${error.message}`)
      }
    }
  }

  const durationMs = parsedSummaries.reduce((total, item) => total + (Number(item.summary.durationMs) || 0), 0)
  return {
    id: group.id,
    ciJob: group.ciJob,
    status: errors.length === 0 ? 'success' : 'failure',
    durationMs,
    expectedJobSummaries,
    summaryFiles: parsedSummaries.map((item) => relative(item.file)),
    jobSummaryFiles: jobSummaries.map((item) => relative(item.file)),
    outputPath: expectedOutputPath ? relative(expectedOutputPath) : group.outputPath,
    errors
  }
}

const configurationErrors = diagnosticMode && !diagnosticArtifactRoot
  ? ['diagnostic: FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT is required']
  : []
const groupSummaries = groups.map(summarizeGroup)
const errors = [
  ...configurationErrors,
  ...groupSummaries.flatMap((group) => group.errors.map((error) => `${group.id}: ${error}`))
]
const status = errors.length === 0 ? 'success' : 'failure'
const summary = {
  schema: 'fsusblog.visual.screenshot-aggregate.v1',
  status,
  aggregationMode: diagnosticMode ? 'diagnostic-probes' : 'ci-job-shards',
  evidenceClass: diagnosticMode ? 'diagnostic' : 'correctness',
  affectsCorrectness: !diagnosticMode,
  executionBoundary: diagnosticMode ? 'real-browser-screenshot-diagnostics' : 'ci-job-shards',
  generatedAt: new Date().toISOString(),
  commit: git(['rev-parse', 'HEAD']),
  groups: groupSummaries,
  groupDurationsMs: Object.fromEntries(groupSummaries.map((group) => [group.id, group.durationMs])),
  combinedEvidence: [
    '.tmp/visual/public/summary.json',
    '.tmp/visual/console/summary.json',
    '.tmp/visual/summary.json',
    '.tmp/release-evidence/visual-screenshot-summary.json'
  ],
  errors
}

const outFiles = [
  path.join(root, '.tmp/visual/summary.json'),
  path.join(root, '.tmp/release-evidence/visual-screenshot-summary.json')
]
for (const outFile of outFiles) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[visual-aggregate] ${error}`)
  process.exit(1)
}

console.log(`[visual-aggregate] ok (${groupSummaries.length} groups)`)
