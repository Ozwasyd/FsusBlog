import { createCurrentRolloutFixtureBinding, createReleaseRolloutEvidenceFixture } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {readDestructiveOperationAuthority, validateDestructiveOperationAuthority, verifyArtifactGcActiveIdentity, verifyCandidateCleanupOwnership, verifyRuntimeSlotStop} = await import(new URL('../../tools/deployment/destructive-operation-authority.mjs', import.meta.url));
const {createEmptySlotState, recordSlotStart, setActiveSlot, writeSlotStateAtomic} = await import(new URL('../../tools/deployment/slot-lib.mjs', import.meta.url));
const {createRolloutState, writeRolloutStateAtomic} = await import(new URL('../../tools/deployment/release-rollout-lib.mjs', import.meta.url));
const {executeReleaseAssetGc, normalizeGcState, observeReleaseAssetProtection, planReleaseAssetGc, verifyReleaseAssetGcPlan} = await import(new URL('../../tools/storage/release-gc.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRelease = '20260710010101-aaaaaaaaaaaa';
const targetRelease = '20260711010101-bbbbbbbbbbbb';
const sourceDigest = `sha256:${'a'.repeat(64)}`;
const targetDigest = `sha256:${'b'.repeat(64)}`;

test('closed authority binds supported consumers and keeps production volume/schema unsupported', () =>
{
    const authority = readDestructiveOperationAuthority();
    assert.deepEqual(authority.operations.filter(item => item.status === 'unsupported').map(item => item.id).sort(), [
        'production-schema-cleanup', 'production-volume-cleanup'
    ]);
    assert.deepEqual(
        authority.operations.find(item => item.id === 'runtime-slot-stop').activeIdentitySources,
        ['durable-slot-state', 'durable-rollout-state', 'live-container-labels']);
    const check = spawnSync(process.execPath, ['tools/deployment/check-destructive-operation-authority.mjs'], {
        cwd: root, encoding: 'utf8'
    });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).operationCount, 5);
});

test('static consumer gate rejects an unbound renamed production cleanup path', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-destructive-static-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const mutation = path.join(directory, 'renamed-cleaner.sh');
    fs.writeFileSync(mutation, '#!/usr/bin/env bash\ndocker volume rm fsusblog-data\n');
    const rejected = spawnSync(process.execPath, [
        'tools/deployment/check-destructive-operation-authority.mjs', '--additional-source', mutation
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /unbound production volume\/schema destructive path/u);
});

test('authority rejects extra fields, semantic drift, and digest tamper', () =>
{
    const authority = structuredClone(readDestructiveOperationAuthority());
    authority.extra = true;
    assert.throws(() => validateDestructiveOperationAuthority(authority), /closed exact/u);
    const drift = structuredClone(readDestructiveOperationAuthority());
    drift.operations[0].status = 'unsupported';
    assert.throws(() => validateDestructiveOperationAuthority(drift), /unsupported|contentDigest/u);
    const digest = structuredClone(readDestructiveOperationAuthority());
    digest.contentDigest = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => validateDestructiveOperationAuthority(digest), /contentDigest/u);
});

test('runtime stop requires one durable active and exact live active plus standby identities', () =>
{
    const fixture = deploymentFixture();
    const authority = readDestructiveOperationAuthority();
    const accepted = verifyRuntimeSlotStop({
        authority, slotState: fixture.slots, rolloutState: fixture.rollout,
        activeObservation: observation(fixture.slots, 'blue'),
        targetObservation: observation(fixture.slots, 'green')
    });
    assert.equal(accepted.targetSlot, 'green');
    for (const mutate of [
        slots =>
        {
            slots.activeSlot = null;
            slots.activeReleaseId = null;
            slots.activeImageDigest = null;
        },
        slots =>
        {
            slots.status = 'switching';
            slots.pendingTransition = {};
        }
    ])
    {
        const slots = structuredClone(fixture.slots);
        mutate(slots);
        assert.throws(() => verifyRuntimeSlotStop({
            authority, slotState: slots, rolloutState: fixture.rollout,
            activeObservation: observation(fixture.slots, 'blue'),
            targetObservation: observation(fixture.slots, 'green')
        }), /active|pendingTransition/u);
    }
    const wrongActive = observation(fixture.slots, 'blue');
    wrongActive.release.releaseId = targetRelease;
    assert.throws(() => verifyRuntimeSlotStop({
        authority, slotState: fixture.slots, rolloutState: fixture.rollout, activeObservation: wrongActive,
        targetObservation: observation(fixture.slots, 'green')
    }), /exactly match/u);
    const extra = observation(fixture.slots, 'green');
    extra.release.runId = 'other-run';
    assert.throws(() => verifyRuntimeSlotStop({
        authority, slotState: fixture.slots, rolloutState: fixture.rollout,
        activeObservation: observation(fixture.slots, 'blue'),
        targetObservation: extra
    }), /closed exact/u);
});

