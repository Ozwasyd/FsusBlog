import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  abortGatewayTransition,
    beginGatewayTransition,
    commitGatewayTransition,
    createEmptySlotState,
    readLegacySlotState,
    readSlotState,
    recordSlotStart,
    setActiveSlot,
  writeSlotStateAtomic
} from '../../tools/deployment/slot-lib.mjs'
import {
  initializeUpstreamFile,
  inspectUpstreamFile,
  prepareGatewayFiles,
  renderUpstream
} from '../../tools/deployment/gateway-control.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const blueRelease = '20260711010101-0123456789ab'
const greenRelease = '20260711020202-fedcba987654'
const blueDigest = `sha256:${'a'.repeat(64)}`
const greenDigest = `sha256:${'e'.repeat(64)}`
const commitSha = '0123456789abcdef0123456789abcdef01234567'
const ports = { FSUSBLOG_BLUE_PORT: '18081', FSUSBLOG_GREEN_PORT: '18082' }

test('controlled upstream generator permits only exact loopback blue and green ports', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-gateway-generator-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const active = path.join(directory, 'active-upstream.conf')
  const config = path.join(directory, 'nginx.conf')
  fs.writeFileSync(active, renderUpstream('blue', ports))
  fs.writeFileSync(config, `events {}\nhttp {\n  upstream fsusblog_kestrel {\n    include ${active};\n    keepalive 64;\n  }\n}\n`)

  assert.equal(renderUpstream('blue', ports), 'server 127.0.0.1:18081;\n')
  assert.equal(renderUpstream('green', ports), 'server 127.0.0.1:18082;\n')
  assert.throws(() => renderUpstream('red', ports), /blue or green/u)
  assert.equal(inspectUpstreamFile(active, ports).slot, 'blue')

  const prepared = prepareGatewayFiles({ slot: 'green', activeFile: active, gatewayConfig: config, environment: ports })
  assert.equal(inspectUpstreamFile(active, ports).slot, 'blue', 'preparing a candidate must not alter active traffic')
  assert.equal(inspectUpstreamFile(prepared.preparedFile, ports).slot, 'green')
  fs.writeFileSync(path.join(directory, '.active-upstream.conf.next-interrupted'), 'server 10.0.0.8:8080;')
  assert.equal(inspectUpstreamFile(active, ports).slot, 'blue', 'an interrupted temporary write cannot become active')

  fs.writeFileSync(active, 'server 0.0.0.0:18081;\n')
  assert.throws(() => inspectUpstreamFile(active, ports), /controlled loopback/u)
  fs.writeFileSync(active, 'server 127.0.0.1:9999;\n')
  assert.throws(() => inspectUpstreamFile(active, ports), /controlled loopback/u)
  fs.writeFileSync(active, 'server 127.0.0.1:18081;\nserver 127.0.0.1:18082;\n')
  assert.throws(() => inspectUpstreamFile(active, ports), /exactly one/u)

  const initialized = path.join(directory, 'initialized-upstream.conf')
  assert.equal(initializeUpstreamFile(initialized, 'blue', ports).status, 'initialized')
  assert.equal(initializeUpstreamFile(initialized, 'blue', ports).status, 'already-initialized')
  assert.throws(() => initializeUpstreamFile(initialized, 'green', ports), /gateway-switch/u)
})

