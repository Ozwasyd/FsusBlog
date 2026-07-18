#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const policyPath = path.join(root, 'tests/flaky.yml')
const policyVersion = 'fsusblog-flaky-execution-v2'
const retryableFailureKind = 'browser-process-crash'
const attemptEvidenceSchema = 'fsusblog.ci.flaky-attempt.v1'
const structuredOutputPrefix = 'FSUSBLOG_FLAKY_ATTEMPT:'

const safeFallbackPolicy = Object.freeze({
  evidenceClass: 'correctness',
  allowedRetries: 0,
  retryOn: 'never',
  classification: 'regression'
})

const safeFallbackSuitePolicies = new Map([
  ['browser-contract', { evidenceClass: 'browser-contract', allowedRetries: 0, retryOn: 'never', classification: 'regression' }],
  ['browser-diagnostics', { evidenceClass: 'diagnostic', allowedRetries: 1, retryOn: retryableFailureKind, classification: 'unknown-flaky' }],
  ['acceptance-playwright', { evidenceClass: 'diagnostic', allowedRetries: 1, retryOn: retryableFailureKind, classification: 'unknown-flaky' }],
  ['visual-playwright', { evidenceClass: 'diagnostic', allowedRetries: 1, retryOn: retryableFailureKind, classification: 'unknown-flaky' }],
  ['ux-viewport-smoke', { evidenceClass: 'diagnostic', allowedRetries: 1, retryOn: retryableFailureKind, classification: 'unknown-flaky' }],
  ['cross-browser-smoke', { evidenceClass: 'diagnostic', allowedRetries: 1, retryOn: retryableFailureKind, classification: 'unknown-flaky' }]
])

function usage() {
  console.error('Usage: node tools/ci/run-flaky-governed.mjs --suite <suite> [--test <name>] -- <command> [args...]')
}

function parseArgs(args) {
  const options = { suite: null, testIds: [] }
  let index = 0
  for (; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      index += 1
      break
    }
    if (arg === '--suite') options.suite = args[++index]
    else if (arg.startsWith('--suite=')) options.suite = arg.slice('--suite='.length)
    else if (arg === '--test' || arg === '--test-id') options.testIds.push(args[++index])
    else if (arg.startsWith('--test=')) options.testIds.push(arg.slice('--test='.length))
    else if (arg.startsWith('--test-id=')) options.testIds.push(arg.slice('--test-id='.length))
    else throw new Error(`unknown option: ${arg}`)
  }
  const command = args.slice(index)
  if (!options.suite) throw new Error('missing --suite')
  if (command.length === 0) throw new Error('missing command after --')
  options.testIds = [...new Set(options.testIds.flatMap((value) => String(value ?? '').split(',')).map((value) => value.trim()).filter(Boolean))]
  return { ...options, command }
}

function parseScalar(value) {
  const trimmed = String(value ?? '').trim().replace(/^['"]|['"]$/gu, '')
  if (/^\d+$/u.test(trimmed)) return Number(trimmed)
  return trimmed
}

function parseExecutionPolicy(text) {
  const defaults = { ...safeFallbackPolicy }
  const suites = new Map()
  let inPolicies = false
  let current = null

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, '')
    if (!line.trim()) continue
    const top = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (top && !/^\s/u.test(rawLine)) {
      inPolicies = top[1] === 'executionPolicies'
      current = null
      if (top[1] === 'defaultEvidenceClass') defaults.evidenceClass = parseScalar(top[2])
      if (top[1] === 'defaultAllowedRetries') defaults.allowedRetries = parseScalar(top[2])
      if (top[1] === 'defaultRetryOn') defaults.retryOn = parseScalar(top[2])
      if (top[1] === 'defaultClassification') defaults.classification = parseScalar(top[2])
      continue
    }
    if (!inPolicies) continue
    const item = line.match(/^\s{2}-\s+suite:\s*(.*?)\s*$/u)
    if (item) {
      current = { suite: parseScalar(item[1]) }
      suites.set(current.suite, current)
      continue
    }
    const field = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (field && current) current[field[1]] = parseScalar(field[2])
  }
  return { defaults, suites }
}

