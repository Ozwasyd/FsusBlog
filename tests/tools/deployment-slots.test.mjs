import { createCurrentSchemaReleaseBindingFixture, createReleaseIdentityRosterFixture } from './support/release-readiness-test-helpers.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {createProductionBuildReceipt} = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const {behaviorTest, concurrencyHarnessId, runRealConcurrencyHarness} = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
const {createEmptySlotState, readSlotState, recordSlotStart, recordSlotStop, reserveRuntimeGeneration, resolveSlotConfig, setActiveSlot, writeSlotStateAtomic} = await import(new URL('../../tools/deployment/slot-lib.mjs', import.meta.url));
const {createReleaseManifest, writeReleaseManifestAtomic} = await import(new URL('../../tools/release/release-manifest.mjs', import.meta.url));
const {createSpaManifestDescriptor} = await import(new URL('../../tools/storage/create-spa-manifest-descriptor.mjs', import.meta.url));
const {materializeReleaseAssets} = await import(new URL('../../tools/storage/release-assets.mjs', import.meta.url));
import { boundedSemanticScale } from './support/timing-policy.mjs';
const {createRolloutState, writeRolloutStateAtomic} = await import(new URL('../../tools/deployment/release-rollout-lib.mjs', import.meta.url));
const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const commitSha = '0123456789abcdef0123456789abcdef01234567';
const greenCommitSha = 'fedcba9876543210fedcba9876543210fedcba98';
const blueRelease = '20260711010101-0123456789ab';
const greenRelease = '20260711020202-fedcba987654';
const blueDigest = `sha256:${'a'.repeat(64)}`;
const greenDigest = `sha256:${'e'.repeat(64)}`;
const hostCpu = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
const configuredCpu = Number(
    process.env.FSUSBLOG_STEP_CPU_BUDGET
    ?? process.env.FSUSBLOG_BUNDLE_CPU_BUDGET
);
const grantedCpu = Number.isFinite(configuredCpu) && configuredCpu > 0
    ? Math.min(hostCpu, configuredCpu)
    : hostCpu;
const pressureScale = Math.max(1, hostCpu / grantedCpu, (os.loadavg()[0] + 1) / grantedCpu);
const slotScriptTimeoutMs = Math.ceil(20_000 * boundedSemanticScale(pressureScale));

function releaseInput(releaseId, imageDigest)
{
    return {
        releaseId,
        commitSha: releaseId === greenRelease ? greenCommitSha : commitSha,
        imageRepository: 'ghcr.io/fsusblog/app',
        imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
        imageDigest,
        registryDigestVerified: true,
        createdAtUtc: releaseId === greenRelease ? '2026-07-11T02:02:02.000Z' : '2026-07-11T01:01:01.000Z',
        frontendManifestHash: `sha256:${'b'.repeat(64)}`,
        wasmArtifactHash: `sha256:${'c'.repeat(64)}`,
        currentSchema: createCurrentSchemaReleaseBindingFixture(),
        identity: createReleaseIdentityRosterFixture({ commitSha: releaseId === greenRelease ? greenCommitSha : commitSha, imageDigest, frontendManifestHash: `sha256:${'b'.repeat(64)}`, wasmArtifactHash: `sha256:${'c'.repeat(64)}` }),
        dotnetVersion: '10.0.100',
        nodeVersion: 'v20.19.0',
        dockerVersion: '28.0.0',
        dockerfileDigest: `sha256:${'d'.repeat(64)}`,
        runtimeProfile: {
            id: 'throughput-musl',
            manifestDigest: `sha256:${'2'.repeat(64)}`,
            profileDigest: `sha256:${'1'.repeat(64)}`,
            baseImageFamily: 'musl',
            targetRuntime: 'linux-musl-x64',
            singleFile: true,
            readyToRun: false,
            tieredPgo: true,
            quickJitForLoops: true,
            serverGc: true,
            nativeAot: false,
            threadPoolMode: 'runtime-default',
            topologyMode: 'smt-visible'
        },
        target: 'final'
    };
}

behaviorTest(
    'deployment-blue-green-runtime-role',
    'positive',
    'slot state uses atomic durable files and preserves independent release identities',
    (t) =>
    {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-slot-state-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const stateFile = path.join(directory, 'deployment', 'slots.json');
        const environment = { FSUSBLOG_BLUE_PORT: '18081', FSUSBLOG_GREEN_PORT: '18082' };
        const state = createEmptySlotState('2026-07-11T00:00:00.000Z');
        recordSlotStart(state, {
            slot: 'blue',
            releaseId: blueRelease,
            imageRef: `ghcr.io/fsusblog/app@${blueDigest}`,
            imageDigest: blueDigest,
            startedAt: '2026-07-11T01:00:00.000Z',
            environment
        });
        setActiveSlot(state, { slot: 'blue', kind: 'bootstrap', changedAt: '2026-07-11T01:01:00.000Z' });
        recordSlotStart(state, {
            slot: 'green',
            releaseId: greenRelease,
            imageRef: `ghcr.io/fsusblog/app@${greenDigest}`,
            imageDigest: greenDigest,
            startedAt: '2026-07-11T02:00:00.000Z',
            environment
        });
        assert.equal(state.slots.blue.deploymentGeneration, 1);
        assert.equal(state.slots.green.deploymentGeneration, 2);
        const restartedGeneration = reserveRuntimeGeneration(state, {
            slot: 'green',
            reservedAt: '2026-07-11T02:01:00.000Z'
        });
        assert.equal(restartedGeneration, 3);
        assert.throws(() => recordSlotStart(state, {
            slot: 'green',
            releaseId: greenRelease,
            imageRef: `ghcr.io/fsusblog/app@${greenDigest}`,
            imageDigest: greenDigest,
            deploymentGeneration: 2,
            startedAt: '2026-07-11T02:02:00.000Z',
            environment
        }), /latest reserved runtime generation/u);
        recordSlotStart(state, {
            slot: 'green',
            releaseId: greenRelease,
            imageRef: `ghcr.io/fsusblog/app@${greenDigest}`,
            imageDigest: greenDigest,
            deploymentGeneration: restartedGeneration,
            startedAt: '2026-07-11T02:02:00.000Z',
            environment
        });

        writeSlotStateAtomic(stateFile, state);
        fs.writeFileSync(path.join(path.dirname(stateFile), '.slots.json.tmp-interrupted'), '{partial');
        const recovered = readSlotState(stateFile, { allowMissing: false });

        assert.equal(recovered.activeSlot, 'blue');
        assert.equal(recovered.slots.blue.releaseId, blueRelease);
        assert.equal(recovered.slots.blue.port, 18081);
        assert.equal(recovered.slots.green.releaseId, greenRelease);
        assert.equal(recovered.slots.green.port, 18082);
        assert.equal(recovered.slots.green.deploymentGeneration, 3);
        assert.equal(recovered.runtimeGeneration, 3);
        assert.equal(recovered.lastTrafficTransition.kind, 'bootstrap');
        assert.notEqual(recovered.slots.blue.imageDigest, recovered.slots.green.imageDigest);
        assert.throws(() => recordSlotStop(recovered, { slot: 'blue' }), /refusing to stop active slot/u);
        recordSlotStop(recovered, { slot: 'green', stoppedAt: '2026-07-11T03:00:00.000Z' });
        assert.equal(recovered.slots.green.status, 'stopped');
        assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
        assert.throws(() => resolveSlotConfig('red', environment), /blue or green/u);
        assert.throws(() => resolveSlotConfig('blue', { FSUSBLOG_BLUE_PORT: '18081', FSUSBLOG_GREEN_PORT: '18081' }), /must be different/u);
    });