test('durable traffic state commits switch, rollback and failed transition generations deterministically', () => {
  const state = createRunningState()
  beginGatewayTransition(state, {
    slot: 'green', releaseId: greenRelease, imageDigest: greenDigest,
    kind: 'switch', startedAt: '2026-07-11T02:01:00.000Z'
  })
  assert.equal(state.status, 'switching')
  assert.equal(state.pendingTransition.generation, 2)
  commitGatewayTransition(state, { committedAt: '2026-07-11T02:02:00.000Z' })
  assert.equal(state.activeSlot, 'green')
  assert.equal(state.previousSlot, 'blue')
  assert.equal(state.switchGeneration, 2)

  beginGatewayTransition(state, {
    slot: 'blue', releaseId: blueRelease, imageDigest: blueDigest,
    kind: 'rollback', startedAt: '2026-07-11T02:03:00.000Z'
  })
  commitGatewayTransition(state, { committedAt: '2026-07-11T02:04:00.000Z' })
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.previousSlot, 'green')
  assert.equal(state.switchGeneration, 3)
  assert.equal(state.lastTrafficTransition.kind, 'rollback')

  beginGatewayTransition(state, {
    slot: 'green', releaseId: greenRelease, imageDigest: greenDigest,
    kind: 'switch', startedAt: '2026-07-11T02:05:00.000Z'
  })
  abortGatewayTransition(state, { message: 'staged config rejected', abortedAt: '2026-07-11T02:06:00.000Z' })
  assert.equal(state.status, 'stable')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.switchGeneration, 3, 'failed transitions do not consume a committed generation')
  assert.equal(state.lastTrafficTransition.status, 'failed')
})

test('legacy slot state upgrades only from a complete persisted active identity and rejects partial gateway fields', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-gateway-state-upgrade-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'slots.json')
  const legacy = createRunningState()
  for (const key of [
    'activeReleaseId', 'activeImageDigest', 'previousSlot', 'previousReleaseId', 'previousImageDigest',
    'switchedAtUtc', 'switchGeneration', 'status', 'pendingTransition', 'lastTrafficTransition'
    ]) {delete legacy[key]};
    delete legacy.runtimeGeneration;
    fs.writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
    assert.throws(() => readSlotState(file, { allowMissing: false }), /explicit readLegacySlotState/u);
    const legacyResult = readLegacySlotState(file);
    assert.equal(legacyResult.legacy, true);
    assert.equal(legacyResult.rollbackOnly, true);
    const upgraded = legacyResult.state;
    assert.equal(upgraded.status, 'stable');
    assert.equal(upgraded.activeSlot, 'blue');
    assert.equal(upgraded.activeReleaseId, blueRelease);
  assert.equal(upgraded.activeImageDigest, blueDigest)
  assert.equal(upgraded.switchGeneration, 1)
  assert.equal(upgraded.runtimeGeneration, 2)

    delete legacy.activeSlot;
    legacy.status = 'stable';
    fs.writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
    assert.throws(() => readSlotState(file, { allowMissing: false }), /explicit readLegacySlotState/u);
    assert.throws(() => readLegacySlotState(file), /partial gateway-state extension/u);
});

test('gateway switches blue to green and rolls back while sustained public requests avoid failures', async (t) =>
{
  const fixture = createGatewayFixture(t)
  const requester = collectChild(spawn('bash', ['-c', [
    'failures=0',
    'for ((i=0; i<100; i++)); do',
    '  curl -fsS --max-time 1 http://gateway.test/health/ready >/dev/null || failures=$((failures+1))',
    '  sleep 0.005',
    'done',
    'printf "%s\\n" "$failures"',
    'test "$failures" -eq 0'
  ].join('\n')], { cwd: root, env: fixture.environment }))

  const switched = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ])
  assert.equal(switched.status, 0, switched.stderr)
  const requestResult = await requester
  assert.equal(requestResult.code, 0, `${requestResult.stdout}\n${requestResult.stderr}`)
  assert.equal(requestResult.stdout.trim(), '0')

  let state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.activeSlot, 'green')
  assert.equal(state.previousSlot, 'blue')
  assert.equal(state.switchGeneration, 2)
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'green')
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'green')
  let evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.status, 'ok')
  assert.equal(evidence.kind, 'switch')
  assert.equal(evidence.checks.targetReadiness, true)
  assert.equal(evidence.checks.stagedConfigTest, true)
  assert.equal(evidence.checks.reload, true)
  assert.equal(evidence.checks.publicReleaseProbe, true)
  assert.equal(evidence.checks.targetLoopbackAfterReload, true)
  assert.equal(evidence.checks.stateCommit, true)
  assert.equal(evidence.checks.sourceRuntimeStatus, true)
  assert.equal(evidence.checks.targetRuntimeStatus, true)
  assert.equal(evidence.checks.targetActivation, true)
  assert.equal(evidence.checks.sourceDrain, true)
  assert.equal(evidence.lifecycle.targetAfterActivation.state, 'active')
  assert.equal(evidence.lifecycle.sourceAfterDrain.state, 'draining')

  setRuntimeCandidateReady(fixture, 'blue')
  const rolledBack = runGateway(fixture, 'gateway-rollback.sh')
  assert.equal(rolledBack.status, 0, rolledBack.stderr)
  state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.previousSlot, 'green')
  assert.equal(state.switchGeneration, 3)
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'blue')
  evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.status, 'ok')
  assert.equal(evidence.kind, 'rollback')
})

