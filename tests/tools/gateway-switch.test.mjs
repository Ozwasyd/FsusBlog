import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createReleaseManifest, writeReleaseManifestAtomic } from '../../tools/release/release-manifest.mjs'
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
import { createRolloutState, writeRolloutStateAtomic } from '../../tools/deployment/release-rollout-lib.mjs'

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

test('gateway switches blue to green but refuses image-only rollback while public requests avoid failures', async (t) =>
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
  const beforeRollback = snapshot(fixture)
  const rolledBack = runGateway(fixture, 'gateway-rollback.sh')
  assert.notEqual(rolledBack.status, 0)
  assert.match(rolledBack.stderr, /schema_image_only_rollback_retired/u)
  assertUnchanged(fixture, beforeRollback)
  state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.activeSlot, 'green')
  assert.equal(state.previousSlot, 'blue')
  assert.equal(state.switchGeneration, 2)
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'green')
  evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.status, 'ok')
  assert.equal(evidence.kind, 'switch')
})

test('gateway mutation scripts reject direct invocation outside the unique rollout entry', (t) => {
  const fixture = createGatewayFixture(t)
  const switched = runGateway(fixture, 'gateway-switch.sh', [], { FSUSBLOG_ROLLOUT_ENTRY: '0' })
  const rolledBack = runGateway(fixture, 'gateway-rollback.sh', [], { FSUSBLOG_ROLLOUT_ENTRY: '0' })

  assert.notEqual(switched.status, 0)
  assert.match(switched.stderr, /gateway-switch is internal/u)
  assert.notEqual(rolledBack.status, 0)
  assert.match(rolledBack.stderr, /schema_image_only_rollback_retired/u)
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

test('reload failure after activation requires database restore or forward recovery without restoring source', (t) => {
  const fixture = createGatewayFixture(t)
  const result = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ], { FAKE_OPENRESTY_RELOAD_FAIL_ONCE: '1' })
  assert.notEqual(result.status, 0)
  const state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'rollback_required')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.switchGeneration, 1)
  assert.equal(state.pendingTransition.toSlot, 'green')
  assert.equal(state.lastTrafficTransition.status, 'failed')
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'green')
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'blue')
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.status, 'failed')
  assert.equal(evidence.failureStage, 'reload')
  assert.equal(evidence.recoveryAction, 'schema-restore-or-forward-required')
  assert.equal(evidence.checks.targetActivation, true)
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

test('restart recovery refuses old-source fallback and can commit the observed active target', (t) => {
  const restoreFixture = createGatewayFixture(t)
  beginPersistedTransition(restoreFixture)
  fs.writeFileSync(restoreFixture.activeUpstream, renderUpstream('green', restoreFixture.environment))
  fs.writeFileSync(restoreFixture.liveSlot, 'blue\n')
  const diagnosis = runGateway(restoreFixture, 'gateway-recover.sh', ['--dry-run'])
  assert.equal(diagnosis.status, 0, diagnosis.stderr)
  assert.equal(JSON.parse(diagnosis.stdout).proposedAction, 'blocked')
  const before = snapshot(restoreFixture)
  const beforeRuntime = fs.readFileSync(restoreFixture.runtimeState, 'utf8')
  const recovered = runGateway(restoreFixture, 'gateway-recover.sh')
  assert.notEqual(recovered.status, 0)
  assert.match(recovered.stderr, /verified database restore or explicit forward recovery/u)
  assertUnchanged(restoreFixture, before)
  assert.equal(fs.readFileSync(restoreFixture.runtimeState, 'utf8'), beforeRuntime)
  let state = readSlotState(restoreFixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'switching')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.switchGeneration, 1)
  assert.equal(inspectUpstreamFile(restoreFixture.activeUpstream, restoreFixture.environment).slot, 'green')

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

test('internal gateway switch cannot bypass retired rollback through its kind argument', (t) => {
  const fixture = createGatewayFixture(t)
  for (const mode of [[], ['--dry-run']]) {
    const before = snapshot(fixture)
    const beforeLog = fs.readFileSync(fixture.openrestyLog, 'utf8')
    const result = runGateway(fixture, 'gateway-switch.sh', [
      '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest,
      '--kind', 'rollback', ...mode
    ])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /schema_image_only_rollback_retired/u)
    assertUnchanged(fixture, before)
    assert.equal(fs.readFileSync(fixture.openrestyLog, 'utf8'), beforeLog)
  }
})