test('artifact protection requires exact slot rollout retention identity and rejects cross-operation state', () =>
{
    const fixture = deploymentFixture();
    const authority = readDestructiveOperationAuthority();
    const retentionState = retention(sourceRelease);
    const accepted = verifyArtifactGcActiveIdentity({
        authority, slotState: fixture.slots, rolloutState: fixture.rollout, retentionState
    });
    assert.equal(accepted.releaseId, sourceRelease);
    const mismatch = retention(targetRelease);
    assert.throws(() => verifyArtifactGcActiveIdentity({
        authority, slotState: fixture.slots, rolloutState: fixture.rollout, retentionState: mismatch
    }), /retention active/u);
    const otherOperation = structuredClone(fixture.rollout);
    otherOperation.source.runtimeGeneration += 10;
    assert.throws(() => verifyArtifactGcActiveIdentity({
        authority, slotState: fixture.slots, rolloutState: otherOperation, retentionState
    }), /exactly one active/u);
    const extraIdentity = structuredClone(fixture.rollout);
    extraIdentity.source.operationId = 'other-operation';
    assert.throws(() => verifyArtifactGcActiveIdentity({
        authority, slotState: fixture.slots, rolloutState: extraIdentity, retentionState
    }), /closed exact/u);
});

test('candidate failure cleanup is limited to the exact current-operation target', () =>
{
    const fixture = deploymentFixture();
    const authority = readDestructiveOperationAuthority();
    const candidate = { ...fixture.rollout.target };
    assert.equal(verifyCandidateCleanupOwnership({
        authority, slotState: fixture.slots, rolloutState: fixture.rollout, candidate
    }).rolloutId, fixture.rollout.rolloutId);
    for (const mutation of [
        { ...candidate, releaseId: sourceRelease },
        { ...candidate, slot: 'blue' },
        { ...candidate, runtimeGeneration: candidate.runtimeGeneration + 1 },
        { ...candidate, operationId: 'other-operation' }
    ])
    {
        assert.throws(() => verifyCandidateCleanupOwnership({
            authority, slotState: fixture.slots, rolloutState: fixture.rollout, candidate: mutation
        }), /current-operation-owned|closed exact/u);
    }
});