test('gateway mutation scripts reject direct invocation outside the unique rollout entry', (t) => {
  const fixture = createGatewayFixture(t)
  const switched = runGateway(fixture, 'gateway-switch.sh', [], { FSUSBLOG_ROLLOUT_ENTRY: '0' })
  const rolledBack = runGateway(fixture, 'gateway-rollback.sh', [], { FSUSBLOG_ROLLOUT_ENTRY: '0' })

  assert.notEqual(switched.status, 0)
  assert.match(switched.stderr, /gateway-switch is internal/u)
  assert.notEqual(rolledBack.status, 0)
  assert.match(rolledBack.stderr, /gateway-rollback is internal/u)
})

test('dry-run executes identity, readiness and full staged config checks without changing traffic or state', (t) => {
  const fixture = createGatewayFixture(t)
  const beforeState = fs.readFileSync(fixture.stateFile, 'utf8')
  const beforeUpstream = fs.readFileSync(fixture.activeUpstream, 'utf8')
  const result = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest, '--dry-run'
  ])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'dry-run')
  assert.ok(report.validated.includes('staged-openresty-config'))
  assert.ok(report.planned.includes('graceful-reload'))
  assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), beforeState)
  assert.equal(fs.readFileSync(fixture.activeUpstream, 'utf8'), beforeUpstream)
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'blue')
})

test('unready candidate and staged config rejection leave active upstream and durable state unchanged', (t) => {
  const readinessFixture = createGatewayFixture(t)
  const beforeReadiness = snapshot(readinessFixture)
  const readiness = runGateway(readinessFixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ], { FAKE_HEALTH_FAIL_SLOT: 'green' })
  assert.notEqual(readiness.status, 0)
  assertUnchanged(readinessFixture, beforeReadiness)
  let evidence = JSON.parse(fs.readFileSync(path.join(readinessFixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.failureStage, 'target-readiness')
  assert.equal(evidence.checks.targetReadiness, false)

  const configFixture = createGatewayFixture(t)
  const beforeConfig = snapshot(configFixture)
  const rejected = runGateway(configFixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ], { FAKE_OPENRESTY_TEST_FAIL: 'staged' })
  assert.notEqual(rejected.status, 0)
  assertUnchanged(configFixture, beforeConfig)
  evidence = JSON.parse(fs.readFileSync(path.join(configFixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.failureStage, 'staged-config-test')
  assert.equal(evidence.checks.stagedConfigTest, false)
})

test('reload failure restores source include, verifies source traffic and records failed transition', (t) => {
  const fixture = createGatewayFixture(t)
  const result = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ], { FAKE_OPENRESTY_RELOAD_FAIL_ONCE: '1' })
  assert.notEqual(result.status, 0)
  const state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'stable')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.switchGeneration, 1)
  assert.equal(state.lastTrafficTransition.status, 'failed')
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'blue')
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'blue')
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.status, 'failed')
  assert.equal(evidence.failureStage, 'reload')
  assert.equal(evidence.recoveryAction, 'source-upstream-restored')
})

