#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const xunitRunner = JSON.parse(await readFile(path.join(root, 'tests/backend/xunit.runner.json'), 'utf8'))
assert.equal(xunitRunner.stopOnFail, false, 'xUnit must collect all failures in each run')
const suiteSupport = await readFile(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8')
const parallelHelper = suiteSupport.slice(
  suiteSupport.indexOf('RunParallel()'),
  suiteSupport.indexOf('\nProbeUrl()')
)
assert.doesNotMatch(parallelHelper, /kill "\$pid"/, 'parallel groups must not kill peers after one failure')
assert.match(parallelHelper, /local -a failures=\(\)/u)
assert.match(parallelHelper, /parallel group failed: \$group \(\$\{failures\[\*\]\}\)/u)
const securityStaticRunner = suiteSupport.slice(
  suiteSupport.indexOf('RunSecurityStaticOnly()'),
  suiteSupport.indexOf('\nRunSecurityRuntimeCoreOnly()')
)
const securityRuntimeRunner = suiteSupport.slice(
  suiteSupport.indexOf('RunSecurityRuntimeCoreOnly()'),
  suiteSupport.indexOf('\nRunSecurityOnly()')
)
const securityRunner = suiteSupport.slice(
  suiteSupport.indexOf('RunSecurityOnly()'),
  suiteSupport.indexOf('\nRunSecurity()')
)
assert.match(securityStaticRunner, /RunParallel "security-static"/u)
assert.doesNotMatch(securityStaticRunner, /RequireDebugStack/u)
assert.match(securityRuntimeRunner, /RunParallel "security-runtime-core"/u)
assert.match(securityRuntimeRunner, /local -a securityFailures=\(\)/u)
assert.match(securityRuntimeRunner, /security stage failed, continuing/u)
assert.match(securityRunner, /RunParallel "security-phases"/u)

async function importRequired(relativePath) {
  const absolutePath = path.join(root, relativePath)
  try {
    return await import(`${pathToFileURL(absolutePath).href}?contract=${Date.now()}`)
  } catch (error) {
    assert.fail(`required helper is not importable: ${relativePath}: ${error.message}`)
  }
}

const vitest = await importRequired('src/frontend/vitest.shared.mjs')
const overridden = vitest.resolveVitestWorkerCount({
  env: { FSUSBLOG_VITEST_MAX_WORKERS: '7' },
  cpuCount: 16,
  freeMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
  load1: 0
})
assert.equal(overridden, 7, 'explicit Vitest worker cap must be applied after host capacity')
assert.equal(vitest.resolveVitestWorkerCount({
  env: {}, cpuCount: 16, freeMemoryBytes: 512 * 1024 ** 2, totalMemoryBytes: 32 * 1024 ** 3, load1: 0
}), 1, 'low-memory hosts must fall back to one Vitest worker')
assert.equal(vitest.resolveVitestWorkerCount({
  env: {}, cpuCount: 8, freeMemoryBytes: 16 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3, load1: 7.5
}), 1, 'high-load hosts must fall back to one Vitest worker')
assert.equal(vitest.resolveVitestWorkerCount({
  env: {
    FSUSBLOG_STEP_CPU_BUDGET: '3',
    FSUSBLOG_BUNDLE_CPU_UNITS: '6',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '12',
    FSUSBLOG_STEP_MEMORY_GIB: '6'
  },
  cpuCount: 16,
  freeMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
  load1: 15
}), 3, 'Vitest must prefer the actual step grant and ignore unrelated host load under scheduler control')
assert.equal(vitest.resolveVitestWorkerCount({
  env: {
    FSUSBLOG_BUNDLE_CPU_UNITS: '6',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '12',
    FSUSBLOG_BUNDLE_MEMORY_GIB: '8'
  },
  cpuCount: 16,
  freeMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
  load1: 15
}), 6, 'scheduler-managed Vitest must use the CPU grant already admitted against live memory')
assert.equal(vitest.resolveVitestWorkerCount({
  env: {
    FSUSBLOG_STEP_CPU_BUDGET: '2',
    FSUSBLOG_STEP_MEMORY_GIB: '1.03'
  },
  cpuCount: 8,
  freeMemoryBytes: 2 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
  load1: 7
}), 2, 'a two-CPU admitted step must not be collapsed by host-average memory accounting')
assert.throws(() => vitest.resolveVitestWorkerCount({
  env: { FSUSBLOG_STEP_CPU_BUDGET: '0', FSUSBLOG_BUNDLE_CPU_UNITS: '8' },
  cpuCount: 16,
  freeMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3
}), /FSUSBLOG_STEP_CPU_BUDGET must be a positive finite number/u)
assert.doesNotMatch(
  await readFile(path.join(root, 'src/frontend/vitest.shared.mjs'), 'utf8'),
  /FSUSBLOG_VITEST_MEMORY_PER_WORKER_BYTES/u,
  'Vitest must derive per-worker memory from current host capacity instead of a fixed GiB value'
)

const playwrightWorkers = await importRequired('tools/test/resolve-playwright-workers.mjs')
assert.equal(playwrightWorkers.resolvePlaywrightWorkerCount({
  profile: 'visual-console',
  env: {
    FSUSBLOG_STEP_CPU_BUDGET: '3',
    FSUSBLOG_BUNDLE_CPU_UNITS: '6',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '12',
    FSUSBLOG_STEP_MEMORY_GIB: '6'
  },
  cpuCount: 16,
  availableMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
  load1: 15,
  busyCpus: 15
}).workers, 3, 'Playwright must prefer the actual step grant and use all granted CPU when memory allows')
assert.equal(playwrightWorkers.resolvePlaywrightWorkerCount({
  profile: 'acceptance-public-routes',
  env: {
    FSUSBLOG_BUNDLE_CPU_UNITS: '6',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '12',
    FSUSBLOG_BUNDLE_MEMORY_GIB: '8'
  },
  cpuCount: 16,
  availableMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
  load1: 15,
  busyCpus: 15
}).workers, 4, 'Playwright must cap the CPU grant with its dynamic proportional-memory capacity')
assert.equal(playwrightWorkers.resolvePlaywrightWorkerCount({
  env: {},
  cpuCount: 8,
  availableMemoryBytes: 16 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
  load1: 7,
  busyCpus: 7
}).workers, 1, 'unmanaged Playwright must retain capacity for current host pressure')
assert.throws(() => playwrightWorkers.resolvePlaywrightWorkerCount({
  env: { FSUSBLOG_STEP_MEMORY_GIB: 'invalid', FSUSBLOG_BUNDLE_MEMORY_GIB: '32' },
  cpuCount: 16,
  availableMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3
}), /FSUSBLOG_STEP_MEMORY_GIB must be a positive finite number/u)
const playwrightConfigSource = await readFile(path.join(root, 'src/frontend/playwright.config.ts'), 'utf8')
for (const token of [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_BUNDLE_CPU_UNITS',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'os.freemem()',
  'os.totalmem()',
  'dynamicWorkerCap'
]) {
  assert.match(playwrightConfigSource, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
}
assert.doesNotMatch(playwrightConfigSource, /process\.env\.CI\s*\?\s*\d+/u)
const consoleVisualSource = await readFile(path.join(root, 'tools/frontend/check-console-visual.sh'), 'utf8')
assert.match(consoleVisualSource, /resolve-playwright-workers\.mjs visual-console/u)

const fastOptions = vitest.createVitestRuntimeOptions('unit-core', {
  env: { FSUSBLOG_TEST_SHARD_INDEX: '2', FSUSBLOG_TEST_SHARD_TOTAL: '4' },
  cpuCount: 8,
  freeMemoryBytes: 16 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
  load1: 0,
  argv: []
})
assert.equal(fastOptions.bail, 0, 'fast Vitest runs must collect all failures')
assert.match(fastOptions.outputFile.json, /unit-core[\\/]shard-2-of-4\.json$/u)
assert.match(fastOptions.outputFile.junit, /unit-core[\\/]shard-2-of-4\.xml$/u)
assert.deepEqual(fastOptions.reporters, ['default', 'json', 'junit'])

const coverageOptions = vitest.createVitestRuntimeOptions('unit-core', {
  env: {}, cpuCount: 8, freeMemoryBytes: 16 * 1024 ** 3, load1: 0, argv: ['--coverage']
})
assert.equal(coverageOptions.bail, 0, 'coverage must collect all failures')
assert.match(coverageOptions.outputFile.json, /unit-core-coverage[\\/]unsharded\.json$/u)

const diagnosticOptions = vitest.createVitestRuntimeOptions('unit-core', {
  env: { FSUSBLOG_VITEST_DIAGNOSTIC: '1' },
  cpuCount: 8,
  freeMemoryBytes: 16 * 1024 ** 3,
  load1: 0,
  argv: ['--coverage']
})
assert.equal(diagnosticOptions.bail, 0, 'explicit diagnostic runs must collect all failures')

const ignoredBailOverride = vitest.createVitestRuntimeOptions('unit-core', {
  env: { FSUSBLOG_VITEST_BAIL: '1' },
  cpuCount: 8,
  freeMemoryBytes: 16 * 1024 ** 3,
  load1: 0,
  argv: []
})
assert.equal(ignoredBailOverride.bail, 0, 'Vitest must not restore a maximum failure cutoff')

const fixturePaths = await importRequired('tests/frontend/support/fixture-paths.mjs')
const fixtureEnv = { FSUSBLOG_TEST_NAMESPACE: 'CI shard/2' }
assert.equal(fixturePaths.resolveFixtureNamespace(fixtureEnv), 'ci-shard-2')
assert.equal(fixturePaths.resolveFixtureNamespace({ FSUSBLOG_TEST_NAMESPACE: '..' }), 'local')
assert.match(
  fixturePaths.resolveFixtureRoot({ env: { FSUSBLOG_TEST_NAMESPACE: '..' }, repoRoot: '/repo' }),
  /^\/repo\/\.tmp\/fixtures\/local$/u
)
assert.match(
  fixturePaths.resolvePublicFixtureFile({ env: fixtureEnv, repoRoot: '/repo' }),
  /^\/repo\/\.tmp\/fixtures\/ci-shard-2\/public\.aeds$/u
)
assert.match(
  fixturePaths.resolveSessionFixtureFile('pw-3', { env: fixtureEnv, repoRoot: '/repo' }),
  /\/\.tmp\/fixtures\/ci-shard-2\/sessions\/pw-3\.aeds$/u
)

const authFixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-auth-fixture-'))
const previousFixtureRoot = process.env.FSUSBLOG_FIXTURE_ROOT
try {
  process.env.FSUSBLOG_FIXTURE_ROOT = authFixtureRoot
  const sessionFixtures = await importRequired('tests/frontend/support/session-fixtures.mjs')
  const sessionFixtureSource = await readFile(
    path.join(root, 'tests/frontend/support/session-fixtures.mjs'),
    'utf8'
  )
  assert.match(
    sessionFixtureSource,
    /account_subject_hash\s*=\s*\$\{sqlString\(accountSubjectHashValue\)\}/u,
    'fixture account reset must persist the same stable subject hash carried by its JWT'
  )
  assert.match(
    sessionFixtureSource,
    /\[ACCOUNT_SUBJECT_HASH_CLAIM\]:\s*accountSubjectHashValue/u,
    'fixture JWT must carry the persisted stable account subject hash'
  )
  await sessionFixtures.persistAuthFixtureManifest({
    user: { userId: 'user-1', sessionId: 'session-user', cookieHeader: 'fsus-user=value' },
    admin: { adminId: 'admin-1', sessionId: 'session-admin', cookieHeader: 'fsus-admin=value' },
    baseUrl: 'http://127.0.0.1:3000'
  })
  const authDirectory = path.join(authFixtureRoot, 'auth')
  assert.equal((await stat(authDirectory)).mode & 0o777, 0o700, 'auth fixture directory must be owner-only')
  for (const fixtureFile of ['auth-fixtures.json', 'user.storage-state.json', 'admin.storage-state.json']) {
    assert.equal(
      (await stat(path.join(authDirectory, fixtureFile))).mode & 0o777,
      0o600,
      `${fixtureFile} must be owner-only`
    )
  }
} finally {
  if (previousFixtureRoot == null) delete process.env.FSUSBLOG_FIXTURE_ROOT
  else process.env.FSUSBLOG_FIXTURE_ROOT = previousFixtureRoot
  await rm(authFixtureRoot, { recursive: true, force: true })
}

const runOnce = await importRequired('tools/test/run-once.mjs')
const fingerprintCli = path.join(root, 'tools/test/run-once.mjs')
const secretProbe = 'fixture-secret-that-must-not-appear-in-argv-or-output'
const fingerprintWithSecret = (secret) => spawnSync(process.execPath, [
  fingerprintCli,
  'fingerprint',
  '--root', root,
  '--secret-env', 'FSUSBLOG_SECRET_FINGERPRINT_PROBE'
], {
  cwd: root,
  env: { ...process.env, FSUSBLOG_SECRET_FINGERPRINT_PROBE: secret },
  encoding: 'utf8'
})
const firstSecretFingerprint = fingerprintWithSecret(secretProbe)
const secondSecretFingerprint = fingerprintWithSecret(`${secretProbe}-changed`)
assert.equal(firstSecretFingerprint.status, 0, firstSecretFingerprint.stderr)
assert.equal(secondSecretFingerprint.status, 0, secondSecretFingerprint.stderr)
assert.match(firstSecretFingerprint.stdout.trim(), /^[a-f0-9]{64}$/u)
assert.notEqual(firstSecretFingerprint.stdout.trim(), secondSecretFingerprint.stdout.trim())
assert.doesNotMatch(`${firstSecretFingerprint.stdout}\n${firstSecretFingerprint.stderr}`, new RegExp(secretProbe, 'u'))
assert.doesNotMatch(JSON.stringify([
  fingerprintCli,
  'fingerprint',
  '--root', root,
  '--secret-env', 'FSUSBLOG_SECRET_FINGERPRINT_PROBE'
]), new RegExp(secretProbe, 'u'))

const frontendFingerprintRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-frontend-fingerprint-'))
try {
  const captureFile = path.join(frontendFingerprintRoot, 'args.txt')
  const legacyTestScript = path.join(root, 'tools/test/lanes/_suite-support.sh')
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1
source "$1"
TestInputFingerprint() {
  printf '%s\\n' "$@" > "$CAPTURE_FILE"
  printf 'test-fingerprint'
}
RunOnceCommand() { :; }
RunFrontendFastBuildGroup
`, 'bash', legacyTestScript], {
    cwd: root,
    env: { ...process.env, CAPTURE_FILE: captureFile },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const capturedArguments = (await readFile(captureFile, 'utf8')).trim().split('\n')
  const configuredPaths = capturedArguments.flatMap((argument, index) => (
    argument === '--path' ? [capturedArguments[index + 1]] : []
  ))
  const tsconfigFiles = (await readdir(path.join(root, 'src/frontend')))
    .filter((name) => /^tsconfig.*\.json$/u.test(name))
    .map((name) => `src/frontend/${name}`)
    .sort()
  assert.deepEqual(
    configuredPaths.filter((file) => /^src\/frontend\/tsconfig.*\.json$/u.test(file)).sort(),
    tsconfigFiles,
    'frontend fast build fingerprint must include every existing tsconfig*.json'
  )
} finally {
  await rm(frontendFingerprintRoot, { recursive: true, force: true })
}

const fixtureGenerationRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-fixture-generation-'))
try {
  const captureFile = path.join(fixtureGenerationRoot, 'fingerprints.txt')
  const legacyTestScript = path.join(root, 'tools/test/lanes/_suite-support.sh')
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1
source "$1"
FixtureRootPath() { printf '%s\\n' "$FIXTURE_ROOT"; }
RunOnceCommand() { printf '%s:%s\\n' "$1" "$2" >> "$CAPTURE_FILE"; }
export FSUSBLOG_TEST_NAMESPACE=contract
export FSUSBLOG_FIXTURE_SERVICE_GENERATION=generation-a
PrepareAuthFixturesOnce
PreparePublicFixturesOnce
PrepareAuthFixturesOnce
PreparePublicFixturesOnce
export FSUSBLOG_FIXTURE_SERVICE_GENERATION=generation-b
PrepareAuthFixturesOnce
PreparePublicFixturesOnce
`, 'bash', legacyTestScript], {
    cwd: root,
    env: {
      ...process.env,
      CAPTURE_FILE: captureFile,
      FIXTURE_ROOT: path.join(fixtureGenerationRoot, 'fixtures')
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const captured = (await readFile(captureFile, 'utf8')).trim().split('\n').map((line) => line.split(':'))
  for (const key of ['auth-fixtures', 'public-fixtures']) {
    const fingerprints = captured.filter(([capturedKey]) => capturedKey === key).map(([, value]) => value)
    assert.equal(fingerprints.length, 3)
    assert.equal(fingerprints[0], fingerprints[1], `${key} must reuse one fingerprint for unchanged service containers`)
    assert.notEqual(fingerprints[1], fingerprints[2], `${key} must rerun after same-name service containers are recreated`)
  }
} finally {
  await rm(fixtureGenerationRoot, { recursive: true, force: true })
}
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-run-once-'))
try {
  const counterFile = path.join(tempRoot, 'counter.txt')
  let executions = 0
  const operation = async () => {
    executions += 1
    await writeFile(counterFile, String(executions), 'utf8')
  }
  await runOnce.runOnce({ root: tempRoot, namespace: 'contract', key: 'fixture', fingerprint: 'a' }, operation)
  await runOnce.runOnce({ root: tempRoot, namespace: 'contract', key: 'fixture', fingerprint: 'a' }, operation)
  assert.equal(await readFile(counterFile, 'utf8'), '1', 'matching fingerprints must execute once')
  await runOnce.runOnce({ root: tempRoot, namespace: 'contract', key: 'fixture', fingerprint: 'b' }, operation)
  assert.equal(await readFile(counterFile, 'utf8'), '2', 'changed fingerprints must rerun')
  const traversalResult = await runOnce.runOnce({
    root: tempRoot,
    namespace: '..',
    key: 'namespace-safety',
    fingerprint: 'safe'
  }, async () => {})
  assert.ok(
    path.relative(tempRoot, traversalResult.stateFile).split(path.sep)[0] !== '..',
    'run-once namespace must not escape its state root'
  )
  const slowOperation = async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 75))
    await writeFile(counterFile, String(executions), 'utf8')
  }
  await Promise.all([
    runOnce.runOnce({ root: tempRoot, namespace: 'contract', key: 'fixture', fingerprint: 'c' }, slowOperation),
    runOnce.runOnce({ root: tempRoot, namespace: 'contract', key: 'fixture', fingerprint: 'c' }, slowOperation)
  ])
  assert.equal(await readFile(counterFile, 'utf8'), '3', 'matching concurrent requests must share one lock owner')

  const requiredArtifact = path.join(tempRoot, 'required-artifact.txt')
  let artifactExecutions = 0
  const writeRequiredArtifact = async () => {
    artifactExecutions += 1
    await writeFile(requiredArtifact, `artifact-${artifactExecutions}`, 'utf8')
  }
  const artifactOptions = {
    root: tempRoot,
    namespace: 'contract',
    key: 'required-artifact',
    fingerprint: 'artifact-v1',
    requiredOutputs: [requiredArtifact]
  }
  await runOnce.runOnce(artifactOptions, writeRequiredArtifact)
  await runOnce.runOnce(artifactOptions, writeRequiredArtifact)
  assert.equal(artifactExecutions, 1, 'unchanged required outputs must preserve the run-once cache hit')
  await writeFile(requiredArtifact, 'tampered-artifact', 'utf8')
  await runOnce.runOnce(artifactOptions, writeRequiredArtifact)
  assert.equal(artifactExecutions, 2, 'changed required outputs must invalidate the run-once cache hit')

  const companionArtifact = path.join(tempRoot, 'required-companion.json')
  let companionExecutions = 0
  const writeArtifactSet = async () => {
    companionExecutions += 1
    await writeFile(requiredArtifact, `set-${companionExecutions}`, 'utf8')
    await writeFile(companionArtifact, `companion-${companionExecutions}`, 'utf8')
  }
  const artifactSetOptions = {
    root: tempRoot,
    namespace: 'contract',
    key: 'required-artifact-set',
    fingerprint: 'artifact-set-v1',
    requiredOutputs: [requiredArtifact, companionArtifact]
  }
  await runOnce.runOnce(artifactSetOptions, writeArtifactSet)
  await runOnce.runOnce(artifactSetOptions, writeArtifactSet)
  assert.equal(companionExecutions, 1, 'complete required output sets must preserve the run-once cache hit')
  await rm(companionArtifact)
  await runOnce.runOnce(artifactSetOptions, writeArtifactSet)
  assert.equal(companionExecutions, 2, 'a missing companion output must invalidate the run-once cache hit')

  let releaseActiveLock
  let reportActiveLock
  const activeLockEntered = new Promise((resolve) => { reportActiveLock = resolve })
  const activeLockRelease = new Promise((resolve) => { releaseActiveLock = resolve })
  let activeLockExecutions = 0
  const activeLockOptions = {
    root: tempRoot,
    namespace: 'contract',
    key: 'active-lock',
    fingerprint: 'active-v1',
    lockTimeoutMs: 2_000,
    staleLockMs: 20,
    heartbeatMs: 1_000
  }
  const firstActiveLock = runOnce.runOnce(activeLockOptions, async () => {
    activeLockExecutions += 1
    const lockDirectory = path.join(tempRoot, 'contract', 'active-lock.lock')
    const ownerFile = path.join(lockDirectory, 'owner.json')
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    await writeFile(ownerFile, `${JSON.stringify({ ...owner, heartbeatAt: new Date(0).toISOString() })}\n`, 'utf8')
    await utimes(ownerFile, new Date(0), new Date(0))
    await utimes(lockDirectory, new Date(0), new Date(0))
    reportActiveLock()
    await activeLockRelease
  })
  await activeLockEntered
  const secondActiveLock = runOnce.runOnce(activeLockOptions, async () => {
    activeLockExecutions += 1
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  releaseActiveLock()
  await Promise.all([firstActiveLock, secondActiveLock])
  assert.equal(activeLockExecutions, 1, 'an active lock owner must not be stolen when the lock timestamp looks stale')
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

const runBoundRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-run-bound-execution-'))
try {
  let executions = 0
  const options = (overrides = {}) => ({
    root: runBoundRoot,
    runId: 'fresh-run-a',
    key: 'governance-check',
    command: ['node', 'governance-check.mjs'],
    cwd: root,
    inputDigest: 'input-a',
    environmentDigest: 'environment-a',
    outputContract: [],
    requiredOutputs: [],
    commit: 'commit-a',
    worktreeFingerprint: 'worktree-a',
    testIds: ['governance-check'],
    consumerId: 'consumer-a',
    ...overrides
  })
  const slowSuccess = async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  const concurrent = await Promise.all([
    runOnce.runBoundExecution(options({ consumerId: 'consumer-a' }), slowSuccess),
    runOnce.runBoundExecution(options({ consumerId: 'consumer-b' }), slowSuccess)
  ])
  assert.equal(executions, 1, 'run-bound concurrent consumers must start one physical producer')
  assert.deepEqual(concurrent.map((entry) => entry.status).sort(), ['executed', 'shared-current-run'])

  await runOnce.runBoundExecution(options({
    environmentDigest: 'environment-b',
    consumerId: 'different-environment'
  }), async () => { executions += 1 })
  await runOnce.runBoundExecution(options({
    inputDigest: 'input-b',
    consumerId: 'different-input'
  }), async () => { executions += 1 })
  await runOnce.runBoundExecution(options({
    outputContract: ['different-output'],
    consumerId: 'different-output'
  }), async () => { executions += 1 })
  assert.equal(executions, 4, 'different environment/input/output contracts must not merge')

  let testIdExecutions = 0
  const normalizedTestIdProducer = await runOnce.runBoundExecution(options({
    key: 'test-id-contract',
    testIds: ['governance-secondary', 'governance-check', 'governance-check'],
    consumerId: 'test-id-producer'
  }), async () => { testIdExecutions += 1 })
  const normalizedTestIdConsumer = await runOnce.runBoundExecution(options({
    key: 'test-id-contract',
    testIds: ['governance-check', 'governance-secondary'],
    consumerId: 'test-id-consumer'
  }), async () => { testIdExecutions += 1 })
  assert.equal(testIdExecutions, 1, 'normalized equivalent test ID contracts must share one receipt')
  assert.equal(normalizedTestIdConsumer.receiptFile, normalizedTestIdProducer.receiptFile)
  const normalizedTestIdReceipt = JSON.parse(await readFile(normalizedTestIdProducer.receiptFile, 'utf8'))
  assert.deepEqual(normalizedTestIdReceipt.testIds, ['governance-check', 'governance-secondary'])

  const injectedTestIdConsumer = await runOnce.runBoundExecution(options({
    key: 'test-id-contract',
    testIds: ['forged-test-id', 'governance-check', 'governance-secondary'],
    consumerId: 'test-id-injection'
  }), async () => { testIdExecutions += 1 })
  assert.equal(testIdExecutions, 2, 'a new logical test ID must not be projected from an existing physical receipt')
  assert.notEqual(injectedTestIdConsumer.receiptFile, normalizedTestIdProducer.receiptFile)

  let failureExecutions = 0
  const producerFailure = async () => {
    failureExecutions += 1
    await new Promise((resolve) => setTimeout(resolve, 50))
    throw Object.assign(new Error('producer failed exactly once'), { exitCode: 17 })
  }
  const failedConsumers = await Promise.allSettled([
    runOnce.runBoundExecution(options({ key: 'failure', consumerId: 'failure-a' }), producerFailure),
    runOnce.runBoundExecution(options({ key: 'failure', consumerId: 'failure-b' }), producerFailure)
  ])
  assert.equal(failureExecutions, 1, 'producer failure must not trigger a consumer fallback rerun')
  assert.ok(failedConsumers.every((entry) => entry.status === 'rejected'))
  assert.ok(failedConsumers.every((entry) => entry.reason.exitCode === 17), 'producer exit status must propagate to every consumer')

  let cancellationExecutions = 0
  const cancellation = Object.assign(new Error('cancelled producer'), { name: 'AbortError', signal: 'SIGTERM' })
  await assert.rejects(
    runOnce.runBoundExecution(options({ key: 'cancelled' }), async () => {
      cancellationExecutions += 1
      throw cancellation
    }),
    /cancelled producer/u
  )
  await assert.rejects(
    runOnce.runBoundExecution(options({ key: 'cancelled', consumerId: 'cancelled-consumer' }), async () => {
      cancellationExecutions += 1
    }),
    /cancelled producer/u
  )
  assert.equal(cancellationExecutions, 1, 'cancelled receipts must release waiters without rerun')

  await runOnce.runBoundExecution(options({ runId: 'fresh-run-b', consumerId: 'fresh-run-b' }), async () => {
    executions += 1
  })
  assert.equal(executions, 5, 'a new Fresh run must not read the previous run receipt')

  const tamperResult = await runOnce.runBoundExecution(options({ key: 'tamper', consumerId: 'tamper-producer' }), async () => {})
  const tamperedReceipt = JSON.parse(await readFile(tamperResult.receiptFile, 'utf8'))
  tamperedReceipt.status = 'failure'
  await writeFile(tamperResult.receiptFile, `${JSON.stringify(tamperedReceipt, null, 2)}\n`, 'utf8')
  await assert.rejects(
    runOnce.runBoundExecution(options({ key: 'tamper', consumerId: 'tamper-consumer' }), async () => {
      assert.fail('tampered receipt must fail closed before operation starts')
    }),
    /receipt integrity validation failed/u
  )

  const artifact = path.join(runBoundRoot, 'artifact.json')
  const artifactOptions = options({
    key: 'artifact-projection',
    outputContract: ['artifact.json'],
    requiredOutputs: [artifact]
  })
  await runOnce.runBoundExecution(artifactOptions, async () => writeFile(artifact, '{"ok":true}\n', 'utf8'))
  await writeFile(artifact, '{"ok":false}\n', 'utf8')
  await assert.rejects(
    runOnce.runBoundExecution({ ...artifactOptions, consumerId: 'artifact-consumer' }, async () => {
      assert.fail('tampered artifact must fail closed before operation starts')
    }),
    /output projection failed closed/u
  )

  const summary = JSON.parse(await readFile(path.join(runBoundRoot, 'fresh-run-a', 'summary.json'), 'utf8'))
  assert.ok(summary.dedupHits >= 2, 'run-bound summary must record dedup consumers')
  assert.ok(summary.avoidedChildStartups >= 2, 'run-bound summary must record avoided child startups')
  assert.ok(summary.receiptBytes > 0, 'run-bound summary must report receipt evidence bytes')
  const projectionFiles = await readdir(path.join(runBoundRoot, 'fresh-run-a', 'projections'))
  const projection = JSON.parse(await readFile(path.join(runBoundRoot, 'fresh-run-a', 'projections', projectionFiles[0]), 'utf8'))
  assert.match(projection.physicalExecutionReceipt, /\/receipts\//u)
  assert.ok(projection.physicalExecutionReceiptDigest, 'logical projection must bind the physical receipt digest')

  const summaryRunId = 'summary-concurrency'
  const summaryRunDirectory = path.join(runBoundRoot, summaryRunId)
  const summaryLockDirectory = path.join(summaryRunDirectory, '.summary.lock')
  await mkdir(summaryLockDirectory, { recursive: true })
  await writeFile(path.join(summaryLockDirectory, 'owner.json'), `${JSON.stringify({
    token: 'test-held-summary-lock',
    pid: process.pid,
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  })}\n`, 'utf8')

  let concurrentPhysicalExecutions = 0
  let activePhysicalExecutions = 0
  let peakPhysicalExecutions = 0
  let releasePhysicalExecutions
  let reportPhysicalOverlap
  const physicalOverlap = new Promise((resolve) => { reportPhysicalOverlap = resolve })
  const physicalRelease = new Promise((resolve) => { releasePhysicalExecutions = resolve })
  const concurrentSummaryOptions = (key) => options({
    runId: summaryRunId,
    key,
    command: ['node', `${key}.mjs`],
    inputDigest: `${key}-input`,
    testIds: [`${key}-test`],
    consumerId: `${key}-consumer`,
    lockTimeoutMs: 2_000,
    staleLockMs: 1_000,
    heartbeatMs: 10
  })
  const concurrentSummaryProducer = async () => {
    concurrentPhysicalExecutions += 1
    activePhysicalExecutions += 1
    peakPhysicalExecutions = Math.max(peakPhysicalExecutions, activePhysicalExecutions)
    if (activePhysicalExecutions === 2) reportPhysicalOverlap()
    await physicalRelease
    activePhysicalExecutions -= 1
  }
  const concurrentSummaryRuns = [
    runOnce.runBoundExecution(concurrentSummaryOptions('summary-a'), concurrentSummaryProducer),
    runOnce.runBoundExecution(concurrentSummaryOptions('summary-b'), concurrentSummaryProducer)
  ]
  await physicalOverlap
  assert.equal(peakPhysicalExecutions, 2, 'the run-summary lock must not serialize different physical execution keys')
  releasePhysicalExecutions()

  let projectionCount = 0
  for (let attempt = 0; attempt < 100 && projectionCount < 2; attempt += 1) {
    try {
      projectionCount = (await readdir(path.join(summaryRunDirectory, 'projections'))).length
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (projectionCount < 2) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(projectionCount, 2, 'both different-key projections must reach the summary critical section')
  await rm(summaryLockDirectory, { recursive: true, force: true })
  await Promise.all(concurrentSummaryRuns)
  assert.equal(concurrentPhysicalExecutions, 2)
  const concurrentSummary = JSON.parse(await readFile(path.join(summaryRunDirectory, 'summary.json'), 'utf8'))
  assert.equal(concurrentSummary.physicalExecutions, 2, 'a late summary writer must retain every completed physical receipt')
  assert.equal(concurrentSummary.logicalConsumers, 2, 'a late summary writer must retain every logical projection')

  await mkdir(summaryLockDirectory, { recursive: true })
  const staleSummaryOwnerFile = path.join(summaryLockDirectory, 'owner.json')
  await writeFile(staleSummaryOwnerFile, `${JSON.stringify({
    token: 'dead-summary-owner',
    pid: 999_999_999,
    createdAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString()
  })}\n`, 'utf8')
  await utimes(staleSummaryOwnerFile, new Date(0), new Date(0))
  await utimes(summaryLockDirectory, new Date(0), new Date(0))
  await runOnce.runBoundExecution({
    ...concurrentSummaryOptions('summary-after-stale-lock'),
    staleLockMs: 1
  }, async () => { concurrentPhysicalExecutions += 1 })
  const recoveredSummary = JSON.parse(await readFile(path.join(summaryRunDirectory, 'summary.json'), 'utf8'))
  assert.equal(recoveredSummary.physicalExecutions, 3, 'a dead stale summary owner must be recovered without losing receipts')
  assert.equal(recoveredSummary.logicalConsumers, 3, 'stale summary-lock recovery must retain logical projections')

  const cancelledSummaryRunId = 'summary-cancellation'
  const cancelledSummaryRunDirectory = path.join(runBoundRoot, cancelledSummaryRunId)
  const cancelledSummaryLockDirectory = path.join(cancelledSummaryRunDirectory, '.summary.lock')
  await mkdir(cancelledSummaryLockDirectory, { recursive: true })
  await writeFile(path.join(cancelledSummaryLockDirectory, 'owner.json'), `${JSON.stringify({
    token: 'test-cancelled-summary-lock',
    pid: process.pid,
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  })}\n`, 'utf8')
  const summaryCancellationController = new AbortController()
  let cancelledSummaryPhysicalExecutions = 0
  const cancelledSummaryOptions = options({
    runId: cancelledSummaryRunId,
    key: 'summary-cancelled-waiter',
    command: ['node', 'summary-cancelled-waiter.mjs'],
    inputDigest: 'summary-cancelled-input',
    testIds: ['summary-cancelled-test'],
    consumerId: 'summary-cancelled-producer',
    lockTimeoutMs: 2_000,
    staleLockMs: 1_000,
    heartbeatMs: 10,
    signal: summaryCancellationController.signal
  })
  const cancelledSummaryRun = runOnce.runBoundExecution(cancelledSummaryOptions, async () => {
    cancelledSummaryPhysicalExecutions += 1
  })
  let cancelledProjectionCount = 0
  for (let attempt = 0; attempt < 100 && cancelledProjectionCount < 1; attempt += 1) {
    try {
      cancelledProjectionCount = (await readdir(path.join(cancelledSummaryRunDirectory, 'projections'))).length
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (cancelledProjectionCount < 1) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(cancelledProjectionCount, 1, 'the cancelled waiter must publish its projection before summary merge')
  summaryCancellationController.abort(Object.assign(new Error('cancelled summary wait'), { name: 'AbortError' }))
  await assert.rejects(cancelledSummaryRun, /cancelled summary wait/u)
  await rm(cancelledSummaryLockDirectory, { recursive: true, force: true })
  const resumedSummaryConsumer = await runOnce.runBoundExecution({
    ...cancelledSummaryOptions,
    consumerId: 'summary-cancelled-consumer',
    signal: undefined
  }, async () => { cancelledSummaryPhysicalExecutions += 1 })
  assert.equal(resumedSummaryConsumer.status, 'shared-current-run')
  assert.equal(cancelledSummaryPhysicalExecutions, 1, 'cancelling a summary waiter must not discard or rerun its successful receipt')
  const resumedCancelledSummary = JSON.parse(await readFile(path.join(cancelledSummaryRunDirectory, 'summary.json'), 'utf8'))
  assert.equal(resumedCancelledSummary.physicalExecutions, 1)
  assert.equal(resumedCancelledSummary.logicalConsumers, 2)
} finally {
  await rm(runBoundRoot, { recursive: true, force: true })
}

const commandManifest = await importRequired('tools/test/run-command-manifest.mjs')
assert.equal(typeof commandManifest.validateCommandManifest, 'function')
assert.deepEqual(commandManifest.validateCommandManifest({
  schema: 'fsusblog.test-command-manifest.v1',
  lane: 'contract',
  commands: [
    { id: 'read', script: 'check:read', access: 'read' },
    { id: 'write', script: 'check:write', access: 'write', ownedOutputs: ['fixture-output'] }
  ]
}), [])
assert.equal(commandManifest.resolveManifestWorkers({
  env: {}, cpuCount: 8, freeMemoryBytes: 512 * 1024 ** 2, totalMemoryBytes: 16 * 1024 ** 3, load1: 0
}), 1, 'low-memory command manifests must run read checks serially')
assert.equal(commandManifest.resolveManifestWorkers({
  env: {
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '12',
    FSUSBLOG_STEP_CPU_BUDGET: '6',
    FSUSBLOG_STEP_MEMORY_GIB: '8'
  },
  cpuCount: 16,
  freeMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
  load1: 15
}), 6, 'scheduler-managed manifests must use the CPU grant already admitted against live memory')
assert.equal(commandManifest.resolveManifestWorkers({
  env: {
    FSUSBLOG_STEP_CPU_BUDGET: '2',
    FSUSBLOG_STEP_MEMORY_GIB: '1.03'
  },
  cpuCount: 8,
  freeMemoryBytes: 512 * 1024 ** 2,
  totalMemoryBytes: 16 * 1024 ** 3,
  load1: 7
}), 2, 'scheduler admission must not be re-capped by host-average memory or host load')
assert.equal(commandManifest.resolveManifestWorkers({
  env: {}, cpuCount: 16, freeMemoryBytes: 32 * 1024 ** 3, totalMemoryBytes: 32 * 1024 ** 3, load1: 0
}), 16, 'healthy unmanaged manifests must not retain a fixed four-worker cap')
assert.equal(commandManifest.resolveNestedManifestMemoryGiBPerWorker({
  env: {
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_MEMORY_GIB: '0.0625'
  }
}), 0.0625, 'nested command manifests must fit the exact parent memory grant')
assert.equal(commandManifest.resolveNestedManifestMemoryGiBPerWorker({
  env: {}, defaultMemoryGiBPerWorker: 0.25
}), 0.25, 'direct command manifests retain the measured default memory cost')
assert.throws(() => commandManifest.resolveManifestWorkers({
  env: { FSUSBLOG_STEP_MEMORY_GIB: 'invalid' },
  cpuCount: 16,
  freeMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3
}), /FSUSBLOG_STEP_MEMORY_GIB must be a positive finite number/u)
assert.throws(() => commandManifest.resolveManifestWorkers({
  env: { FSUSBLOG_COMMAND_MANIFEST_WORKERS: '8x' },
  cpuCount: 16,
  freeMemoryBytes: 32 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3
}), /FSUSBLOG_COMMAND_MANIFEST_WORKERS must be a positive integer/u)
const manifestChildEnv = commandManifest.resolveManifestChildEnvironment({
  env: {
    FSUSBLOG_STEP_CPU_BUDGET: '6',
    FSUSBLOG_STEP_MEMORY_GIB: '9',
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '12'
  },
  workers: 3,
  concurrent: true
})
assert.equal(manifestChildEnv.FSUSBLOG_STEP_CPU_BUDGET, '2')
assert.equal(manifestChildEnv.FSUSBLOG_STEP_MEMORY_GIB, '3')
assert.equal(manifestChildEnv.FSUSBLOG_COMMAND_MANIFEST_WORKERS, '2')
assert.equal(manifestChildEnv.FSUSBLOG_NODE_TEST_CONCURRENCY, '2')

const commandTempRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-command-manifest-'))
try {
  const markerFile = path.join(commandTempRoot, 'markers.txt')
  const commandManifestEnv = { ...process.env }
  for (const key of [
    'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE',
    'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID',
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_MEMORY_GIB',
    'FSUSBLOG_LIVE_GRANT_EVIDENCE_FILE'
  ]) {
    delete commandManifestEnv[key]
  }
  // Keep this ordering contract independent of transient host load. The
  // production caller is scheduler-admitted, so exercise the same explicit
  // two-slot grant instead of sampling os.loadavg() twice and allowing the
  // expected and actual worker counts to disagree between those samples.
  commandManifestEnv.FSUSBLOG_STEP_CPU_BUDGET = '2'
  commandManifestEnv.FSUSBLOG_STEP_MEMORY_GIB = '1'
  commandManifestEnv.FSUSBLOG_COMMAND_MANIFEST_WORKERS = '2'
  const commandManifestWorkers = commandManifest.resolveManifestWorkers({ env: commandManifestEnv })
  const overlapExpected = commandManifestWorkers > 1
  const markerScript = [
    "const fs = require('node:fs')",
    'const [file, id, overlap] = process.argv.slice(1)',
    "const peer = id === 'read-a' ? 'read-b' : 'read-a'",
    "fs.appendFileSync(file, `${id}:start\\n`)",
    "if (overlap !== 'true') { fs.appendFileSync(file, `${id}:end\\n`); process.exit(0) }",
    "fs.writeFileSync(`${file}.${id}.ready`, '')",
    'const finishAfterPeerStarts = () => {',
    "  if (!fs.existsSync(`${file}.${peer}.ready`)) return setImmediate(finishAfterPeerStarts)",
    "  fs.appendFileSync(file, `${id}:end\\n`)",
    '}',
    'setImmediate(finishAfterPeerStarts)'
  ].join(';')
  await commandManifest.runCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'contract-ordering',
    commands: [
      { id: 'read-a', command: [process.execPath, '-e', markerScript, markerFile, 'read-a', String(overlapExpected)], access: 'read', consumedInputs: ['marker-file'] },
      { id: 'read-b', command: [process.execPath, '-e', markerScript, markerFile, 'read-b', String(overlapExpected)], access: 'read', consumedInputs: ['marker-file'] },
      {
        id: 'write',
        command: [
          process.execPath,
          '-e',
          "require('node:fs').appendFileSync(process.argv[1], 'write:start\\n')",
          markerFile
        ],
        access: 'write',
        ownedOutputs: ['marker-file']
      }
    ]
  }, {
    cwd: commandTempRoot,
    env: commandManifestEnv
  })
  const markers = (await readFile(markerFile, 'utf8')).trim().split('\n')
  const lastReadEnd = Math.max(markers.indexOf('read-a:end'), markers.indexOf('read-b:end'))
  if (overlapExpected) {
    assert.ok(markers.indexOf('read-a:start') < markers.indexOf('read-b:end'))
    assert.ok(markers.indexOf('read-b:start') < markers.indexOf('read-a:end'))
  } else {
    assert.ok(markers.indexOf('read-a:end') < markers.indexOf('read-b:start'))
  }
  assert.ok(markers.indexOf('write:start') > lastReadEnd, 'write checks must start after read checks finish')
} finally {
  await rm(commandTempRoot, { recursive: true, force: true })
}

const commandFailureRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-command-manifest-failures-'))
try {
  const markerFile = path.join(commandFailureRoot, 'markers.txt')
  const commandScript = [
    "const fs = require('node:fs')",
    'const [file, id, status] = process.argv.slice(1)',
    "fs.appendFileSync(file, `${id}\n`)",
    'process.exit(Number(status))'
  ].join(';')
  await assert.rejects(commandManifest.runCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'contract-failure-collection',
    commands: [
      { id: 'read-fail-a', command: [process.execPath, '-e', commandScript, markerFile, 'read-fail-a', '2'], access: 'read', consumedInputs: ['marker-file'] },
      { id: 'read-fail-b', command: [process.execPath, '-e', commandScript, markerFile, 'read-fail-b', '3'], access: 'read', consumedInputs: ['marker-file'] },
      { id: 'write-after-failures', command: [process.execPath, '-e', commandScript, markerFile, 'write-after-failures', '0'], access: 'write', ownedOutputs: ['marker-file'] }
    ]
  }, {
    cwd: commandFailureRoot,
    env: { ...process.env, FSUSBLOG_COMMAND_MANIFEST_WORKERS: '1' }
  }), (error) => error instanceof AggregateError && error.errors.length === 2)
  assert.deepEqual((await readFile(markerFile, 'utf8')).trim().split('\n'), [
    'read-fail-a',
    'read-fail-b',
    'write-after-failures'
  ])
} finally {
  await rm(commandFailureRoot, { recursive: true, force: true })
}

const dotnetProcessors = await importRequired('tools/test/resolve-dotnet-test-processors.mjs')
assert.equal(dotnetProcessors.resolveDotnetTestProcessorCount({
  env: {}, cpuCount: 8, freeMemoryBytes: 2 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3, load1: 0
}), 1, 'low-resource .NET test hosts must run serially')
assert.equal(dotnetProcessors.resolveDotnetTestProcessorCount({
  env: {}, cpuCount: 8, freeMemoryBytes: 16 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3, load1: 0
}), 8, 'healthy .NET test hosts must scale to the available CPU and memory envelope')
assert.equal(dotnetProcessors.resolveDotnetTestProcessorCount({
  env: {
    FSUSBLOG_TIER_CPU_UNITS: '6',
    FSUSBLOG_TIER_MEMORY_GIB: '8',
    FSUSBLOG_DOTNET_TEST_PROCESSORS: '99'
  },
  cpuCount: 32,
  freeMemoryBytes: 64 * 1024 ** 3,
  totalMemoryBytes: 64 * 1024 ** 3,
  load1: 0
}), 6, 'explicit .NET processor overrides must be capped by the scheduler CPU grant after memory admission')
assert.equal(dotnetProcessors.resolveDotnetTestProcessorCount({
  env: {
    FSUSBLOG_STEP_CPU_BUDGET: '3',
    FSUSBLOG_STEP_MEMORY_GIB: '12',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '8',
    FSUSBLOG_BUNDLE_MEMORY_GIB: '32',
    FSUSBLOG_TIER_CPU_UNITS: '16',
    FSUSBLOG_TIER_MEMORY_GIB: '64'
  },
  cpuCount: 16,
  totalMemoryBytes: 64 * 1024 ** 3
}), 3, 'the most specific step grant must win over bundle and tier grants')
assert.throws(() => dotnetProcessors.resolveDotnetTestProcessorCount({
  env: { FSUSBLOG_BUNDLE_CPU_BUDGET: 'invalid' },
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3
}), /FSUSBLOG_BUNDLE_CPU_BUDGET must be a finite positive CPU grant/u)
assert.throws(() => dotnetProcessors.resolveDotnetTestProcessorCount({
  env: {
    FSUSBLOG_TIER_CPU_UNITS: '8',
    FSUSBLOG_TIER_MEMORY_GIB: '16',
    FSUSBLOG_DOTNET_TEST_PROCESSORS: '8x'
  },
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3
}), /FSUSBLOG_DOTNET_TEST_PROCESSORS must be a positive integer processor override/u)

console.log('[test-execution-helpers] ok')
