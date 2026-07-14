#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { buildBackendTopologyCalibrationMatrix } from './backend-production-topology.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultOutput = '.tmp/diagnostics/backend-topology-calibration.json'

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function positiveNumber(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`)
  return parsed
}

export function parseBackendTopologyCalibrationArgs(argv) {
  const options = {
    fresh: false,
    output: defaultOutput,
    repeat: 3,
    maxCandidates: Number.POSITIVE_INFINITY,
    candidateIds: [],
    cpuBudget: os.availableParallelism(),
    memoryGiB: os.freemem() / (1024 ** 3),
    planningUnitCount: 1024
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${argument} requires a value`)
      return argv[index]
    }
    if (argument === '--fresh') options.fresh = true
    else if (argument === '--output') options.output = value()
    else if (argument === '--repeat') options.repeat = positiveInteger(value(), '--repeat')
    else if (argument === '--max-candidates') options.maxCandidates = positiveInteger(value(), '--max-candidates')
    else if (argument === '--candidate') options.candidateIds.push(value())
    else if (argument === '--cpu-budget') options.cpuBudget = positiveInteger(value(), '--cpu-budget')
    else if (argument === '--memory-gib') options.memoryGiB = positiveNumber(value(), '--memory-gib')
    else if (argument === '--planning-units') {
      options.planningUnitCount = positiveInteger(value(), '--planning-units')
    } else if (argument === '--help') options.help = true
    else throw new Error(`unknown backend topology calibration option: ${argument}`)
  }
  if (!options.help && !options.fresh) {
    throw new Error('backend topology calibration requires --fresh; historical test results are never reusable')
  }
  return options
}

function field(text, label) {
  const escapedLabel = String(label).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = String(text).match(new RegExp(`^\\s*${escapedLabel}:\\s*(.+)\\s*$`, 'mu'))
  return match?.[1]?.trim() ?? null
}

function metric(value, parser = Number) {
  if (value === null) return { status: 'unavailable', value: null }
  const parsed = parser(value)
  return Number.isFinite(parsed)
    ? { status: 'measured', value: parsed }
    : { status: 'unavailable', value: null }
}

export function parseGnuTimeVerboseMetrics(text) {
  const elapsed = field(text, 'Elapsed (wall clock) time (h:mm:ss or m:ss)')
  const elapsedSeconds = elapsed === null
    ? null
    : elapsed.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  return {
    userCpuSeconds: metric(field(text, 'User time (seconds)')),
    systemCpuSeconds: metric(field(text, 'System time (seconds)')),
    elapsedSeconds: metric(elapsedSeconds),
    peakRssKiB: metric(field(text, 'Maximum resident set size (kbytes)')),
    voluntaryContextSwitches: metric(field(text, 'Voluntary context switches')),
    involuntaryContextSwitches: metric(field(text, 'Involuntary context switches')),
    fileSystemInputs: metric(field(text, 'File system inputs')),
    fileSystemOutputs: metric(field(text, 'File system outputs'))
  }
}

function quantile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function summarizeBackendTopologyCalibrationCandidate(candidate, samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('backend topology calibration candidate requires samples')
  }
  const successes = samples.filter(({ status }) => status === 'success')
  const wallClockMs = successes.map(({ wallClockMs: value }) => value)
  const medianMs = quantile(wallClockMs, 0.5)
  const meanMs = wallClockMs.length === 0
    ? null
    : wallClockMs.reduce((sum, value) => sum + value, 0) / wallClockMs.length
  const varianceMs2 = meanMs === null
    ? null
    : wallClockMs.reduce((sum, value) => sum + ((value - meanMs) ** 2), 0) / wallClockMs.length
  return {
    ...candidate,
    status: successes.length === samples.length ? 'success' : 'failed',
    sampleCount: samples.length,
    successfulSampleCount: successes.length,
    wallClock: {
      medianMs,
      p25Ms: quantile(wallClockMs, 0.25),
      p75Ms: quantile(wallClockMs, 0.75),
      meanMs,
      varianceMs2,
      standardDeviationMs: varianceMs2 === null ? null : Math.sqrt(varianceMs2)
    },
    samples
  }
}