test('deployment lock rejects concurrent gateway mutation before any upstream write', async (t) => {
  const fixture = createGatewayFixture(t)
  const holder = spawn('bash', ['-c', 'exec 8>"$FSUSBLOG_DEPLOYMENT_LOCK_FILE"; flock 8; printf locked; sleep 2'], {
    cwd: root, env: fixture.environment, stdio: ['ignore', 'pipe', 'pipe']
  })
  await waitForOutput(holder.stdout, 'locked')
  const before = snapshot(fixture)
  const result = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /another deployment or gateway transition/u)
  assertUnchanged(fixture, before)
  holder.kill('SIGTERM')
})

test('restart recovery diagnoses interrupted source/target ownership and resolves without guessing', (t) => {
  const restoreFixture = createGatewayFixture(t)
  beginPersistedTransition(restoreFixture)
  fs.writeFileSync(restoreFixture.activeUpstream, renderUpstream('green', restoreFixture.environment))
  fs.writeFileSync(restoreFixture.liveSlot, 'blue\n')
  const diagnosis = runGateway(restoreFixture, 'gateway-recover.sh', ['--dry-run'])
  assert.equal(diagnosis.status, 0, diagnosis.stderr)
  assert.equal(JSON.parse(diagnosis.stdout).proposedAction, 'restore-source')
  const recovered = runGateway(restoreFixture, 'gateway-recover.sh')
  assert.equal(recovered.status, 0, recovered.stderr)
  let state = readSlotState(restoreFixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'stable')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.switchGeneration, 1)
  assert.equal(inspectUpstreamFile(restoreFixture.activeUpstream, restoreFixture.environment).slot, 'blue')

  const commitFixture = createGatewayFixture(t)
  beginPersistedTransition(commitFixture)
  fs.writeFileSync(commitFixture.activeUpstream, renderUpstream('green', commitFixture.environment))
  fs.writeFileSync(commitFixture.liveSlot, 'green\n')
  setRuntimeActive(commitFixture, 'green')
  const committed = runGateway(commitFixture, 'gateway-recover.sh')
  assert.equal(committed.status, 0, committed.stderr)
  state = readSlotState(commitFixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'stable')
  assert.equal(state.activeSlot, 'green')
  assert.equal(state.switchGeneration, 2)
  const evidence = JSON.parse(fs.readFileSync(path.join(commitFixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.schema, 'fsusblog.gateway-recovery-evidence.v1')
  assert.equal(evidence.action, 'commit-target')
  assert.equal(evidence.checks.stateResolution, true)
  assert.equal(evidence.checks.targetActivation, true)
  assert.equal(evidence.checks.sourceDrain, true)
  assert.equal(evidence.lifecycle.targetAfterActivation.state, 'active')
  assert.equal(evidence.lifecycle.sourceAfterDrain.drain.drained, true)
})

test('rollback refuses a recorded identity that no longer matches the immutable previous runtime', (t) => {
  const fixture = createGatewayFixture(t)
  const switched = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ])
  assert.equal(switched.status, 0, switched.stderr)
  const state = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'))
  state.previousReleaseId = '20260711999999-badbadbadbad'
  fs.writeFileSync(fixture.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  const beforeUpstream = fs.readFileSync(fixture.activeUpstream, 'utf8')
  const rollback = runGateway(fixture, 'gateway-rollback.sh')
  assert.notEqual(rollback.status, 0)
  assert.equal(fs.readFileSync(fixture.activeUpstream, 'utf8'), beforeUpstream)
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'green')
})

