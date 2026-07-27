import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const productionFreshOutputPartitions = Object.freeze([
  'bundles', 'reports', 'coverage', 'release-evidence', 'runtime', 'logs', 'artifacts', 'summary'
])
export const productionFreshForbiddenOutputRoots = Object.freeze([
  '.tmp/local-production',
  '.tmp/release-evidence',
  '.tmp/test-results',
  '.tmp/coverage',
  '.tmp/perf',
  '.tmp/security',
  '.tmp/frontend',
  '.tmp/scale',
  '.tmp/ux',
  '.tmp/acceptance',
  '.tmp/runtime-scenario-host',
  '.tmp/runtime',
  '.tmp/contracts',
  '.tmp/fault-injection',
  '.tmp/fuzz',
  '.tmp/physical-execution-projections',
  '.tmp/docs',
  '.tmp/test-asset-audit',
  '.tmp/test-governance',
  '.tmp/env',
  '.tmp/fixtures',
  '.tmp/data',
  '.tmp/public-aot-cache-resilience',
  'src/frontend/coverage',
  'src/frontend/test-results',
  'src/frontend/playwright-report',
  'BenchmarkDotNet.Artifacts'
])
const attemptPattern = /^attempt-(\d{4})$/u

export const productionFreshProducerInventory = Object.freeze({
  schema: 'fsusblog.production-fresh.producer-inventory.v1',
  schedulerProducers: Object.freeze([
    'managed-production-build-gc',
    'logical-tier-projection',
    'production-resource-utilization',
    'production-build-layout',
    'forbidden-output-observation',
    'runtime-cleanup',
    'sensitive-fixture-cleanup',
    'run-summary'
  ]),
  bundles: Object.freeze({
    'build-static': Object.freeze([
      'backend-tests-ready', 'frontend-build', 'validate-matrix', 'public-hydration-fast',
      'perception-redteam', 'risk-control', 'viewport-plan-progress', 'sync-static-assets',
      'production-build-artifacts', 'frontend-runtime-contracts', 'wasm-fuzz'
    ]),
    'backend-tests': Object.freeze([
      'services', 'dotnet-restore', 'backend-server-build', 'backend-tests-build',
      'backend-benchmark-build', 'dotnet-production-union', 'perception-matrix',
      'perception-evidence-finalize', 'backend-coverage-summary'
    ]),
    'frontend-tests': Object.freeze([
      'frontend-static-blocking-prebuild', 'frontend-build-ready',
      'frontend-early-test-capacity-ready',
      'vitest-production-projects', 'vitest-production-perf-isolated',
      'frontend-static-concurrent', 'static-governance-concurrent',
      'privacy-zk-canonical-receipts', 'privacy-zk-contract-prebuild',
      'privacy-zk-contract', 'frontend-static-postbuild', 'vitest-settled',
      'static-governance-post-vitest', 'frontend-coverage-summary',
      'frontend-static-isolated', 'frontend-static-final-ready', 'frontend-static-final',
      'frontend-static-cross-stack-owner', 'frontend-render-structure', 'frontend-tests-join'
    ]),
    'runtime-browser': Object.freeze([
      'backend-build-ready', 'frontend-build-ready', 'security-static', 'bootstrap',
      'release-public-hydration', 'security-runtime-core', 'authenticated-dast',
      'runtime-integration', 'release-public', 'endpoint-depth', 'zap-baseline',
      'cross-stack', 'cross-stack-runtime', 'rights-matrix', 'csrf-matrix',
      'resilience', 'local-runtime-exposure', 'security-join', 'cross-stack-join',
      'runtime-state-stable'
    ]),
    'performance-evidence': Object.freeze([
      'backend-coverage-ready', 'frontend-coverage-ready', 'frontend-build-ready',
      'benchmark-build-ready', 'runtime-state-ready', 'backend-quiet-ready',
      'frontend-quiet-ready', 'build-static-quiet-ready', 'resident-handoff-ready',
      'privacy-zk-project-functional', 'coverage-merge', 'coverage-threshold',
      'privacy-zk-performance-ready', 'data-scale-xs', 'data-scale-s',
      'data-scale-summary', 'fault-injection', 'performance-measurement-ready',
      'backend-perf', 'privacy-zk-benchmark', 'privacy-zk-finalize',
      'mixed-performance-window', 'aeds-frame-cost', 'aeds-compression',
      'performance-summary', 'release-evidence', 'production-summary'
    ])
  })
})

