#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontendRoot = path.join(root, 'src/frontend')
const outputRoot = path.join(root, '.tmp/test-results/vitest/production-rolling')
const blobRoot = path.join(outputRoot, 'blobs')
const coverageShardRoot = path.join(root, '.tmp/coverage/frontend-vitest-shards')
const catalogFile = path.join(outputRoot, 'catalog.json')
const mergedJson = path.join(outputRoot, 'merged.json')
const mergedJunit = path.join(outputRoot, 'merged.xml')
const frontendRequire = createRequire(path.join(frontendRoot, 'package.json'))

export function canonicalVitestId(file, name) {
  const normalizedFile = path.relative(root, path.resolve(file)).replaceAll(path.sep, '/')
  return `vitest:${normalizedFile}#${String(name).trim()}`
}

function canonicalVitestFile(file) {
  return path.relative(root, path.resolve(file)).replaceAll(path.sep, '/')
}

export function validateExactVitestExecution(fileCatalog, reports) {
  const expectedFiles = fileCatalog.map((entry) => canonicalVitestFile(entry.file))
  const reportedFiles = reports.flatMap((report) => (report.testResults ?? []).map((testFile) => ({
    file: canonicalVitestFile(testFile.name),
    assertions: testFile.assertionResults ?? []
  })))
  const expectedSet = new Set(expectedFiles)
  const reportedSet = new Set(reportedFiles.map((entry) => entry.file))
  const duplicateFiles = reportedFiles.filter((entry, index) => reportedFiles.findIndex((candidate) => candidate.file === entry.file) !== index)
  const missingFiles = [...expectedSet].filter((file) => !reportedSet.has(file))
  const unexpectedFiles = [...reportedSet].filter((file) => !expectedSet.has(file))
  const emptyFiles = reportedFiles.filter((entry) => entry.assertions.length === 0).map((entry) => entry.file)
  const tests = reportedFiles.flatMap((entry) => entry.assertions.map((assertion) => ({
    id: canonicalVitestId(entry.file, assertion.fullName || assertion.title),
    status: assertion.status
  })))
  const duplicateTests = tests.filter((entry, index) => tests.findIndex((candidate) => candidate.id === entry.id) !== index)
  const failedTests = tests.filter((entry) => entry.status !== 'passed')
  if (expectedSet.size !== expectedFiles.length
    || duplicateFiles.length || missingFiles.length || unexpectedFiles.length || emptyFiles.length
    || duplicateTests.length || failedTests.length) {
    throw new Error('Vitest exact execution failed:'
      + ` duplicateFiles=${duplicateFiles.length} missingFiles=${missingFiles.length}`
      + ` unexpectedFiles=${unexpectedFiles.length} emptyFiles=${emptyFiles.length}`
      + ` duplicateTests=${duplicateTests.length} failedTests=${failedTests.length}`)
  }
  return {
    catalogFileCount: expectedFiles.length,
    executedFileCount: reportedFiles.length,
    executedTestIdCount: tests.length,
    exactOnce: true
  }
}

function readPositive(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function resolveSingleHostWorkers(env = process.env, hostCpu = os.availableParallelism?.() ?? os.cpus().length) {
  const granted = readPositive(env.FSUSBLOG_VITEST_TARGET_WORKERS)
    ?? readPositive(env.FSUSBLOG_STEP_CPU_BUDGET)
    ?? readPositive(env.FSUSBLOG_BUNDLE_CPU_UNITS)
    ?? readPositive(env.FSUSBLOG_BUNDLE_CPU_BUDGET)
    ?? hostCpu
  return Math.max(1, Math.min(Math.floor(hostCpu), Math.floor(granted)))
}

function run(args, { env = process.env, logFile } = {}) {
  return new Promise((resolve) => {
    const child = spawn('npx', args, { cwd: frontendRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'w' }) : null
    for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', (chunk) => {
        log?.write(chunk)
        target.write(chunk)
      })
    }
    child.once('error', (error) => resolve({ code: 1, error }))
    child.once('close', (code, signal) => {
      log?.end()
      resolve({ code: code ?? 1, signal })
    })
  })
}

async function requireSuccess(args, options) {
  const result = await run(args, options)
  if (result.code !== 0 || result.signal || result.error) {
    throw result.error ?? new Error(`command failed (${result.signal ?? result.code}): npx ${args.join(' ')}`)
  }
}

function commonArguments() {
  return [
    'vitest', 'run', '--config', 'vitest.production.config.ts',
    '--project=unit', '--project=property', '--project=model'
  ]
}

async function discoverCatalog() {
  await requireSuccess([
    'vitest', 'list', '--config', 'vitest.production.config.ts',
    '--project=unit', '--project=property', '--project=model', '--filesOnly', `--json=${catalogFile}`
  ], { logFile: path.join(outputRoot, 'catalog.log') })
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
  if (!Array.isArray(catalog) || catalog.length === 0) throw new Error('Vitest test catalog is empty')
  return catalog
}

function singleHostEnvironment(workers) {
  return {
    ...process.env,
    FSUSBLOG_VITEST_LANE: 'production-single-host',
    FSUSBLOG_VITEST_SINGLE_HOST: '1',
    FSUSBLOG_VITEST_REPORT_ID: 'single-host',
    FSUSBLOG_VITEST_MAX_WORKERS: String(workers),
    FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD: '0',
    FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD: '0',
    FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD: '0',
    FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD: '0'
  }
}