function createRunningState() {
  const state = createEmptySlotState('2026-07-11T00:00:00.000Z')
  recordSlotStart(state, {
    slot: 'blue', releaseId: blueRelease, imageRef: `ghcr.io/fsusblog/app@${blueDigest}`,
    imageDigest: blueDigest, startedAt: '2026-07-11T01:00:00.000Z', environment: ports
  })
  setActiveSlot(state, { slot: 'blue', kind: 'bootstrap', changedAt: '2026-07-11T01:01:00.000Z' })
  recordSlotStart(state, {
    slot: 'green', releaseId: greenRelease, imageRef: `ghcr.io/fsusblog/app@${greenDigest}`,
    imageDigest: greenDigest, startedAt: '2026-07-11T02:00:00.000Z', environment: ports
  })
  return state
}

function createGatewayFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-gateway-switch-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, 'bin')
  const stateFile = path.join(directory, 'state', 'slots.json')
  const activeUpstream = path.join(directory, 'openresty', 'active-upstream.conf')
  const gatewayConfig = path.join(directory, 'openresty', 'nginx.conf')
  const dockerState = path.join(directory, 'docker-state.json')
  const liveSlot = path.join(directory, 'gateway-live-slot')
  const evidenceDir = path.join(directory, 'evidence')
  const openrestyLog = path.join(directory, 'openresty.log')
  const runtimeState = path.join(directory, 'deployment-runtime.json')
  const adminHeader = path.join(directory, 'deployment-admin.header')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.dirname(activeUpstream), { recursive: true })
  writeFakeDocker(path.join(bin, 'docker'))
  writeFakeCurl(path.join(bin, 'curl'))
  writeFakeOpenResty(path.join(bin, 'openresty'))
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ...ports,
    FSUSBLOG_SLOT_STATE_FILE: stateFile,
    FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM: activeUpstream,
    FSUSBLOG_GATEWAY_CONFIG_FILE: gatewayConfig,
    FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL: 'http://gateway.test/health/ready',
    FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1',
    FSUSBLOG_GATEWAY_EVIDENCE_DIR: evidenceDir,
    FSUSBLOG_OPENRESTY_BIN: 'openresty',
    FSUSBLOG_DEPLOYMENT_LOCK_FILE: path.join(directory, 'deployment.lock'),
    FSUSBLOG_GATEWAY_PROBE_TIMEOUT_SECONDS: '2',
    FSUSBLOG_GATEWAY_PROBE_INTERVAL_SECONDS: '1',
    FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE: adminHeader,
    FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN: 'http://gateway.test',
    FSUSBLOG_DRAIN_TIMEOUT_SECONDS: '5',
    FSUSBLOG_ROLLOUT_ENTRY: '1',
    FAKE_DOCKER_STATE: dockerState,
    FAKE_DEPLOYMENT_RUNTIME_STATE: runtimeState,
    FAKE_ACTIVE_UPSTREAM: activeUpstream,
    FAKE_GATEWAY_LIVE_SLOT: liveSlot,
    FAKE_OPENRESTY_LOG: openrestyLog,
    FAKE_OPENRESTY_FAIL_MARKER: path.join(directory, 'reload-failed-once')
  }
  writeSlotStateAtomic(stateFile, createRunningState())
  fs.writeFileSync(activeUpstream, renderUpstream('blue', environment))
  fs.writeFileSync(gatewayConfig, `events {}\nhttp {\n  upstream fsusblog_kestrel {\n    include ${activeUpstream};\n    keepalive 64;\n  }\n}\n`)
  fs.writeFileSync(liveSlot, 'blue\n')
  fs.writeFileSync(openrestyLog, '')
  fs.writeFileSync(adminHeader, 'Authorization: Bearer deployment-test-token\n', { mode: 0o600 })
  fs.writeFileSync(dockerState, `${JSON.stringify({
    'fsus-app-blue': runtimeContainer('blue', blueRelease, blueDigest, 18081, 1),
    'fsus-app-green': runtimeContainer('green', greenRelease, greenDigest, 18082, 2)
  }, null, 2)}\n`)
  fs.writeFileSync(runtimeState, `${JSON.stringify({
    blue: runtimeDeploymentSnapshot('blue', blueRelease, 1, 'active', 'active'),
    green: runtimeDeploymentSnapshot('green', greenRelease, 2, 'candidate', 'ready')
  }, null, 2)}\n`)
  return { directory, stateFile, activeUpstream, gatewayConfig, evidenceDir, liveSlot, openrestyLog, runtimeState, environment }
}

