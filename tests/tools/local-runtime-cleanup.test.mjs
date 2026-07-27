import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  cleanupLocalRuntime,
  cleanupStaleLocalRuntimes,
  dedicatedContainerOwnershipMatches,
  dedicatedProcessIdentityMatches,
  freshRuntimeCleanupReceiptDigest,
  isOrphanProductionViteProcess,
  isStaleSchemaContainer,
  terminateDedicatedProcessGroup,
  verifyFreshRuntimeCleanup,
  verifyFreshRuntimeCleanupReceipt,
  writeFreshRuntimeCleanupReceipt
} from '../../tools/test-matrix/local-runtime-cleanup.mjs'
import { cleanLocalProductionOutputs } from '../../tools/test-matrix/fresh-production.mjs'
import {
  executeProductionFreshPreflight,
  recordBlockedProductionFreshPreflight,
  runProductionFreshRuntimeCleanupPhase
} from '../../tools/test-matrix/production-fresh-runtime-evidence.mjs'
import {
  createResidentLeaseInventory,
  writeResidentLeaseDocument
} from '../../tools/test-matrix/resident-resource-leases.mjs'

function cacheTransactionOwner(root) {
  return {
    leaseId: 'lease-runtime-cleanup-test',
    ownerToken: 'token-runtime-cleanup-test',
    canonicalRepositoryRoot: fs.realpathSync(root),
    profile: 'production-fresh',
    candidateIdentityDigest: `sha256:${'a'.repeat(64)}`,
    pid: process.pid,
    processStartIdentity: 'runtime-cleanup-test',
    executableDigest: `sha256:${'b'.repeat(64)}`,
    commandDigest: `sha256:${'c'.repeat(64)}`,
    processGroupOrJobIdentity: { kind: 'unix-process-group', processGroupId: process.pid }
  }
}

function schemaContainer(name, {
  id = 'c'.repeat(64),
  created = '2026-07-12T00:00:00.000Z',
  labels = {},
  image = 'postgres:18-alpine',
  hostIp = '127.0.0.1',
  binds = null
} = {}) {
  return {
    Id: id,
    Name: `/${name}`,
    Created: created,
    Path: 'docker-entrypoint.sh',
    Args: ['postgres'],
    Config: {
      Image: image,
      Env: ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=postgres', 'POSTGRES_DB=postgres'],
      Labels: labels
    },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { '5432/tcp': [{ HostIp: hostIp, HostPort: '' }] },
      Binds: binds
    },
    State: { Running: true }
  }
}

function runtimeContainer(labels, id = 'a'.repeat(64)) {
  return { Id: id, Config: { Labels: labels } }
}

