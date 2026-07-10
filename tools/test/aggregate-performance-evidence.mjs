#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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

function resolveSourceFile(root, source) {
  const direct = path.resolve(root, source.path)
  if (!direct.startsWith(`${root}${path.sep}`)) throw new Error(`${source.id} source escapes root`)
  if (fs.existsSync(direct)) return direct

  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  const artifactRelativePaths = [...new Set([source.path, source.path.replace(/^\.tmp\//u, '')])]
  const matches = fs.existsSync(downloadedRoot)
    ? fs.readdirSync(downloadedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => artifactRelativePaths.map((relativePath) => path.join(downloadedRoot, entry.name, relativePath)))
      .filter((candidate) => fs.existsSync(candidate))
      .sort()
    : []
  if (matches.length === 0) throw new Error(`missing ${source.id} performance evidence: ${source.path}`)
  if (matches.length > 1) throw new Error(`ambiguous ${source.id} performance evidence in downloaded artifacts`)
  return matches[0]
}

function readSummary(root, source) {
  const absolute = resolveSourceFile(root, source)
  const summary = JSON.parse(fs.readFileSync(absolute, 'utf8'))
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

function aggregateStatus(entries) {
  if (entries.every((entry) => entry.status === 'ok')) return 'ok'
  if (entries.some((entry) => !['ok', 'blocked', 'scheduled'].includes(entry.status))) return 'failed'
  if (entries.some((entry) => ['blocked', 'scheduled'].includes(entry.status))) return 'blocked'
  return 'ok'
}

export function aggregatePerformanceEvidence(rootValue = repositoryRoot) {
  const root = path.resolve(rootValue)
  const entries = performanceEvidenceSources.map((source) => readSummary(root, source))
  const summary = {
    schema: 'fsusblog.performance-evidence-summary.v1',
    status: aggregateStatus(entries),
    requiredEvidenceIds: performanceEvidenceSources.map((source) => source.id),
    entries,
    generatedAt: new Date().toISOString()
  }
  const output = path.join(root, '.tmp/release-evidence/perf-summary.json')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const temporary = `${output}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`)
  fs.renameSync(temporary, output)
  return { output, summary }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = aggregatePerformanceEvidence(options.root)
    console.log(`[performance-evidence] wrote ${path.relative(options.root, result.output)}`)
  } catch (error) {
    console.error(`[performance-evidence] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