function runtimeDeploymentSnapshot(slot, releaseId, generation, mode, state) {
  const active = state === 'active'
  return {
    releaseId,
    slot,
    mode,
    state,
    generation,
    startedAtUtc: '2026-07-11T01:01:01.000Z',
    activatedAtUtc: active ? '2026-07-11T01:02:00.000Z' : null,
    drainStartedAtUtc: null,
    inFlightHttpRequests: 0,
    notificationStreamConnections: 0,
    activeBackgroundClaims: 0,
    drain: { requested: false, drained: false, timedOut: false, deadlineUtc: null, blockers: [], components: [] },
    canReceiveTraffic: active,
    canClaimBackgroundWork: active,
    canAcceptNotificationStream: active,
    lastFailureStage: null,
    lastErrorCode: null
  }
}

function setRuntimeCandidateReady(fixture, slot) {
  const state = JSON.parse(fs.readFileSync(fixture.runtimeState, 'utf8'))
  state[slot] = {
    ...state[slot],
    mode: 'candidate',
    state: 'ready',
    activatedAtUtc: null,
    drainStartedAtUtc: null,
    canReceiveTraffic: false,
    canClaimBackgroundWork: false,
    canAcceptNotificationStream: false,
    drain: { requested: false, drained: false, timedOut: false, deadlineUtc: null, blockers: [], components: [] }
  }
  fs.writeFileSync(fixture.runtimeState, `${JSON.stringify(state, null, 2)}\n`)
}

function setRuntimeActive(fixture, slot) {
  const state = JSON.parse(fs.readFileSync(fixture.runtimeState, 'utf8'))
  state[slot] = {
    ...state[slot],
    mode: 'active',
    state: 'active',
    activatedAtUtc: '2026-07-11T02:02:02.000Z',
    canReceiveTraffic: true,
    canClaimBackgroundWork: true,
    canAcceptNotificationStream: true
  }
  fs.writeFileSync(fixture.runtimeState, `${JSON.stringify(state, null, 2)}\n`)
}

function runtimeContainer(slot, releaseId, digest, port, generation) {
  return {
    Name: `/fsus-app-${slot}`,
    Config: { Labels: {
      'io.fsusblog.release.slot': slot,
      'io.fsusblog.release.id': releaseId,
      'io.fsusblog.release.commit': commitSha,
      'io.fsusblog.release.image-ref': `ghcr.io/fsusblog/app@${digest}`,
      'io.fsusblog.release.image-digest': digest,
      'io.fsusblog.deployment.project': `fsusblog-${slot}`,
      'io.fsusblog.deployment.mode': 'candidate',
      'io.fsusblog.deployment.generation': String(generation)
    } },
    State: { Running: true, Health: { Status: 'healthy' }, StartedAt: '2026-07-11T01:01:01.123456789Z' },
    NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } }
  }
}

function runGateway(fixture, script, args = [], overrides = {}) {
  return spawnSync('bash', [path.join(root, 'tools/deployment', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...fixture.environment, ...overrides }
  })
}

function beginPersistedTransition(fixture) {
  const state = readSlotState(fixture.stateFile, { allowMissing: false })
  beginGatewayTransition(state, {
    slot: 'green', releaseId: greenRelease, imageDigest: greenDigest,
    kind: 'switch', startedAt: '2026-07-11T02:05:00.000Z'
  })
  writeSlotStateAtomic(fixture.stateFile, state)
}

function snapshot(fixture) {
  return {
    state: fs.readFileSync(fixture.stateFile, 'utf8'),
    upstream: fs.readFileSync(fixture.activeUpstream, 'utf8'),
    live: fs.readFileSync(fixture.liveSlot, 'utf8')
  }
}