function writeDedicatedRuntimeFixture(root, {
  namespace = 'bc-deadbeef-0123456789-abcdef',
  runId = 'browser-contract-run-7',
  bundleId = 'browser-contract',
  stepId = 'browser-contract-fixture',
  preparationId = 'prepare-7',
  pid = 4242,
  role = 'backend',
  startTimeTicks = '100'
} = {}) {
  const envDir = path.join(root, '.tmp/env')
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  const fixtureDir = path.join(root, '.tmp/fixtures', namespace)
  const dataDir = path.join(root, '.tmp/data', namespace)
  const runOnceDir = path.join(root, '.tmp/run-once', namespace)
  for (const directory of [envDir, runtimeDir, fixtureDir, dataDir, runOnceDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
    `FSUSBLOG_TEST_RUN_ID=${runId}`,
    `FSUSBLOG_PHYSICAL_BUNDLE_ID=${bundleId}`,
    `FSUSBLOG_STEP_ID=${stepId}`,
    'FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1',
    `FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID=${preparationId}`,
    `FSUSBLOG_FIXTURE_ROOT=${fixtureDir}`,
    `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
    `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`
  ].join('\n'))
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${pid}\n`, { mode: 0o600 })
  const identity = {
    schema: 'fsusblog.local-runtime-process-identity.v1',
    pid,
    processGroupId: pid,
    startTimeTicks,
    runId,
    namespace,
    role,
    preparationId,
    createdAt: '2026-07-18T00:00:00.000Z'
  }
  fs.writeFileSync(
    path.join(runtimeDir, 'backend.identity.json'),
    `${JSON.stringify(identity)}\n`,
    { mode: 0o600 }
  )
  fs.writeFileSync(path.join(fixtureDir, 'fixture'), 'fixture')
  fs.writeFileSync(path.join(dataDir, 'state'), 'state')
  fs.writeFileSync(path.join(runOnceDir, 'auth-fixtures.json'), '{}')
  fs.writeFileSync(path.join(runOnceDir, 'public-fixtures.json'), '{}')
  return {
    namespace,
    runId,
    bundleId,
    stepId,
    preparationId,
    pid,
    role,
    startTimeTicks,
    identity,
    envFile: path.join(envDir, `${namespace}.env`),
    runtimeDir,
    fixtureDir,
    dataDir,
    runOnceDir,
    labels: {
      'io.fsusblog.test.run-id': runId,
      'io.fsusblog.test.bundle-id': bundleId,
      'io.fsusblog.test.step-id': stepId,
      'io.fsusblog.test.namespace': namespace,
      'io.fsusblog.test.preparation-id': preparationId
    }
  }
}

test('dedicated browser bootstrap is fixed at one worker and fail-closes owned runtime identity', () => {
  const source = fs.readFileSync('tools/bootstrap-acceptance-env.sh', 'utf8')
  const deterministicDefaults = source.slice(
    source.indexOf('if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then'),
    source.indexOf('PUBLIC_AOT_SSR_CLIENT_ROOT=')
  )
  assert.match(deterministicDefaults, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?PUBLIC_AOT_BACKFILL_CONCURRENCY=1[\s\S]*?PUBLIC_AOT_SSR_WORKER_COUNT=1[\s\S]*?RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU=1[\s\S]*?else[\s\S]*?resolve-public-aot-concurrency\.mjs[\s\S]*?os\.availableParallelism/u)
  const executionResolver = source.slice(
    source.indexOf('DEDICATED_RUNTIME_EXECUTION_BUDGET_CAP_MS='),
    source.indexOf('EXECUTION_BUDGET_MS=')
  )
  const dedicatedBudgetCap = Number(executionResolver.match(/DEDICATED_RUNTIME_EXECUTION_BUDGET_CAP_MS=(\d+)/u)?.[1])
  assert.ok(dedicatedBudgetCap > 0 && dedicatedBudgetCap < 300_000)
  assert.ok(executionResolver.indexOf('FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME')
    < executionResolver.indexOf('os.availableParallelism'))
  assert.match(executionResolver, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?rounded < cap \? rounded : cap[\s\S]*?return 0[\s\S]*?os\.freemem/u)
  const workerResolver = source.slice(
    source.indexOf('ResolveBootstrapParallelWorkers()'),
    source.indexOf('ResolveBootstrapChildEnvironment()')
  )
  const childResolver = source.slice(
    source.indexOf('ResolveBootstrapChildEnvironment()'),
    source.indexOf('RunBootstrapParallel()')
  )
  assert.ok(workerResolver.indexOf('FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME')
    < workerResolver.indexOf('resolveManifestLiveCapacity'))
  assert.match(workerResolver, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?printf '1\\n'[\s\S]*?return 0/u)
  assert.ok(childResolver.indexOf('FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME')
    < childResolver.indexOf('readManifestSchedulerResourceGrant'))
  assert.match(childResolver, /FSUSBLOG_COMMAND_MANIFEST_WORKERS=1[\s\S]*?FSUSBLOG_NODE_TEST_CONCURRENCY=1[\s\S]*?return 0/u)
  assert.match(source, /unset FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE[\s\S]*?unset FSUSBLOG_LIVE_GRANT_EVIDENCE_FILE[\s\S]*?unset FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX/u)

  for (const label of [
    'io.fsusblog.test.run-id',
    'io.fsusblog.test.bundle-id',
    'io.fsusblog.test.step-id',
    'io.fsusblog.test.namespace',
    'io.fsusblog.test.preparation-id'
  ]) assert.match(source, new RegExp(label.replaceAll('.', '\\.'), 'u'))

  assert.match(source, /const deadlineAtMs = Math\.min\(inheritedDeadlineAtMs, Date\.now\(\) \+ 2_000\)/u)
  assert.match(source, /processGroupId === pid[\s\S]*?sessionId === pid[\s\S]*?FSUSBLOG_RUNTIME_ROLE === role/u)
  assert.match(source, /FSUSBLOG_RUNTIME_IDENTITY_PREPARATION_ID[\s\S]*?environment\.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === preparationId[\s\S]*?preparationId,/u)
  assert.match(source, /fs\.writeFileSync\(pending,[\s\S]*?mode: 0o600/u)
  assert.match(source, /fs\.chmodSync\(file, 0o600\)/u)
  assert.match(source, /WriteRuntimeProcessIdentity "\$pidFile" "\$startedPid" backend "\$readinessDeadline"/u)
  assert.match(source, /WriteRuntimeProcessIdentity "\$pidFile" "\$startedPid" "\$role" "\$readinessDeadline"/u)
  assert.match(source, /fs\.constants\.O_NOFOLLOW[\s\S]*?fs\.fstatSync\(fd\)[\s\S]*?\(stat\.mode & 0o777\) !== 0o600/u)
  assert.match(source, /observed\.processGroupId !== managedPid[\s\S]*?observed\.sessionId !== managedPid/u)
  assert.match(source, /WriteRuntimePidFile "\$pidFile" "\$startedPid"/u)

  const backend = source.slice(source.indexOf('EnsureBackend()'), source.indexOf('StartBackgroundIfNeeded()'))
  const background = source.slice(source.indexOf('StartBackgroundIfNeeded()'), source.indexOf('EnsureDebugFrontend()'))
  const debugFrontend = source.slice(source.indexOf('EnsureDebugFrontend()'), source.indexOf('EnsureReleasePreview()'))
  const releasePreview = source.slice(source.indexOf('EnsureReleasePreview()'), source.indexOf('PrepareFixtures()'))
  for (const [label, runtimeSource, reuseMarker] of [
    ['backend', backend, 'already healthy'],
    ['background helper', background, 'already reachable'],
    ['debug frontend', debugFrontend, 'already healthy'],
    ['release preview', releasePreview, 'already healthy']
  ]) {
    assert.ok(runtimeSource.indexOf('AdmitDedicatedRuntimePort') >= 0, `${label} lacks dedicated admission`)
    assert.ok(runtimeSource.indexOf('AdmitDedicatedRuntimePort')
      < runtimeSource.indexOf(reuseMarker), `${label} admits after reuse`)
  }
  assert.doesNotMatch(backend.slice(0, backend.indexOf('nohup setsid')), /KillPidIfRunning/u)
  assert.doesNotMatch(debugFrontend, /KillPidIfRunning/u)
  assert.doesNotMatch(releasePreview, /KillPidIfRunning/u)
  assert.match(background, /local role[\s\S]*?role="\$\(RuntimeProcessRole[\s\S]*?ProbeUrl[\s\S]*?AdmitDedicatedRuntimePort[\s\S]*?already reachable/u)
  assert.match(background, /AssertDedicatedRuntimePortAvailable "\$label" "\$port"[\s\S]*?nohup setsid/u)
  assert.match(backend, /AssertDedicatedRuntimePortAvailable 'debug backend' "\$DEBUG_BACKEND_PORT"[\s\S]*?nohup setsid/u)
  assert.match(debugFrontend, /KillRuntimePidIfOwned debug-frontend[\s\S]*?WaitForPortRelease[\s\S]*?StartBackgroundIfNeeded/u)
  assert.match(releasePreview, /AdmitDedicatedRuntimePort[\s\S]*?building release preview[\s\S]*?AdmitDedicatedRuntimePort[\s\S]*?KillRuntimePidIfOwned release-preview/u)
  const portRelease = source.slice(source.indexOf('WaitForPortRelease()'), source.indexOf('ProbeUrl()'))
  assert.match(portRelease, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?PortIsListening[\s\S]*?refusing blind termination[\s\S]*?return 1[\s\S]*?KillPidIfRunning/u)

  const postgres = source.slice(source.indexOf('EnsurePostgres()'), source.indexOf('EnsureRedis()'))
  const redis = source.slice(source.indexOf('EnsureRedis()'), source.indexOf('RefreshFixtureServiceGeneration()'))
  for (const serviceSource of [postgres, redis]) {
    assert.match(serviceSource, /AssertDedicatedContainerBinding/u)
    assert.match(serviceSource, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?refusing to remove or recreate[\s\S]*?return 1[\s\S]*?docker rm -f -v/u)
  }
  const fixtures = source.slice(source.indexOf('PrepareFixtures()'), source.indexOf('CurrentPowDifficulty()'))
  assert.match(fixtures, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?PrepareAuthFixturesOnce[\s\S]*?PreparePublicFixturesOnce[\s\S]*?else[\s\S]*?RunParallel "bootstrap-runtime-fixtures"/u)
})

test('dedicated runtime admission fail-closes foreign, hidden, reachable, and raced listeners for all roles', (t) => {
  const namespace = `runtime-admission-${process.pid}-${Date.now()}`
  const runtimeDir = path.join(process.cwd(), '.tmp/acceptance', namespace)
  const envFile = path.join(process.cwd(), '.tmp/env', `${namespace}.env`)
  const fixtureDir = path.join(process.cwd(), '.tmp/fixtures', namespace)
  const dataDir = path.join(process.cwd(), '.tmp/data', namespace)
  t.after(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
    fs.rmSync(envFile, { force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const script = String.raw`
    export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1
    export FSUSBLOG_TEST_NAMESPACE=${namespace}
    export FSUSBLOG_TEST_RUN_ID=browser-contract-admission-fixture
    export FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1
    export FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID=preparation-fixture
    export FSUSBLOG_DEBUG_BACKEND_PORT=45101
    export FSUSBLOG_DEBUG_FRONTEND_PORT=45102
    export FSUSBLOG_RELEASE_PREVIEW_PORT=45103
    export FSUSBLOG_STEP_DEADLINE_MS=10000
    export FSUSBLOG_NODE=/definitely/unavailable-node
    source ./tools/bootstrap-acceptance-env.sh

    fail_fixture() { printf 'fixture failure: %s\n' "$1" >&2; exit 1; }
    TEST_LISTENING=0
    TEST_PORT_PID=''
    TEST_BINDING=0
    TEST_GROUP_EXISTS=0
    SIGNAL_CALLS=0
    PortIsListening() { [[ "$TEST_LISTENING" == "1" ]]; }
    FindPortPid() { printf '%s\n' "$TEST_PORT_PID"; }
    DedicatedRuntimeProcessBindingMatches() { [[ "$TEST_BINDING" == "1" ]]; }
    RuntimeProcessGroupExists() { [[ "$TEST_GROUP_EXISTS" == "1" ]]; }
    SignalRuntimeProcessGroup() {
      SIGNAL_CALLS=$((SIGNAL_CALLS + 1))
      TEST_GROUP_EXISTS=0
    }

    while IFS=: read -r role pid_name port; do
      pidFile="$TMP_DIR/$pid_name"
      rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"

      TEST_LISTENING=1
      TEST_PORT_PID=424242
      TEST_BINDING=0
      if AdmitDedicatedRuntimePort "$role" "$role" "$pidFile" "$port" 0; then
        fail_fixture "$role admitted a foreign listener"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a foreign listener"

      TEST_PORT_PID=''
      if AdmitDedicatedRuntimePort "$role" "$role" "$pidFile" "$port" 1; then
        fail_fixture "$role reused a reachable listener without an inspectable sidecar"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a hidden listener"

      WriteRuntimePidFile "$pidFile" "$$"
      TEST_PORT_PID=424243
      TEST_BINDING=1
      AdmitDedicatedRuntimePort "$role" "$role" "$pidFile" "$port" 1 \
        || fail_fixture "$role rejected an owned child listener"

      TEST_LISTENING=0
      TEST_PORT_PID=''
      AdmitDedicatedRuntimePort "$role" "$role" "$pidFile" "$port" 0 \
        || fail_fixture "$role rejected a free port"
      TEST_LISTENING=1
      TEST_PORT_PID=424244
      if AssertDedicatedRuntimePortAvailable "$role" "$port"; then
        fail_fixture "$role missed a pre-spawn port race"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a raced listener"

      TEST_BINDING=0
      TEST_GROUP_EXISTS=1
      if KillRuntimePidIfOwned "$role" "$pidFile" "$$" "$EXECUTION_DEADLINE_AT_MS"; then
        fail_fixture "$role terminated a mismatched process"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a mismatched process group"

      TEST_BINDING=1
      KillRuntimePidIfOwned "$role" "$pidFile" "$$" "$EXECUTION_DEADLINE_AT_MS" \
        || fail_fixture "$role could not terminate its owned process group"
      [[ "$SIGNAL_CALLS" == "1" ]] || fail_fixture "$role did not signal exactly one owned group"
      SIGNAL_CALLS=0

      TEST_LISTENING=1
      TEST_PORT_PID=''
      deadline_now="$(date +%s%3N)"
      if WaitForPortRelease "$port" "$deadline_now"; then
        fail_fixture "$role treated an uninspectable listener as released"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role blindly killed an uninspectable listener"
    done <<'ROLES'
backend:backend.pid:45101
debug-frontend:dev-server.pid:45102
release-preview:preview.pid:45103
ROLES
  `
  const result = spawnSync('bash', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 8_000
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('dedicated ownership matching binds exact Docker labels and procfs identity', () => {
  const expected = {
    runId: 'browser-contract-run-7',
    bundleId: 'browser-contract',
    stepId: 'browser-contract-fixture',
    namespace: 'bc-deadbeef-0123456789-abcdef',
    preparationId: 'prepare-7'
  }
  const labels = {
    'io.fsusblog.test.run-id': expected.runId,
    'io.fsusblog.test.bundle-id': expected.bundleId,
    'io.fsusblog.test.step-id': expected.stepId,
    'io.fsusblog.test.namespace': expected.namespace,
    'io.fsusblog.test.preparation-id': expected.preparationId
  }
  assert.equal(dedicatedContainerOwnershipMatches(runtimeContainer(labels), expected), true)
  assert.equal(dedicatedContainerOwnershipMatches(runtimeContainer({
    ...labels,
    'io.fsusblog.test.namespace': 'other-runtime'
  }), expected), false)
  assert.equal(dedicatedContainerOwnershipMatches(runtimeContainer({
    ...labels,
    'io.fsusblog.test.preparation-id': 'other-preparation'
  }), expected), false)
  assert.equal(dedicatedContainerOwnershipMatches(runtimeContainer(labels), {
    ...expected,
    preparationId: ''
  }), false)
  assert.equal(dedicatedContainerOwnershipMatches(runtimeContainer({
    ...labels,
    'io.fsusblog.test.preparation-id': undefined
  }), { ...expected, preparationId: '' }), false)

  const identity = {
    schema: 'fsusblog.local-runtime-process-identity.v1',
    pid: 4242,
    processGroupId: 4242,
    startTimeTicks: '100',
    runId: expected.runId,
    namespace: expected.namespace,
    role: 'backend',
    preparationId: expected.preparationId
  }
  const observed = {
    pid: 4242,
    processGroupId: 4242,
    startTimeTicks: '100',
    cwd: '/repo',
    args: ['dotnet', '/repo/src/backend/FsusBlog.Server.dll'],
    env: {
      FSUSBLOG_TEST_RUN_ID: expected.runId,
      FSUSBLOG_TEST_NAMESPACE: expected.namespace,
      FSUSBLOG_RUNTIME_ROLE: 'backend',
      FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
      FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: expected.preparationId
    }
  }
  const processExpected = {
    root: '/repo',
    namespace: expected.namespace,
    runId: expected.runId,
    role: 'backend',
    preparationId: expected.preparationId
  }
  assert.equal(dedicatedProcessIdentityMatches(identity, observed, processExpected), true)
  assert.equal(dedicatedProcessIdentityMatches(identity, {
    ...observed,
    startTimeTicks: '101'
  }, processExpected), false)
  assert.equal(dedicatedProcessIdentityMatches(identity, {
    ...observed,
    processGroupId: 4243
  }, processExpected), false)
  assert.equal(dedicatedProcessIdentityMatches(identity, {
    ...observed,
    env: { ...observed.env, FSUSBLOG_TEST_NAMESPACE: 'other-runtime' }
  }, processExpected), false)
  assert.equal(dedicatedProcessIdentityMatches({ ...identity, preparationId: '' }, observed, {
    ...processExpected,
    preparationId: ''
  }), false)
  assert.equal(dedicatedProcessIdentityMatches(identity, {
    ...observed,
    env: { ...observed.env, FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: 'other-preparation' }
  }, processExpected), false)
  assert.equal(dedicatedProcessIdentityMatches(identity, observed, {
    ...processExpected,
    preparationId: 'other-preparation'
  }), false)
})

test('dedicated process termination validates every live group member before SIGKILL', () => {
  const identity = {
    schema: 'fsusblog.local-runtime-process-identity.v1',
    pid: 4242,
    processGroupId: 4242,
    startTimeTicks: '100',
    runId: 'browser-contract-run-7',
    namespace: 'bc-deadbeef-0123456789-abcdef',
    role: 'backend',
    preparationId: 'prepare-7'
  }
  const environment = {
    FSUSBLOG_TEST_RUN_ID: identity.runId,
    FSUSBLOG_TEST_NAMESPACE: identity.namespace,
    FSUSBLOG_RUNTIME_ROLE: identity.role,
    FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
    FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: identity.preparationId
  }
  const leader = {
    pid: identity.pid,
    processGroupId: identity.processGroupId,
    startTimeTicks: identity.startTimeTicks,
    cwd: '/repo',
    args: ['dotnet', '/repo/src/backend/FsusBlog.Server.dll'],
    env: environment
  }
  const worker = {
    pid: 4243,
    state: 'S',
    processGroupId: identity.processGroupId,
    cwd: '/repo',
    args: ['runtime-worker'],
    env: environment
  }
  const signals = []
  let leaderRunning = true
  let groupRunning = true
  const terminated = terminateDedicatedProcessGroup(identity, {
    root: '/repo',
    graceMs: 0,
    observeProcess: () => leaderRunning ? leader : null,
    processGroupExists: () => groupRunning,
    listProcessGroupMembers: () => groupRunning ? [worker] : [],
    signalGroup: (processGroupId, signal) => {
      signals.push([processGroupId, signal])
      if (signal === 'SIGTERM') leaderRunning = false
      if (signal === 'SIGKILL') groupRunning = false
      return true
    }
  })
  assert.equal(terminated, true)
  assert.deepEqual(signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']])
  assert.equal(groupRunning, false)

  leaderRunning = true
  groupRunning = true
  const foreignSignals = []
  assert.equal(terminateDedicatedProcessGroup(identity, {
    root: '/repo',
    graceMs: 0,
    observeProcess: () => leaderRunning ? leader : null,
    processGroupExists: () => groupRunning,
    listProcessGroupMembers: () => [{
      ...worker,
      env: { ...environment, FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: 'reused-preparation' }
    }],
    signalGroup: (processGroupId, signal) => {
      foreignSignals.push([processGroupId, signal])
      if (signal === 'SIGTERM') leaderRunning = false
      return true
    }
  }), false)
  assert.deepEqual(foreignSignals, [[4242, 'SIGTERM']])
})

test('dedicated cleanup removes inspected container IDs and confirmed process groups', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-dedicated-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixture = writeDedicatedRuntimeFixture(root)
  assert.equal(fs.statSync(path.join(fixture.runtimeDir, 'backend.identity.json')).mode & 0o777, 0o600)
  const containerIds = new Map([
    [`fsusblog-test-postgres-${fixture.namespace}`, 'a'.repeat(64)],
    [`fsusblog-test-redis-${fixture.namespace}`, 'b'.repeat(64)]
  ])
  const present = new Set([...containerIds.keys(), ...containerIds.values()])
  const removals = []
  let processRunning = true
  const observed = {
    pid: fixture.pid,
    processGroupId: fixture.pid,
    startTimeTicks: fixture.startTimeTicks,
    cwd: root,
    args: ['dotnet', path.join(root, 'src/backend/FsusBlog.Server.dll')],
    env: {
      FSUSBLOG_TEST_RUN_ID: fixture.runId,
      FSUSBLOG_TEST_NAMESPACE: fixture.namespace,
      FSUSBLOG_RUNTIME_ROLE: fixture.role,
      FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
      FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: fixture.preparationId
    }
  }
  const cleanupStartedAfter = Date.now()
  const result = cleanupLocalRuntime({
    root,
    namespace: fixture.namespace,
    containerExists: (identity) => present.has(identity),
    inspectContainer: (name) => runtimeContainer(fixture.labels, containerIds.get(name)),
    removeContainer: (id, context) => {
      removals.push([id, context.name])
      present.delete(id)
      present.delete(context.name)
      return { removed: true }
    },
    observeProcess: () => processRunning ? observed : null,
    processGroupExists: () => processRunning,
    terminateDedicatedProcess: () => { processRunning = false; return true }
  })
  const cleanupFinishedBefore = Date.now()

  assert.ok(Date.parse(result.startedAt) >= cleanupStartedAfter)
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt))
  assert.ok(Date.parse(result.finishedAt) <= cleanupFinishedBefore)
  assert.deepEqual(removals, [
    ['a'.repeat(64), `fsusblog-test-postgres-${fixture.namespace}`],
    ['b'.repeat(64), `fsusblog-test-redis-${fixture.namespace}`]
  ])
  assert.deepEqual(result.removedContainers, [
    `fsusblog-test-postgres-${fixture.namespace}`,
    `fsusblog-test-redis-${fixture.namespace}`
  ])
  assert.deepEqual(result.terminatedPids, [fixture.pid])
  assert.deepEqual(result.skippedProcesses, [])
  assert.equal(result.cleanupStatus, 'complete')
  assert.equal(result.retainedRuntimeState, false)
  assert.equal(fs.statSync(path.join(root, '.tmp')).isDirectory(), true)
  for (const target of [fixture.envFile, fixture.runtimeDir, fixture.fixtureDir, fixture.dataDir, fixture.runOnceDir]) {
    assert.equal(fs.existsSync(target), false)
  }
})

test('dedicated cleanup retains recovery evidence for mismatched ownership and proc identity', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-dedicated-mismatch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixture = writeDedicatedRuntimeFixture(root)
  const postgres = `fsusblog-test-postgres-${fixture.namespace}`
  const redis = `fsusblog-test-redis-${fixture.namespace}`
  const ids = new Map([[postgres, 'a'.repeat(64)], [redis, 'b'.repeat(64)]])
  const present = new Set([...ids.keys(), ...ids.values()])
  const removals = []
  let terminateCalled = false
  const result = cleanupLocalRuntime({
    root,
    namespace: fixture.namespace,
    containerExists: (identity) => present.has(identity),
    inspectContainer: (name) => runtimeContainer(name === postgres
      ? { ...fixture.labels, 'io.fsusblog.test.preparation-id': 'wrong-preparation' }
      : fixture.labels, ids.get(name)),
    removeContainer: (id, context) => {
      removals.push([id, context.name])
      present.delete(id)
      present.delete(context.name)
      return { removed: true }
    },
    observeProcess: () => ({
      pid: fixture.pid,
      processGroupId: fixture.pid,
      startTimeTicks: '101',
      cwd: root,
      args: ['dotnet', path.join(root, 'src/backend/FsusBlog.Server.dll')],
      env: {
        FSUSBLOG_TEST_RUN_ID: fixture.runId,
        FSUSBLOG_TEST_NAMESPACE: fixture.namespace,
        FSUSBLOG_RUNTIME_ROLE: fixture.role,
        FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
        FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: fixture.preparationId
      }
    }),
    processGroupExists: () => true,
    terminateDedicatedProcess: () => { terminateCalled = true; return true }
  })

  assert.deepEqual(removals, [['b'.repeat(64), redis]])
  assert.equal(terminateCalled, false)
  assert.deepEqual(result.containerCleanupFailures, [{
    container: postgres,
    reason: 'ownership-label-mismatch'
  }])
  assert.deepEqual(result.skippedProcesses, [{
    pidFile: 'backend.pid',
    pid: fixture.pid,
    reason: 'proc-identity-mismatch'
  }])
  assert.equal(result.cleanupStatus, 'skipped')
  assert.equal(result.retainedRuntimeState, true)
  for (const target of [fixture.envFile, fixture.runtimeDir, fixture.fixtureDir, fixture.dataDir, fixture.runOnceDir]) {
    assert.equal(fs.existsSync(target), true)
  }
})

test('dedicated cleanup reports unconfirmed Docker removal and private-sidecar failures', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-dedicated-failure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixture = writeDedicatedRuntimeFixture(root)
  const postgres = `fsusblog-test-postgres-${fixture.namespace}`
  const redis = `fsusblog-test-redis-${fixture.namespace}`
  const ids = new Map([[postgres, 'a'.repeat(64)], [redis, 'b'.repeat(64)]])
  const present = new Set([...ids.keys(), ...ids.values()])
  fs.chmodSync(path.join(fixture.runtimeDir, 'backend.identity.json'), 0o644)
  const result = cleanupLocalRuntime({
    root,
    namespace: fixture.namespace,
    containerExists: (identity) => present.has(identity),
    inspectContainer: (name) => runtimeContainer(fixture.labels, ids.get(name)),
    removeContainer: () => ({ removed: false, exitCode: 1, reason: 'docker refused removal' }),
    observeProcess: () => assert.fail('private sidecar must fail before proc observation'),
    processGroupExists: () => true,
    terminateDedicatedProcess: () => assert.fail('private sidecar must fail before termination')
  })

  assert.equal(result.containerCleanupFailures.length, 2)
  assert.ok(result.containerCleanupFailures.every((failure) => failure.reason === 'docker refused removal'))
  assert.deepEqual(result.skippedProcesses, [{
    pidFile: 'backend.pid',
    pid: fixture.pid,
    reason: 'identity-sidecar-not-private'
  }])
  assert.equal(result.cleanupStatus, 'skipped')
  assert.equal(fs.existsSync(fixture.envFile), true)
  assert.equal(fs.existsSync(fixture.runtimeDir), true)
})

test('tracked process with an invalid identity schema is retained without signalling', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-invalid-runtime-sidecar-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixture = writeDedicatedRuntimeFixture(root)
  fs.writeFileSync(
    path.join(fixture.runtimeDir, 'backend.identity.json'),
    `${JSON.stringify({ ...fixture.identity, schema: 'invalid' })}\n`,
    { mode: 0o600 }
  )
  let signalled = false
  const result = cleanupLocalRuntime({
    root,
    namespace: fixture.namespace,
    containerExists: () => false,
    observeProcess: () => assert.fail('invalid sidecar must fail before proc observation'),
    terminateDedicatedProcess: () => { signalled = true; return true }
  })

  assert.equal(signalled, false)
  assert.deepEqual(result.skippedProcesses, [{
    pidFile: 'backend.pid',
    pid: fixture.pid,
    reason: 'identity-sidecar-invalid'
  }])
  assert.equal(result.cleanupStatus, 'skipped')
  assert.equal(result.retainedRuntimeState, true)
})

test('default container cleanup removes anonymous test volumes with the container', () => {
  const source = fs.readFileSync('tools/test-matrix/local-runtime-cleanup.mjs', 'utf8')
  assert.match(source, /spawnSync\('docker', \['rm', '--force', '--volumes', name\]/u)
  assert.match(source, /process\.kill\(-processGroupId, signal\)/u)
  const fixture = fs.readFileSync('tests/backend/Fixtures/PostgresSchemaMigrationFixture.cs', 'utf8')
  assert.match(fixture, /com\.fsusblog\.test\.kind=schema-migration/u)
  assert.match(fixture, /com\.fsusblog\.test\.owner-pid=\{Environment\.ProcessId\}/u)
  assert.match(fixture, /com\.fsusblog\.test\.run-id=\{testRunId\}/u)
})

test('orphan Vite discovery requires a dead canonical production owner and exact repo command binding', () => {
  const root = '/repo'
  const runId = 'production-2026-07-12_12-44-12-568-82962'
  const record = {
    pid: 900,
    ppid: 1,
    startTimeTicks: '1234',
    cwd: '/repo/src/frontend',
    args: ['/usr/bin/node', '/repo/src/frontend/node_modules/.bin/vite', 'preview', '--host', '0.0.0.0', '--port', '29560', '--strictPort'],
    env: {
      FSUSBLOG_TEST_RUN_ID: runId,
      FSUSBLOG_TEST_NAMESPACE: `${runId}-fresh-local-production-0`,
      FSUSBLOG_RELEASE_PREVIEW_PORT: '29560',
      FSUSBLOG_DEBUG_FRONTEND_PORT: '26877'
    }
  }
  assert.equal(isOrphanProductionViteProcess(record, { root, processExists: () => false }), true)
  assert.equal(isOrphanProductionViteProcess({ ...record, ppid: 42 }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess({ ...record, cwd: '/other/src/frontend' }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess({
    ...record,
    env: { ...record.env, FSUSBLOG_TEST_RUN_ID: 'production-manual-82962' }
  }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess({
    ...record,
    env: { ...record.env, FSUSBLOG_RELEASE_PREVIEW_PORT: '29561' }
  }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess(record, { root, processExists: (pid) => pid === 82962 }), false)
})

test('schema cleanup accepts dead labeled owners and only the exact aged unlabeled legacy shape', () => {
  const labeled = schemaContainer('fsus-pg-bp-0123456789-m-4321-deadbeef', {
    labels: {
      'com.fsusblog.test.kind': 'schema-migration',
      'com.fsusblog.test.owner-pid': '4321',
      'com.fsusblog.test.run-id': 'production-run'
    }
  })
  assert.equal(isStaleSchemaContainer(labeled, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: () => false
  }), true)
  assert.equal(isStaleSchemaContainer(labeled, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: (pid) => pid === 4321
  }), false)

  const transitional = schemaContainer('fsus-pg-bp-0123456789-m-4321-deadbeef')
  assert.equal(isStaleSchemaContainer(transitional, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: () => false
  }), true)
  assert.equal(isStaleSchemaContainer(transitional, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: (pid) => pid === 4321
  }), false)

  const legacy = schemaContainer('fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9')
  assert.equal(isStaleSchemaContainer(legacy, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000
  }), true)
  assert.equal(isStaleSchemaContainer(legacy, {
    nowMs: Date.parse('2026-07-12T00:05:00Z'),
    legacyMinimumAgeMs: 600_000
  }), false)
  assert.equal(isStaleSchemaContainer(legacy, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    activeBackendTesthost: true
  }), false)
  assert.equal(isStaleSchemaContainer(schemaContainer('fsusblog-dev-postgres'), {
    nowMs: Date.parse('2026-07-12T01:00:00Z'), legacyMinimumAgeMs: 600_000
  }), false)
  assert.equal(isStaleSchemaContainer(schemaContainer('fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9', {
    hostIp: '0.0.0.0'
  }), { nowMs: Date.parse('2026-07-12T01:00:00Z'), legacyMinimumAgeMs: 600_000 }), false)
  assert.equal(isStaleSchemaContainer(schemaContainer('fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9', {
    labels: { owner: 'unknown' }
  }), { nowMs: Date.parse('2026-07-12T01:00:00Z'), legacyMinimumAgeMs: 600_000 }), false)
})

test('untracked cleanup removes only classified orphan processes and schema containers', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-untracked-cleanup-'))
  const orphan = {
    pid: 900,
    processGroupId: 900,
    startTimeTicks: '1234',
    args: ['/usr/bin/node', path.join(root, 'src/frontend/node_modules/.bin/vite'), 'preview'],
    env: { FSUSBLOG_TEST_NAMESPACE: 'production-orphan' }
  }
  const staleName = 'fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9'
  const retainedName = 'fsusblog-dev-postgres'
  const staleId = 'c'.repeat(64)
  const killed = []
  const removed = []
  let stalePresent = true
  const result = cleanupStaleLocalRuntimes({
    root,
    discoverUntracked: true,
    legacyContainerMinimumAgeMs: 600_000,
    orphanTerminationGraceMs: 3_000,
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    discoverOrphanProcesses: () => [orphan],
    killOrphanProcess: (record, graceMs) => { killed.push([record.pid, graceMs]); return true },
    observeOrphanProcess: () => null,
    orphanProcessGroupExists: () => false,
    listSchemaContainers: () => [staleName, retainedName],
    inspectContainer: (identity) => {
      if ((identity === staleName || identity === staleId) && stalePresent) return schemaContainer(staleName, { id: staleId })
      return identity === retainedName ? schemaContainer(retainedName) : null
    },
    detectActiveBackendTesthost: () => false,
    removeContainer: (id, context) => {
      removed.push([id, context.name])
      stalePresent = false
      return { removed: true }
    }
  })
  assert.deepEqual(killed, [[900, 3_000]])
  assert.deepEqual(removed, [[staleId, staleName]])
  assert.deepEqual(result.orphanProcesses, [900])
  assert.deepEqual(result.untrackedContainers, [staleName])
  assert.deepEqual(result.terminatedPids, [900])
  assert.deepEqual(result.removedContainers, [staleName])
  assert.deepEqual(result.orphanProcessRecords, [{
    pid: 900,
    processGroupId: 900,
    startTimeTicks: '1234',
    role: 'release-preview',
    identityResult: 'strict-orphan-production-vite',
    action: 'terminated',
    postObservation: 'leader-and-group-absent'
  }])
  assert.deepEqual(result.untrackedContainerRecords, [{
    name: staleName,
    id: staleId,
    ownershipLabels: {},
    action: 'removed',
    postObservation: 'name-and-id-absent'
  }])
  assert.equal(verifyFreshRuntimeCleanup(result).status, 'complete')
  const receipt = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'preflight',
    runId: 'untracked-owned-run',
    invocationId: 'untracked-owned-invocation',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    cleanup: result
  })
  assert.equal(receipt.receipt.status, 'complete')
  assert.deepEqual(receipt.receipt.removed, [staleName, 900])
  assert.deepEqual(receipt.receipt.untrackedContainerRecords, result.untrackedContainerRecords)
  assert.deepEqual(receipt.receipt.orphanProcessRecords, result.orphanProcessRecords)
  fs.rmSync(root, { recursive: true, force: true })
})