export function assertProductionFreshBundleProducerWiring(bundleId, executedProducerIds) {
  const expected = productionFreshProducerInventory.bundles[bundleId]
  if (!expected) throw new Error(`Production Fresh physical bundle is absent from producer inventory: ${bundleId}`)
  const executed = [...new Set(executedProducerIds)].sort()
  const missing = expected.filter((producerId) => !executed.includes(producerId))
  const unexpected = executed.filter((producerId) => !expected.includes(producerId))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Production Fresh physical producer wiring mismatch for ${bundleId}:`
      + ` missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`
    )
  }
  return true
}

export function assertProductionFreshSchedulerProducerWiring(declarations) {
  const expected = productionFreshProducerInventory.schedulerProducers
  const actual = Object.keys(declarations).sort()
  const missing = expected.filter((producerId) => !Array.isArray(declarations[producerId])
    || declarations[producerId].length === 0)
  const unexpected = actual.filter((producerId) => !expected.includes(producerId))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      'Production Fresh scheduler producer wiring mismatch:'
      + ` missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`
    )
  }
  return true
}

function digest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function directoryIdentity(directory) {
  const stat = fs.statSync(directory, { bigint: true })
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode & 0o777n),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  }
}

export function beginProductionFreshForbiddenOutputObservation({ repositoryRoot }) {
  const root = path.resolve(repositoryRoot)
  const guards = []
  try {
    for (const relative of productionFreshForbiddenOutputRoots) {
      const directory = path.join(root, relative)
      assertContained(root, directory)
      assertNoSymlinkComponents(root, path.dirname(directory), { createDirectories: true })
      if (fs.existsSync(directory)) {
        throw new Error(`forbidden Production Fresh output root existed before producer spawn: ${relative}`)
      }
      fs.mkdirSync(directory)
      fs.chmodSync(directory, 0o555)
      guards.push({ relative, directory, identity: directoryIdentity(directory) })
    }
  } catch (error) {
    for (const guard of guards.reverse()) {
      fs.chmodSync(guard.directory, 0o755)
      fs.rmdirSync(guard.directory)
    }
    throw error
  }
  return {
    schema: 'fsusblog.production-fresh.forbidden-output-observation.v1',
    repositoryRoot: root,
    startedAt: new Date().toISOString(),
    guards
  }
}

export function finishProductionFreshForbiddenOutputObservation({ observation, layout, receiptFile }) {
  const violations = []
  try {
    for (const guard of observation.guards) {
      if (!fs.existsSync(guard.directory)) {
        violations.push(`${guard.relative}:removed`)
        continue
      }
      const stat = fs.lstatSync(guard.directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        violations.push(`${guard.relative}:replaced`)
        continue
      }
      const current = directoryIdentity(guard.directory)
      if (JSON.stringify(current) !== JSON.stringify(guard.identity)) {
        violations.push(`${guard.relative}:metadata-changed`)
      }
      const entries = fs.readdirSync(guard.directory).sort()
      if (entries.length > 0) violations.push(`${guard.relative}:entries=${entries.join(',')}`)
    }
    const receipt = {
      schema: observation.schema,
      runId: layout.runId,
      attemptId: layout.attemptId,
      outputRoot: layout.relativeOutputRoot,
      status: violations.length === 0 ? 'complete' : 'failed',
      forbiddenOutputRoots: productionFreshForbiddenOutputRoots,
      violations,
      startedAt: observation.startedAt,
      completedAt: new Date().toISOString()
    }
    const file = outputPath(layout, receiptFile)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  } finally {
    for (const guard of observation.guards.reverse()) {
      if (!fs.existsSync(guard.directory) || fs.lstatSync(guard.directory).isSymbolicLink()) continue
      fs.chmodSync(guard.directory, 0o755)
      fs.rmSync(guard.directory, { recursive: true, force: true })
    }
  }
  if (violations.length > 0) {
    throw new Error(`Production Fresh wrote or locked forbidden global correctness output: ${violations.join(', ')}`)
  }
  return true
}

function safeRelative(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/')
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`output path must be a safe non-empty relative path: ${value}`)
  }
  return normalized
}

function assertContained(root, candidate) {
  const resolved = path.resolve(candidate)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`output escapes run root: ${candidate}`)
  return resolved
}

function assertNoSymlinkComponents(root, candidate, { createDirectories = false } = {}) {
  const contained = assertContained(path.resolve(root), candidate)
  const relative = path.relative(path.resolve(root), contained)
  let current = path.resolve(root)
  const rootStat = fs.lstatSync(current)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`correctness output ancestor must be a real directory: ${current}`)
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!stat) {
      if (!createDirectories) continue
      fs.mkdirSync(current)
      stat = fs.lstatSync(current)
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`symlink is not allowed in a correctness output path: ${path.relative(root, current)}`)
    }
    if (current !== contained && !stat.isDirectory()) {
      throw new Error(`correctness output ancestor must be a directory: ${path.relative(root, current)}`)
    }
  }
  return contained
}

function walk(root, directory = root, entries = []) {
  if (!fs.existsSync(directory)) return entries
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name)
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in a correctness output root: ${path.relative(root, file)}`)
    if (stat.isDirectory()) walk(root, file, entries)
    else if (stat.isFile()) entries.push(path.relative(root, file).replaceAll(path.sep, '/'))
    else throw new Error(`non-regular correctness output is not allowed: ${path.relative(root, file)}`)
  }
  return entries
}