test('post-switch source recovery refuses before reading inputs or restarting any previous image', (t) => {
  const fixture = createGatewayFixture(t)
  const before = snapshot(fixture)
  const beforeRuntime = fs.readFileSync(fixture.runtimeState, 'utf8')
  const beforeLog = fs.readFileSync(fixture.openrestyLog, 'utf8')
  const output = path.join(fixture.directory, 'must-not-be-created.json')
  const result = runGateway(fixture, 'release-rollout-recovery.sh', [
    'rollback-to-source', '--rollout-state', fixture.stateFile,
    '--source-manifest', path.join(fixture.directory, 'missing-source-manifest.json'),
    '--out', output
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /schema_image_only_rollback_retired/u)
  assertUnchanged(fixture, before)
  assert.equal(fs.readFileSync(fixture.runtimeState, 'utf8'), beforeRuntime)
  assert.equal(fs.readFileSync(fixture.openrestyLog, 'utf8'), beforeLog)
  assert.equal(fs.existsSync(output), false)
})

test('failure before candidate activation permits source preservation without an image restart', (t) => {
  const fixture = createGatewayFixture(t)
  const result = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ], { FAKE_OPENRESTY_TEST_FAIL_ACTIVE_ONCE: '1' })

  assert.notEqual(result.status, 0)
  const state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'stable')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(state.switchGeneration, 1)
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'blue')
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'blue')
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.failureStage, 'active-config-test')
  assert.equal(evidence.recoveryAction, 'source-upstream-restored')
  assert.equal(evidence.checks.targetActivation, false)
})

test('an unconfirmed activation response does not authorize restoring source traffic', (t) => {
  const fixture = createGatewayFixture(t)
  const result = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ], { FAKE_ACTIVATE_FAIL_SLOT: 'green' })

  assert.notEqual(result.status, 0)
  const state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'rollback_required')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'green')
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.failureStage, 'target-activation')
  assert.equal(evidence.recoveryAction, 'schema-restore-or-forward-required')
})

test('lost response after actual target activation leaves source unrestored and undrained', (t) => {
  const fixture = createGatewayFixture(t)
  const result = runGateway(fixture, 'gateway-switch.sh', [
    '--to', 'green', '--release', greenRelease, '--image-digest', greenDigest
  ], { FAKE_ACTIVATE_RESPONSE_LOST_SLOT: 'green' })
  assert.notEqual(result.status, 0)
  const state = readSlotState(fixture.stateFile, { allowMissing: false })
  assert.equal(state.status, 'rollback_required')
  assert.equal(state.activeSlot, 'blue')
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'green')
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'blue')
  const runtime = JSON.parse(fs.readFileSync(fixture.runtimeState, 'utf8'))
  assert.equal(runtime.green.state, 'active')
  assert.equal(runtime.green.canReceiveTraffic, true)
  assert.equal(runtime.blue.state, 'active')
  assert.equal(runtime.blue.drain.requested, false)
  assert.equal(runtime.green.drain.requested, false)
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.failureStage, 'target-activation')
  assert.equal(evidence.recoveryAction, 'schema-restore-or-forward-required')
  assert.equal(evidence.checks.targetActivation, false)
  assert.equal(evidence.checks.targetNeutralizedOnRecovery, false)
})

