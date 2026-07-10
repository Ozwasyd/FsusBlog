#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const knownStatuses = ['CompileError', 'Ignored', 'Killed', 'NoCoverage', 'Survived', 'Timeout']
const executedStatuses = new Set(['Killed', 'Survived', 'Timeout'])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requireText(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function requireSourceState(sourceState) {
  const commit = String(sourceState?.commit ?? '').trim()
  const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim()
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('producer sourceState.commit must be a 40-character lowercase Git SHA')
  }
  if (!/^[0-9a-f]{64}$/u.test(worktreeFingerprint)) {
    throw new Error('producer sourceState.worktreeFingerprint must be a SHA-256 digest')
  }
  return { commit, worktreeFingerprint }
}

function requireGeneratedAt(value) {
  const generatedAt = requireText(value, 'producer generatedAt')
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('producer generatedAt must be an ISO date-time')
  }
  return generatedAt
}

export function validateStrykerReport(report) {
  if (!report || typeof report !== 'object' || report.schemaVersion !== '2') {
    throw new Error('Stryker report must use schemaVersion 2')
  }
  if (!report.files || typeof report.files !== 'object') {
    throw new Error('Stryker report must contain files')
  }

  const statuses = Object.fromEntries(knownStatuses.map((status) => [status, 0]))
  for (const file of Object.values(report.files)) {
    for (const mutant of Array.isArray(file?.mutants) ? file.mutants : []) {
      if (!(mutant.status in statuses)) {
        throw new Error(`Stryker report contains unknown mutant status ${mutant.status}`)
      }
      statuses[mutant.status] += 1
    }
  }

  const executedMutants = [...executedStatuses]
    .reduce((total, status) => total + statuses[status], 0)
  if (executedMutants === 0) {
    throw new Error('Stryker report must execute at least one mutant')
  }

  const thresholds = report.thresholds
  if (!thresholds || !Number.isFinite(thresholds.high) || !Number.isFinite(thresholds.low)) {
    throw new Error('Stryker report must declare numeric high and low thresholds')
  }

  return {
    schemaVersion: report.schemaVersion,
    executedMutants,
    statuses,
    thresholds: { high: thresholds.high, low: thresholds.low }
  }
}

export function createStrykerAuthority({
  report,
  rawReport,
  reportPath,
  config,
  rawConfig,
  configPath,
  tierId,
  runId,
  sourceState,
  generatedAt
}) {
  const summary = validateStrykerReport(report)
  const strykerConfig = config?.['stryker-config']
  if (!strykerConfig || typeof strykerConfig !== 'object') {
    throw new Error('Stryker config must contain stryker-config')
  }

  const scope = Array.isArray(strykerConfig.mutate)
    ? strykerConfig.mutate.map((entry) => requireText(entry, 'Stryker mutate scope entry'))
    : []
  if (scope.length === 0) throw new Error('Stryker config must declare a non-empty mutate scope')
  const testCaseFilter = requireText(strykerConfig['test-case-filter'], 'Stryker test-case-filter')
  const configuredThresholds = strykerConfig.thresholds
  if (
    !configuredThresholds
    || !Number.isFinite(configuredThresholds.high)
    || !Number.isFinite(configuredThresholds.low)
    || !Number.isFinite(configuredThresholds.break)
  ) {
    throw new Error('Stryker config must declare numeric high, low, and break thresholds')
  }
  for (const name of ['high', 'low']) {
    if (configuredThresholds[name] !== summary.thresholds[name]) {
      throw new Error(`Stryker report ${name} threshold does not match current config`)
    }
  }

  const scoreableMutants = summary.statuses.Killed
    + summary.statuses.NoCoverage
    + summary.statuses.Survived
    + summary.statuses.Timeout
  if (scoreableMutants === 0) throw new Error('Stryker report must contain scoreable mutants')
  const score = Number(((summary.statuses.Killed / scoreableMutants) * 100).toFixed(4))
  if (score < configuredThresholds.break) {
    throw new Error(`Stryker mutation score ${score} is below break threshold ${configuredThresholds.break}`)
  }

  const normalizedTierId = requireText(tierId, 'tierId')
  const normalizedRunId = requireText(runId, 'producer runId')
  const normalizedSourceState = requireSourceState(sourceState)
  const normalizedGeneratedAt = requireGeneratedAt(generatedAt)
  const reportBytes = Buffer.isBuffer(rawReport) ? rawReport : Buffer.from(rawReport ?? '')
  const configBytes = Buffer.isBuffer(rawConfig) ? rawConfig : Buffer.from(rawConfig ?? '')
  if (reportBytes.length === 0) throw new Error('raw Stryker report is empty')
  if (configBytes.length === 0) throw new Error('raw Stryker config is empty')

  return {
    schema: 'fsusblog.stryker-authority.v1',
    status: 'success',
    tierId: normalizedTierId,
    sliceId: normalizedTierId,
    commandAlias: normalizedTierId === 'release-mutation-critical-slice'
      ? 'backend-mutation-critical'
      : normalizedTierId,
    score,
    mutantCount: Object.values(summary.statuses).reduce((total, count) => total + count, 0),
    executedMutants: summary.executedMutants,
    statuses: summary.statuses,
    scope,
    testCaseFilter,
    thresholds: {
      high: configuredThresholds.high,
      low: configuredThresholds.low,
      break: configuredThresholds.break
    },
    rawReport: {
      path: requireText(reportPath, 'raw report path'),
      sha256: sha256(reportBytes)
    },
    config: {
      path: requireText(configPath, 'config path'),
      sha256: sha256(configBytes)
    },
    producer: {
      runId: normalizedRunId,
      sourceState: normalizedSourceState,
      generatedAt: normalizedGeneratedAt
    }
  }
}