function nextAttemptId(attemptsRoot) {
  if (!fs.existsSync(attemptsRoot)) return 'attempt-0001'
  const indexes = fs.readdirSync(attemptsRoot)
    .map((name) => Number(attemptPattern.exec(name)?.[1]))
    .filter(Number.isInteger)
  return `attempt-${String(Math.max(0, ...indexes) + 1).padStart(4, '0')}`
}

export function createProductionFreshOutputRoot({ root, runId, resume = false, attemptId = null }) {
  const repositoryRoot = path.resolve(root)
  assertNoSymlinkComponents(repositoryRoot, repositoryRoot)
  const safeRun = safeRelative(runId)
  if (safeRun.includes('/')) throw new Error(`runId must be one path segment: ${runId}`)
  const runOutputRoot = path.join(repositoryRoot, '.tmp', 'test-runs', safeRun, 'outputs')
  const canonicalRunsRoot = path.join(repositoryRoot, '.tmp', 'test-runs')
  assertContained(canonicalRunsRoot, runOutputRoot)
  assertNoSymlinkComponents(repositoryRoot, runOutputRoot, { createDirectories: true })
  for (const partition of productionFreshOutputPartitions) {
    assertNoSymlinkComponents(repositoryRoot, path.join(runOutputRoot, partition), { createDirectories: true })
  }
  const attemptsRoot = path.join(runOutputRoot, 'attempts')
  assertNoSymlinkComponents(repositoryRoot, attemptsRoot, { createDirectories: true })
  if (resume) {
    verifyTerminalProductionFreshOutputs({
      repositoryRoot,
      runId: safeRun,
      runOutputRoot
    })
  }
  const selectedAttempt = attemptId ?? (resume ? nextAttemptId(attemptsRoot) : 'attempt-0001')
  if (!attemptPattern.test(selectedAttempt)) throw new Error(`attemptId must match ${attemptPattern}: ${selectedAttempt}`)
  const outputRoot = path.join(attemptsRoot, selectedAttempt)
  if (fs.existsSync(outputRoot)) {
    throw new Error(`production Fresh output attempt already exists: ${path.relative(repositoryRoot, outputRoot)}`)
  }
  assertNoSymlinkComponents(repositoryRoot, outputRoot, { createDirectories: true })
  for (const partition of productionFreshOutputPartitions) {
    assertNoSymlinkComponents(repositoryRoot, path.join(outputRoot, partition), { createDirectories: true })
  }
  return {
    repositoryRoot,
    runId: safeRun,
    attemptId: selectedAttempt,
    runOutputRoot,
    outputRoot,
    relativeRunOutputRoot: path.relative(repositoryRoot, runOutputRoot).replaceAll(path.sep, '/'),
    relativeOutputRoot: path.relative(repositoryRoot, outputRoot).replaceAll(path.sep, '/')
  }
}