test('read-only protection reopens durable identity inside the canonical lock and binds manifest bytes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-readonly-gc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = path.join(directory, 'store')
  const active = path.join(store, 'releases', sourceRelease)
  const orphan = path.join(store, 'releases', targetRelease)
  for (const target of [active, orphan, path.join(store, 'objects')]) fs.mkdirSync(target, { recursive: true })
  writeManifest(active, sourceRelease, 'a')
  writeManifest(orphan, targetRelease, 'b')
  const fixture = deploymentFixture()
  const state = retention(sourceRelease)
  const protection = verifyArtifactGcActiveIdentity({
    authority: readDestructiveOperationAuthority(), slotState: fixture.slots,
    rolloutState: fixture.rollout, retentionState: state
  })
  const lock = path.join(store, '.gc.lock')
  let calls = 0
  const accepted = observeReleaseAssetProtection({ storeDirectory: store, state, readProtection: () => {
    assert.equal(JSON.parse(fs.readFileSync(lock)).pid, process.pid)
    calls += 1
    return protection
  } })
  assert.equal(calls, 2)
  assert.equal(accepted.gcEvidence.dryRun, true)
  assert.deepEqual(accepted.gcEvidence.before, accepted.gcEvidence.after)
  assert.equal(accepted.activeProtection.releaseId, sourceRelease)
  assert.equal(fs.existsSync(lock), false)
  assert.equal(fs.existsSync(orphan), true)
  calls = 0
  assert.throws(() => observeReleaseAssetProtection({ storeDirectory: store, state, readProtection: () => {
    calls += 1
    return calls === 1 ? protection : { ...protection, rolloutId: 'other-operation-2981' }
  } }), /identity changed/u)
  assert.equal(fs.existsSync(lock), false)
  calls = 0
  assert.throws(() => observeReleaseAssetProtection({ storeDirectory: store, state, readProtection: () => {
    calls += 1
    if (calls === 2) fs.appendFileSync(path.join(active, 'asset-manifest.json'), ' ')
    return protection
  } }), /asset bytes changed/u)
  assert.equal(fs.existsSync(lock), false)
  assert.throws(() => observeReleaseAssetProtection({ storeDirectory: store, state }), /durable identity reader/u)
  assert.throws(() => executeReleaseAssetGc({
    storeDirectory: store, state, apply: true, readOnlyProtection: () => protection
  }), /cannot authorize GC apply/u)
  assert.equal(fs.existsSync(orphan), true)
})


// Task-owned filesystem only: no host storage, runtime process, or admission is invoked.
test('read-only protection rejects physical manifest and owned storage lock replacement', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-readonly-gc-physical-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = path.join(directory, 'store');
    const active = path.join(store, 'releases', sourceRelease);
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
    writeManifest(active, sourceRelease, 'a');
    const fixture = deploymentFixture();
    const state = retention(sourceRelease);
    const protection = verifyArtifactGcActiveIdentity({ authority: readDestructiveOperationAuthority(),
        slotState: fixture.slots, rolloutState: fixture.rollout, retentionState: state });
    const manifest = path.join(active, 'asset-manifest.json');
    const lock = path.join(store, '.gc.lock');
    let calls = 0;
    assert.throws(() => observeReleaseAssetProtection({ storeDirectory: store, state, readProtection: () =>
    {
        if (++calls === 2)
        {
            const replacement = path.join(directory, 'replacement.json');
            fs.writeFileSync(replacement, fs.readFileSync(manifest));
            fs.renameSync(replacement, manifest);
        }
        return protection;
    } }), /asset bytes changed/u);
    assert.equal(fs.existsSync(lock), false);
    const hardlink = path.join(directory, 'manifest-link.json');
    fs.linkSync(manifest, hardlink);
    assert.throws(() => observeReleaseAssetProtection({ storeDirectory: store, state,
        readProtection: () => protection }), /single-link regular file/u);
    assert.equal(fs.existsSync(lock), false);
    fs.unlinkSync(hardlink);
    assert.throws(() => observeReleaseAssetProtection({ storeDirectory: store, state, readProtection: () =>
    {
        fs.appendFileSync(lock, 'changed lock record');
        return protection;
    } }), /storage lock physical identity changed/u);
    assert.equal(fs.existsSync(lock), false);
    assert.throws(() => observeReleaseAssetProtection({ storeDirectory: store, state, readProtection: () =>
    {
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, 'another task-owned collector');
        return protection;
    } }), /storage lock physical identity changed/u);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'another task-owned collector',
        'cleanup must preserve a replacement collector lock');
});

