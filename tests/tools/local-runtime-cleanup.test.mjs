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
  isOrphanProductionViteProcess,
  isStaleSchemaContainer,
  terminateDedicatedProcessGroup
} from '../../tools/test-matrix/local-runtime-cleanup.mjs'
import {
  createResidentLeaseInventory,
  writeResidentLeaseDocument
} from '../../tools/test-matrix/resident-resource-leases.mjs'

function schemaContainer(name, {
  created = '2026-07-12T00:00:00.000Z',
  labels = {},
  image = 'postgres:18-alpine',
  hostIp = '127.0.0.1',
  binds = null
} = {}) {
  return {
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
    source.indexOf('resolve_bootstrap_parallel_workers()'),
    source.indexOf('resolve_bootstrap_child_environment()')
  )
  const childResolver = source.slice(
    source.indexOf('resolve_bootstrap_child_environment()'),
    source.indexOf('run_bootstrap_parallel()')
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
  assert.match(source, /write_runtime_process_identity "\$pid_file" "\$started_pid" backend "\$readiness_deadline"/u)
  assert.match(source, /write_runtime_process_identity "\$pid_file" "\$started_pid" "\$role" "\$readiness_deadline"/u)
  assert.match(source, /fs\.constants\.O_NOFOLLOW[\s\S]*?fs\.fstatSync\(fd\)[\s\S]*?\(stat\.mode & 0o777\) !== 0o600/u)
  assert.match(source, /observed\.processGroupId !== managedPid[\s\S]*?observed\.sessionId !== managedPid/u)
  assert.match(source, /write_runtime_pid_file "\$pid_file" "\$started_pid"/u)

  const backend = source.slice(source.indexOf('ensure_backend()'), source.indexOf('start_background_if_needed()'))
  const background = source.slice(source.indexOf('start_background_if_needed()'), source.indexOf('ensure_debug_frontend()'))
  const debugFrontend = source.slice(source.indexOf('ensure_debug_frontend()'), source.indexOf('ensure_release_preview()'))
  const releasePreview = source.slice(source.indexOf('ensure_release_preview()'), source.indexOf('prepare_fixtures()'))
  for (const [label, runtimeSource, reuseMarker] of [
    ['backend', backend, 'already healthy'],
    ['background helper', background, 'already reachable'],
    ['debug frontend', debugFrontend, 'already healthy'],
    ['release preview', releasePreview, 'already healthy']
  ]) {
    assert.ok(runtimeSource.indexOf('admit_dedicated_runtime_port') >= 0, `${label} lacks dedicated admission`)
    assert.ok(runtimeSource.indexOf('admit_dedicated_runtime_port')
      < runtimeSource.indexOf(reuseMarker), `${label} admits after reuse`)
  }
  assert.doesNotMatch(backend.slice(0, backend.indexOf('nohup setsid')), /kill_pid_if_running/u)
  assert.doesNotMatch(debugFrontend, /kill_pid_if_running/u)
  assert.doesNotMatch(releasePreview, /kill_pid_if_running/u)
  assert.match(background, /local role[\s\S]*?role="\$\(runtime_process_role[\s\S]*?probe_url[\s\S]*?admit_dedicated_runtime_port[\s\S]*?already reachable/u)
  assert.match(background, /assert_dedicated_runtime_port_available "\$label" "\$port"[\s\S]*?nohup setsid/u)
  assert.match(backend, /assert_dedicated_runtime_port_available 'debug backend' "\$DEBUG_BACKEND_PORT"[\s\S]*?nohup setsid/u)
  assert.match(debugFrontend, /kill_runtime_pid_if_owned debug-frontend[\s\S]*?wait_for_port_release[\s\S]*?start_background_if_needed/u)
  assert.match(releasePreview, /admit_dedicated_runtime_port[\s\S]*?building release preview[\s\S]*?admit_dedicated_runtime_port[\s\S]*?kill_runtime_pid_if_owned release-preview/u)
  const portRelease = source.slice(source.indexOf('wait_for_port_release()'), source.indexOf('probe_url()'))
  assert.match(portRelease, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?port_is_listening[\s\S]*?refusing blind termination[\s\S]*?return 1[\s\S]*?kill_pid_if_running/u)

  const postgres = source.slice(source.indexOf('ensure_postgres()'), source.indexOf('ensure_redis()'))
  const redis = source.slice(source.indexOf('ensure_redis()'), source.indexOf('refresh_fixture_service_generation()'))
  for (const serviceSource of [postgres, redis]) {
    assert.match(serviceSource, /assert_dedicated_container_binding/u)
    assert.match(serviceSource, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?refusing to remove or recreate[\s\S]*?return 1[\s\S]*?docker rm -f -v/u)
  }
  const fixtures = source.slice(source.indexOf('prepare_fixtures()'), source.indexOf('current_pow_difficulty()'))
  assert.match(fixtures, /DEDICATED_RUNTIME:-0\}" == "1"[\s\S]*?prepare_auth_fixtures_once[\s\S]*?prepare_public_fixtures_once[\s\S]*?else[\s\S]*?run_parallel "bootstrap-runtime-fixtures"/u)
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
    port_is_listening() { [[ "$TEST_LISTENING" == "1" ]]; }
    find_port_pid() { printf '%s\n' "$TEST_PORT_PID"; }
    dedicated_runtime_process_binding_matches() { [[ "$TEST_BINDING" == "1" ]]; }
    runtime_process_group_exists() { [[ "$TEST_GROUP_EXISTS" == "1" ]]; }
    signal_runtime_process_group() {
      SIGNAL_CALLS=$((SIGNAL_CALLS + 1))
      TEST_GROUP_EXISTS=0
    }

    while IFS=: read -r role pid_name port; do
      pid_file="$TMP_DIR/$pid_name"
      rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"

      TEST_LISTENING=1
      TEST_PORT_PID=424242
      TEST_BINDING=0
      if admit_dedicated_runtime_port "$role" "$role" "$pid_file" "$port" 0; then
        fail_fixture "$role admitted a foreign listener"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a foreign listener"

      TEST_PORT_PID=''
      if admit_dedicated_runtime_port "$role" "$role" "$pid_file" "$port" 1; then
        fail_fixture "$role reused a reachable listener without an inspectable sidecar"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a hidden listener"

      write_runtime_pid_file "$pid_file" "$$"
      TEST_PORT_PID=424243
      TEST_BINDING=1
      admit_dedicated_runtime_port "$role" "$role" "$pid_file" "$port" 1 \
        || fail_fixture "$role rejected an owned child listener"

      TEST_LISTENING=0
      TEST_PORT_PID=''
      admit_dedicated_runtime_port "$role" "$role" "$pid_file" "$port" 0 \
        || fail_fixture "$role rejected a free port"
      TEST_LISTENING=1
      TEST_PORT_PID=424244
      if assert_dedicated_runtime_port_available "$role" "$port"; then
        fail_fixture "$role missed a pre-spawn port race"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a raced listener"

      TEST_BINDING=0
      TEST_GROUP_EXISTS=1
      if kill_runtime_pid_if_owned "$role" "$pid_file" "$$" "$EXECUTION_DEADLINE_AT_MS"; then
        fail_fixture "$role terminated a mismatched process"
      fi
      [[ "$SIGNAL_CALLS" == "0" ]] || fail_fixture "$role signalled a mismatched process group"

      TEST_BINDING=1
      kill_runtime_pid_if_owned "$role" "$pid_file" "$$" "$EXECUTION_DEADLINE_AT_MS" \
        || fail_fixture "$role could not terminate its owned process group"
      [[ "$SIGNAL_CALLS" == "1" ]] || fail_fixture "$role did not signal exactly one owned group"
      SIGNAL_CALLS=0

      TEST_LISTENING=1
      TEST_PORT_PID=''
      deadline_now="$(date +%s%3N)"
      if wait_for_port_release "$port" "$deadline_now"; then
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

test('default container cleanup removes anonymous test volumes with the container', () => {
  const source = fs.readFileSync('tools/test-matrix/local-runtime-cleanup.mjs', 'utf8')
  assert.match(source, /spawnSync\('docker', \['rm', '--force', '--volumes', name\]/u)
  assert.match(source, /process\.kill\(-pid, 'SIGTERM'\)/u)
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
  const orphan = { pid: 900, startTimeTicks: '1234', args: [], env: {} }
  const staleName = 'fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9'
  const retainedName = 'fsusblog-dev-postgres'
  const killed = []
  const removed = []
  const result = cleanupStaleLocalRuntimes({
    root,
    discoverUntracked: true,
    legacyContainerMinimumAgeMs: 600_000,
    orphanTerminationGraceMs: 3_000,
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    discoverOrphanProcesses: () => [orphan],
    killOrphanProcess: (record, graceMs) => { killed.push([record.pid, graceMs]); return true },
    listSchemaContainers: () => [staleName, retainedName],
    inspectContainer: (name) => name === staleName ? schemaContainer(staleName) : schemaContainer(retainedName),
    detectActiveBackendTesthost: () => false,
    removeContainer: (name) => removed.push(name)
  })
  assert.deepEqual(killed, [[900, 3_000]])
  assert.deepEqual(removed, [staleName])
  assert.deepEqual(result.orphanProcesses, [900])
  assert.deepEqual(result.untrackedContainers, [staleName])
  assert.deepEqual(result.terminatedPids, [900])
  assert.deepEqual(result.removedContainers, [staleName])
  fs.rmSync(root, { recursive: true, force: true })
})

test('cleanupStaleLocalRuntimes discovers tracked namespaces before fresh output deletion', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-stale-runtime-cleanup-'))
  for (const namespace of ['production-old-a', 'production-old-b']) {
    const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
    const envDir = path.join(root, '.tmp/env')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.mkdirSync(envDir, { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${namespace.endsWith('a') ? 101 : 202}\n`)
    fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
      `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
      `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`
    ].join('\n'))
  }
  const runOnceOnlyNamespace = 'production-run-once-only'
  fs.mkdirSync(path.join(root, '.tmp/run-once', runOnceOnlyNamespace), { recursive: true })
  fs.writeFileSync(path.join(root, '.tmp/run-once', runOnceOnlyNamespace, 'auth-fixtures.json'), '{}')

  const removedContainers = []
  const terminatedPids = []
  const result = cleanupStaleLocalRuntimes({
    root,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: (pid) => { terminatedPids.push(pid); return true }
  })

  assert.deepEqual(result.namespaces, ['production-old-a', 'production-old-b', runOnceOnlyNamespace])
  assert.deepEqual(terminatedPids, [101, 202])
  assert.deepEqual(removedContainers, [
    'fsusblog-test-postgres-production-old-a',
    'fsusblog-test-redis-production-old-a',
    'fsusblog-test-postgres-production-old-b',
    'fsusblog-test-redis-production-old-b'
  ])
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-a')), false)
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-b')), false)
  assert.equal(fs.existsSync(path.join(root, '.tmp/run-once', runOnceOnlyNamespace)), false)
})

test('default stale cleanup refuses a reused pid that is not a managed acceptance command', () => {
  if (process.platform === 'win32') return
  const root = process.cwd()
  const namespace = `reused-pid-${process.pid}`
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${process.pid}\n`)

  const result = cleanupLocalRuntime({ root, namespace })

  assert.deepEqual(result.terminatedPids, [])
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
  fs.mkdirSync(envDir, { recursive: true })
  for (const directory of [runtimeDir, fixtureDir, dataDir, runOnceDir, otherRunOnceDir]) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'fixture'), 'fixture')
  }
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), '999999\n')
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
    `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`,
    'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:40000'
  ].join('\n'))

  const removedContainers = []
  const result = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: () => false
  })

  assert.deepEqual(removedContainers, [
    `fsusblog-test-postgres-${namespace}`,
    `fsusblog-test-redis-${namespace}`
  ])
  assert.deepEqual(result.removedContainers, removedContainers)
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
    'FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-dev-postgres',
    'FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-other-run'
  ].join('\n'))

  const removedContainers = []
  const result = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: () => false
  })

  assert.deepEqual(removedContainers, [])
  assert.deepEqual(result.skippedContainers, ['fsusblog-dev-postgres', 'fsusblog-test-redis-other-run'])
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
  fs.writeFileSync(envFile, `FSUSBLOG_TEST_RUN_ID=${runId}\n`)
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), '4242\n')
  fs.writeFileSync(path.join(fixtureDir, 'fixture'), 'fixture')
  fs.writeFileSync(path.join(dataDir, 'state'), 'state')
  const inventory = createResidentLeaseInventory({
    runId,
    namespace,
    ownerBundleId: 'runtime-browser',
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
    killProcess: () => true,
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
    killProcess: () => true,
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