test('cleanupStaleLocalRuntimes discovers tracked namespaces before fresh output deletion', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-stale-runtime-cleanup-'))
  for (const namespace of ['production-old-a', 'production-old-b']) {
    const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
    const envDir = path.join(root, '.tmp/env')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.mkdirSync(envDir, { recursive: true })
    fs.writeFileSync(path.join(envDir, `${namespace}.env`), `FSUSBLOG_TEST_NAMESPACE=${namespace}\n`)
  }
  const runOnceOnlyNamespace = 'production-run-once-only'
  fs.mkdirSync(path.join(root, '.tmp/run-once', runOnceOnlyNamespace), { recursive: true })
  fs.writeFileSync(path.join(root, '.tmp/run-once', runOnceOnlyNamespace, 'auth-fixtures.json'), '{}')

  const removedContainers = []
  const cleanupStartedAfter = Date.now()
  const result = cleanupStaleLocalRuntimes({
    root,
    removeContainer: (name) => removedContainers.push(name)
  })
  const cleanupFinishedBefore = Date.now()

  assert.ok(Date.parse(result.startedAt) >= cleanupStartedAfter)
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt))
  assert.ok(Date.parse(result.finishedAt) <= cleanupFinishedBefore)
  assert.deepEqual(result.namespaces, ['production-old-a', 'production-old-b', runOnceOnlyNamespace])
  assert.deepEqual(result.terminatedPids, [])
  assert.deepEqual(removedContainers, [])
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-a')), false)
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-b')), false)
  assert.equal(fs.existsSync(path.join(root, '.tmp/run-once', runOnceOnlyNamespace)), false)
})