export function resolveProductionFreshOutputAttempt({ root, runId, attemptId = null }) {
  const repositoryRoot = path.resolve(root)
  assertNoSymlinkComponents(repositoryRoot, repositoryRoot)
  const safeRun = safeRelative(runId)
  const runOutputRoot = path.join(repositoryRoot, '.tmp', 'test-runs', safeRun, 'outputs')
  const attemptsRoot = path.join(runOutputRoot, 'attempts')
  const attempts = fs.existsSync(attemptsRoot)
    ? fs.readdirSync(attemptsRoot).filter((name) => attemptPattern.test(name)).sort()
    : []
  const selectedAttempt = attemptId ?? attempts.at(-1)
  if (!selectedAttempt || !attemptPattern.test(selectedAttempt)) {
    throw new Error(`production Fresh output attempt is missing for run ${safeRun}`)
  }
  const outputRoot = path.join(attemptsRoot, selectedAttempt)
  assertNoSymlinkComponents(repositoryRoot, outputRoot)
  if (!fs.existsSync(outputRoot) || !fs.lstatSync(outputRoot).isDirectory()
    || fs.lstatSync(outputRoot).isSymbolicLink()) {
    throw new Error(`production Fresh output attempt is invalid: ${selectedAttempt}`)
  }
  return {
    repositoryRoot,
    runId: safeRun,
    attemptId: selectedAttempt,
    runOutputRoot,
    outputRoot,
    relativeRunOutputRoot: path.relative(repositoryRoot, runOutputRoot).replaceAll(path.sep, '/'),
    relativeOutputRoot: path.relative(repositoryRoot, outputRoot).replaceAll(path.sep, '/')
  }
}

export function outputPath(layout, relativeOutput) {
  const relative = safeRelative(relativeOutput)
  const file = assertContained(path.resolve(layout.outputRoot), path.join(layout.outputRoot, relative))
  const partition = relative.split('/')[0]
  if (!productionFreshOutputPartitions.includes(partition)) throw new Error(`output must use a declared partition: ${relative}`)
  assertNoSymlinkComponents(path.resolve(layout.repositoryRoot ?? layout.runOutputRoot), file)
  return file
}