test('manifest v2 is the sole identity source for slot and rollout state writers', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-propagation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'slots.json');
    const rolloutFile = path.join(directory, 'rollout.json');
    const blueManifest = path.join(directory, 'blue-release-manifest.json');
    const greenManifest = path.join(directory, 'green-release-manifest.json');
    writeReleaseManifestAtomic(blueManifest, createReleaseManifest(releaseInput(blueRelease, blueDigest)));
    writeReleaseManifestAtomic(greenManifest, createReleaseManifest(releaseInput(greenRelease, greenDigest)));

    let result = spawnSync(process.execPath, [
        'tools/deployment/slot-state.mjs', 'record-start', '--state', stateFile, '--slot', 'blue',
        '--release-manifest', blueManifest, '--release-id', blueRelease,
        '--image-ref', `ghcr.io/fsusblog/app@${blueDigest}`, '--image-digest', blueDigest,
        '--at', '2026-07-11T01:00:00.000Z'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, [
        'tools/deployment/slot-state.mjs', 'set-active', '--state', stateFile,
        '--slot', 'blue', '--kind', 'bootstrap', '--at', '2026-07-11T01:01:00.000Z'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, [
        'tools/deployment/slot-state.mjs', 'reserve-generation', '--state', stateFile,
        '--slot', 'green', '--at', '2026-07-11T02:00:00.000Z'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const targetGeneration = JSON.parse(result.stdout).generation;

    result = spawnSync(process.execPath, [
        'tools/deployment/rollout-state.mjs', 'create', '--state', rolloutFile,
        '--rollout-id', 'rollout-20260711', '--kind', 'deploy', '--manifest', greenManifest,
        '--slot-state', stateFile,
        '--source-slot', 'blue', '--source-release', blueRelease, '--source-digest', blueDigest, '--source-generation', '1',
        '--target-slot', 'green', '--target-release', greenRelease, '--target-digest', greenDigest,
        '--target-generation', String(targetGeneration), '--at', '2026-07-11T02:01:00.000Z'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const rollout = JSON.parse(result.stdout);
    assert.equal(rollout.source.releaseId, blueRelease);
    assert.equal(rollout.target.releaseId, greenRelease);
    assert.equal(rollout.target.imageDigest, greenDigest);
    assert.equal(rollout.manifestPath, greenManifest);

    result = spawnSync(process.execPath, [
        'tools/deployment/slot-state.mjs', 'record-start', '--state', stateFile, '--slot', 'green',
        '--release-manifest', greenManifest, '--release-id', blueRelease,
        '--image-ref', `ghcr.io/fsusblog/app@${greenDigest}`, '--image-digest', greenDigest
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /releaseId does not match/u);

    result = spawnSync(process.execPath, [
        'tools/deployment/rollout-state.mjs', 'create', '--state', path.join(directory, 'forged-rollout.json'),
        '--rollout-id', 'rollout-forged', '--kind', 'deploy', '--manifest', greenManifest,
        '--slot-state', stateFile,
        '--source-slot', 'blue', '--source-release', greenRelease, '--source-digest', blueDigest, '--source-generation', '1',
        '--target-slot', 'green', '--target-release', greenRelease, '--target-digest', greenDigest,
        '--target-generation', String(targetGeneration)
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source identity does not match persisted slot state/u);
});

test('slot scripts coexist, remain idempotent, preserve active slot on candidate failures and recover status', (t) =>
{
    const fixture = createScriptFixture(t);
    const blueManifest = writeManifest(fixture.directory, 'blue.json', blueRelease, blueDigest);
    const greenManifest = writeManifest(fixture.directory, 'green.json', greenRelease, greenDigest);

    const blueStart = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'blue', '--release-manifest', blueManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.equal(blueStart.status, 0, blueStart.stderr);
    assert.equal(lastJson(blueStart.stdout).status, 'started');

    const activate = spawnSync(process.execPath, [
        path.join(root, 'tools/deployment/slot-state.mjs'), 'set-active',
        '--state', fixture.stateFile, '--slot', 'blue', '--kind', 'bootstrap'
    ], { cwd: root, encoding: 'utf8', env: fixture.environment });
    assert.equal(activate.status, 0, activate.stderr);

    const greenStart = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', greenManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.equal(greenStart.status, 0, greenStart.stderr);
    const greenAgain = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', greenManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.equal(greenAgain.status, 0, greenAgain.stderr);
    assert.equal(lastJson(greenAgain.stdout).status, 'already-running');
    const durableSlots = readSlotState(fixture.stateFile, { allowMissing: false });
    const rolloutFile = path.join(fixture.directory, 'rollout-state.json');
    writeRolloutStateAtomic(rolloutFile, createRolloutState({
        rolloutId: 'deployment-slots-test', manifestPath: greenManifest,
        source: {
            slot: 'blue', releaseId: blueRelease, imageDigest: blueDigest,
            runtimeGeneration: durableSlots.slots.blue.deploymentGeneration
        },
        target: {
            slot: 'green', releaseId: greenRelease, imageDigest: greenDigest,
            runtimeGeneration: durableSlots.slots.green.deploymentGeneration
        },
        createdAtUtc: '2026-07-11T03:00:00.000Z'
    }));

    const status = runSlot(fixture, 'slot-status.sh', ['--state-file', fixture.stateFile]);
    assert.equal(status.status, 0, status.stderr);
    const snapshot = JSON.parse(status.stdout);
    assert.equal(snapshot.activeSlot, 'blue');
    assert.equal(snapshot.activeStateConsistent, true);
    assert.equal(snapshot.runtimeGenerationsConsistent, true);
    assert.equal(snapshot.slots.blue.release.deploymentGeneration, snapshot.slots.blue.persisted.record.deploymentGeneration);
    assert.equal(snapshot.slots.green.release.deploymentGeneration, snapshot.slots.green.persisted.record.deploymentGeneration);
    assert.equal(snapshot.slots.blue.release.releaseId, blueRelease);
    assert.equal(snapshot.slots.green.release.releaseId, greenRelease);
    assert.equal(snapshot.slots.blue.loopbackOnly, true);
    assert.equal(snapshot.slots.green.loopbackOnly, true);
    assert.equal(snapshot.lastTrafficTransition.kind, 'bootstrap');

    const activeStop = runSlot(fixture, 'slot-stop.sh', [
        '--slot', 'blue', '--env-file', fixture.envFile, '--state-file', fixture.stateFile,
        '--rollout-state', rolloutFile
    ]);
    assert.notEqual(activeStop.status, 0);
    assert.match(activeStop.stderr, /refusing to stop active slot blue/u);

    const directStop = runSlot(fixture, 'slot-stop.sh', [
        '--slot', 'green', '--env-file', fixture.envFile, '--state-file', fixture.stateFile,
        '--rollout-state', rolloutFile
    ], { FSUSBLOG_ROLLOUT_ENTRY: '0' });
    assert.notEqual(directStop.status, 0);
    assert.match(directStop.stderr, /slot-stop is internal/u);

    const stopGreen = runSlot(fixture, 'slot-stop.sh', [
        '--slot', 'green', '--env-file', fixture.envFile, '--state-file', fixture.stateFile,
        '--rollout-state', rolloutFile
    ]);
    assert.equal(stopGreen.status, 0, stopGreen.stderr);
    const stopGreenAgain = runSlot(fixture, 'slot-stop.sh', [
        '--slot', 'green', '--env-file', fixture.envFile, '--state-file', fixture.stateFile,
        '--rollout-state', rolloutFile
    ]);
    assert.equal(stopGreenAgain.status, 0, stopGreenAgain.stderr);
    assert.equal(JSON.parse(stopGreenAgain.stdout).status, 'already-stopped');

    const failedHealth = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', greenManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile,
        '--rollout-state', rolloutFile, '--deployment-generation', String(durableSlots.slots.green.deploymentGeneration)
    ], { FAKE_HEALTH_FAIL_SLOT: 'green', FSUSBLOG_SLOT_HEALTH_TIMEOUT_SECONDS: '1' });
    assert.notEqual(failedHealth.status, 0);
    const afterFailure = runSlot(fixture, 'slot-status.sh', ['--state-file', fixture.stateFile]);
    const failureSnapshot = JSON.parse(afterFailure.stdout);
    assert.equal(failureSnapshot.slots.blue.running, true);
    assert.equal(failureSnapshot.slots.blue.release.releaseId, blueRelease);
    assert.equal(failureSnapshot.slots.green.running, false);
    assert.equal(failureSnapshot.runtimeGeneration, durableSlots.runtimeGeneration);
    assert.equal(failureSnapshot.lastTransition.status, 'failed');
    assert.equal(failureSnapshot.lastTrafficTransition.kind, 'bootstrap');

    const restartRead = spawnSync(process.execPath, [
        path.join(root, 'tools/deployment/slot-state.mjs'), 'read', '--state', fixture.stateFile
    ], { cwd: root, encoding: 'utf8', env: fixture.environment });
    assert.equal(restartRead.status, 0, restartRead.stderr);
    assert.equal(JSON.parse(restartRead.stdout).activeSlot, 'blue');
});

behaviorTest('deployment-blue-green-runtime-role', 'negative', {
    title: 'slot start rejects a valid receipt outside the retained current-release authority',
    invariantIds: ['active-release-identity-retention']
}, (t) =>
{
    const fixture = createScriptFixture(t);
    const manifest = writeManifest(fixture.directory, 'blue.json', blueRelease, blueDigest);
    const authority = ensureSpaAuthority(fixture, manifest, 'blue');

    const rejected = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'blue',
        '--release-manifest', manifest,
        '--production-build-receipt', authority.originalReceiptPath,
        '--env-file', fixture.envFile,
        '--state-file', fixture.stateFile
    ]);

    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must use the current retained release authority/u);
    assert.doesNotMatch(fs.readFileSync(fixture.dockerLog, 'utf8'), /^(?:pull|up):/mu);
});

behaviorTest('deployment-blue-green-runtime-role', 'concurrency', {
    title: 'concurrent blue-green state plans preserve active and candidate identities',
    concurrencyHarness: concurrencyHarnessId
}, async () =>
{
    const initial = createEmptySlotState('2026-07-11T00:00:00.000Z');
    recordSlotStart(initial, {
        slot: 'blue',
        releaseId: blueRelease,
        imageRef: `ghcr.io/fsusblog/app@${blueDigest}`,
        imageDigest: blueDigest,
        startedAt: '2026-07-11T01:00:00.000Z',
        environment: { FSUSBLOG_BLUE_PORT: '18081', FSUSBLOG_GREEN_PORT: '18082' }
    });
    setActiveSlot(initial, { slot: 'blue', kind: 'bootstrap', changedAt: '2026-07-11T01:01:00.000Z' });

    const results = await runRealConcurrencyHarness([
        async () =>
        {
            const snapshot = structuredClone(initial);
            assert.throws(() => recordSlotStop(snapshot, { slot: 'blue' }), /refusing to stop active slot/u);
            return snapshot.activeSlot;
        },
        async () =>
        {
            const snapshot = structuredClone(initial);
            const generation = reserveRuntimeGeneration(snapshot, {
                slot: 'green',
                reservedAt: '2026-07-11T02:00:00.000Z'
            });
            return { activeSlot: snapshot.activeSlot, generation };
        }
    ]);

    assert.deepEqual(results, ['blue', { activeSlot: 'blue', generation: 2 }]);
});

test('slot preflight blocks occupied ports, insufficient resources, invalid slots and bad digests without touching active', (t) =>
{
    const fixture = createScriptFixture(t);
    const blueManifest = writeManifest(fixture.directory, 'blue.json', blueRelease, blueDigest);
    const greenManifest = writeManifest(fixture.directory, 'green.json', greenRelease, greenDigest);
    const blueStart = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'blue', '--release-manifest', blueManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.equal(blueStart.status, 0, blueStart.stderr);
    const activate = spawnSync(process.execPath, [
        path.join(root, 'tools/deployment/slot-state.mjs'), 'set-active',
        '--state', fixture.stateFile, '--slot', 'blue', '--kind', 'bootstrap'
    ], { cwd: root, encoding: 'utf8', env: fixture.environment });
    assert.equal(activate.status, 0, activate.stderr);

    const duplicateActiveRelease = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', blueManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.notEqual(duplicateActiveRelease.status, 0);

    const occupied = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', greenManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ], { FAKE_SS_PORT: '18082' });
    assert.notEqual(occupied.status, 0);
    assert.match(occupied.stderr, /preflight failed/u);

    const lowResource = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', greenManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ], { FSUSBLOG_SLOT_MIN_AVAILABLE_MEMORY_MB: '999999999' });
    assert.notEqual(lowResource.status, 0);

    const unsafeGracePeriod = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', greenManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ], { FSUSBLOG_DRAIN_TIMEOUT_SECONDS: '60', FSUSBLOG_STOP_GRACE_PERIOD: '30s' });
    assert.notEqual(unsafeGracePeriod.status, 0);
    assert.match(unsafeGracePeriod.stderr, /STOP_GRACE_PERIOD must be greater/u);

    const invalidSlot = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'red', '--release-manifest', greenManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.notEqual(invalidSlot.status, 0);
    assert.match(invalidSlot.stderr, /blue or green/u);

    const corruptedManifest = path.join(fixture.directory, 'bad-manifest.json');
    fs.writeFileSync(corruptedManifest, JSON.stringify({ ...createReleaseManifest(releaseInput(greenRelease, greenDigest)), imageDigest: 'sha256:abc' }));
    const badDigest = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'green', '--release-manifest', corruptedManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.notEqual(badDigest.status, 0);

    const finalStatus = runSlot(fixture, 'slot-status.sh', ['--state-file', fixture.stateFile]);
    const snapshot = JSON.parse(finalStatus.stdout);
    assert.equal(snapshot.activeSlot, 'blue');
    assert.equal(snapshot.slots.blue.running, true);
    const log = fs.readFileSync(fixture.dockerLog, 'utf8');
    assert.equal(log.split('\n').filter(line => line === 'up:green').length, 0);

});

test('slot preflight enforces target image runtime contract without touching active', (t) =>
{
    const fixture = createScriptFixture(t);
    const blueManifest = writeManifest(fixture.directory, 'blue.json', blueRelease, blueDigest);
    const greenManifest = writeManifest(fixture.directory, 'green.json', greenRelease, greenDigest);
    const blueStart = runSlot(fixture, 'slot-start.sh', [
        '--slot', 'blue', '--release-manifest', blueManifest,
        '--env-file', fixture.envFile, '--state-file', fixture.stateFile
    ]);
    assert.equal(blueStart.status, 0, blueStart.stderr);
    const blueResult = lastJson(blueStart.stdout);
    assert.equal(blueResult.preflight.imageContract.schema, 'fsusblog.image-runtime-contract.v1');
    assert.equal(blueResult.preflight.imageContract.status, 'ok');
    assert.match(blueResult.preflight.imageContract.build.vcpkgCommit, /^[0-9a-f]{40}$/u);
    assert.equal(blueResult.preflight.imageContract.runtime.node, 'required');
    assert.equal(blueResult.preflight.imageContract.runtime.npm, 'forbidden');
    assert.equal(blueResult.preflight.imageContract.runtime.profileId, 'throughput-musl');
    assert.match(blueResult.preflight.imageContract.runtime.profileManifestDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(blueResult.preflight.imageContract.runtime.publishReadyToRun, 'false');

    const activate = spawnSync(process.execPath, [
        path.join(root, 'tools/deployment/slot-state.mjs'), 'set-active',
        '--state', fixture.stateFile, '--slot', 'blue', '--kind', 'bootstrap'
    ], { cwd: root, encoding: 'utf8', env: fixture.environment });
    assert.equal(activate.status, 0, activate.stderr);

    for (const [mode, message] of [
        ['pull-fail', /unable to pull target image/u],
        ['label-inspect-fail', /unable to inspect target image label/u],
        ['vcpkg-unpinned', /vcpkg commit label/u],
        ['node-label-invalid', /node contract label/u],
        ['npm-label-invalid', /npm contract label/u],
        ['runtime-boolean-invalid', /runtime boolean label/u],
        ['profile-digest-invalid', /runtime profile digest label/u],
        ['profile-digest-mismatch', /runtime profile labels do not match/u],
        ['node-missing', /must provide node/u],
        ['npm-present', /must not provide npm/u]
    ])
    {
        const rejected = runSlot(fixture, 'slot-start.sh', [
            '--slot', 'green', '--release-manifest', greenManifest,
            '--env-file', fixture.envFile, '--state-file', fixture.stateFile
        ], { FAKE_DOCKER_IMAGE_CONTRACT_MODE: mode });
        assert.notEqual(rejected.status, 0, `${mode} unexpectedly passed`);
        assert.match(rejected.stderr, message);
    }

    const finalStatus = runSlot(fixture, 'slot-status.sh', ['--state-file', fixture.stateFile]);
    assert.equal(finalStatus.status, 0, finalStatus.stderr);
    const snapshot = JSON.parse(finalStatus.stdout);
    assert.equal(snapshot.activeSlot, 'blue');
    assert.equal(snapshot.slots.blue.running, true);
    assert.equal(snapshot.slots.blue.release.releaseId, blueRelease);
    assert.equal(snapshot.slots.green.running, false);

    const log = fs.readFileSync(fixture.dockerLog, 'utf8');
    assert.match(log, /^contract:pull:ghcr\.io\/fsusblog\/app@sha256:/mu);
    assert.match(log, /^contract:inspect:io\.fsusblog\.build\.vcpkg-commit$/mu);
    assert.match(log, /^contract:inspect:io\.fsusblog\.runtime\.node$/mu);
    assert.match(log, /^contract:inspect:io\.fsusblog\.runtime\.npm$/mu);
    assert.match(log, /^contract:inspect:io\.fsusblog\.runtime\.publish-ready-to-run$/mu);
    assert.match(log, /^contract:run:node$/mu);
    assert.match(log, /^contract:run:npm$/mu);
    assert.equal(log.split('\n').filter(line => line === 'up:green').length, 0);

    for (const imageRef of [
        'ghcr.io/fsusblog/app:mutable',
        'ghcr.io/fsusblog/app@sha256:abc',
        `ghcr.io/fsusblog/app@sha256:${'A'.repeat(64)}`
    ])
    {
        const beforeInvalidReference = fs.readFileSync(fixture.dockerLog, 'utf8');
        const invalidReference = spawnSync('bash', [
            path.join(root, 'tools/deployment/image-runtime-contract.sh'),
            imageRef
        ], { cwd: root, encoding: 'utf8', env: fixture.environment });
        assert.notEqual(invalidReference.status, 0);
        assert.match(invalidReference.stderr, /image reference must be immutable/u);
        assert.equal(fs.readFileSync(fixture.dockerLog, 'utf8'), beforeInvalidReference);
    }
});

test('production Compose keeps fixed slots on distinct loopback ports with shared and isolated volumes', () =>
{
    const compose = fs.readFileSync(path.join(root, 'ops/docker/docker-compose.production.yml'), 'utf8');
    assert.match(compose, /container_name: \$\{FSUSBLOG_CONTAINER_NAME:\?/u);
    assert.match(compose, /127\.0\.0\.1:\$\{FSUSBLOG_SLOT_PORT:\?[^}]+\}:8080/u);
    assert.match(compose, /FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME/u);
    assert.doesNotMatch(compose, /\/app\/wwwroot\/uploads/u);
    assert.doesNotMatch(compose, /FSUSBLOG_SHARED_UPLOADS_VOLUME/u);
    assert.match(compose, /FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME/u);
    assert.match(compose, /FSUSBLOG_SLOT_AOT_CACHE_VOLUME/u);
    assert.match(compose, /FSUSBLOG_SLOT_LOGS_VOLUME/u);
    assert.match(compose, /FSUSBLOG_SLOT_DATA_VOLUME/u);
    assert.match(compose, /FSUSBLOG_RELEASE_MANIFEST_PATH=\/app\/release-manifest\.json/u);
    assert.match(
        compose,
        /FSUSBLOG_SPA_MANIFEST_DESCRIPTOR=\/app\/release-assets\/\$\{FSUSBLOG_RELEASE_ID:[^}]+\}\/spa-manifest-descriptor\.json/u);
    assert.match(
        compose,
        /FSUSBLOG_PRODUCTION_BUILD_RECEIPT=\/app\/release-assets\/\$\{FSUSBLOG_RELEASE_ID:[^}]+\}\/production-build-receipt\.json/u);
    assert.match(compose, /FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE/u);
    assert.match(compose, /FSUSBLOG_RELEASE_MANIFEST_HOST_PATH[^\n]+:\/app\/release-manifest\.json:ro/u);
    assert.doesNotMatch(compose, /127\.0\.0\.1:8080:8080/u);
});