test('missing namespace env still inspects and removes standard owned containers by labels and full ID', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-missing-env-container-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const namespace = 'production-checkpoint-only'
  const runId = 'production-missing-env'
  const names = [
    `fsusblog-test-postgres-${namespace}`,
    `fsusblog-test-redis-${namespace}`
  ]
  const ids = new Map(names.map((name, index) => [name, String(index + 1).repeat(64)]))
  const present = new Set([...names, ...ids.values()])
  const inspected = []
  const removed = []
  const labels = {
    'io.fsusblog.test.run-id': runId,
    'io.fsusblog.test.bundle-id': 'runtime-browser',
    'io.fsusblog.test.step-id': 'bootstrap',
    'io.fsusblog.test.namespace': namespace
  }
  const result = cleanupLocalRuntime({
    root,
    namespace,
    trackedIdentity: { runId },
    inspectContainer: (identity) => {
      inspected.push(identity)
      const name = ids.has(identity)
        ? identity
        : [...ids].find(([, id]) => id === identity)?.[0]
      return name && present.has(identity)
        ? runtimeContainer(labels, ids.get(name))
        : null
    },
    removeContainer: (id, context) => {
      removed.push([id, context.name])
      present.delete(id)
      present.delete(context.name)
      return { removed: true }
    }
  })

  assert.deepEqual(removed, names.map((name) => [ids.get(name), name]))
  assert.ok(names.every((name) => inspected.includes(name)))
  assert.equal(result.cleanupStatus, 'complete')
  assert.deepEqual(result.removedContainers, names)
})