function validatePolicy(policy, label) {
  if (!['correctness', 'browser-contract', 'diagnostic'].includes(policy.evidenceClass)) {
    throw new Error(`${label}: evidenceClass must be correctness, browser-contract, or diagnostic`)
  }
  if (!Number.isInteger(policy.allowedRetries) || policy.allowedRetries < 0 || policy.allowedRetries > 1) {
    throw new Error(`${label}: allowedRetries must be 0 or 1`)
  }
  if (!['never', retryableFailureKind].includes(policy.retryOn)) {
    throw new Error(`${label}: retryOn must be never or ${retryableFailureKind}`)
  }
  if (policy.evidenceClass !== 'diagnostic' && (policy.allowedRetries !== 0 || policy.retryOn !== 'never')) {
    throw new Error(`${label}: only diagnostic suites may configure a retry`)
  }
  if (policy.evidenceClass === 'diagnostic' && policy.allowedRetries > 0 && policy.retryOn !== retryableFailureKind) {
    throw new Error(`${label}: diagnostic retry must be restricted to ${retryableFailureKind}`)
  }
}

function loadPolicy(suite) {
  if (!fs.existsSync(policyPath)) {
    const fallback = { ...(safeFallbackSuitePolicies.get(suite) ?? safeFallbackPolicy) }
    validatePolicy(fallback, `safe fallback for ${suite}`)
    return fallback
  }
  const registry = parseExecutionPolicy(fs.readFileSync(policyPath, 'utf8'))
  const policy = { ...registry.defaults, ...(registry.suites.get(suite) ?? {}) }
  delete policy.suite
  validatePolicy(policy, `tests/flaky.yml suite ${suite}`)
  return policy
}

function evidenceFile(suite) {
  const safeSuite = String(suite).replace(/[^A-Za-z0-9_.-]/g, '-')
  return path.join(root, '.tmp/release-evidence/flaky', `${safeSuite}.json`)
}

function portablePath(file) {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    ? relative.replaceAll(path.sep, '/')
    : path.resolve(file).replaceAll(path.sep, '/')
}

function runDirectory(suite) {
  const safeSuite = String(suite).replace(/[^A-Za-z0-9_.-]/g, '-')
  const runId = `${Date.now()}-${process.pid}`
  return path.join(root, '.tmp/release-evidence/flaky/attempts', safeSuite, runId)
}

function replay(file, stream) {
  const contents = fs.readFileSync(file)
  if (contents.length > 0) stream.write(contents)
}

function runCommand(command, { attempt, attemptDirectory, defaultTestIds }) {
  fs.mkdirSync(attemptDirectory, { recursive: true })
  const stdoutFile = path.join(attemptDirectory, 'stdout.log')
  const stderrFile = path.join(attemptDirectory, 'stderr.log')
  const sidecarFile = path.join(attemptDirectory, 'attempt.json')
  const artifactDirectory = path.join(attemptDirectory, 'artifacts')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const stdoutFd = fs.openSync(stdoutFile, 'w')
  const stderrFd = fs.openSync(stderrFile, 'w')
  const startedAt = Date.now()
  let result
  try {
    result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      env: {
        ...process.env,
        FSUSBLOG_FLAKY_ATTEMPT: String(attempt),
        FSUSBLOG_FLAKY_ATTEMPT_EVIDENCE: sidecarFile,
        FSUSBLOG_FLAKY_ATTEMPT_ARTIFACT_DIR: artifactDirectory
      },
      stdio: ['inherit', stdoutFd, stderrFd]
    })
  } finally {
    fs.closeSync(stdoutFd)
    fs.closeSync(stderrFd)
  }
  replay(stdoutFile, process.stdout)
  replay(stderrFile, process.stderr)

  const durationMs = Math.max(0, Date.now() - startedAt)
  const output = `${fs.readFileSync(stdoutFile, 'utf8')}\n${fs.readFileSync(stderrFile, 'utf8')}`
  const metadata = readAttemptMetadata(sidecarFile, output)
  const succeeded = result.status === 0 && !result.error
  const normalizedFailure = succeeded
    ? { failureClass: null, failureKind: null }
    : normalizeFailure(metadata, result)
  const testIds = uniqueStrings(metadata?.testIds?.length > 0 ? metadata.testIds : defaultTestIds)
  const artifacts = uniqueStrings([
    portablePath(stdoutFile),
    portablePath(stderrFile),
    ...(metadata?.artifacts ?? []).map((value) => normalizeArtifact(value, attemptDirectory))
  ])

  return {
    attempt,
    status: succeeded ? 'success' : 'failure',
    testIds: testIds.length > 0 ? testIds : ['<suite-level>'],
    failureClass: normalizedFailure.failureClass,
    failureKind: normalizedFailure.failureKind,
    artifacts,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    durationMs
  }
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function normalizeArtifact(value, attemptDirectory) {
  const artifact = String(value ?? '').trim()
  if (!artifact) return artifact
  if (path.isAbsolute(artifact)) return portablePath(artifact)
  const rootCandidate = path.resolve(root, artifact)
  const attemptCandidate = path.resolve(attemptDirectory, artifact)
  return portablePath(fs.existsSync(rootCandidate) ? rootCandidate : attemptCandidate)
}