test('explicit source recovery refuses before input access even in dry-run mode', (t) => {
  const fixture = createGatewayFixture(t)
  for (const mode of [[], ['--dry-run']]) {
    const before = snapshot(fixture)
    const beforeLog = fs.readFileSync(fixture.openrestyLog, 'utf8')
    const result = runGateway(fixture, 'gateway-recover.sh', [
      '--action', 'restore-source', '--state-file', path.join(fixture.directory, 'missing.json'),
      '--active-upstream', path.join(fixture.directory, 'missing.conf'), ...mode
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /schema_image_only_rollback_retired/u)
    assertUnchanged(fixture, before)
    assert.equal(fs.readFileSync(fixture.openrestyLog, 'utf8'), beforeLog)
  }
})

test('restart forward recovery does not restore source upstream after activated target reload failure', (t) => {
  const fixture = createGatewayFixture(t)
  beginPersistedTransition(fixture)
  const result = runGateway(fixture, 'gateway-recover.sh', ['--action', 'commit-target'], {
    FAKE_OPENRESTY_RELOAD_FAIL_ONCE: '1'
  })
  assert.notEqual(result.status, 0)
  assert.equal(inspectUpstreamFile(fixture.activeUpstream, fixture.environment).slot, 'green')
  assert.equal(fs.readFileSync(fixture.liveSlot, 'utf8').trim(), 'blue')
  assert.equal(readSlotState(fixture.stateFile, { allowMissing: false }).status, 'switching')
  const runtime = JSON.parse(fs.readFileSync(fixture.runtimeState, 'utf8'))
  assert.equal(runtime.green.state, 'active')
  assert.equal(runtime.blue.state, 'active')
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, 'latest.json'), 'utf8'))
  assert.equal(evidence.status, 'failed')
  assert.equal(evidence.checks.targetActivation, true)
  assert.equal(evidence.checks.stateResolution, false)
})