test('missing namespace env fails closed when a standard container lacks complete ownership labels', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-missing-env-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const namespace = 'production-missing-identity'
  const runId = 'production-missing-identity-run'
  const postgres = `fsusblog-test-postgres-${namespace}`
  const id = 'a'.repeat(64)
  let removeCount = 0
  const result = cleanupLocalRuntime({
    root,
    namespace,
    trackedIdentity: { runId },
    inspectContainer: (identity) => identity === postgres
      ? runtimeContainer({
          'io.fsusblog.test.run-id': runId,
          'io.fsusblog.test.namespace': namespace
        }, id)
      : null,
    removeContainer: () => {
      removeCount += 1
      return { removed: true }
    }
  })

  assert.equal(removeCount, 0)
  assert.equal(result.cleanupStatus, 'skipped')
  assert.deepEqual(result.containerCleanupFailures, [{
    container: postgres,
    reason: 'ownership-label-mismatch'
  }])
  assert.equal(verifyFreshRuntimeCleanup({ cleanups: [result] }).status, 'blocked')
})

test('checkpoint-only namespace is discovered and cleaned without env or acceptance tracking', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-checkpoint-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runId = 'production-checkpoint-runtime'
  const namespace = `${runId}-fresh-local-production-0`
  const checkpointDirectory = path.join(root, '.tmp/test-runs', runId)
  fs.mkdirSync(checkpointDirectory, { recursive: true })
  fs.writeFileSync(path.join(checkpointDirectory, 'checkpoint.json'), `${JSON.stringify({
    schema: 'fsusblog.test-matrix.checkpoint.v1',
    runId,
    targetTierId: 'production',
    runtimeNamespace: namespace
  })}\n`)
  const postgres = `fsusblog-test-postgres-${namespace}`
  const id = 'b'.repeat(64)
  let present = true
  let removeCount = 0
  const result = cleanupStaleLocalRuntimes({
    root,
    inspectContainer: (identity) => present && (identity === postgres || identity === id)
      ? runtimeContainer({
          'io.fsusblog.test.run-id': runId,
          'io.fsusblog.test.bundle-id': 'runtime-browser',
          'io.fsusblog.test.step-id': 'bootstrap',
          'io.fsusblog.test.namespace': namespace
        }, id)
      : null,
    removeContainer: () => {
      removeCount += 1
      present = false
      return { removed: true }
    }
  })

  assert.deepEqual(result.namespaces, [namespace])
  assert.equal(removeCount, 1)
  assert.deepEqual(result.removedContainers, [postgres])
  assert.equal(verifyFreshRuntimeCleanup(result).status, 'complete')
})

test('preflight and postflight execute the same tracked and strict untracked cleanup pipeline', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-symmetric-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const orphan = {
    pid: 8123,
    processGroupId: 8123,
    startTimeTicks: '444',
    args: ['/usr/bin/node', path.join(root, 'src/frontend/node_modules/.bin/vite'), 'preview']
  }
  const schemaName = 'fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9'
  const schemaId = 'c'.repeat(64)
  let orphanAlive = true
  let schemaPresent = true
  const cleanupOptions = {
    legacyContainerMinimumAgeMs: 600_000,
    orphanTerminationGraceMs: 3_000,
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    discoverOrphanProcesses: () => [orphan],
    killOrphanProcess: () => {
      orphanAlive = false
      return true
    },
    observeOrphanProcess: () => orphanAlive ? orphan : null,
    orphanProcessGroupExists: () => orphanAlive,
    listSchemaContainers: () => [schemaName],
    inspectContainer: (identity) => schemaPresent
      && (identity === schemaName || identity === schemaId)
      ? schemaContainer(schemaName, { id: schemaId })
      : null,
    detectActiveBackendTesthost: () => false,
    removeContainer: () => {
      schemaPresent = false
      return { removed: true }
    }
  }
  const source = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const preflight = runProductionFreshRuntimeCleanupPhase({
    root,
    phase: 'preflight',
    source,
    cleanupOptions
  })
  orphanAlive = true
  schemaPresent = true
  const postflight = runProductionFreshRuntimeCleanupPhase({
    root,
    phase: 'postflight',
    source,
    preflightSource: source,
    cleanupOptions
  })

  for (const cleanup of [preflight, postflight]) {
    assert.equal(cleanup.orphanProcessRecords[0].identityResult, 'strict-orphan-production-vite')
    assert.equal(cleanup.orphanProcessRecords[0].action, 'terminated')
    assert.equal(cleanup.untrackedContainerRecords[0].action, 'removed')
    assert.equal(verifyFreshRuntimeCleanup(cleanup).status, 'complete')
  }
})

test('runtime cleanup envelope turns inventory exceptions into blocked receipt evidence', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-inventory-failure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const cleanup = runProductionFreshRuntimeCleanupPhase({
    root,
    phase: 'preflight',
    source,
    cleanupOptions: {
      legacyContainerMinimumAgeMs: 600_000,
      orphanTerminationGraceMs: 3_000,
      discoverOrphanProcesses: () => [],
      listSchemaContainers: () => {
        throw new Error('injected Docker inventory failure')
      }
    }
  })
  const receipt = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'preflight',
    runId: 'inventory-failure-run',
    invocationId: 'inventory-failure-invocation',
    source,
    cleanup
  })

  assert.deepEqual(cleanup.operationFailures, [{
    stage: 'preflight-inventory-cleanup',
    message: 'injected Docker inventory failure'
  }])
  assert.equal(receipt.receipt.status, 'blocked')
  assert.match(receipt.receipt.failures[0], /injected Docker inventory failure/u)
  assert.equal(verifyFreshRuntimeCleanupReceipt(receipt.receipt).status, 'blocked')
})