function writeManifest(directory, name, releaseId, digest)
{
    const file = path.join(directory, name);
    writeReleaseManifestAtomic(file, createReleaseManifest(releaseInput(releaseId, digest)));
    return file;
}

function runSlot(fixture, script, args, overrides = {})
{
    const resolvedArgs = [...args];
    if (script === 'slot-start.sh' && !resolvedArgs.includes('--production-build-receipt'))
    {
        const manifestIndex = resolvedArgs.indexOf('--release-manifest');
        const slotIndex = resolvedArgs.indexOf('--slot');
        let receiptPath = fixture.placeholderReceipt;
        if (manifestIndex >= 0 && slotIndex >= 0 && ['blue', 'green'].includes(resolvedArgs[slotIndex + 1]))
        {
            try
            {
                receiptPath = ensureSpaAuthority(
                    fixture,
                    resolvedArgs[manifestIndex + 1],
                    resolvedArgs[slotIndex + 1]).retainedReceiptPath;
            }
            catch
            {
                // Invalid-manifest tests must reach the script's own fail-closed validation.
            }
        }
        resolvedArgs.push('--production-build-receipt', receiptPath);
    }
    return spawnSync('bash', [path.join(root, 'tools/deployment', script), ...resolvedArgs], {
        cwd: root,
        encoding: 'utf8',
        timeout: slotScriptTimeoutMs,
        env: { ...fixture.environment, ...overrides }
    });
}