test('restart recovery refuses a persisted legacy rollback transition without runtime mutation', (t) => {
  const fixture = createGatewayFixture(t)
  beginPersistedTransition(fixture)
  const state = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'))
  state.pendingTransition.kind = 'rollback'
  fs.writeFileSync(fixture.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  const before = snapshot(fixture)
  const beforeRuntime = fs.readFileSync(fixture.runtimeState, 'utf8')
  const beforeLog = fs.readFileSync(fixture.openrestyLog, 'utf8')
  const result = runGateway(fixture, 'gateway-recover.sh', ['--action', 'commit-target'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /schema_image_only_rollback_retired/u)
  assertUnchanged(fixture, before)
  assert.equal(fs.readFileSync(fixture.runtimeState, 'utf8'), beforeRuntime)
  assert.equal(fs.readFileSync(fixture.openrestyLog, 'utf8'), beforeLog)
})

test('rollout rejects image-only rollback before input validation, lock creation or dry-run planning', (t) => {
  const fixture = createGatewayFixture(t)
  for (const mode of [[], ['--dry-run'], ['--resume'], ['--no-switch']]) {
    const before = snapshot(fixture)
    const beforeRuntime = fs.readFileSync(fixture.runtimeState, 'utf8')
    const beforeLog = fs.readFileSync(fixture.openrestyLog, 'utf8')
    const lockFile = path.join(fixture.directory, 'must-not-create.lock')
    const result = runGateway(fixture, 'release-rollout.sh', [
      '--rollback', '--release-manifest', path.join(fixture.directory, 'missing.json'), ...mode
    ], { FSUSBLOG_DEPLOYMENT_LOCK_FILE: lockFile })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /schema_image_only_rollback_retired/u)
    assertUnchanged(fixture, before)
    assert.equal(fs.readFileSync(fixture.runtimeState, 'utf8'), beforeRuntime)
    assert.equal(fs.readFileSync(fixture.openrestyLog, 'utf8'), beforeLog)
    assert.equal(fs.existsSync(lockFile), false)
  }
})

test('rollout cannot resume persisted image rollback or old-source recovery as deploy', (t) => {
  const controlFixture = createGatewayFixture(t)
  const control = currentAdmissionInputs(controlFixture)
  const accepted = runGateway(controlFixture, 'release-rollout.sh', ['--release-manifest', control.manifestFile,
    '--rollout-state-file', control.stateFile], control.environment())
  assert.notEqual(accepted.status, 0)
  assert.match(accepted.stderr, /backup restore evidence is required/u)
  assertCurrentAdmissionInvocation(control)
  for (const kind of ['rollback', 'deploy']) {
    const fixture = createGatewayFixture(t)
    const current = currentAdmissionInputs(fixture)
    const rolloutFile = current.stateFile
    const state = createRolloutState({
      ...createCurrentRolloutFixtureBinding(),
      manifestSha256: createHash('sha256').update(fs.readFileSync(current.manifestFile)).digest('hex'),
      candidateSourceRevision: current.manifest.commitSha, currentSchema: current.manifest.currentSchema,
      rolloutId: `${kind}-fixture`, kind: 'deploy', manifestPath: current.manifestFile,
      source: { slot: 'blue', releaseId: blueRelease, imageDigest: blueDigest, runtimeGeneration: 1 },
      target: { slot: 'green', releaseId: greenRelease, imageDigest: greenDigest, runtimeGeneration: 2 }
    })
    if (kind === 'rollback') state.kind = 'rollback'
    if (kind === 'deploy') {
      state.status = 'recovery_required'
      state.recovery = {
        action: 'rollback-gateway-to-source', automatic: true,
        reason: 'post_switch_gate_failed_before_source_drain', failedStage: 'source-drain'
      }
    }
    // Deliberately persist a historical invalid state without the current writer accepting it.
    fs.writeFileSync(rolloutFile, `${JSON.stringify(state)}\n`)
    const beforeRollout = fs.readFileSync(rolloutFile, 'utf8')
    const before = snapshot(fixture)
    const beforeRuntime = fs.readFileSync(fixture.runtimeState, 'utf8')
    const beforeLog = fs.readFileSync(fixture.openrestyLog, 'utf8')
    const result = runGateway(fixture, 'release-rollout.sh', [
      '--resume', '--release-manifest', current.manifestFile, '--rollout-state-file', rolloutFile
    ], current.environment())
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /current_schema_admission_input_binding_failed/u)
    assert.match(result.stderr, kind === 'rollback' ? /kind is invalid/u : /recovery.action is invalid/u)
    assert.equal(fs.existsSync(current.commandLog), false)
    assert.equal(fs.existsSync(current.lockFile), false)
    assert.equal(fs.readFileSync(rolloutFile, 'utf8'), beforeRollout)
    assertUnchanged(fixture, before)
    assert.equal(fs.readFileSync(fixture.runtimeState, 'utf8'), beforeRuntime)
    assert.equal(fs.readFileSync(fixture.openrestyLog, 'utf8'), beforeLog)
  }
})

test('fresh current admission rejects missing environment and mismatched Server output before mutable rollout work', (t) => {
  for (const mutation of ['missing-environment', 'malformed-output', 'wrong-candidate', 'wrong-receipt', 'wrong-target', 'wrong-database', 'wrong-physical', 'missing-status']) {
    const fixture = createGatewayFixture(t)
    const current = currentAdmissionInputs(fixture)
    const output = structuredClone(current.output)
    if (mutation === 'wrong-candidate') output.candidateSourceRevision = 'a'.repeat(40)
    if (mutation === 'wrong-receipt') output.artifactSha256 = 'a'.repeat(64)
    if (mutation === 'wrong-target') output.target.contentDigest = 'a'.repeat(64)
    if (mutation === 'wrong-database') output.database.databaseId = 'other'
    if (mutation === 'wrong-physical') output.actualSchemaDigest = output.target.contentDigest
    if (mutation === 'missing-status') delete output.status
    fs.writeFileSync(current.outputFile, mutation === 'malformed-output' ? '{invalid' : JSON.stringify(output))
    const before = snapshot(fixture)
    const runtime = fs.readFileSync(fixture.runtimeState)
    const result = runGateway(fixture, 'release-rollout.sh', ['--release-manifest', current.manifestFile,
      '--rollout-state-file', current.stateFile], current.environment(mutation === 'missing-environment'))
    assert.notEqual(result.status, 0, mutation)
    assert.match(result.stderr, /current_schema_admission/u)
    assert.equal(fs.existsSync(current.stateFile), false, mutation)
    assert.equal(fs.existsSync(current.lockFile), false, mutation)
    assertUnchanged(fixture, before)
    assert.deepEqual(fs.readFileSync(fixture.runtimeState), runtime)
    assert.equal(fs.readFileSync(fixture.openrestyLog, 'utf8'), '')
    if (mutation === 'missing-environment') assert.equal(fs.existsSync(current.commandLog), false)
    else assertCurrentAdmissionInvocation(current)
  }
})