export function productionFreshOutputEnvironment(layout, tierId) {
  const root = path.resolve(layout.outputRoot)
  const tier = safeRelative(tierId).replaceAll('/', '-')
  return {
    FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT: root,
    FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID: layout.attemptId,
    FSUSBLOG_TEST_RESULTS_ROOT: path.join(root, 'reports'),
    FSUSBLOG_COVERAGE_ROOT: path.join(root, 'coverage'),
    FSUSBLOG_COVERAGE_EVIDENCE_DIR: path.join(root, 'coverage'),
    FSUSBLOG_BACKEND_TRX_DIR: path.join(root, 'reports', 'trx', 'backend'),
    PLAYWRIGHT_OUTPUT_DIR: path.join(root, 'artifacts', 'playwright', tier),
    FSUSBLOG_BENCHMARK_ARTIFACT_ROOT: path.join(root, 'artifacts', 'benchmarkdotnet', tier),
    FSUSBLOG_PERFORMANCE_OUTPUT_ROOT: path.join(root, 'reports', 'performance'),
    FSUSBLOG_PERF_EVIDENCE_DIR: path.join(root, 'reports', 'performance'),
    FSUSBLOG_SECURITY_OUTPUT_ROOT: path.join(root, 'artifacts', 'security'),
    FSUSBLOG_SECURITY_EVIDENCE_DIR: path.join(root, 'artifacts', 'security'),
    FSUSBLOG_ZAP_OUT_DIR: path.join(root, 'artifacts', 'security', 'zap'),
    FSUSBLOG_FRONTEND_OUTPUT_ROOT: path.join(root, 'artifacts', 'frontend'),
    FSUSBLOG_DATA_SCALE_ROOT: path.join(root, 'artifacts', 'data-scale'),
    FSUSBLOG_UX_OUTPUT_ROOT: path.join(root, 'artifacts', 'ux'),
    FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT: path.join(root, 'logs', 'acceptance'),
    FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT: path.join(root, 'runtime', 'scenarios'),
    FSUSBLOG_RUNTIME_OUTPUT_ROOT: path.join(root, 'runtime', 'lane-evidence'),
    FSUSBLOG_CONTRACT_OUTPUT_ROOT: path.join(root, 'artifacts', 'contracts'),
    FSUSBLOG_FAULT_EVIDENCE_DIR: path.join(root, 'artifacts', 'fault-injection'),
    FSUSBLOG_FUZZ_EVIDENCE_DIR: path.join(root, 'artifacts', 'fuzz'),
    FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR: path.join(root, 'artifacts', 'operations'),
    FSUSBLOG_SOAK_EVIDENCE_DIR: path.join(root, 'artifacts', 'soak'),
    FSUSBLOG_DOWNLOADED_ARTIFACTS_ROOT: path.join(root, 'runtime', 'downloaded-artifacts'),
    FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR: path.join(root, 'artifacts', 'governance', 'projections'),
    FSUSBLOG_DOCS_EVIDENCE_DIR: path.join(root, 'artifacts', 'governance', 'docs'),
    FSUSBLOG_TEST_ASSET_AUDIT_DIR: path.join(root, 'artifacts', 'governance', 'test-asset-audit'),
    FSUSBLOG_TEST_GOVERNANCE_DIR: path.join(root, 'artifacts', 'governance', 'test-governance'),
    FSUSBLOG_ACCEPTANCE_ENV_ROOT: path.join(root, 'runtime', 'acceptance-env'),
    FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT: path.join(root, 'runtime', 'acceptance-fixtures'),
    FSUSBLOG_DATA_ROOT: path.join(root, 'runtime', 'data', tier),
    FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: path.join(root, 'artifacts', 'production-build'),
    FSUSBLOG_RELEASE_EVIDENCE_DIR: path.join(root, 'release-evidence'),
    FSUSBLOG_RELEASE_EVIDENCE_SOURCE_DIR: path.join(root, 'release-evidence'),
    FSUSBLOG_RELEASE_EVIDENCE_COLLECTION_DIR: path.join(root, 'release-evidence', tier),
    FSUSBLOG_PUBLIC_HYDRATION_MATRIX_SUMMARY_FILE: path.join(root, 'release-evidence', 'public-hydration-matrix-fast-summary.json'),
    FSUSBLOG_PERCEPTION_V2_OUT: path.join(root, 'artifacts', 'perception-v2', tier),
    FSUSBLOG_GATE_LOG_DIR: path.join(root, 'logs', 'gate'),
    FSUSBLOG_GATE_LOG_SOURCE_DIR: path.join(root, 'logs', 'gate'),
    FSUSBLOG_COLLECT_LIVE_GRANT_EVIDENCE_FILE: path.join(root, 'reports', 'live-grant', `${tier}.json`),
    FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE: path.join(root, 'runtime', 'perception-v2-e2e-runtime.json'),
    FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE: path.join(root, 'artifacts', 'perception-v2-test-matrix.json'),
    FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE: path.join(root, 'release-evidence', 'perception-v2-release-evidence.json')
  }
}