function assertUnchanged(fixture, before) {
  assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before.state)
  assert.equal(fs.readFileSync(fixture.activeUpstream, 'utf8'), before.upstream)
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8'), before.live)
}

function collectChild(child) {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function waitForOutput(stream, expected) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 2_000)
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      output += chunk
      if (output.includes(expected)) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
}

function writeFakeDocker(file) {
  fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "inspect" ]]; then
  name="\${2:-}"
  jq -e --arg name "$name" '.[$name]' "\${FAKE_DOCKER_STATE:?}" >/dev/null 2>&1 || exit 1
  jq -c --arg name "$name" '[.[$name]]' "\${FAKE_DOCKER_STATE:?}"
  exit 0
fi
exit 32
`, { mode: 0o755 })
}

function writeFakeCurl(file) {
  fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
headers=0
method=GET
previous=""
for arg in "$@"; do
  [[ "$arg" == "-D" ]] && headers=1
  [[ "$previous" == "--request" ]] && method="$arg"
  previous="$arg"
done
if [[ "$url" == "http://gateway.test/health/ready" ]]; then
  [[ "\${FAKE_PUBLIC_FAIL:-0}" != "1" ]] || exit 22
  slot="\${FAKE_PUBLIC_FORCE_SLOT:-$(tr -d '\\r\\n' < "\${FAKE_GATEWAY_LIVE_SLOT:?}")}"
else
  port="\${url#*127.0.0.1:}"
  port="\${port%%/*}"
  slot=""
  [[ "$port" == "\${FSUSBLOG_BLUE_PORT:-8081}" ]] && slot=blue
  [[ "$port" == "\${FSUSBLOG_GREEN_PORT:-8082}" ]] && slot=green
fi
[[ -n "$slot" && "\${FAKE_HEALTH_FAIL_SLOT:-}" != "$slot" ]] || exit 22
name="fsus-app-$slot"
jq -e --arg name "$name" '.[$name].State.Running == true' "\${FAKE_DOCKER_STATE:?}" >/dev/null
release="$(jq -r --arg name "$name" '.[$name].Config.Labels["io.fsusblog.release.id"]' "\${FAKE_DOCKER_STATE:?}")"
if [[ "\${FAKE_IDENTITY_FAIL_SLOT:-}" == "$slot" ]]; then release="wrong-release"; fi
if [[ "$url" == */api/ops/deployment/status ]]; then
  jq -c --arg slot "$slot" '.[$slot]' "\${FAKE_DEPLOYMENT_RUNTIME_STATE:?}"
  exit 0
fi
if [[ "$url" == */api/ops/deployment/activate || "$url" == */api/ops/deployment/drain ]]; then
  body="$(cat)"
  expected_release="$(jq -r '.releaseId // ""' <<< "$body")"
  expected_slot="$(jq -r '.slot // ""' <<< "$body")"
  expected_generation="$(jq -r '.generation // 0' <<< "$body")"
  jq -e --arg slot "$slot" --arg release "$expected_release" --arg expectedSlot "$expected_slot" --argjson generation "$expected_generation" \
    '.[$slot].releaseId == $release and .[$slot].slot == $expectedSlot and .[$slot].generation == $generation' \
    "\${FAKE_DEPLOYMENT_RUNTIME_STATE:?}" >/dev/null || exit 22
  temporary="\${FAKE_DEPLOYMENT_RUNTIME_STATE:?}.tmp.$$"
  if [[ "$url" == */activate ]]; then
    jq --arg slot "$slot" '
      .[$slot].mode = "active"
      | .[$slot].state = "active"
      | .[$slot].activatedAtUtc = "2026-07-11T02:02:02.000Z"
      | .[$slot].canReceiveTraffic = true
      | .[$slot].canClaimBackgroundWork = true
      | .[$slot].canAcceptNotificationStream = true
    ' "\${FAKE_DEPLOYMENT_RUNTIME_STATE:?}" > "$temporary"
  else
    jq --arg slot "$slot" '
      .[$slot].mode = "draining"
      | .[$slot].state = "draining"
      | .[$slot].drainStartedAtUtc = "2026-07-11T02:03:03.000Z"
      | .[$slot].canReceiveTraffic = false
      | .[$slot].canClaimBackgroundWork = false
      | .[$slot].canAcceptNotificationStream = false
      | .[$slot].drain = {requested: true, drained: true, timedOut: false, deadlineUtc: "2026-07-11T02:03:08.000Z", blockers: [], components: []}
    ' "\${FAKE_DEPLOYMENT_RUNTIME_STATE:?}" > "$temporary"
  fi
  mv "$temporary" "\${FAKE_DEPLOYMENT_RUNTIME_STATE:?}"
  snapshot="$(jq -c --arg slot "$slot" '.[$slot]' "\${FAKE_DEPLOYMENT_RUNTIME_STATE:?}")"
  jq -cn --argjson snapshot "$snapshot" '{accepted: true, idempotent: false, status: "accepted", errorCode: null, snapshot: $snapshot}'
  exit 0
fi
if [[ "$headers" == "1" ]]; then
  printf 'HTTP/1.1 200 OK\\r\\nX-Fsus-Release-Id: %s\\r\\nX-Fsus-Release-Slot: %s\\r\\nContent-Length: 0\\r\\n\\r\\n' "$release" "$slot"
else
  printf '{"status":"ok","releaseId":"%s","slot":"%s"}\\n' "$release" "$slot"
fi
`, { mode: 0o755 })
}