test('withdrawn admission reaps this invocation probes but leaves adopted observers untouched on exit and interrupt', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-rollout-owned-probes-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = fs.readFileSync(path.join(root, 'tools/deployment/release-rollout.sh'), 'utf8')
  const functions = ['StopPublicTraffic', 'StopResourceProbe', 'StopNotificationProbe',
    'CancelAssetCompatibilityProbe', 'CleanupBackgroundProbes', 'InterruptRollout'].map(name => {
    const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'mu'))
    assert.ok(match, `actual rollout function ${name}`)
    return match[0]
  }).join('\n')
  for (const mode of ['exit', 'interrupt']) {
    for (const adopted of ['0000', '1111', '0101']) {
      const runDirectory = path.join(directory, `${mode}-${adopted}`)
      fs.mkdirSync(runDirectory)
      // Real local child processes exercise the actual owner cleanup bodies, not a native receipt.
      const result = spawnSync('bash', ['-c', `
set -Eeuo pipefail
${functions}
cd "$1"
adoptionPattern="$2"
prefixes=(TRAFFIC RESOURCE NOTIFICATION ASSET_COMPATIBILITY)
pids=()
for index in 0 1 2 3; do
  prefix="\${prefixes[$index]}"
  (trap 'printf terminated > "'$index'.terminal"; exit 143' TERM
   printf ready > "$index.ready"
   for ((turn=0; turn<500; turn++)); do
     if [[ -f "$index.stop" ]]; then printf stopped > "$index.terminal"; exit 0; fi
     sleep 0.01
   done
   exit 94) &
  pid=$!
  pids+=("$pid")
  for ((turn=0; turn<500; turn++)); do [[ -f "$index.ready" ]] && break; sleep 0.01; done
  [[ -f "$index.ready" ]]
  printf -v "\${prefix}_PID" '%s' "$pid"
  printf -v "\${prefix}_ADOPTED" '%s' "\${2:$index:1}"
  printf -v "\${prefix}_PID_FILE" '%s' "$index.pid"
  printf -v "\${prefix}_STOP_FILE" '%s' "$index.stop"
  printf '%s' "$pid" > "$index.pid"
done
finish() {
  local original=$? failed=0
  trap - EXIT
  CleanupBackgroundProbes
  for index in 0 1 2 3; do
    if [[ "\${adoptionPattern:$index:1}" == 1 ]]; then
      kill -0 "\${pids[$index]}" || failed=1
      [[ -f "$index.pid" && ! -e "$index.stop" && ! -e "$index.terminal" ]] || failed=1
      printf 'adopted-%s-retained\\n' "$index"
    else
      if kill -0 "\${pids[$index]}" 2>/dev/null; then failed=1; fi
      [[ ! -e "$index.pid" && -f "$index.terminal" ]] || failed=1
      printf 'owned-%s-reaped\\n' "$index"
    fi
  done
  for pid in "\${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  [[ "$failed" == 0 ]] || exit 95
  exit "$original"
}
CURRENT_ADMISSION_PASSED=1
PRESERVE_BACKGROUND_PROBES_ON_EXIT=1
# Simulate a later fresh verification withdrawing an earlier admission.
CURRENT_ADMISSION_PASSED=0
trap finish EXIT
if [[ "$3" == interrupt ]]; then InterruptRollout TERM; fi
exit 0
`, 'owned-probe-fixture', runDirectory, adopted, mode], { encoding: 'utf8', timeout: 10_000 })
      assert.equal(result.error, undefined, result.stderr)
      assert.equal(result.status, mode === 'interrupt' ? 130 : 0, result.stderr)
      for (let index = 0; index < 4; index += 1) {
        assert.ok(result.stdout.includes(`${adopted[index] === '1' ? 'adopted' : 'owned'}-${index}-${adopted[index] === '1' ? 'retained' : 'reaped'}`))
      }
    }
  }
})