test('fresh verifier fails closed on retained tracked state and receipt keeps exact resource identities', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-fresh-cleanup-receipt-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cleanup = {
    startedAt: '2026-07-26T00:00:00.000Z',
    finishedAt: '2026-07-26T00:00:01.000Z',
    namespaces: ['tracked-runtime'],
    cleanups: [{
      namespace: 'tracked-runtime',
      dedicatedRuntime: true,
      removedContainers: [],
      alreadyAbsentContainers: [],
      skippedContainers: ['fsusblog-test-postgres-tracked-runtime'],
      containerCleanupFailures: [{ container: 'fsusblog-test-postgres-tracked-runtime', reason: 'ownership-label-mismatch' }],
      terminatedPids: [],
      alreadyExitedPids: [],
      skippedProcesses: [{ pidFile: 'backend.pid', pid: 4242, reason: 'identity-sidecar-missing' }],
      retainedRuntimeState: true,
      cleanupStatus: 'skipped',
      residentResourceLeases: { status: 'cleanup-pending-live-services' },
      containerRecords: [{ name: 'fsusblog-test-postgres-tracked-runtime', id: 'a'.repeat(64), ownershipLabels: { 'io.fsusblog.test.namespace': 'tracked-runtime' }, action: 'blocked-ownership-mismatch', postObservation: 'not-removed' }],
      processRecords: [{ pid: 4242, processGroupId: 4242, startTimeTicks: '100', role: 'backend', identityResult: 'identity-sidecar-missing', action: 'blocked', postObservation: 'not-observed' }]
    }],
    removedContainers: [],
    skippedContainers: ['fsusblog-test-postgres-tracked-runtime'],
    terminatedPids: []
  }
  const verification = verifyFreshRuntimeCleanup(cleanup)
  assert.equal(verification.status, 'blocked')
  assert.ok(verification.failures.some((failure) => /container cleanup failure/u.test(failure)))
  const written = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'preflight',
    runId: 'production-cleanup-receipt',
    invocationId: 'invocation-1',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    cleanup
  })
  assert.equal(written.receipt.status, 'blocked')
  assert.match(written.receipt.contentDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.deepEqual(JSON.parse(fs.readFileSync(written.file, 'utf8')).cleanups[0].processRecords, cleanup.cleanups[0].processRecords)
  assert.ok(written.file.includes(`${path.sep}.tmp${path.sep}release-evidence${path.sep}`))
})

test('fresh verifier accepts already absent tracked resources and preserves their record', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-already-absent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cleanup = {
    startedAt: '2026-07-26T00:00:00.000Z',
    finishedAt: '2026-07-26T00:00:01.000Z',
    namespaces: ['tracked-runtime'],
    cleanups: [{
      namespace: 'tracked-runtime',
      dedicatedRuntime: true,
      containerCleanupFailures: [],
      skippedContainers: [],
      skippedProcesses: [],
      retainedRuntimeState: false,
      cleanupStatus: 'complete',
      residentResourceLeases: { status: 'released' },
      alreadyAbsentContainers: ['fsusblog-test-postgres-tracked-runtime'],
      alreadyExitedPids: [4242],
      containerRecords: [{
        name: 'fsusblog-test-postgres-tracked-runtime',
        id: null,
        ownershipLabels: null,
        action: 'already-absent',
        postObservation: 'name-absent'
      }],
      processRecords: [{
        pid: 4242,
        processGroupId: 4242,
        startTimeTicks: '100',
        role: 'backend',
        identityResult: 'identity-valid',
        action: 'already-absent',
        postObservation: 'leader-and-group-absent'
      }]
    }]
  }
  assert.deepEqual(verifyFreshRuntimeCleanup(cleanup), { status: 'complete', failures: [] })
  const receipt = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'preflight',
    runId: 'already-absent-run',
    invocationId: 'already-absent-invocation',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    cleanup
  })
  assert.deepEqual(receipt.receipt.alreadyAbsent, ['fsusblog-test-postgres-tracked-runtime', 4242])
  assert.equal(receipt.receipt.status, 'complete')
})

test('fresh verifier independently rejects tampered live post-observations and receipt digest', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-tamper-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const clean = { namespace: 'n', dedicatedRuntime: true, containerCleanupFailures: [], skippedContainers: [], skippedProcesses: [], retainedRuntimeState: false, cleanupStatus: 'complete', containerRecords: [{ name: 'fsusblog-test-postgres-n', id: 'a'.repeat(64), ownershipLabels: {}, action: 'removed', postObservation: 'name-and-id-absent' }], processRecords: [{ pid: 2, processGroupId: 2, startTimeTicks: '1', role: 'backend', identityResult: 'identity-valid', action: 'terminated', postObservation: 'leader-and-group-absent' }] }
  assert.equal(verifyFreshRuntimeCleanup({ cleanups: [clean] }).status, 'complete')
  assert.equal(verifyFreshRuntimeCleanup({ cleanups: [{ ...clean, containerRecords: [{ ...clean.containerRecords[0], postObservation: 'id-still-present' }] }] }).status, 'blocked')
  assert.equal(verifyFreshRuntimeCleanup({ cleanups: [{ ...clean, processRecords: [{ ...clean.processRecords[0], postObservation: 'group-still-live' }] }] }).status, 'blocked')
  const written = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'postflight',
    runId: 'tamper-run',
    invocationId: 'tamper-invocation',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    cleanup: {
      startedAt: '2026-07-26T00:00:00.000Z',
      finishedAt: '2026-07-26T00:00:01.000Z',
      namespaces: ['n'],
      cleanups: [clean]
    }
  })
  assert.equal(verifyFreshRuntimeCleanupReceipt(written.receipt).status, 'complete')
  written.receipt.cleanups[0].processRecords[0].postObservation = 'group-still-live'
  assert.throws(() => verifyFreshRuntimeCleanupReceipt(written.receipt), /digest/u)
})

test('same-source cleanup receipts keep independent run identities and blocked state', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-equivalence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const interval = { startedAt: '2026-07-26T00:00:00.000Z', finishedAt: '2026-07-26T00:00:01.000Z' }
  const complete = { ...interval, namespaces: [], cleanups: [], removedContainers: [], skippedContainers: [], terminatedPids: [] }
  const blocked = { ...interval, namespaces: ['n'], cleanups: [{ namespace: 'n', cleanupStatus: 'skipped', retainedRuntimeState: true, skippedProcesses: [], skippedContainers: [], containerCleanupFailures: [], containerRecords: [], processRecords: [] }], removedContainers: [], skippedContainers: [], terminatedPids: [] }
  const one = writeFreshRuntimeCleanupReceipt({ root, directory: path.join(root, 'external'), phase: 'preflight', runId: 'run-one', invocationId: 'one', source, cleanup: complete })
  const equivalent = writeFreshRuntimeCleanupReceipt({ root, directory: path.join(root, 'external'), phase: 'preflight', runId: 'run-two', invocationId: 'two', source, cleanup: complete })
  const two = writeFreshRuntimeCleanupReceipt({ root, directory: path.join(root, 'external'), phase: 'postflight', runId: 'run-two', invocationId: 'two', source, cleanup: blocked })
  const firstAttempt = writeFreshRuntimeCleanupReceipt({
    root,
    directory: path.join(root, 'external'),
    phase: 'preflight',
    runId: 'retry-run',
    invocationId: 'same-invocation',
    attemptId: '1'.repeat(32),
    source,
    cleanup: blocked
  })
  const successfulRetry = writeFreshRuntimeCleanupReceipt({
    root,
    directory: path.join(root, 'external'),
    phase: 'preflight',
    runId: 'retry-run',
    invocationId: 'same-invocation',
    attemptId: '2'.repeat(32),
    source,
    cleanup: complete
  })
  assert.equal(one.receipt.status, 'complete')
  assert.equal(equivalent.receipt.status, 'complete')
  assert.deepEqual(equivalent.receipt.source, one.receipt.source)
  assert.deepEqual(equivalent.receipt.discoveredNamespaces, one.receipt.discoveredNamespaces)
  assert.equal(one.receipt.source.worktreeFingerprint, two.receipt.source.worktreeFingerprint)
  assert.notEqual(one.file, equivalent.file)
  assert.notEqual(one.file, two.file)
  assert.notEqual(firstAttempt.file, successfulRetry.file)
  assert.equal(firstAttempt.receipt.invocationId, successfulRetry.receipt.invocationId)
  assert.notEqual(firstAttempt.receipt.attemptId, successfulRetry.receipt.attemptId)
  assert.equal(two.receipt.status, 'blocked')
  assert.equal(JSON.parse(fs.readFileSync(firstAttempt.file, 'utf8')).status, 'blocked')
  assert.equal(JSON.parse(fs.readFileSync(successfulRetry.file, 'utf8')).status, 'complete')
  assert.ok(fs.existsSync(one.file), 'later receipt must not overwrite earlier run receipt')
})

test('postflight receipt fails closed when the current source differs from preflight', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-source-mismatch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const receipt = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'postflight',
    runId: 'source-mismatch-run',
    invocationId: 'source-mismatch-invocation',
    source: { commit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) },
    cleanup: {
      startedAt: '2026-07-26T00:00:00.000Z',
      finishedAt: '2026-07-26T00:00:01.000Z',
      sourceStateMatchesPreflight: false,
      namespaces: [],
      cleanups: []
    }
  })

  assert.equal(receipt.receipt.source.commit, 'c'.repeat(40))
  assert.equal(receipt.receipt.sourceStateMatchesPreflight, false)
  assert.equal(receipt.receipt.status, 'blocked')
  assert.deepEqual(receipt.receipt.failures, ['postflight source state differs from preflight'])
  assert.equal(verifyFreshRuntimeCleanupReceipt(receipt.receipt).status, 'blocked')
})