function writeFakeOpenResty(file) {
  fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
mode=""
config=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == "-c" ]]; then config="$arg"; fi
  [[ "$arg" == "-t" ]] && mode=test
  [[ "$previous" == "-s" && "$arg" == "reload" ]] && mode=reload
  previous="$arg"
done
printf '%s:%s\\n' "$mode" "$config" >> "\${FAKE_OPENRESTY_LOG:?}"
if [[ "$mode" == "test" ]]; then
  [[ "\${FAKE_OPENRESTY_TEST_FAIL:-}" != "all" ]] || exit 1
  if [[ "\${FAKE_OPENRESTY_TEST_FAIL:-}" == "staged" && "$config" == *".stage-"* ]]; then exit 1; fi
  if [[ "\${FAKE_OPENRESTY_TEST_FAIL:-}" == "active" && "$config" != *".stage-"* ]]; then exit 1; fi
  exit 0
fi
if [[ "$mode" == "reload" ]]; then
  if [[ "\${FAKE_OPENRESTY_RELOAD_FAIL:-0}" == "1" ]]; then exit 1; fi
  if [[ "\${FAKE_OPENRESTY_RELOAD_FAIL_ONCE:-0}" == "1" && ! -f "\${FAKE_OPENRESTY_FAIL_MARKER:?}" ]]; then
    : > "\${FAKE_OPENRESTY_FAIL_MARKER:?}"
    exit 1
  fi
  port="$(awk '/^server 127[.]0[.]0[.]1:/ { line=$2; sub(/^127[.]0[.]0[.]1:/, "", line); sub(/;$/, "", line); print line }' "\${FAKE_ACTIVE_UPSTREAM:?}")"
  slot=""
  [[ "$port" == "\${FSUSBLOG_BLUE_PORT:-8081}" ]] && slot=blue
  [[ "$port" == "\${FSUSBLOG_GREEN_PORT:-8082}" ]] && slot=green
  [[ -n "$slot" ]] || exit 1
  temporary="\${FAKE_GATEWAY_LIVE_SLOT:?}.tmp.$$"
  printf '%s\\n' "$slot" > "$temporary"
  mv "$temporary" "\${FAKE_GATEWAY_LIVE_SLOT:?}"
  exit 0
fi
exit 1
`, { mode: 0o755 })
}