test('accepted component admission reaches later required gates without claiming a native receipt', (t) => {
  const fixture = createGatewayFixture(t)
  const current = currentAdmissionInputs(fixture)
  const result = runGateway(fixture, 'release-rollout.sh', ['--release-manifest', current.manifestFile,
    '--rollout-state-file', current.stateFile], current.environment())
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /backup restore evidence is required/u)
  assert.equal(fs.existsSync(current.lockFile), true)
  assert.equal(fs.existsSync(current.stateFile), false)
  assertCurrentAdmissionInvocation(current)
})

test('resume rebinds current receipt and complete manifest before lock or native command', (t) => {
  for (const field of ['manifestSha256', 'candidateSourceRevision', 'currentSchema']) {
    const fixture = createGatewayFixture(t)
    const current = currentAdmissionInputs(fixture)
    const state = createRolloutState({ ...createCurrentRolloutFixtureBinding(),
      manifestSha256: createHash('sha256').update(fs.readFileSync(current.manifestFile)).digest('hex'),
      candidateSourceRevision: current.manifest.commitSha, currentSchema: current.manifest.currentSchema,
      rolloutId: 'resume-current-refusal', manifestPath: current.manifestFile,
      source: { slot: 'blue', releaseId: blueRelease, imageDigest: blueDigest, runtimeGeneration: 1 },
      target: { slot: 'green', releaseId: greenRelease, imageDigest: greenDigest, runtimeGeneration: 2 } })
    if (field === 'currentSchema') state.currentSchema.database.databaseId = 'other'
    else state[field] = field === 'manifestSha256' ? 'a'.repeat(64) : 'a'.repeat(40)
    writeRolloutStateAtomic(current.stateFile, state)
    const before = fs.readFileSync(current.stateFile)
    const slotBefore = snapshot(fixture)
    const result = runGateway(fixture, 'release-rollout.sh', ['--resume', '--release-manifest', current.manifestFile,
      '--rollout-state-file', current.stateFile], current.environment())
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /current_schema_admission_input_binding_failed/u)
    assert.equal(fs.existsSync(current.lockFile), false)
    assert.equal(fs.existsSync(current.commandLog), false)
    assert.deepEqual(fs.readFileSync(current.stateFile), before)
    assertUnchanged(fixture, slotBefore)
  }
})