function lastJson(output)
{
    const lines = output.trim().split('\n');
    return JSON.parse(lines.at(-1));
}

function createScriptFixture(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-slot-scripts-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binDir = path.join(directory, 'bin');
    const dockerRoot = path.join(directory, 'docker-root');
    const dockerState = path.join(directory, 'docker-state.json');
    const dockerLog = path.join(directory, 'docker.log');
    const stateFile = path.join(directory, 'persistent', 'slots.json');
    const assetStore = path.join(directory, 'release-assets');
    const placeholderReceipt = path.join(directory, 'invalid-production-build-receipt.json');
    fs.mkdirSync(binDir);
    fs.mkdirSync(dockerRoot);
    fs.mkdirSync(assetStore);
    fs.writeFileSync(dockerState, '{}\n');
    fs.writeFileSync(dockerLog, '');
    fs.writeFileSync(placeholderReceipt, '{}\n');
    writeFakeDocker(path.join(binDir, 'docker'));
    writeFakeCurl(path.join(binDir, 'curl'));
    writeFakeSs(path.join(binDir, 'ss'));
    fs.writeFileSync(path.join(binDir, 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const envFile = createProductionEnv(directory, assetStore);
    const environment = { ...process.env };
    for (const key of ['FSUSBLOG_RELEASE_ID', 'FSUSBLOG_RELEASE_SLOT', 'FSUSBLOG_COMMIT_SHA', 'FSUSBLOG_IMAGE_REF', 'FSUSBLOG_IMAGE_DIGEST'])
    {
        delete environment[key];
    }
    Object.assign(environment, {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_DOCKER_ROOT: dockerRoot,
        FAKE_DOCKER_STATE: dockerState,
        FAKE_DOCKER_LOG: dockerLog,
        FSUSBLOG_BLUE_PORT: '18081',
        FSUSBLOG_GREEN_PORT: '18082',
        FSUSBLOG_SLOT_MIN_AVAILABLE_MEMORY_MB: '256',
        FSUSBLOG_SLOT_MIN_FREE_DISK_MB: '256',
        FSUSBLOG_SLOT_IMAGE_PULL_RESERVE_MB: '256',
        FSUSBLOG_SLOT_HEALTH_TIMEOUT_SECONDS: '2',
        FSUSBLOG_SLOT_HEALTH_INTERVAL_SECONDS: '1',
        FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE: '20260710010101-aaaaaaaaaaaa',
        FSUSBLOG_ROLLOUT_ENTRY: '1',
        FSUSBLOG_DEPLOYMENT_LOCK_FILE: path.join(directory, 'deployment.lock'),
        FSUSBLOG_RELEASE_ASSET_STORE: assetStore
    });
    return {
        directory,
        envFile,
        stateFile,
        dockerLog,
        environment,
        assetStore,
        placeholderReceipt
    };
}

function createProductionEnv(directory, assetStore)
{
    const configDir = path.join(directory, 'zk-config');
    const secretDir = path.join(directory, 'zk-secret');
    fs.mkdirSync(configDir);
    fs.mkdirSync(secretDir);
    for (const [name, value] of [
        ['trusted.json', '{}\n'],
        ['verifying.json', '{}\n'],
        ['comment.v5.vk', 'verifying key\n'],
        ['issuer-public.key', 'issuer public\n']
    ])
    {
        fs.writeFileSync(path.join(configDir, name), value);
    };
    fs.writeFileSync(path.join(secretDir, 'issuer-private.key'), 'issuer private\n');
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const envFile = path.join(directory, '.env.production');
    fs.writeFileSync(envFile, [
        'EXTERNAL_DB_HOST=db', 'EXTERNAL_REDIS_HOST=redis', 'DB_USER=fsus', 'DB_PASSWORD=database-password',
        'DB_NAME=fsusblog', 'REDIS_PASSWORD=redis-password', 'Jwt__SecretKey=0123456789abcdef0123456789abcdef',
        'Jwt__KeyVersion=v2-2026-07', 'Jwt__RotationWindowDays=30',
        'SITE_BASEURL=https://example.com', 'CORS_ALLOWED_HOSTS=https://example.com', 'APP_ALLOWED_HOSTS=example.com',
        'FIDO2_SERVER_DOMAIN=example.com', 'REVERSE_PROXY_KNOWN_PROXIES=127.0.0.1',
        'FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME=fsusblog-public-assets-fixture',
        'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME=fsusblog-data-protection-fixture',
        `FSUSBLOG_RELEASE_ASSET_STORE=${assetStore}`,
        'FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1', 'FSUSBLOG_ZK_PROD_ENABLED=true',
        'FSUSBLOG_ZK_TRUSTED_SETUP_VERIFIED=true', 'FSUSBLOG_ZK_CREDENTIAL_READY=true',
        'FSUSBLOG_ZK_VERIFIER_ENABLED=true', 'FSUSBLOG_ZK_CREDENTIAL_ISSUER_ENABLED=true',
        `FSUSBLOG_ZK_CONFIG_DIR=${configDir}`, `FSUSBLOG_ZK_SECRET_DIR=${secretDir}`,
        `FSUSBLOG_ZK_VERIFYING_KEY_HASH=${hash(path.join(configDir, 'comment.v5.vk'))}`,
        'FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST=/app/config/zk/trusted.json',
        'FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST=/app/config/zk/verifying.json',
        'FSUSBLOG_ZK_GROTH16_VERIFYING_KEY=/app/config/zk/comment.v5.vk',
        'FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_ID=issuer-v1',
        'FSUSBLOG_ZK_ISSUER_PUBLIC_KEY=/app/config/zk/issuer-public.key',
        'FSUSBLOG_ZK_ISSUER_PRIVATE_KEY=/app/secrets/zk/issuer-private.key',
        `FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH=${hash(path.join(configDir, 'issuer-public.key'))}`
    ].join('\n') + '\n');
    return envFile;
}

function ensureSpaAuthority(fixture, releaseManifestPath, slot)
{
    const release = JSON.parse(fs.readFileSync(releaseManifestPath, 'utf8'));
    const releaseId = String(release.releaseId ?? '');
    const commit = String(release.commitSha ?? '');
    if (!/^[0-9]{14}-[a-f0-9]{12}$/u.test(releaseId) || !/^[a-f0-9]{40}$/u.test(commit))
    {
        throw new Error('release manifest identity is invalid');
    }

    const authorityRoot = path.join(fixture.directory, 'spa-authority-inputs', releaseId);
    const artifactRoot = path.join(authorityRoot, 'production-build');
    const frontendDist = path.join(artifactRoot, 'frontend-dist');
    const retainedReceiptPath = path.join(
        fixture.assetStore,
        'releases',
        releaseId,
        'production-build-receipt.json');
    const descriptorPath = path.join(
        fixture.assetStore,
        'releases',
        releaseId,
        'spa-manifest-descriptor.json');
    if (fs.existsSync(retainedReceiptPath) && fs.existsSync(descriptorPath))
    {
        return {
            retainedReceiptPath,
            descriptorPath,
            originalReceiptPath: path.join(artifactRoot, 'receipt.json')
        };
    }

    const checkout = path.join(authorityRoot, 'checkout');
    fs.mkdirSync(path.join(frontendDist, '.vite'), { recursive: true });
    fs.mkdirSync(path.join(frontendDist, 'assets'), { recursive: true });
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'build-input.json'), '{"profile":"production"}\n');
    fs.writeFileSync(path.join(frontendDist, 'index.html'), `<main>${releaseId}</main>\n`);
    fs.writeFileSync(
        path.join(frontendDist, 'assets', 'app.js'),
        `export const releaseId = '${releaseId}'\n`);
    fs.writeFileSync(path.join(frontendDist, '.vite', 'manifest.json'), `${JSON.stringify({
        'src/bootstrap/entry.ts': {
            file: 'assets/app.js',
            name: 'route-public'
        }
    })}\n`);
    createProductionBuildReceipt({
        root: checkout,
        artifactRoot,
        sourceState: {
            commit,
            worktreeFingerprint: `sha256:${crypto.createHash('sha256').update(releaseId).digest('hex')}`
        },
        producer: {
            workflow: 'deployment-slots-test',
            runId: releaseId,
            runAttempt: 1,
            job: 'production-build-artifacts'
        },
        toolchain: {
            node: 'v24.1.0',
            npm: '11.0.0',
            dotnet: '10.0.1',
            vite: '7.0.0',
            vitest: '4.0.0',
            playwright: '1.58.0',
            emsdk: '4.0.0'
        },
        inputPaths: ['build-input.json'],
        domains: [{ name: 'frontend-dist', path: 'frontend-dist' }],
        build: {
            profile: 'production-release-fresh',
            command: './tools/test.sh ci-tier production-build-artifacts'
        },
        now: () => new Date('2026-07-11T00:00:00Z')
    });
    materializeReleaseAssets({
        releaseId,
        slot,
        sourceDirectory: frontendDist,
        storeDirectory: fixture.assetStore,
        dryRun: false
    });
    createSpaManifestDescriptor({
        releaseManifestPath,
        buildReceiptPath: path.join(artifactRoot, 'receipt.json'),
        releaseAssetRoot: path.join(fixture.assetStore, 'releases'),
        assetRoot: path.join(fixture.assetStore, 'releases', releaseId),
        runtimeAssetRoot: `/app/release-assets/${releaseId}`,
        out: descriptorPath
    });
    return {
        retainedReceiptPath,
        descriptorPath,
        originalReceiptPath: path.join(artifactRoot, 'receipt.json')
    };
}