test('GC apply rejects stale protection, plan tamper, extra state, symlink and preserves all data before failure', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-active-gc-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = path.join(directory, 'store');
    const active = path.join(store, 'releases', sourceRelease);
    const previousRelease = '20260709010101-dddddddddddd';
    const previous = path.join(store, 'releases', previousRelease);
    const orphanRelease = '20260701010101-cccccccccccc';
    const orphan = path.join(store, 'releases', orphanRelease);
    const object = path.join(store, 'objects', 'c'.repeat(64));
    for (const target of [active, previous, orphan, object])
    {
        fs.mkdirSync(target, { recursive: true });
    }
    writeManifest(active, sourceRelease, 'a');
    writeManifest(previous, previousRelease, 'd');
    writeManifest(orphan, orphanRelease, 'c');
    const state = { ...retention(sourceRelease), previousReleaseId: previousRelease };
    const protection = {
        releaseId: sourceRelease, slot: 'blue', imageDigest: sourceDigest,
        deploymentGeneration: 1, rolloutId: 'deploy-release-2981'
    };
    // Keep the reviewed delete set stable before testing symlink refusal.
    fs.utimesSync(orphan, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const reviewedDryRun = executeReleaseAssetGc({ storeDirectory: store, state });
    assert.throws(() => executeReleaseAssetGc({
        storeDirectory: store, state, apply: true, activeProtection: protection,
        refreshProtection: () => ({ ...protection, rolloutId: 'other-operation-2981' }),
        reviewedDryRun
    }), /changed after GC planning/u);
    assert.equal(fs.existsSync(orphan), true);

    const plan = planReleaseAssetGc({ storeDirectory: store, state });
    const tampered = structuredClone(plan);
    const tamperedActive = tampered.releases.find(item => item.releaseId === sourceRelease);
    tamperedActive.action = 'delete';
    tamperedActive.protected = false;
    tamperedActive.reasons = [];
    assert.throws(() => verifyReleaseAssetGcPlan(tampered), /digest/u);
    assert.throws(() => normalizeGcState({ ...state, unknownIdentity: sourceRelease }), /closed exact/u);

    const external = path.join(directory, 'external');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(orphan, 'escape'));
    fs.utimesSync(orphan, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    assert.throws(() => executeReleaseAssetGc({
        storeDirectory: store, state, apply: true, activeProtection: protection,
        refreshProtection: () => protection,
        reviewedDryRun
    }), /symlink/u);
    assert.equal(fs.existsSync(active), true);
    assert.equal(fs.existsSync(orphan), true);

    fs.rmSync(path.join(orphan, 'escape'));
    const externalManifest = path.join(directory, 'external-manifest.json');
    fs.copyFileSync(path.join(active, 'asset-manifest.json'), externalManifest);
    fs.rmSync(path.join(active, 'asset-manifest.json'));
    fs.symlinkSync(externalManifest, path.join(active, 'asset-manifest.json'));
    assert.throws(() => planReleaseAssetGc({ storeDirectory: store, state }), /manifest.*non-symlink/u);

    const alias = path.join(directory, 'store-alias');
    fs.symlinkSync(store, alias);
    assert.throws(() => planReleaseAssetGc({ storeDirectory: alias, state }), /store root|symlink/u);
});