function currentAdmissionInputs(fixture) {
  // Explicit fake component outputs are not issued Shared receipts or database observations.
  const binding = createCurrentRolloutFixtureBinding()
  binding.candidateSourceRevision = `${greenRelease.slice(-12)}${'b'.repeat(28)}`
  const receiptFile = path.join(fixture.directory, 'current-receipt.json')
  fs.writeFileSync(receiptFile, JSON.stringify({ format: 'fsusblog.current-schema-receipt.v1', status: 'verified-current',
    target: binding.currentSchema.target, database: binding.currentSchema.database, actualSchemaDigest: binding.currentSchema.actualSchemaDigest }))
  binding.currentSchema.receipt = { reference: receiptFile, sha256: createHash('sha256').update(fs.readFileSync(receiptFile)).digest('hex') }
  const manifest = createReleaseManifest({ releaseId: greenRelease, commitSha: binding.candidateSourceRevision,
    imageRepository: 'ghcr.io/fsusblog/app', imageTag: `ghcr.io/fsusblog/app:${greenRelease}`,
    imageDigest: greenDigest, registryDigestVerified: true, createdAtUtc: '2026-07-11T02:02:02Z',
    frontendManifestHash: `sha256:${'c'.repeat(64)}`, wasmArtifactHash: `sha256:${'d'.repeat(64)}`,
    currentSchema: binding.currentSchema, dotnetVersion: '10.0.100', nodeVersion: '24.0.0',
    dockerVersion: '28.0.0', dockerfileDigest: `sha256:${'e'.repeat(64)}`, target: 'final',
    runtimeProfile: { id: 'throughput-musl', manifestDigest: `sha256:${'c'.repeat(64)}`,
      profileDigest: `sha256:${'d'.repeat(64)}`, baseImageFamily: 'musl', targetRuntime: 'linux-musl-x64',
      singleFile: false, readyToRun: true, tieredPgo: true, quickJitForLoops: true,
      serverGc: true, nativeAot: false, threadPoolMode: 'runtime-default', topologyMode: 'smt-visible' } })
  const manifestFile = path.join(fixture.directory, 'current-manifest.json')
  writeReleaseManifestAtomic(manifestFile, manifest)
  const output = { status: 'verified-current', candidateSourceRevision: manifest.commitSha,
    artifactSha256: binding.currentSchema.receipt.sha256, target: binding.currentSchema.target,
    database: binding.currentSchema.database, actualSchemaDigest: binding.currentSchema.actualSchemaDigest }
  const outputFile = path.join(fixture.directory, 'admission-output.json')
  fs.writeFileSync(outputFile, JSON.stringify(output))
  const envFile = path.join(fixture.directory, 'production.env')
  fs.writeFileSync(envFile, 'ASPNETCORE_ENVIRONMENT=Production\n', { mode: 0o600 })
  const stateFile = path.join(fixture.directory, 'current-rollout.json')
  const lockFile = path.join(fixture.directory, 'current.lock')
  const commandLog = path.join(fixture.directory, 'current-command.log')
  return { manifest, manifestFile, output, outputFile, stateFile, lockFile, commandLog,
    environment: missing => ({ FSUSBLOG_PRODUCTION_ENV_FILE: missing ? path.join(fixture.directory, 'missing.env') : envFile,
      FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL: 'http://127.0.0.1:18080/health/ready',
      FSUSBLOG_DEPLOYMENT_LOCK_FILE: lockFile,
      FAKE_CURRENT_ADMISSION_OUTPUT: outputFile, FAKE_CURRENT_ADMISSION_COMMAND_LOG: commandLog }) }
}

function assertCurrentAdmissionInvocation(current) {
  const command = fs.readFileSync(current.commandLog, 'utf8')
  assert.match(command, /--entrypoint\n\/app\/FsusBlog.Server\n/u)
  assert.ok(command.includes(current.manifest.imageRef))
  assert.ok(command.includes('current-schema-check\n'))
  assert.ok(command.includes(current.output.artifactSha256))
  assert.ok(command.includes(current.manifest.commitSha))
  assert.doesNotMatch(command, /--user|--schema-minimum-coordinate|migrate/u)
}

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
if [[ "\${1:-}" == "run" && -n "\${FAKE_CURRENT_ADMISSION_OUTPUT:-}" ]]; then
  printf '%s\\n' "$@" >> "\${FAKE_CURRENT_ADMISSION_COMMAND_LOG:?}"
  cat "\${FAKE_CURRENT_ADMISSION_OUTPUT:?}"
  exit 0
fi
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
  if [[ "$url" == */activate && "\${FAKE_ACTIVATE_FAIL_SLOT:-}" == "$slot" ]]; then exit 22; fi
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
  if [[ "$url" == */activate && "\${FAKE_ACTIVATE_RESPONSE_LOST_SLOT:-}" == "$slot" ]]; then exit 22; fi
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
  if [[ "\${FAKE_OPENRESTY_TEST_FAIL_ACTIVE_ONCE:-0}" == "1" && "$config" != *".stage-"* && ! -f "\${FAKE_OPENRESTY_FAIL_MARKER:?}" ]]; then
    : > "\${FAKE_OPENRESTY_FAIL_MARKER:?}"
    exit 1
  fi
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