export function assertProductionFreshProducerConfiguration(layout, environment) {
  const required = [
    'FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT',
    'FSUSBLOG_TEST_RESULTS_ROOT',
    'FSUSBLOG_COVERAGE_ROOT',
    'FSUSBLOG_BACKEND_TRX_DIR',
    'PLAYWRIGHT_OUTPUT_DIR',
    'FSUSBLOG_BENCHMARK_ARTIFACT_ROOT',
    'FSUSBLOG_PERFORMANCE_OUTPUT_ROOT',
    'FSUSBLOG_SECURITY_OUTPUT_ROOT',
    'FSUSBLOG_SECURITY_EVIDENCE_DIR',
    'FSUSBLOG_FRONTEND_OUTPUT_ROOT',
    'FSUSBLOG_DATA_SCALE_ROOT',
    'FSUSBLOG_UX_OUTPUT_ROOT',
    'FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT',
    'FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT',
    'FSUSBLOG_RUNTIME_OUTPUT_ROOT',
    'FSUSBLOG_CONTRACT_OUTPUT_ROOT',
    'FSUSBLOG_FAULT_EVIDENCE_DIR',
    'FSUSBLOG_FUZZ_EVIDENCE_DIR',
    'FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR',
    'FSUSBLOG_SOAK_EVIDENCE_DIR',
    'FSUSBLOG_DOWNLOADED_ARTIFACTS_ROOT',
    'FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR',
    'FSUSBLOG_DOCS_EVIDENCE_DIR',
    'FSUSBLOG_TEST_ASSET_AUDIT_DIR',
    'FSUSBLOG_TEST_GOVERNANCE_DIR',
    'FSUSBLOG_ACCEPTANCE_ENV_ROOT',
    'FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT',
    'FSUSBLOG_DATA_ROOT',
    'FSUSBLOG_RELEASE_EVIDENCE_DIR'
  ]
  const outputRoot = path.resolve(layout.outputRoot)
  const errors = []
  for (const name of required) {
    const value = String(environment?.[name] ?? '').trim()
    if (!value) {
      errors.push(`${name}=missing`)
      continue
    }
    const resolved = path.resolve(value)
    if (resolved !== outputRoot && !resolved.startsWith(`${outputRoot}${path.sep}`)) {
      errors.push(`${name}=${value}`)
      continue
    }
    try {
      assertNoSymlinkComponents(path.resolve(layout.repositoryRoot ?? layout.runOutputRoot), resolved)
    } catch (error) {
      errors.push(`${name}=${error.message}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(`Production Fresh producer has fixed or escaping correctness output: ${errors.join(', ')}`)
  }
  return true
}

export function verifyProducerOutputs({ layout, producerId, relativeOutputs }) {
  if (!String(producerId ?? '').trim()) throw new Error('producerId is required')
  if (!Array.isArray(relativeOutputs) || relativeOutputs.length === 0) throw new Error(`${producerId} must declare relativeOutputs`)
  const declared = [...new Set(relativeOutputs.map(safeRelative))].sort()
  if (declared.length !== relativeOutputs.length) throw new Error(`${producerId} declares duplicate outputs`)
  const actual = walk(path.resolve(layout.outputRoot)).sort()
  const undeclared = actual.filter((file) => !declared.includes(file))
  const missing = declared.filter((file) => !actual.includes(file))
  if (undeclared.length || missing.length) {
    throw new Error(`${producerId} output inventory mismatch: undeclared=${undeclared.join(',') || 'none'} missing=${missing.join(',') || 'none'}`)
  }
  const perOutputDigest = Object.fromEntries(declared.map((relative) => [relative, digest(outputPath(layout, relative))]))
  return {
    runId: layout.runId,
    attemptId: layout.attemptId,
    producerId,
    outputRoot: layout.relativeOutputRoot,
    relativeOutputs: declared,
    perOutputDigest,
    outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(perOutputDigest)).digest('hex')}`
  }
}

export function captureProductionFreshOutputInventory(layout) {
  const root = path.resolve(layout.outputRoot)
  return Object.fromEntries(walk(root).sort().map((relative) => [relative, digest(path.join(root, relative))]))
}

export function verifyProducerOutputDelta({
  layout,
  producerId,
  before = {},
  relativeOutputs,
  allowedConcurrentOutputs = [],
  receiptFile = null
}) {
  const declared = [...new Set(relativeOutputs.map(safeRelative))].sort()
  const concurrent = new Set(allowedConcurrentOutputs.map(safeRelative))
  const after = captureProductionFreshOutputInventory(layout)
  const changed = Object.keys(after)
    .filter((relative) => before[relative] !== after[relative])
    .sort()
  const removed = Object.keys(before).filter((relative) => !Object.hasOwn(after, relative)).sort()
  const undeclared = changed.filter((relative) => !declared.includes(relative) && !concurrent.has(relative))
  const missing = declared.filter((relative) => !changed.includes(relative))
  if (undeclared.length || missing.length || removed.length) {
    throw new Error(
      `${producerId} output delta mismatch: undeclared=${undeclared.join(',') || 'none'}`
      + ` missing=${missing.join(',') || 'none'} removed=${removed.join(',') || 'none'}`
    )
  }
  const perOutputDigest = Object.fromEntries(declared.map((relative) => [relative, after[relative]]))
  const receipt = {
    runId: layout.runId,
    attemptId: layout.attemptId,
    producerId,
    outputRoot: layout.relativeOutputRoot,
    relativeOutputs: declared,
    perOutputDigest,
    outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(perOutputDigest)).digest('hex')}`
  }
  if (receiptFile) {
    const file = outputPath(layout, receiptFile)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  }
  return receipt
}

export function verifyProductionFreshReceiptInventory({
  layout,
  receipts,
  governanceOutputs = []
}) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error('production Fresh output inventory requires producer receipts')
  }
  const owners = new Map()
  for (const receipt of receipts) {
    if (receipt?.runId !== layout.runId || receipt?.attemptId !== layout.attemptId
      || receipt?.outputRoot !== layout.relativeOutputRoot || !String(receipt?.producerId ?? '').trim()
      || !Array.isArray(receipt.relativeOutputs) || receipt.relativeOutputs.length === 0) {
      throw new Error(`producer receipt identity is invalid: ${receipt?.producerId ?? 'missing'}`)
    }
    const expectedDigests = {}
    for (const relative of receipt.relativeOutputs.map(safeRelative)) {
      if (owners.has(relative)) {
        throw new Error(`producer output has multiple owners: ${relative} (${owners.get(relative)}, ${receipt.producerId})`)
      }
      const file = outputPath(layout, relative)
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
        throw new Error(`producer receipt output is missing or invalid: ${relative}`)
      }
      owners.set(relative, receipt.producerId)
      expectedDigests[relative] = digest(file)
    }
    if (JSON.stringify(expectedDigests) !== JSON.stringify(receipt.perOutputDigest)
      || `sha256:${crypto.createHash('sha256').update(JSON.stringify(expectedDigests)).digest('hex')}`
        !== receipt.outputInventoryDigest) {
      throw new Error(`producer receipt digest mismatch: ${receipt.producerId}`)
    }
  }
  const governanceEntries = Array.isArray(governanceOutputs)
    ? governanceOutputs.map((relative) => [safeRelative(relative), 'production-fresh-governance'])
    : Object.entries(governanceOutputs).map(([relative, owner]) => [safeRelative(relative), String(owner ?? '').trim()])
  if (governanceEntries.some(([, owner]) => !owner)) throw new Error('governance output owner is required')
  const governance = new Map(governanceEntries)
  for (const [relative, owner] of governance) {
    if (owners.has(relative)) {
      throw new Error(`governance output conflicts with producer owner: ${relative} (${owners.get(relative)}, ${owner})`)
    }
  }
  const actual = walk(path.resolve(layout.outputRoot)).sort()
  const undeclared = actual.filter((relative) => !owners.has(relative) && !governance.has(relative))
  const missingGovernance = [...governance.keys()].filter((relative) => !actual.includes(relative))
  if (undeclared.length || missingGovernance.length) {
    throw new Error(
      `production Fresh output inventory mismatch: undeclared=${undeclared.join(',') || 'none'}`
      + ` missingGovernance=${missingGovernance.join(',') || 'none'}`
    )
  }
  const perOutputDigest = Object.fromEntries(actual.map((relative) => [relative, digest(outputPath(layout, relative))]))
  return {
    runId: layout.runId,
    attemptId: layout.attemptId,
    producerId: 'production-fresh-output-inventory',
    outputRoot: layout.relativeOutputRoot,
    relativeOutputs: actual,
    perOutputDigest,
    outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(perOutputDigest)).digest('hex')}`
  }
}