function gitOutput(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`cannot resolve producer Git state: ${result.stderr.trim() || args.join(' ')}`)
  }
  return result.stdout.trim()
}

function producerIdentity(root, tierId, generatedAt) {
  const environmentCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim()
  const environmentFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim()
  if (Boolean(environmentCommit) !== Boolean(environmentFingerprint)) {
    throw new Error('scheduler producer source environment is incomplete')
  }

  let sourceState
  if (environmentCommit && environmentFingerprint) {
    sourceState = requireSourceState({
      commit: environmentCommit,
      worktreeFingerprint: environmentFingerprint
    })
  } else {
    const status = gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status) {
      throw new Error('standalone Stryker authority requires a clean Git worktree')
    }
    sourceState = requireSourceState({
      commit: gitOutput(root, ['rev-parse', 'HEAD']),
      worktreeFingerprint: sha256('{}')
    })
  }

  const environmentRunId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
  const standaloneSuffix = generatedAt.replace(/[^0-9A-Za-z]/gu, '-')
  return {
    runId: environmentRunId || `${tierId}-standalone-${standaloneSuffix}-${process.pid}`,
    sourceState
  }
}

function repoRelativePath(root, inputPath, label) {
  const absolutePath = resolve(inputPath)
  const result = relative(root, absolutePath)
  if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new Error(`${label} must be a file inside the repository`)
  }
  return result.split(sep).join('/')
}

function parseAuthorityOptions(args) {
  const options = { configPath: null, tierId: null, outputPath: null }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--config', '--tier', '--out'].includes(flag) || !value || value.startsWith('--')) {
      throw new Error(`unknown or incomplete authority option ${flag}`)
    }
    index += 1
    if (flag === '--config') options.configPath = value
    if (flag === '--tier') options.tierId = value
    if (flag === '--out') options.outputPath = value
  }
  const present = Object.values(options).filter(Boolean).length
  if (present !== 0 && present !== 3) {
    throw new Error('authority generation requires --config, --tier, and --out together')
  }
  return options
}

function writeJsonAtomic(outputPath, value) {
  mkdirSync(dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.next-${process.pid}`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, outputPath)
}

function main() {
  const reportPath = process.argv[2]
  if (!reportPath) {
    throw new Error('usage: node tools/test/check-stryker-report.mjs <report.json> [--config <config.json> --tier <tier-id> --out <authority.json>]')
  }
  const absoluteReportPath = resolve(reportPath)
  const rawReport = readFileSync(absoluteReportPath)
  const report = JSON.parse(rawReport)
  const summary = validateStrykerReport(report)
  const authorityOptions = parseAuthorityOptions(process.argv.slice(3))
  if (authorityOptions.outputPath) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const absoluteConfigPath = resolve(authorityOptions.configPath)
    const rawConfig = readFileSync(absoluteConfigPath)
    const generatedAt = new Date().toISOString()
    const producer = producerIdentity(root, authorityOptions.tierId, generatedAt)
    const authority = createStrykerAuthority({
      report,
      rawReport,
      reportPath: repoRelativePath(root, absoluteReportPath, 'raw report'),
      config: JSON.parse(rawConfig),
      rawConfig,
      configPath: repoRelativePath(root, absoluteConfigPath, 'config'),
      tierId: authorityOptions.tierId,
      runId: producer.runId,
      sourceState: producer.sourceState,
      generatedAt
    })
    writeJsonAtomic(resolve(authorityOptions.outputPath), authority)
    process.stdout.write(`[stryker-report] authority=${authorityOptions.outputPath} run=${authority.producer.runId} score=${authority.score}\n`)
  }
  process.stdout.write(`[stryker-report] ok executed=${summary.executedMutants} statuses=${JSON.stringify(summary.statuses)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[stryker-report] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