function writeFakeDocker(file)
{
    fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_DOCKER_STATE:?}"
log="\${FAKE_DOCKER_LOG:?}"
contract_mode="\${FAKE_DOCKER_IMAGE_CONTRACT_MODE:-valid}"
if [[ "\${1:-}" == "info" ]]; then printf '%s\\n' "\${FAKE_DOCKER_ROOT:?}"; exit 0; fi
if [[ "\${1:-}" == "volume" && "\${2:-}" == "inspect" ]]; then exit 0; fi
if [[ "\${1:-}" == "network" && "\${2:-}" == "inspect" ]]; then exit 0; fi
if [[ "\${1:-}" == "pull" ]]; then
  printf 'pull:%s\\n' "\${FSUSBLOG_RELEASE_SLOT:-}" >> "$log"
  printf 'contract:pull:%s\\n' "\${2:-}" >> "$log"
  [[ "$contract_mode" != "pull-fail" ]]
  exit
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  case "\${5:-}" in
    *io.fsusblog.build.vcpkg-commit*)
      printf 'contract:inspect:io.fsusblog.build.vcpkg-commit\\n' >> "$log"
      [[ "$contract_mode" == "label-inspect-fail" ]] && exit 31
      [[ "$contract_mode" == "vcpkg-unpinned" ]] && printf 'unpinned\\n' || printf 'eae1680538b86f962455c27abca2aad0dc304a4d\\n' ;;
    *io.fsusblog.runtime.node*)
      printf 'contract:inspect:io.fsusblog.runtime.node\\n' >> "$log"
      [[ "$contract_mode" == "node-label-invalid" ]] && printf 'optional\\n' || printf 'required\\n' ;;
    *io.fsusblog.runtime.npm*)
      printf 'contract:inspect:io.fsusblog.runtime.npm\\n' >> "$log"
      [[ "$contract_mode" == "npm-label-invalid" ]] && printf 'allowed\\n' || printf 'forbidden\\n' ;;
    *io.fsusblog.runtime.publish-ready-to-run*)
      printf 'contract:inspect:io.fsusblog.runtime.publish-ready-to-run\\n' >> "$log"
      [[ "$contract_mode" == "runtime-boolean-invalid" ]] && printf 'maybe\\n' || printf 'false\\n' ;;
    *io.fsusblog.runtime.profile-id*) printf 'throughput-musl\\n' ;;
    *io.fsusblog.runtime.profile-manifest-digest*) printf 'sha256:2222222222222222222222222222222222222222222222222222222222222222\\n' ;;
    *io.fsusblog.runtime.profile-digest*)
      if [[ "$contract_mode" == "profile-digest-invalid" ]]; then printf 'missing\\n'
      elif [[ "$contract_mode" == "profile-digest-mismatch" ]]; then printf 'sha256:2222222222222222222222222222222222222222222222222222222222222222\\n'
      else printf 'sha256:1111111111111111111111111111111111111111111111111111111111111111\\n'; fi ;;
    *io.fsusblog.runtime.base-family*) printf 'musl\\n' ;;
    *io.fsusblog.runtime.target-runtime*) printf 'linux-musl-x64\\n' ;;
    *io.fsusblog.runtime.publish-single-file*) printf 'true\\n' ;;
    *io.fsusblog.runtime.tiered-pgo*) printf 'true\\n' ;;
    *io.fsusblog.runtime.quick-jit-for-loops*) printf 'true\\n' ;;
    *io.fsusblog.runtime.server-gc*) printf 'true\\n' ;;
    *io.fsusblog.runtime.native-aot*) printf 'false\\n' ;;
    *io.fsusblog.runtime.gc-heap-count-mode*) printf 'container-default\\n' ;;
    *io.fsusblog.runtime.gc-heap-hard-limit-mode*) printf 'container-limit\\n' ;;
    *io.fsusblog.runtime.gc-heap-hard-limit-percent*) printf '0\\n' ;;
    *io.fsusblog.runtime.thread-pool-mode*) printf 'runtime-default\\n' ;;
    *io.fsusblog.runtime.thread-pool-min-threads-per-cpu*) printf '0\\n' ;;
    *io.fsusblog.runtime.topology-mode*) printf 'smt-visible\\n' ;;
    *RepoDigests*) printf '%s\\n' "\${FSUSBLOG_IMAGE_REF:-}" ;;
    *image.version*) printf '%s\\n' "\${FSUSBLOG_RELEASE_ID:-}" ;;
    *image.created*) printf '%s\\n' "\${FSUSBLOG_RELEASE_CREATED_AT_UTC:-}" ;;
    *image.revision*) printf '%s\\n' "\${FSUSBLOG_COMMIT_SHA:-}" ;;
    *) exit 31 ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  command_text="\${*: -1}"
  if [[ "$command_text" == *"command -v node"* ]]; then
    printf 'contract:run:node\\n' >> "$log"
    [[ "$contract_mode" != "node-missing" ]]
    exit
  fi
  if [[ "$command_text" == *"command -v npm"* ]]; then
    printf 'contract:run:npm\\n' >> "$log"
    [[ "$contract_mode" != "npm-present" ]]
    exit
  fi
  exit 33