function readAttemptMetadata(sidecarFile, output) {
  let item = null
  if (fs.existsSync(sidecarFile)) {
    try {
      item = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'))
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('expected an object')
      if (item.schema !== undefined && item.schema !== attemptEvidenceSchema) {
        throw new Error(`schema must be ${attemptEvidenceSchema}`)
      }
    } catch (error) {
      return {
        failureClass: 'infra',
        failureKind: 'attempt-evidence-invalid',
        testIds: [],
        artifacts: [sidecarFile],
        metadataError: error.message
      }
    }
  }
  const structured = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(structuredOutputPrefix))
    .at(-1)
  if (structured) {
    try {
      const parsed = JSON.parse(structured.slice(structuredOutputPrefix.length))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) item = { ...(item ?? {}), ...parsed }
    } catch {
      return {
        failureClass: 'infra',
        failureKind: 'attempt-evidence-invalid',
        testIds: [],
        artifacts: item?.artifacts ?? []
      }
    }
  }
  return item ?? {}
}

function normalizeFailure(metadata, result) {
  if (metadata?.failureKind === retryableFailureKind || metadata?.failureClass === retryableFailureKind) {
    return { failureClass: 'infra', failureKind: retryableFailureKind }
  }
  const rawClass = String(metadata?.failureClass ?? '').trim()
  const rawKind = String(metadata?.failureKind ?? '').trim()
  const infraKinds = new Set([
    'browser-disconnect',
    'browser-install-failure',
    'browser-launch-failure',
    'runner-resource-exhaustion',
    'fixture-bootstrap-failure',
    'attempt-evidence-invalid'
  ])
  if (rawClass === 'infra' || rawClass === 'infra-failure' || infraKinds.has(rawKind) || infraKinds.has(rawClass)) {
    return { failureClass: 'infra', failureKind: rawKind || rawClass || 'infra-failure' }
  }
  if (rawClass === 'contract') return { failureClass: 'contract', failureKind: rawKind || 'contract-failure' }
  if (rawClass === 'product') return { failureClass: 'product', failureKind: rawKind || 'product-failure' }
  if (result.error) return { failureClass: 'infra', failureKind: 'command-launch-failure' }
  if (result.signal) return { failureClass: 'infra', failureKind: 'runner-process-signal' }
  return { failureClass: 'product', failureKind: rawKind || rawClass || 'command-failure' }
}

function isRetryableDiagnosticFailure(policy, attempt) {
  return policy.evidenceClass === 'diagnostic'
    && policy.allowedRetries > 0
    && policy.retryOn === retryableFailureKind
    && attempt.status === 'failure'
    && attempt.failureClass === 'infra'
    && attempt.failureKind === retryableFailureKind
}

