#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { resolveManifestWorkers } from './run-command-manifest.mjs'

const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))

export const performanceEvidenceSources = Object.freeze([
  { id: 'load-baseline', path: '.tmp/perf/release-summaries/load-baseline.json' },
  { id: 'load-peak', path: '.tmp/perf/release-summaries/load-expected-peak.json' },
  { id: 'backend-benchmark-regression', path: '.tmp/perf/release-summaries/backend-benchmark-regression.json' },
  { id: 'browser-performance-regression', path: '.tmp/perf/release-summaries/browser-performance-regression.json' }
])

function parseArgs(argv) {
  const options = { root: repositoryRoot }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--root') {
      const value = argv[++index]
      if (!value) throw new Error('--root requires a path')
      options.root = path.resolve(value)
    } else {
      throw new Error(`unknown option: ${argument}`)
    }
  }
  return options
}

function downloadedArtifactDirectories(root) {
  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  return fs.existsSync(downloadedRoot)
    ? fs.readdirSync(downloadedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(downloadedRoot, entry.name))
      .sort()
    : []
}

function resolveSourceFile(root, source, artifactDirectories) {
  const direct = path.resolve(root, source.path)
  if (!direct.startsWith(`${root}${path.sep}`)) throw new Error(`${source.id} source escapes root`)
  if (fs.existsSync(direct)) return direct

  const artifactRelativePaths = [...new Set([source.path, source.path.replace(/^\.tmp\//u, '')])]
  const matches = artifactDirectories
    .flatMap((directory) => artifactRelativePaths.map((relativePath) => path.join(directory, relativePath)))
    .filter((candidate) => fs.existsSync(candidate))
    .sort()
  if (matches.length === 0) throw new Error(`missing ${source.id} performance evidence: ${source.path}`)
  if (matches.length > 1) throw new Error(`ambiguous ${source.id} performance evidence in downloaded artifacts`)
  return matches[0]
}

async function readSummary(root, source, artifactDirectories) {
  const absolute = resolveSourceFile(root, source, artifactDirectories)
  let summary
  try {
    summary = JSON.parse(await fs.promises.readFile(absolute, 'utf8'))
  } catch (error) {
    throw new Error(`${source.id} performance evidence is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error(`${source.id} performance evidence must be a JSON object`)
  }
  if (typeof summary.status !== 'string' || summary.status.length === 0) {
    throw new Error(`${source.id} performance evidence status is missing`)
  }
  return {
    id: source.id,
    path: source.path,
    sourceLocation: path.relative(root, absolute).replaceAll(path.sep, '/'),
    status: summary.status,
    summary
  }
}

export function resolvePerformanceEvidenceWorkers({
  sourceCount = performanceEvidenceSources.length,
  ...runtime
} = {}) {
  if (!Number.isInteger(sourceCount) || sourceCount <= 0) {
    throw new Error('performance evidence source count must be a positive integer')
  }
  return Math.min(sourceCount, resolveManifestWorkers(runtime))
}

async function readAllSummaries(root, sources, artifactDirectories) {
  const entries = new Array(sources.length)
  const failures = []
  const workerCount = resolvePerformanceEvidenceWorkers({ sourceCount: sources.length })
  let nextIndex = 0
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < sources.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        entries[index] = await readSummary(root, sources[index], artifactDirectories)
      } catch (error) {
        failures.push({ index, error })
      }
    }
  }))
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index)
    const errors = failures.map(({ error }) => error instanceof Error ? error : new Error(String(error)))
    const details = errors.map((error) => error.message).join('; ')
    throw new AggregateError(errors, `${errors.length} performance evidence source(s) failed: ${details}`)
  }
  return entries
}

function aggregateStatus(entries) {
  if (entries.every((entry) => entry.status === 'ok')) return 'ok'
  if (entries.some((entry) => !['ok', 'blocked', 'scheduled'].includes(entry.status))) return 'failed'
  if (entries.some((entry) => ['blocked', 'scheduled'].includes(entry.status))) return 'blocked'
  return 'ok'
}

export async function aggregatePerformanceEvidence(rootValue = repositoryRoot) {
  const root = path.resolve(rootValue)
  const entries = await readAllSummaries(root, performanceEvidenceSources, downloadedArtifactDirectories(root))
  const summary = {
    schema: 'fsusblog.performance-evidence-summary.v1',
    status: aggregateStatus(entries),
    requiredEvidenceIds: performanceEvidenceSources.map((source) => source.id),
    entries,
    generatedAt: new Date().toISOString()
  }
  const output = path.join(root, '.tmp/release-evidence/perf-summary.json')
  await fs.promises.mkdir(path.dirname(output), { recursive: true })
  const temporary = `${output}.next-${process.pid}`
  await fs.promises.writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`)
  await fs.promises.rename(temporary, output)
  return { output, summary }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await aggregatePerformanceEvidence(options.root)
    console.log(`[performance-evidence] wrote ${path.relative(options.root, result.output)}`)
  } catch (error) {
    console.error(`[performance-evidence] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