export function buildBackendTopologyCalibrationReport({
  sourceCommit,
  sourceFingerprint,
  machine,
  candidates,
  generatedAt = new Date().toISOString()
}) {
  if (!/^[0-9a-f]{40}$/u.test(String(sourceCommit))) {
    throw new Error('backend topology calibration requires a full source commit')
  }
  if (!String(sourceFingerprint).startsWith('sha256:')) {
    throw new Error('backend topology calibration requires a source fingerprint')
  }
  const rankedSuccessfulCandidates = candidates
    .filter(({ status, wallClock }) => status === 'success' && Number.isFinite(wallClock?.medianMs))
    .sort((left, right) => left.wallClock.medianMs - right.wallClock.medianMs)
    .map(({ id, wallClock }, index) => ({ rank: index + 1, id, medianMs: wallClock.medianMs }))
  return {
    schema: 'fsusblog.backend-topology-calibration.v1',
    status: candidates.every(({ status }) => status === 'success') ? 'success' : 'failed',
    mode: 'diagnostic-only-fresh-production',
    sourceCommit,
    sourceFingerprint,
    machine,
    semantics: {
      sameSourceRequired: true,
      freshProductionPerSample: true,
      historicalPassReuseAllowed: false,
      coverageReuseAllowed: false,
      releaseEvidenceReuseAllowed: false,
      selectedTopologyRequiresSubsequentFreshValidation: true
    },
    metricAvailability: {
      processTreeCpuRssContextSwitchAndIo: process.platform === 'linux' ? 'gnu-time-v' : 'unavailable',
      postgresWait: 'unavailable-until-resource-utilization-evidence',
      firstTestStart: 'vstest-trx-startTime'
    },
    rankedSuccessfulCandidates,
    candidates,
    generatedAt
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout).trim())
  return String(result.stdout).trim()
}

function sourceIdentity() {
  const sourceCommit = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--porcelain=v2', '--untracked-files=all'])
  if (status) throw new Error('backend topology calibration requires a clean worktree')
  return {
    sourceCommit,
    sourceFingerprint: `sha256:${createHash('sha256').update(`${sourceCommit}\n${status}`).digest('hex')}`
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, options)
    child.once('error', (error) => resolve({ code: null, signal: null, error, wallClockMs: Date.now() - startedAt }))
    child.once('exit', (code, signal) => resolve({ code, signal, error: null, wallClockMs: Date.now() - startedAt }))
  })
}

function removeCalibrationPassArtifacts() {
  for (const relative of [
    '.tmp/test-runs',
    '.tmp/test-results/backend/production',
    '.tmp/coverage/backend/production',
    '.tmp/release-evidence'
  ]) fs.rmSync(path.join(root, relative), { recursive: true, force: true })
}

async function executeSample(candidate, repeatIndex, identity) {
  const timeFile = path.join(os.tmpdir(), `fsusblog-backend-topology-${process.pid}-${candidate.id}-${repeatIndex}.time`)
  const timeAvailable = process.platform === 'linux' && fs.existsSync('/usr/bin/time')
  const command = timeAvailable ? '/usr/bin/time' : path.join(root, 'tools/test.sh')
  const args = timeAvailable
    ? ['-v', '-o', timeFile, path.join(root, 'tools/test.sh'), 'production', '--fresh']
    : ['production', '--fresh']
  const result = await runCommand(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      FSUSBLOG_BACKEND_PRODUCTION_SHARDS: String(candidate.testhostCount),
      FSUSBLOG_BACKEND_PARTITION_MULTIPLIER: String(candidate.partitionMultiplier),
      FSUSBLOG_BACKEND_PROCESSOR_ALLOCATION_MODE: candidate.processorAllocationMode,
      FSUSBLOG_BACKEND_TOPOLOGY_CALIBRATION: '1'
    }
  })
  const currentIdentity = sourceIdentity()
  if (currentIdentity.sourceCommit !== identity.sourceCommit
    || currentIdentity.sourceFingerprint !== identity.sourceFingerprint) {
    throw new Error('backend topology calibration source changed during execution')
  }
  const summaryFile = path.join(root, '.tmp/test-results/backend/production/summary.json')
  const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : null
  const timeMetrics = timeAvailable && fs.existsSync(timeFile)
    ? parseGnuTimeVerboseMetrics(fs.readFileSync(timeFile, 'utf8'))
    : parseGnuTimeVerboseMetrics('')
  fs.rmSync(timeFile, { force: true })
  const sample = {
    repeat: repeatIndex + 1,
    status: result.code === 0 && result.signal === null && summary?.status === 'success' ? 'success' : 'failed',
    exitCode: result.code,
    signal: result.signal,
    wallClockMs: result.wallClockMs,
    resourceUsage: timeMetrics,
    discovery: summary?.discovery ?? null,
    topology: summary?.planningForecast?.potentialTopology ?? summary?.parallelism ?? null,
    partitionDurationsMs: (summary?.partitions ?? []).map(({ durationMs }) => durationMs),
    testhostStartupMs: (summary?.partitions ?? [])
      .filter(({ kind }) => kind === 'coverage-shard')
      .map(({ testhostStartupMs }) => testhostStartupMs),
    firstTestStartedAtUnixMs: (summary?.partitions ?? [])
      .filter(({ kind }) => kind === 'coverage-shard')
      .map(({ firstTestStartedAtUnixMs }) => firstTestStartedAtUnixMs),
    slowestPartitionMs: Math.max(0, ...(summary?.partitions ?? []).map(({ durationMs }) => Number(durationMs) || 0)),
    exactOnce: summary?.execution?.exactOnce ?? null,
    coverageAndTrxAreDiagnosticOnly: true,
    error: result.error instanceof Error ? result.error.message : null
  }
  removeCalibrationPassArtifacts()
  return sample
}