test('cleanup receipt rejects missing fields, fake source, timestamps, schema and status tampering', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-shape-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const written = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'preflight',
    runId: 'shape-run',
    invocationId: 'shape-invocation',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    cleanup: {
      startedAt: '2026-07-26T00:00:00.000Z',
      finishedAt: '2026-07-26T00:00:01.000Z',
      namespaces: ['n'],
      cleanups: [{
        namespace: 'n',
        dedicatedRuntime: false,
        containerCleanupFailures: [],
        skippedContainers: [],
        skippedProcesses: [],
        retainedRuntimeState: false,
        cleanupStatus: 'complete',
        containerRecords: [],
        processRecords: []
      }]
    }
  })
  const invalid = (mutate, pattern) => {
    const receipt = structuredClone(written.receipt)
    mutate(receipt)
    receipt.contentDigest = freshRuntimeCleanupReceiptDigest(receipt)
    assert.throws(() => verifyFreshRuntimeCleanupReceipt(receipt), pattern)
  }
  invalid((receipt) => { receipt.schema = 'wrong' }, /schema/u)
  invalid((receipt) => { delete receipt.invocationId }, /invocationId/u)
  invalid((receipt) => { receipt.attemptId = 'not-an-attempt' }, /attemptId/u)
  invalid((receipt) => { receipt.source.commit = 'fake' }, /source state/u)
  invalid((receipt) => { receipt.startedAt = 'not-iso' }, /timestamps/u)
  invalid((receipt) => { receipt.finishedAt = '2025-01-01T00:00:00.000Z' }, /timestamps/u)
  invalid((receipt) => { receipt.status = 'blocked' }, /status/u)
  invalid((receipt) => { receipt.discoveredNamespaces = ['z', 'a'] }, /sorted and unique/u)
  invalid((receipt) => { delete receipt.cleanups[0].cleanupStatus }, /cleanup outcome/u)
  invalid((receipt) => { receipt.removed = ['unrecorded-container'] }, /action summaries/u)
})

test('blocked preflight atomically binds receipt, checkpoint and summary before producer spawn', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-preflight-block-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runId = 'blocked-preflight-run'
  const source = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const external = path.join(root, 'external')
  let producerSpawns = 0
  assert.throws(() => {
    executeProductionFreshPreflight({
      root,
      profileId: 'production',
      profile: {
        budgetMs: 300_000,
        summaryOnly: [],
        bundles: [{ id: 'runtime', members: ['production'] }]
      },
      runId,
      runsRoot: path.join(root, '.tmp/test-runs'),
      runtimeNamespace: `${runId}-fresh-local-production-0`,
      invocationId: 'blocked-preflight-invocation',
      sourceState: source,
      physicalTiers: [{ id: 'local-production-runtime', physicalBundleId: 'runtime' }],
      executionSource: 'fresh',
      wallClockStartedAtMs: Date.now() - 10,
      receiptDirectory: external,
      cleanupOptions: {
        legacyContainerMinimumAgeMs: 600_000,
        orphanTerminationGraceMs: 3_000,
        discoverOrphanProcesses: () => [],
        listSchemaContainers: () => {
          throw new Error('injected preflight inventory failure')
        }
      }
    })
    producerSpawns += 1
  }, /preflight blocked/u)
  assert.equal(producerSpawns, 0)
  const [externalReceipt] = fs.readdirSync(external)
  assert.equal(externalReceipt.endsWith('.json'), true)
  const externalReceiptFile = path.join(external, externalReceipt)
  assert.equal(
    verifyFreshRuntimeCleanupReceipt(JSON.parse(fs.readFileSync(externalReceiptFile, 'utf8'))).status,
    'blocked'
  )
  const checkpointFile = path.join(root, '.tmp/test-runs', runId, 'checkpoint.json')
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
  assert.equal(checkpoint.status, 'failure')
  assert.equal(checkpoint.runtimeCleanup.preflight.status, 'blocked')
  const boundReceipt = path.join(root, checkpoint.runtimeCleanup.preflight.path)
  assert.equal(fs.existsSync(boundReceipt), true)
  assert.notEqual(boundReceipt, externalReceiptFile)
  assert.equal(
    verifyFreshRuntimeCleanupReceipt(JSON.parse(fs.readFileSync(boundReceipt, 'utf8'))).status,
    'blocked'
  )
  const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/local-production/summary.json'), 'utf8'))
  assert.equal(summary.status, 'failure')
  assert.deepEqual(summary.runtimeCleanup, checkpoint.runtimeCleanup)
  const journalFile = path.join(
    path.dirname(checkpointFile),
    'evidence-store',
    'journals',
    `${runId}.jsonl`
  )
  const journal = fs.readFileSync(journalFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(journal.map((entry) => entry.eventType), ['runtime-cleanup-blocked'])
})

test('blocked preflight fallback journals failure when later checkpoint evidence binding throws', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-binding-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runId = 'blocked-binding-fallback'
  const source = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const blocked = writeFreshRuntimeCleanupReceipt({
    root,
    directory: path.join(root, 'external'),
    phase: 'preflight',
    runId,
    invocationId: 'binding-fallback-invocation',
    source,
    cleanup: {
      startedAt: '2026-07-26T00:00:00.000Z',
      finishedAt: '2026-07-26T00:00:01.000Z',
      namespaces: [],
      cleanups: [],
      operationFailures: [{ stage: 'preflight-inventory-cleanup', message: 'inventory failed' }]
    }
  })

  assert.throws(() => recordBlockedProductionFreshPreflight({
    root,
    profileId: 'production',
    profile: {
      budgetMs: 300_000,
      summaryOnly: [],
      bundles: [{ id: 'runtime', members: ['production'] }]
    },
    runId,
    runsRoot: path.join(root, '.tmp/test-runs'),
    runtimeNamespace: `${runId}-fresh-local-production-0`,
    sourceState: source,
    receipt: blocked,
    physicalTiers: [{ id: 'local-production-runtime', physicalBundleId: 'runtime' }],
    executionSource: 'fresh',
    wallClockStartedAtMs: Date.now() - 10,
    recordRuntimeCleanup: () => {
      throw new Error('injected checkpoint receipt mutation failure')
    }
  }), /injected checkpoint receipt mutation failure/u)

  const checkpointFile = path.join(root, '.tmp/test-runs', runId, 'checkpoint.json')
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
  assert.equal(checkpoint.status, 'failure')
  assert.match(checkpoint.failure.reason, /evidence binding failed/u)
  const journalFile = path.join(
    path.dirname(checkpointFile),
    'evidence-store',
    'journals',
    `${runId}.jsonl`
  )
  const journal = fs.readFileSync(journalFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(journal.map((entry) => entry.eventType), [
    'runtime-cleanup-preflight-binding-failed'
  ])
  const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/local-production/summary.json'), 'utf8'))
  assert.equal(summary.status, 'failure')
  assert.match(summary.failure.reason, /evidence binding failed/u)
})

test('preflight receipt persistence failure still leaves a journaled current-run failure', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-receipt-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runId = 'preflight-receipt-fallback'
  const source = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const invalidReceiptDirectory = path.join(root, 'receipt-directory-is-a-file')
  fs.writeFileSync(invalidReceiptDirectory, 'not a directory')
  let producerSpawns = 0

  assert.throws(() => {
    executeProductionFreshPreflight({
      root,
      profileId: 'production',
      profile: {
        budgetMs: 300_000,
        summaryOnly: [],
        bundles: [{ id: 'runtime', members: ['production'] }]
      },
      runId,
      runsRoot: path.join(root, '.tmp/test-runs'),
      runtimeNamespace: `${runId}-fresh-local-production-0`,
      invocationId: 'receipt-fallback-invocation',
      sourceState: source,
      physicalTiers: [{ id: 'local-production-runtime', physicalBundleId: 'runtime' }],
      executionSource: 'fresh',
      wallClockStartedAtMs: Date.now() - 10,
      receiptDirectory: invalidReceiptDirectory,
      cleanupRuntime: () => ({
        startedAt: '2026-07-26T00:00:00.000Z',
        finishedAt: '2026-07-26T00:00:01.000Z',
        namespaces: [],
        cleanups: [],
        removedContainers: [],
        skippedContainers: [],
        terminatedPids: []
      })
    })
    producerSpawns += 1
  }, /EEXIST|not a directory/u)

  assert.equal(producerSpawns, 0)
  const checkpointFile = path.join(root, '.tmp/test-runs', runId, 'checkpoint.json')
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
  assert.equal(checkpoint.status, 'failure')
  assert.match(checkpoint.failure.reason, /receipt persistence failed/u)
  const journalFile = path.join(
    path.dirname(checkpointFile),
    'evidence-store',
    'journals',
    `${runId}.jsonl`
  )
  const journal = fs.readFileSync(journalFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(journal.map((entry) => entry.eventType), [
    'runtime-cleanup-preflight-receipt-failed'
  ])
  const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/local-production/summary.json'), 'utf8'))
  assert.equal(summary.status, 'failure')
  assert.match(summary.failure.reason, /receipt persistence failed/u)
})

test('external preflight receipt survives fresh output cleanup before current-run binding', (t) => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-cleanup-receipt-survival-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'repository')
  const external = path.join(temp, 'external-receipts')
  fs.mkdirSync(path.join(root, '.tmp', 'stale'), { recursive: true })
  fs.writeFileSync(path.join(root, '.tmp', 'stale', 'result.json'), '{}')
  const receipt = writeFreshRuntimeCleanupReceipt({
    root,
    directory: external,
    phase: 'preflight',
    runId: 'receipt-survival-run',
    invocationId: 'receipt-survival-invocation',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    cleanup: {
      startedAt: '2026-07-26T00:00:00.000Z',
      finishedAt: '2026-07-26T00:00:01.000Z',
      namespaces: [],
      cleanups: []
    }
  })

  cleanLocalProductionOutputs(root, {
    runId: 'receipt-survival-run',
    ownerIdentity: cacheTransactionOwner(root)
  })

  assert.equal(fs.existsSync(path.join(root, '.tmp', 'stale')), false)
  assert.equal(fs.existsSync(receipt.file), true)
  assert.equal(verifyFreshRuntimeCleanupReceipt(JSON.parse(fs.readFileSync(receipt.file, 'utf8'))).status, 'complete')
})