fi
if [[ "\${1:-}" == "inspect" ]]; then
  name="\${2:-}"
  jq -e --arg name "$name" '.[$name]' "$state" >/dev/null 2>&1 || exit 1
  jq -c --arg name "$name" '[.[$name]]' "$state"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  action=""
  for arg in "$@"; do case "$arg" in config|up|down) action="$arg" ;; esac; done
  case "$action" in
    config) exit 0 ;;
    up)
      printf 'up:%s\\n' "\${FSUSBLOG_RELEASE_SLOT:-}" >> "$log"
      tmp="$state.tmp"
      jq --arg name "\${FSUSBLOG_CONTAINER_NAME:?}" \
        --arg slot "\${FSUSBLOG_RELEASE_SLOT:?}" \
        --arg project "\${FSUSBLOG_COMPOSE_PROJECT_NAME:?}" \
        --arg releaseId "\${FSUSBLOG_RELEASE_ID:?}" \
        --arg commit "\${FSUSBLOG_COMMIT_SHA:?}" \
        --arg imageRef "\${FSUSBLOG_IMAGE_REF:?}" \
        --arg digest "\${FSUSBLOG_IMAGE_DIGEST:?}" \
        --arg port "\${FSUSBLOG_SLOT_PORT:?}" \
        --arg generation "\${FSUSBLOG_DEPLOYMENT_GENERATION:?}" \
        '.[$name] = {
          Name: ("/" + $name),
          Config: {Labels: {
            "io.fsusblog.release.slot": $slot,
            "io.fsusblog.release.id": $releaseId,
            "io.fsusblog.release.commit": $commit,
            "io.fsusblog.release.image-ref": $imageRef,
            "io.fsusblog.release.image-digest": $digest,
            "io.fsusblog.deployment.project": $project,
            "io.fsusblog.deployment.mode": "candidate",
            "io.fsusblog.deployment.generation": $generation
          }},
          State: {Running: true, Health: {Status: "healthy"}, StartedAt: "2026-07-11T01:01:01.123456789Z"},
          NetworkSettings: {Ports: {"8080/tcp": [{HostIp: "127.0.0.1", HostPort: $port}]}}
        }' "$state" > "$tmp"
      mv "$tmp" "$state"
      exit 0 ;;
    down)
      printf 'down:%s\\n' "\${FSUSBLOG_RELEASE_SLOT:-}" >> "$log"
      tmp="$state.tmp"
      jq --arg name "\${FSUSBLOG_CONTAINER_NAME:?}" 'del(.[$name])' "$state" > "$tmp"
      mv "$tmp" "$state"
      exit 0 ;;
  esac
fi
exit 32
`, { mode: 0o755 });
}

function writeFakeCurl(file)
{
    fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
port="\${url#*127.0.0.1:}"
port="\${port%%/*}"
slot=""
[[ "$port" == "\${FSUSBLOG_BLUE_PORT:-8081}" ]] && slot=blue
[[ "$port" == "\${FSUSBLOG_GREEN_PORT:-8082}" ]] && slot=green
[[ -n "$slot" && "\${FAKE_HEALTH_FAIL_SLOT:-}" != "$slot" ]] || exit 22
name="fsus-app-$slot"
jq -e --arg name "$name" '.[$name].State.Running == true' "\${FAKE_DOCKER_STATE:?}" >/dev/null
printf '{"status":"ok"}\\n'
`, { mode: 0o755 });
}

function writeFakeSs(file)
{
    fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${FAKE_SS_PORT:-}" ]]; then printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\\n' "$FAKE_SS_PORT"; fi
`, { mode: 0o755 });
}