export function productionFreshGovernanceOutputs(layout) {
  const actual = Object.keys(captureProductionFreshOutputInventory(layout))
  const rules = [
    [/^artifacts\/producer-receipts\/[^/]+\/[^/]+\.json$/u, 'producer-receipt-registry'],
    [/^bundles\/[^/]+\/member-summaries\/[^/]+\.json$/u, 'bundle-member-receipts'],
    [/^bundles\/[^/]+\/(?:summary|resource-utilization)\.json$/u, 'bundle-finalizer'],
    [/^bundles\/performance-evidence\/deadline-evidence\.json$/u, 'performance-bundle-finalizer'],
    [/^logs\/acceptance\//u, 'runtime-service-log-finalizer'],
    [/^runtime\/acceptance-env\/[^/]+\.env$/u, 'runtime-environment-coordinator']
  ]
  return Object.fromEntries(actual.flatMap((relative) => {
    const rule = rules.find(([pattern]) => pattern.test(relative))
    return rule ? [[relative, rule[1]]] : []
  }))
}

function protectionFile(layout) {
  return path.join(layout.runOutputRoot, 'terminal-attempts.json')
}

function readProtection(layout) {
  const file = protectionFile(layout)
  if (!fs.existsSync(file)) {
    return { schema: 'fsusblog.production-fresh.terminal-attempts.v1', runId: layout.runId, attempts: [] }
  }
  const document = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (document.schema !== 'fsusblog.production-fresh.terminal-attempts.v1'
    || document.runId !== layout.runId || !Array.isArray(document.attempts)) {
    throw new Error(`terminal attempt protection is invalid for run ${layout.runId}`)
  }
  return document
}

export function verifyTerminalProductionFreshOutputs(layout) {
  const document = readProtection(layout)
  for (const attempt of document.attempts) {
    const protectedLayout = resolveProductionFreshOutputAttempt({
      root: layout.repositoryRoot,
      runId: layout.runId,
      attemptId: attempt.attemptId
    })
    const current = captureProductionFreshOutputInventory(protectedLayout)
    const currentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex')}`
    if (currentDigest !== attempt.outputInventoryDigest) {
      throw new Error(`terminal Production Fresh attempt changed: ${layout.runId}/${attempt.attemptId}`)
    }
  }
  return document
}

export function mutateProductionFreshOutput({ layout, target, operation, destination = null, contents = '', mode = 0o644 }) {
  verifyTerminalProductionFreshOutputs(layout)
  const resolvedTarget = path.resolve(target)
  const ownRoot = path.resolve(layout.outputRoot)
  assertContained(ownRoot, resolvedTarget)
  assertNoSymlinkComponents(layout.repositoryRoot, resolvedTarget)
  if (destination) {
    const resolvedDestination = path.resolve(destination)
    assertContained(ownRoot, resolvedDestination)
    assertNoSymlinkComponents(layout.repositoryRoot, resolvedDestination)
  }
  if (operation === 'delete') fs.rmSync(resolvedTarget, { recursive: true, force: true })
  else if (operation === 'overwrite') fs.writeFileSync(resolvedTarget, contents)
  else if (operation === 'rename') fs.renameSync(resolvedTarget, path.resolve(destination))
  else if (operation === 'chmod') fs.chmodSync(resolvedTarget, mode)
  else throw new Error(`unsupported Production Fresh output mutation: ${operation}`)
}

export function sealTerminalProductionFreshOutputs(layout) {
  const root = path.resolve(layout.outputRoot)
  const protection = readProtection(layout)
  if (protection.attempts.some((attempt) => attempt.attemptId === layout.attemptId)) {
    throw new Error(`production Fresh output attempt is already terminal: ${layout.attemptId}`)
  }
  const inventory = captureProductionFreshOutputInventory(layout)
  protection.attempts.push({
    attemptId: layout.attemptId,
    relativeOutputRoot: layout.relativeOutputRoot,
    outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`
  })
  const file = protectionFile(layout)
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(protection, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o444)
  for (const file of walk(root).map((relative) => path.join(root, relative))) fs.chmodSync(file, 0o444)
  const directories = [root]
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const child = path.join(directory, name)
      if (fs.lstatSync(child).isDirectory()) { directories.push(child); visit(child) }
    }
  }
  visit(root)
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o555)
}

export async function finalizeProductionFreshAttempt(layout, operation) {
  try {
    return await operation()
  } finally {
    sealTerminalProductionFreshOutputs(layout)
  }
}