async function runSingleHost(catalog) {
  const workers = resolveSingleHostWorkers()
  const json = path.join(outputRoot, 'single-host.json')
  const junit = path.join(outputRoot, 'single-host.xml')
  const blob = path.join(blobRoot, 'single-host.blob')
  const coverage = path.join(coverageShardRoot, 'single-host')
  await requireSuccess([
    ...commonArguments(), ...catalog.map((entry) => entry.file), '--coverage', '--coverage.all=false',
    '--coverage.reporter=json', `--maxWorkers=${workers}`,
    '--reporter=default', '--reporter=json', '--reporter=junit', '--reporter=blob',
    `--outputFile.json=${json}`, `--outputFile.junit=${junit}`, `--outputFile.blob=${blob}`,
    `--coverage.reportsDirectory=${coverage}`
  ], { env: singleHostEnvironment(workers), logFile: path.join(outputRoot, 'single-host.log') })
  return { json, junit, blob, coverage, workers }
}

async function seedFullCoverageUniverse() {
  const coverage = path.join(coverageShardRoot, 'full-universe')
  await requireSuccess([
    ...commonArguments(), '__fsusblog_no_matching_test_file__', '--coverage', '--coverage.all=true',
    '--coverage.reporter=json', `--coverage.reportsDirectory=${coverage}`, '--passWithNoTests',
    '--reporter=dot'
  ], {
    env: {
      ...process.env,
      FSUSBLOG_VITEST_LANE: 'production-rolling-coverage-universe',
      FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD: '0',
      FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD: '0',
      FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD: '0',
      FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD: '0'
    },
    logFile: path.join(outputRoot, 'coverage-universe.log')
  })
  return { coverage }
}

export function mergeAuthoritativeCoverageMaps(universeFile, shardFiles, {
  reportsDirectory = path.join(frontendRoot, 'coverage/unit')
} = {}) {
  const { createCoverageMap } = frontendRequire('istanbul-lib-coverage')
  const { createContext } = frontendRequire('istanbul-lib-report')
  const reports = frontendRequire('istanbul-reports')
  const universe = JSON.parse(fs.readFileSync(universeFile, 'utf8'))
  const authoritativeFiles = new Set(Object.keys(universe))
  if (authoritativeFiles.size === 0) throw new Error('frontend full coverage universe is empty')
  const merged = createCoverageMap(universe)
  for (const shardFile of shardFiles) {
    const shard = JSON.parse(fs.readFileSync(shardFile, 'utf8'))
    const projected = Object.fromEntries(Object.entries(shard).filter(([file]) => authoritativeFiles.has(file)))
    if (Object.keys(projected).length === 0) {
      throw new Error(`frontend coverage shard has no authoritative files: ${shardFile}`)
    }
    merged.merge(projected)
  }
  fs.rmSync(reportsDirectory, { recursive: true, force: true })
  fs.mkdirSync(reportsDirectory, { recursive: true })
  const context = createContext({ dir: reportsDirectory, coverageMap: merged })
  for (const reporter of ['text', 'json-summary', 'html', 'lcov']) {
    reports.create(reporter).execute(context)
  }
  const summaryFile = path.join(reportsDirectory, 'coverage-summary.json')
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')).total
  const thresholds = {
    // Production owns threshold enforcement in coverage-threshold.sh after
    // backend/frontend summaries are normalized. Keep this collector aligned
    // with collect-frontend-coverage.sh so it records the complete universe
    // without applying the standalone developer-config defaults twice.
    lines: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD ?? 0),
    branches: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD ?? 0),
    functions: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD ?? 0),
    statements: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD ?? 0)
  }
  const failures = Object.entries(thresholds).filter(([key, threshold]) => (
    !Number.isFinite(threshold) || Number(summary?.[key]?.pct) < threshold
  ))
  if (failures.length > 0) {
    throw new Error(`frontend coverage threshold failed: ${failures.map(([key, threshold]) => `${key}=${summary?.[key]?.pct ?? 'missing'}<${threshold}`).join(' ')}`)
  }
  return { authoritativeFileCount: authoritativeFiles.size, summary, thresholds }
}

async function main() {
  fs.rmSync(outputRoot, { recursive: true, force: true })
  fs.rmSync(coverageShardRoot, { recursive: true, force: true })
  fs.rmSync(path.join(frontendRoot, 'coverage/unit'), { recursive: true, force: true })
  fs.mkdirSync(blobRoot, { recursive: true })
  fs.mkdirSync(coverageShardRoot, { recursive: true })
  const catalog = await discoverCatalog()
  const host = await runSingleHost(catalog)
  const universe = await seedFullCoverageUniverse()
  await requireSuccess([
    ...commonArguments(), `--mergeReports=${blobRoot}`,
    '--reporter=default', '--reporter=json', '--reporter=junit',
    `--outputFile.json=${mergedJson}`, `--outputFile.junit=${mergedJunit}`
  ], { logFile: path.join(outputRoot, 'merge.log') })
  const coverageEvidence = mergeAuthoritativeCoverageMaps(
    path.join(universe.coverage, 'coverage-final.json'),
    [path.join(host.coverage, 'coverage-final.json')]
  )
  const exact = validateExactVitestExecution(catalog, [JSON.parse(fs.readFileSync(host.json, 'utf8'))])
  const summary = {
    schema: 'fsusblog.frontend-vitest-single-host.v1',
    status: 'success',
    schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    hostCount: 1,
    maxWorkers: host.workers,
    ...exact,
    coverage: coverageEvidence,
    artifacts: {
      mergedJson: path.relative(root, mergedJson).replaceAll(path.sep, '/'),
      mergedJunit: path.relative(root, mergedJunit).replaceAll(path.sep, '/'),
      coverageSummary: 'src/frontend/coverage/unit/coverage-summary.json'
    }
  }
  fs.writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`[frontend-vitest-single-host] exactOnce=${exact.executedTestIdCount} files=${exact.executedFileCount} workers=${host.workers}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
