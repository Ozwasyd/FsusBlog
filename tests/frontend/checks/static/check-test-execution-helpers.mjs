#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const xunitRunner = JSON.parse(await readFile(path.join(root, 'tests/backend/xunit.runner.json'), 'utf8'))
assert.equal(xunitRunner.stopOnFail, false, 'xUnit must collect all failures in each run')
const legacyRunner = await readFile(path.join(root, 'tools/test/legacy-test.sh'), 'utf8')
const parallelHelper = legacyRunner.slice(
  legacyRunner.indexOf('run_parallel()'),
  legacyRunner.indexOf('\nprobe_url()')
)
assert.doesNotMatch(parallelHelper, /kill "\$pid"/, 'parallel groups must not kill peers after one failure')
assert.match(parallelHelper, /local -a failures=\(\)/u)
assert.match(parallelHelper, /parallel group failed: \$group \(\$\{failures\[\*\]\}\)/u)
const securityStaticRunner = legacyRunner.slice(
  legacyRunner.indexOf('run_security_static_only()'),
  legacyRunner.indexOf('\nrun_security_runtime_core_only()')
)
const securityRuntimeRunner = legacyRunner.slice(
  legacyRunner.indexOf('run_security_runtime_core_only()'),
  legacyRunner.indexOf('\nrun_security_only()')
)
const securityRunner = legacyRunner.slice(
  legacyRunner.indexOf('run_security_only()'),
  legacyRunner.indexOf('\nrun_security()')
)
assert.match(securityStaticRunner, /run_parallel "security-static"/u)
assert.doesNotMatch(securityStaticRunner, /require_debug_stack/u)
assert.match(securityRuntimeRunner, /run_parallel "security-runtime-core"/u)
assert.match(securityRuntimeRunner, /local -a security_failures=\(\)/u)
assert.match(securityRuntimeRunner, /security stage failed, continuing/u)
assert.match(securityRunner, /run_parallel "security-phases"/u)

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
  const legacyTestScript = path.join(root, 'tools/test/legacy-test.sh')
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1
source "$1"
test_input_fingerprint() {
  printf '%s\\n' "$@" > "$CAPTURE_FILE"
  printf 'test-fingerprint'
}
run_once_command() { :; }
run_frontend_fast_build_group
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
  const legacyTestScript = path.join(root, 'tools/test/legacy-test.sh')
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1
source "$1"
fixture_root_path() { printf '%s\\n' "$FIXTURE_ROOT"; }
run_once_command() { printf '%s:%s\\n' "$1" "$2" >> "$CAPTURE_FILE"; }
export FSUSBLOG_TEST_NAMESPACE=contract
export FSUSBLOG_FIXTURE_SERVICE_GENERATION=generation-a
prepare_auth_fixtures_once
prepare_public_fixtures_once
prepare_auth_fixtures_once
prepare_public_fixtures_once
export FSUSBLOG_FIXTURE_SERVICE_GENERATION=generation-b
prepare_auth_fixtures_once
prepare_public_fixtures_once
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

const commandManifest = await importRequired('tools/test/run-command-manifest.mjs')
assert.equal(typeof commandManifest.validateCommandManifest, 'function')
assert.deepEqual(commandManifest.validateCommandManifest({
  schema: 'fsusblog.test-command-manifest.v1',
  lane: 'contract',
  commands: [
    { id: 'read', script: 'check:read', access: 'read' },
    { id: 'write', script: 'check:write', access: 'write' }
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
  const commandManifestEnv = {
    ...process.env,
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '2'
  }
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
      { id: 'read-a', command: [process.execPath, '-e', markerScript, markerFile, 'read-a', String(overlapExpected)], access: 'read' },
      { id: 'read-b', command: [process.execPath, '-e', markerScript, markerFile, 'read-b', String(overlapExpected)], access: 'read' },
      {
        id: 'write',
        command: [
          process.execPath,
          '-e',
          "require('node:fs').appendFileSync(process.argv[1], 'write:start\\n')",
          markerFile
        ],
        access: 'write'
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
      { id: 'read-fail-a', command: [process.execPath, '-e', commandScript, markerFile, 'read-fail-a', '2'], access: 'read' },
      { id: 'read-fail-b', command: [process.execPath, '-e', commandScript, markerFile, 'read-fail-b', '3'], access: 'read' },
      { id: 'write-after-failures', command: [process.execPath, '-e', commandScript, markerFile, 'write-after-failures', '0'], access: 'write' }
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