function topologyIsUnstable(attempts) {
  const failed = attempts.filter((attempt) => attempt.status === 'failure')
  if (failed.length < 2) return false
  const identities = failed.map((attempt) => [...attempt.testIds].sort().join('\n'))
  return new Set(identities).size > 1
}

function outcome(policy, attempts) {
  const last = attempts.at(-1)
  const retries = Math.max(0, attempts.length - 1)
  if (topologyIsUnstable(attempts)) {
    return {
      evidenceClass: 'infra-failure',
      failureClass: 'unstable-topology',
      failureKind: 'different-tests-failed-across-attempts',
      finalStatus: 'unstable-topology',
      retryCount: retries
    }
  }
  if (last.status === 'success') {
    return {
      evidenceClass: policy.evidenceClass,
      failureClass: retries > 0 ? 'infra' : null,
      failureKind: retries > 0 ? retryableFailureKind : null,
      finalStatus: retries > 0 ? 'diagnostic-passed-after-infra-retry' : 'success',
      retryCount: retries
    }
  }
  const infrastructureFailure = last.failureClass === 'infra'
  return {
    evidenceClass: infrastructureFailure ? 'infra-failure' : policy.evidenceClass,
    failureClass: last.failureClass,
    failureKind: last.failureKind,
    finalStatus: retries > 0 ? 'failed-after-infra-retry' : 'failed-no-retry',
    retryCount: retries
  }
}

function writeEvidence({ suite, testIds, policy, command, attempts }) {
  const result = outcome(policy, attempts)
  const executedTestIds = uniqueStrings(attempts.flatMap((attempt) => attempt.testIds))
  const file = evidenceFile(suite)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({
    schema: 'fsusblog.ci.flaky.v1',
    policyVersion,
    suite,
    test: executedTestIds.length === 1 ? executedTestIds[0] : null,
    testIds: executedTestIds,
    declaredTestIds: testIds,
    classification: result.failureClass === 'infra' ? 'infra-transient' : policy.classification,
    evidenceClass: result.evidenceClass,
    sourceEvidenceClass: policy.evidenceClass,
    affectsCorrectness: policy.evidenceClass !== 'diagnostic',
    failureClass: result.failureClass,
    failureKind: result.failureKind,
    issue: 1151,
    retryPolicy: {
      allowedRetries: policy.allowedRetries,
      retryOn: policy.retryOn
    },
    retryCount: result.retryCount,
    finalStatus: result.finalStatus,
    command: command.join(' '),
    attempts,
    localReproduction: `node tools/ci/run-flaky-governed.mjs --suite ${suite}${testIds.map((id) => ` --test-id ${id}`).join('')} -- ${command.join(' ')}`,
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
  return result
}

function main() {
  const { suite, testIds, command } = parseArgs(process.argv.slice(2))
  const policy = loadPolicy(suite)
  const attempts = []
  const directory = runDirectory(suite)
  const defaultTestIds = testIds.length > 0 ? testIds : [suite]

  for (let attemptNumber = 1; attemptNumber <= policy.allowedRetries + 1; attemptNumber += 1) {
    console.error(`[flaky:${suite}] attempt ${attemptNumber}/${policy.allowedRetries + 1}: ${command.join(' ')}`)
    const attempt = runCommand(command, {
      attempt: attemptNumber,
      attemptDirectory: path.join(directory, `attempt-${attemptNumber}`),
      defaultTestIds
    })
    attempts.push(attempt)
    if (attempt.status === 'success') break
    if (!isRetryableDiagnosticFailure(policy, attempt)) break
  }

  const result = writeEvidence({ suite, testIds: defaultTestIds, policy, command, attempts })
  if (result.finalStatus === 'diagnostic-passed-after-infra-retry') {
    console.error(`[flaky:${suite}] diagnostic recovered after explicit browser process crash; correctness remains unaffected`)
  }
  if (attempts.at(-1)?.status !== 'success') process.exit(1)
}

try {
  main()
} catch (error) {
  usage()
  console.error(`[flaky] ${error.message}`)
  process.exit(2)
}