test('artifact GC CLI holds deployment and storage locks and deletes only an exact orphan plan', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-active-gc-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = path.join(directory, 'store');
    const orphanRelease = '20260701010101-cccccccccccc';
    for (const [releaseId, hash] of [[sourceRelease, 'a'], [targetRelease, 'b'], [orphanRelease, 'c']])
    {
        const release = path.join(store, 'releases', releaseId);
        fs.mkdirSync(release, { recursive: true });
        fs.mkdirSync(path.join(store, 'objects', hash.repeat(64)), { recursive: true });
        writeManifest(release, releaseId, hash);
    }
    fs.utimesSync(path.join(store, 'releases', orphanRelease), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const fixture = deploymentFixture();
    const slotState = path.join(directory, 'slots.json');
    const rolloutState = path.join(directory, 'rollout.json');
    const retentionState = path.join(directory, 'retention.json');
    const evidence = path.join(directory, 'gc-evidence.json');
    writeSlotStateAtomic(slotState, fixture.slots);
    writeRolloutStateAtomic(rolloutState, fixture.rollout);
    fs.writeFileSync(retentionState, `${JSON.stringify({
        ...retention(sourceRelease), previousReleaseId: targetRelease
    })}\n`);
    const reviewedDryRun = path.join(directory, 'gc-dry-run.json');
    const dryRun = spawnSync(process.execPath, [
        'tools/storage/gc-release-assets.mjs', '--dry-run', '--store', store,
        '--state', retentionState, '--out', reviewedDryRun
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const result = spawnSync(process.execPath, [
        'tools/storage/gc-release-assets.mjs', '--apply', '--store', store,
        '--state', retentionState, '--slot-state', slotState, '--rollout-state', rolloutState,
        '--reviewed-dry-run', reviewedDryRun,
        '--deployment-lock', path.join(directory, 'deployment.lock'), '--out', evidence
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    assert.equal(receipt.status, 'ok');
    assert.match(receipt.planSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(receipt.activeProtection.rolloutId, fixture.rollout.rolloutId);
    assert.equal(fs.existsSync(path.join(store, 'releases', sourceRelease)), true);
    assert.equal(fs.existsSync(path.join(store, 'releases', targetRelease)), true);
    assert.equal(fs.existsSync(path.join(store, 'releases', orphanRelease)), false);
});


// Manual diagnostic source controls own only their temporary fixture files and
// bounded Node/flock children. No production store, SDK, DB or container runs.
// SOURCE effects: existing manual-diagnostic owner; task-owned temporary files, Node/flock
// children bounded by 10 seconds and 1 MiB. No production storage, containers, DB, or SDK.
test('read-only protection CLI preserves original locks and closed current rollout byte bindings', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-readonly-gc-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = path.join(directory, 'store');
    const orphanRelease = '20260701010101-cccccccccccc';
    for (const [releaseId, hash] of [[sourceRelease, 'a'], [targetRelease, 'b'], [orphanRelease, 'c']])
    {
        const release = path.join(store, 'releases', releaseId);
        fs.mkdirSync(release, { recursive: true });
        fs.mkdirSync(path.join(store, 'objects', hash.repeat(64)), { recursive: true });
        writeManifest(release, releaseId, hash);
    }
    const fixture = deploymentFixture();
    const slotState = path.join(directory, 'slots.json');
    const rolloutState = path.join(directory, 'rollout.json');
    const retentionState = path.join(directory, 'retention.json');
    const deploymentLock = path.join(directory, 'deployment.lock');
    writeSlotStateAtomic(slotState, fixture.slots);
    writeRolloutStateAtomic(rolloutState, fixture.rollout);
    fs.writeFileSync(retentionState, `${JSON.stringify({ ...retention(sourceRelease), previousReleaseId: targetRelease })}\n`);
    const args = ['tools/storage/gc-release-assets.mjs', '--observe-protection', '--store', store,
        '--state', retentionState, '--slot-state', slotState, '--rollout-state', rolloutState,
        '--deployment-lock', deploymentLock];
    const execute = (extra = [], environment = {}) => spawnSync(process.execPath, [...args, ...extra], {
        cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256', ...environment }
    });
    const refused = (result, expected) =>
    {
        assert.equal(result.error, undefined, 'the actual CLI must settle without timeout');
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, expected);
        assert.equal(fs.existsSync(path.join(store, '.gc.lock')), false);
        assert.equal(fs.existsSync(path.join(store, 'releases', orphanRelease)), true);
    };
    const observed = execute();
    assert.equal(observed.status, 0, observed.stderr || observed.stdout);
    const value = JSON.parse(observed.stdout);
    assert.equal(value.schema, 'fsusblog.release-assets.protection-observation.v1');
    assert.equal(value.readOnly, true);
    assert.equal(value.qualificationEligible, false);
    assert.equal(value.gcEvidence.dryRun, true);
    assert.deepEqual(value.gcEvidence.before, value.gcEvidence.after);
    assert.equal(value.activeProtection.releaseId, sourceRelease);
    assert.equal(value.inputReferences.slotState.path, slotState);
    assert.match(value.inputReferences.slotState.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(fs.existsSync(path.join(store, '.gc.lock')), false);
    assert.equal(fs.existsSync(path.join(store, 'releases', orphanRelease)), true);
    const output = path.join(directory, 'observation.json');
    assert.equal(execute(['--out', output]).status, 0);
    const retainedOutput = fs.readFileSync(output);
    refused(execute(['--out', output]), /EEXIST/u);
    assert.deepEqual(fs.readFileSync(output), retainedOutput);
    const originalState = fs.readFileSync(slotState);
    refused(execute(['--out', slotState]), /EEXIST/u);
    assert.deepEqual(fs.readFileSync(slotState), originalState);
    refused(execute(['--out', path.join(store, 'observation.json')]), /outside the asset store/u);
    refused(execute(['--apply', '--dry-run']), /cannot be combined with apply/u);
    refused(execute(['--locked', '--lock-token', 'fake'], { FSUSBLOG_GC_LOCK_TOKEN: 'fake' }), /does not accept caller lock claims/u);
    for (const extra of [['--unknown-identity', 'accepted'], ['--slot-state', slotState]])
    {
        refused(execute(extra), /unknown or duplicate/u);
    }
    const descriptor = fs.openSync(deploymentLock, 'a');
    try
    {
        const held = spawnSync('flock', ['--nonblock', '3'], {
            stdio: ['ignore', 'pipe', 'pipe', descriptor], timeout: 10_000, maxBuffer: 1024 * 1024
        });
        assert.equal(held.status, 0);
        refused(execute(), /could not acquire the deployment lock/u);
    }
    finally { fs.closeSync(descriptor); }
    assert.equal(execute().status, 0, 'deployment descriptor must close on failure');
    fs.writeFileSync(path.join(store, '.gc.lock'), 'other task-owned collector');
    const storageContended = execute();
    assert.notEqual(storageContended.status, 0);
    assert.match(storageContended.stdout, /GC lock already exists/u);
    assert.equal(fs.readFileSync(path.join(store, '.gc.lock'), 'utf8'), 'other task-owned collector');
    fs.unlinkSync(path.join(store, '.gc.lock'));
    assert.equal(execute().status, 0, 'deployment lock must release after storage contention');
    const deploymentLink = path.join(directory, 'deployment-hardlink');
    fs.linkSync(deploymentLock, deploymentLink);
    refused(execute(), /deployment lock physical identity changed/u);
    fs.unlinkSync(deploymentLink);
    fs.unlinkSync(deploymentLock);
    fs.symlinkSync(deploymentLink, deploymentLock);
    refused(execute(), /ELOOP/u);
    fs.unlinkSync(deploymentLock);
    assert.equal(execute().status, 0, 'rejected physical lock inputs must release all descriptors');
    const forgedRollout = path.join(directory, 'forged-rollout.json');
    fs.writeFileSync(forgedRollout, JSON.stringify({ schema: 'fsusblog.release-rollout-evidence.v2', status: 'pass',
        rolloutId: fixture.rollout.rolloutId, source: fixture.rollout.source, target: fixture.rollout.target,
        stages: [], artifacts: {}, auxiliary: {} }));
    refused(execute(['--rollout-evidence', forgedRollout]), /canonical rollout evidence verification failed/u);
    refused(execute(['--schema-pair', forgedRollout]), /legacy schema-pair inputs are retired/u);
    refused(execute(['--current-schema-input', forgedRollout]), /requires live runtime observation/u);
    const current = createReleaseRolloutEvidenceFixture({ rolloutId: fixture.rollout.rolloutId,
        source: fixture.rollout.source, target: fixture.rollout.target });
    const data = { directory, stateFile: rolloutState, commandDirectory: path.join(directory, 'commands'),
        artifactDirectory: path.join(directory, 'artifacts') };
    current.advanceState(data, { includeFinalStage: true });
    const artifacts = current.writeArtifacts(data);
    const auxiliary = current.writeAuxiliary(data);
    const completeRollout = path.join(directory, 'complete-rollout.json');
    const finalized = spawnSync(process.execPath, ['tools/deployment/release-rollout-evidence.mjs', 'finalize',
        '--state', rolloutState, '--out', completeRollout,
        ...current.artifactArgs(artifacts), ...current.auxiliaryArgs(auxiliary)], {
        cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' }
    });
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const bound = execute(['--rollout-evidence', completeRollout]);
    assert.equal(bound.status, 0, bound.stderr || bound.stdout);
    assert.equal(JSON.parse(bound.stdout).rolloutObservation.verification.status, 'pass');
    const command = path.join(data.commandDirectory, 'candidate-readiness.json');
    fs.appendFileSync(command, ' ');
    refused(execute(['--rollout-evidence', completeRollout]), /canonical rollout evidence verification failed/u);
    const stateBytes = fs.readFileSync(slotState);
    const link = path.join(directory, 'slot-state-hardlink.json');
    fs.linkSync(slotState, link);
    refused(execute(), /single-link regular file/u);
    fs.unlinkSync(link);
    fs.unlinkSync(slotState);
    fs.writeFileSync(path.join(directory, 'actual-slot-state.json'), stateBytes);
    fs.symlinkSync(path.join(directory, 'actual-slot-state.json'), slotState);
    refused(execute(), /canonical physical file/u);
});

function deploymentFixture()
{
    const slots = createEmptySlotState('2026-07-11T00:00:00.000Z');
    recordSlotStart(slots, {
        slot: 'blue', releaseId: sourceRelease, imageRef: `registry.example/fsusblog@${sourceDigest}`,
        imageDigest: sourceDigest, startedAt: '2026-07-11T00:00:01.000Z'
    });
    setActiveSlot(slots, { slot: 'blue', kind: 'bootstrap', changedAt: '2026-07-11T00:00:02.000Z' });
    recordSlotStart(slots, {
        slot: 'green', releaseId: targetRelease, imageRef: `registry.example/fsusblog@${targetDigest}`,
        imageDigest: targetDigest, startedAt: '2026-07-11T00:00:03.000Z'
    });
    const rollout = createRolloutState({
      ...createCurrentRolloutFixtureBinding(),
        rolloutId: 'deploy-release-2981', manifestPath: '/tmp/release-2981.json',
        source: { slot: 'blue', releaseId: sourceRelease, imageDigest: sourceDigest, runtimeGeneration: 1 },
        target: { slot: 'green', releaseId: targetRelease, imageDigest: targetDigest, runtimeGeneration: 2 },
        createdAtUtc: '2026-07-11T00:00:04.000Z'
    });
    return { slots, rollout };
}

function observation(slots, slot)
{
    const record = slots.slots[slot];
    return {
        slot, exists: true, running: true, health: 'healthy', liveness: 'ok', readiness: 'ok',
        containerName: record.containerName, projectName: record.projectName, host: record.host, port: record.port,
        portBindings: [{ HostIp: '127.0.0.1', HostPort: String(record.port) }], loopbackOnly: true,
        identityMatchesSlot: true,
        release: {
            slot, releaseId: record.releaseId, commitSha: '0'.repeat(40), imageRef: record.imageRef,
            imageDigest: record.imageDigest, deploymentMode: 'production', deploymentGeneration: record.deploymentGeneration
        },
        startedAt: record.lastSuccessfulStartAt,
        persisted: { activeSlot: slots.activeSlot, slot, config: {}, record, lastTransition: slots.lastTransition }
    };
}

function retention(activeReleaseId)
{
    return {
        schema: 'fsusblog.release-assets.gc-state.v1', activeReleaseId, previousReleaseId: null,
        drainingReleaseIds: [], retentionReleaseIds: [], referencedReleaseIds: [], minimumRetainedReleaseCount: 2
    };
}

function writeManifest(directory, releaseId, hash)
{
    fs.writeFileSync(path.join(directory, 'asset-manifest.json'), `${JSON.stringify({
        schema: 'fsusblog.release-assets.v1', releaseId, slot: 'blue', frontendBuildId: releaseId,
        compatibilityFile: null,
        files: [{
            path: 'asset.js', sha256: `sha256:${hash.repeat(64)}`, bytes: 1,
            class: 'immutable-static', releaseUrl: `/release-assets/${releaseId}/asset.js`,
            cacheControl: 'public,max-age=31536000,immutable'
        }]
    })}\n`);
}