test('default stale cleanup refuses a reused pid that is not a managed acceptance command', (t) => {
  if (process.platform === 'win32') return
  const root = process.cwd()
  const namespace = `reused-pid-${process.pid}`
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${process.pid}\n`)

  const result = cleanupLocalRuntime({ root, namespace })

  assert.deepEqual(result.terminatedPids, [])
  assert.deepEqual(result.skippedProcesses, [{
    pidFile: 'backend.pid',
    pid: process.pid,
    reason: 'identity-sidecar-missing'
  }])
  assert.equal(result.cleanupStatus, 'skipped')
  assert.equal(process.kill(process.pid, 0), true)
})

test('cleanupLocalRuntime removes only containers and process state owned by its namespace', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-cleanup-'))
  const namespace = 'production-run-42'
  const envDir = path.join(root, '.tmp/env')
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  const fixtureDir = path.join(root, '.tmp/fixtures', namespace)
  const dataDir = path.join(root, '.tmp/data', namespace)
  const runOnceDir = path.join(root, '.tmp/run-once', namespace)
  const otherRunOnceDir = path.join(root, '.tmp/run-once/production-run-elsewhere')
  const runId = 'production-managed-run'
  const bundleId = 'runtime-browser'
  const stepId = 'bootstrap'
  const pid = 4242
  const startTimeTicks = '100'
  fs.mkdirSync(envDir, { recursive: true })
  for (const directory of [runtimeDir, fixtureDir, dataDir, runOnceDir, otherRunOnceDir]) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'fixture'), 'fixture')
  }
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${pid}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(runtimeDir, 'backend.identity.json'), `${JSON.stringify({
    schema: 'fsusblog.local-runtime-process-identity.v1',
    pid,
    processGroupId: pid,
    startTimeTicks,
    runId,
    namespace,
    role: 'backend',
    preparationId: ''
  })}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
    `FSUSBLOG_TEST_RUN_ID=${runId}`,
    `FSUSBLOG_PHYSICAL_BUNDLE_ID=${bundleId}`,
    `FSUSBLOG_STEP_ID=${stepId}`,
    'FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=0',
    `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
    `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`,
    'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:40000'
  ].join('\n'))

  const containerIds = new Map([
    [`fsusblog-test-postgres-${namespace}`, 'a'.repeat(64)],
    [`fsusblog-test-redis-${namespace}`, 'b'.repeat(64)]
  ])
  const labels = {
    'io.fsusblog.test.run-id': runId,
    'io.fsusblog.test.bundle-id': bundleId,
    'io.fsusblog.test.step-id': stepId,
    'io.fsusblog.test.namespace': namespace
  }
  const present = new Set([...containerIds.keys(), ...containerIds.values()])
  const removals = []
  let processRunning = true
  const result = cleanupLocalRuntime({
    root,
    namespace,
    containerExists: (identity) => present.has(identity),
    inspectContainer: (name) => runtimeContainer(labels, containerIds.get(name)),
    removeContainer: (id, context) => {
      removals.push([id, context.name])
      present.delete(id)
      present.delete(context.name)
      return { removed: true }
    },
    observeProcess: () => processRunning ? {
      pid,
      processGroupId: pid,
      startTimeTicks,
      cwd: root,
      args: ['dotnet', path.join(root, 'src/backend/FsusBlog.Server.dll')],
      env: {
        FSUSBLOG_TEST_RUN_ID: runId,
        FSUSBLOG_TEST_NAMESPACE: namespace,
        FSUSBLOG_RUNTIME_ROLE: 'backend',
        FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '0',
        FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: ''
      }
    } : null,
    processGroupExists: () => processRunning,
    terminateDedicatedProcess: () => { processRunning = false; return true }
  })

  assert.deepEqual(removals, [
    ['a'.repeat(64), `fsusblog-test-postgres-${namespace}`],
    ['b'.repeat(64), `fsusblog-test-redis-${namespace}`]
  ])
  assert.deepEqual(result.removedContainers, [
    `fsusblog-test-postgres-${namespace}`,
    `fsusblog-test-redis-${namespace}`
  ])
  assert.deepEqual(result.terminatedPids, [pid])
  assert.equal(fs.existsSync(path.join(envDir, `${namespace}.env`)), false)
  assert.equal(fs.existsSync(runtimeDir), false)
  assert.equal(fs.existsSync(fixtureDir), false)
  assert.equal(fs.existsSync(dataDir), false)
  assert.equal(fs.existsSync(runOnceDir), false)
  assert.equal(fs.existsSync(otherRunOnceDir), true)
})

test('cleanupLocalRuntime refuses container names not derived from the current namespace', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-cleanup-'))
  const namespace = 'production-run-43'
  const envDir = path.join(root, '.tmp/env')
  fs.mkdirSync(envDir, { recursive: true })
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    'FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1',
    'FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID=external-resource-test',
    'FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-dev-postgres',
    'FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-other-run'
  ].join('\n'))

  const removedContainers = []
  const result = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: (name) => removedContainers.push(name)
  })

  assert.deepEqual(removedContainers, [])
  assert.deepEqual(result.skippedContainers, ['fsusblog-dev-postgres', 'fsusblog-test-redis-other-run'])
  assert.equal(result.cleanupStatus, 'complete', 'external container names are neither deleted nor treated as owned state')
  assert.deepEqual(verifyFreshRuntimeCleanup({ cleanups: [result] }), { status: 'complete', failures: [] })
  const receipt = writeFreshRuntimeCleanupReceipt({
    root,
    phase: 'preflight',
    runId: 'external-resource-run',
    invocationId: 'external-resource-invocation',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    cleanup: {
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      namespaces: [result.namespace],
      cleanups: [result],
      removedContainers: result.removedContainers,
      skippedContainers: result.skippedContainers,
      terminatedPids: result.terminatedPids
    }
  })
  assert.equal(receipt.receipt.status, 'complete')
  assert.deepEqual(receipt.receipt.skipped, result.skippedContainers)
})

test('cleanupLocalRuntime retains recovery handles until resident identities are confirmed exited', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-resident-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const namespace = 'production-resident-retry'
  const runId = 'resident-cleanup-run'
  const envFile = path.join(root, '.tmp/env', `${namespace}.env`)
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  const fixtureDir = path.join(root, '.tmp/fixtures', namespace)
  const dataDir = path.join(root, '.tmp/data', namespace)
  const runDir = path.join(root, '.tmp/test-runs', runId)
  for (const directory of [path.dirname(envFile), runtimeDir, fixtureDir, dataDir, runDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(envFile, [
    `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
    `FSUSBLOG_TEST_RUN_ID=${runId}`,
    'FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=0'
  ].join('\n'))
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), '4242\n', { mode: 0o600 })
  fs.writeFileSync(path.join(runtimeDir, 'backend.identity.json'), `${JSON.stringify({
    schema: 'fsusblog.local-runtime-process-identity.v1',
    pid: 4242,
    processGroupId: 4242,
    startTimeTicks: '100',
    runId,
    namespace,
    role: 'backend',
    preparationId: ''
  })}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(fixtureDir, 'fixture'), 'fixture')
  fs.writeFileSync(path.join(dataDir, 'state'), 'state')
  const inventory = createResidentLeaseInventory({
    runId,
    namespace,
    ownerBundleId: 'runtime-browser',
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    resourceGrant: { cpuUnits: 2, memoryGiB: 4 },
    services: [{
      id: 'debug-backend',
      kind: 'process',
      identity: { pid: 4242, startTimeTicks: '100' },
      port: 24001,
      generation: 'backend-1',
      health: { status: 'ready', checkedAt: '2026-07-14T00:00:00.000Z' },
      observedRssBytes: 1024
    }]
  })
  const inventoryFile = path.join(runDir, 'resident-resource-leases.json')
  const checkpointFile = path.join(runDir, 'checkpoint.json')
  writeResidentLeaseDocument(inventoryFile, inventory)
  writeResidentLeaseDocument(checkpointFile, {
    schema: 'fsusblog.test-matrix.checkpoint.v1',
    runId,
    targetTierId: 'production',
    mode: 'fresh',
    authoritative: true,
    status: 'success',
    startedAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:01.000Z',
    finishedAt: '2026-07-14T00:00:01.000Z',
    sourceState: inventory.sourceState,
    completedTiers: [],
    tiers: {},
    failure: null,
    failures: [],
    residentResourceLeases: {
      status: 'handed-off',
      inventoryFile: `.tmp/test-runs/${runId}/resident-resource-leases.json`,
      reservation: inventory.reservation,
      services: {},
      events: []
    }
  })

  const retained = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: () => {},
    observeProcess: () => null,
    processGroupExists: () => false,
    observeResidentService: () => ({ status: 'unknown', reason: 'termination-pending' }),
    residentCleanupTimeoutMs: 0
  })
  assert.equal(retained.residentResourceLeases.status, 'cleanup-pending-live-services')
  assert.equal(retained.retainedRuntimeState, true)
  assert.equal(fs.existsSync(envFile), true)
  assert.equal(fs.existsSync(runtimeDir), true)
  assert.equal(fs.existsSync(fixtureDir), true)
  assert.equal(fs.existsSync(dataDir), true)

  const released = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: () => {},
    observeProcess: () => null,
    processGroupExists: () => false,
    observeResidentService: () => ({ status: 'exited' }),
    residentCleanupTimeoutMs: 0
  })
  assert.equal(released.residentResourceLeases.status, 'released')
  assert.equal(released.retainedRuntimeState, false)
  assert.equal(fs.existsSync(envFile), false)
  assert.equal(fs.existsSync(runtimeDir), false)
  assert.equal(fs.existsSync(fixtureDir), false)
  assert.equal(fs.existsSync(dataDir), false)
})