export async function runBackendTopologyCalibration(options) {
  const identity = sourceIdentity()
  const machine = {
    platform: process.platform,
    architecture: process.arch,
    cpuBudget: options.cpuBudget,
    memoryGiB: options.memoryGiB,
    availableParallelism: os.availableParallelism(),
    totalMemoryGiB: os.totalmem() / (1024 ** 3)
  }
  let matrix = buildBackendTopologyCalibrationMatrix({
    cpuBudget: options.cpuBudget,
    memoryGiB: options.memoryGiB,
    planningUnitCount: options.planningUnitCount
  })
  if (options.candidateIds.length > 0) {
    const requested = new Set(options.candidateIds)
    matrix = matrix.filter(({ id }) => requested.has(id))
    const missing = [...requested].filter((id) => !matrix.some((candidate) => candidate.id === id))
    if (missing.length > 0) throw new Error(`unknown or infeasible backend topology candidate: ${missing.join(', ')}`)
  }
  matrix = matrix.slice(0, options.maxCandidates)
  const candidates = []
  for (const candidate of matrix) {
    const samples = []
    for (let repeatIndex = 0; repeatIndex < options.repeat; repeatIndex += 1) {
      samples.push(await executeSample(candidate, repeatIndex, identity))
    }
    candidates.push(summarizeBackendTopologyCalibrationCandidate(candidate, samples))
  }
  const report = buildBackendTopologyCalibrationReport({ ...identity, machine, candidates })
  const output = path.resolve(root, options.output)
  writeJsonAtomic(output, report)
  console.log(`[backend-topology-calibration] ${report.status} candidates=${candidates.length} output=${path.relative(root, output)}`)
  return report
}

function printHelp() {
  console.log(`Usage: node tools/test/calibrate-backend-production-topology.mjs --fresh [options]

Runs every selected candidate through a complete ./tools/test.sh production --fresh.
Calibration pass/coverage/release artifacts are removed after each sample and cannot be reused.

Options:
  --candidate <id>       Repeatable candidate id such as h4-p2-uniform
  --repeat <n>           Fresh samples per candidate (default: 3)
  --max-candidates <n>   Bound a broad diagnostic sweep
  --cpu-budget <n>       Candidate-matrix CPU envelope (default: live machine)
  --memory-gib <n>       Candidate-matrix memory envelope (default: live free memory)
  --planning-units <n>   Candidate-matrix planning-unit upper bound
  --output <file>        Machine-readable report path`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  let options
  try {
    options = parseBackendTopologyCalibrationArgs(process.argv.slice(2))
    if (options.help) printHelp()
    else {
      const report = await runBackendTopologyCalibration(options)
      if (report.status !== 'success') process.exitCode = 1
    }
  } catch (error) {
    console.error(`[backend-topology-calibration] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
