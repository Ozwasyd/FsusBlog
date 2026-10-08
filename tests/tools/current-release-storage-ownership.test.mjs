/* eslint-disable import-x/no-relative-parent-imports -- Focused byte/planning controls exercise the sole existing storage owner. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalize } from '../../tools/fact-extractors/lib/canonicalize.mjs';
import { RELEASE_ID_CONTRACT } from '../../tools/release/release-id.mjs';
import { signReleaseManifest } from '../../tools/release/release-manifest-signature-contract.mjs';
import { deriveReleaseManifestContentDigest } from '../../tools/release/release-manifest.mjs';
import { CURRENT_STORAGE_OWNERSHIP_SCHEMA, normalizeCurrentStorageOwnership, planCurrentReleaseAssetGc,
    verifyCurrentReleaseAssetGcPlan, executeCurrentReleaseAssetGc, planCurrentReleaseRecovery } from '../../tools/storage/release-gc.mjs';

import { currentReleaseAssetsFixture } from './support/current-release-assets-fixture.mjs';

const digest = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const seal = value =>
{
    const unsigned = structuredClone(value);
    delete unsigned.contentDigest;
    return { ...unsigned, contentDigest: digest(canonicalize(unsigned)) };
};

function fixture(context)
{
    const source = currentReleaseAssetsFixture(context);
    const store = path.join(source.root, 'store');
    const releaseRoot = path.join(store, 'releases', source.options.manifest.releaseId);
    fs.mkdirSync(path.dirname(releaseRoot), { recursive: true });
    fs.cpSync(source.source, releaseRoot, { recursive: true });
    // Bind the actual task-owned store location in the original signed manifest.
    const input = source.options.manifest;
    const identity = structuredClone(input.identity);
    identity.frontend.assetManifest.reference = path.join(releaseRoot, 'asset-manifest.json');
    const moved = { ...input, identity };
    moved.contentDigest = deriveReleaseManifestContentDigest(moved);
    const manifest = signReleaseManifest(moved, source.privateKey);
    const receiptPath = path.join(source.root, 'nonqualifying-owner-bytes.json');
    const receiptBytes = Buffer.from('{"sourceFixture":true,"nativeQualification":false}');
    fs.writeFileSync(receiptPath, receiptBytes);
    const owner = { kind: 'active-current', candidateId: manifest.candidateId, manifestContentDigest: manifest.contentDigest,
        ownerId: 'control-active', state: 'owned', receipt: { reference: receiptPath, sha256: digest(receiptBytes) } };
    const entries = source.inventory.files.map(file => ({ path: `releases/${manifest.releaseId}/${file.path}`,
        sha256: file.sha256, bytes: file.bytes, owner }));
    const inventoryBytes = fs.readFileSync(identity.frontend.assetManifest.reference);
    entries.push({ path: `releases/${manifest.releaseId}/asset-manifest.json`, sha256: digest(inventoryBytes), bytes: inventoryBytes.length, owner });
    const ownership = seal({ schema: CURRENT_STORAGE_OWNERSHIP_SCHEMA,
        active: { candidateId: manifest.candidateId, manifestContentDigest: manifest.contentDigest,
            releaseId: manifest.releaseId, assetManifestSha256: identity.frontend.assetManifest.sha256 }, entries });
    const options = { ...source.options, manifest, storeDirectory: store, ownership, releaseIdContract: RELEASE_ID_CONTRACT };
    return { source, store, options, receiptPath };
}

function addFile(data, relativePath, kind, state = 'owned', candidateId = digest('candidate-control'))
{
    const bytes = Buffer.from(`source-owned:${relativePath}`);
    const absolute = path.join(data.store, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
    const entry = { path: relativePath, sha256: digest(bytes), bytes: bytes.length,
        owner: { ...data.options.ownership.entries[0].owner, kind, state, candidateId,
            manifestContentDigest: digest('other-manifest'), ownerId: 'control-operation' } };
    data.options.ownership.entries.push(entry);
    data.options.ownership = seal(data.options.ownership);
    return entry;
}

test('current GC protects exact active assets and shared content-addressed objects without compatibility holds', context =>
{
    const data = fixture(context);
    const file = data.options.ownership.entries.find(entry => entry.path.endsWith('/assets/current.js'));
    const objectRelative = `objects/${file.sha256.slice(7)}/assets/current.js`;
    const objectAbsolute = path.join(data.store, objectRelative);
    fs.mkdirSync(path.dirname(objectAbsolute), { recursive: true });
    fs.linkSync(path.join(data.store, file.path), objectAbsolute);
    data.options.ownership.entries.push({ ...file, path: objectRelative,
        owner: { ...file.owner, kind: 'obsolete', candidateId: digest('old') } });
    data.options.ownership = seal(data.options.ownership);
    const plan = planCurrentReleaseAssetGc(data.options);
    assert.ok(plan.artifacts.every(item => item.action === 'retain' && item.protectedActive));
    assert.equal(plan.deleteExecutionEligible, false);
    assert.deepEqual(verifyCurrentReleaseAssetGcPlan(plan, data.options), plan);
    for (const key of ['previousReleaseId', 'drainingReleaseIds', 'minimumRetainedReleaseCount', 'retentionReleaseIds', 'graceDeadline'])
    {
        assert.equal(canonicalize(plan).includes(key), false);
    }
});

test('closed current ownership rejects missing ambiguous active, seven-day/version-count reasons and unknown owner kind', context =>
{
    const data = fixture(context);
    for (const mutate of [value =>
    {
        value.active.candidateId = null;
    }, value =>
    {
        value.active.releaseId = 'latest';
    },
    value =>
    {
        value.minimumRetainedReleaseCount = 2;
    }, value =>
    {
        value.graceDeadline = '2026-10-15';
    },
    value =>
    {
        value.entries[0].owner.kind = 'old-client';
    }, value =>
    {
        value.entries[0].owner.previousClient = true;
    }])
    {
        const changed = structuredClone(data.options.ownership);
        mutate(changed);
        assert.throws(() => normalizeCurrentStorageOwnership(seal(changed)), /current storage|safe immutable/u);
    }
    const mismatch = structuredClone(data.options.ownership);
    mismatch.active.candidateId = digest('wrong');
    assert.throws(() => planCurrentReleaseAssetGc({ ...data.options, ownership: seal(mismatch) }), /exact signed manifest/u);
});

test('unfinished candidate, operation, backup, shared and user ownership conservatively retain artifacts', context =>
{
    const data = fixture(context);
    addFile(data, 'staging/current-task/part.js', 'current-operation', 'running');
    addFile(data, 'releases/20260710010101-aaaaaaaaaaaa/candidate.js', 'current-candidate', 'prepared');
    addFile(data, 'backups/current-backup/backup.bin', 'backup-owned');
    addFile(data, 'objects/shared/owned.bin', 'shared');
    addFile(data, 'objects/user/owned.bin', 'user');
    const plan = planCurrentReleaseAssetGc(data.options);
    assert.ok(plan.artifacts.every(item => item.action === 'retain'));
    assert.ok(plan.occupation.backup > 0 && plan.occupation.operation > 0 && plan.occupation.shared > 0 && plan.occupation.user > 0);
    assert.throws(() => executeCurrentReleaseAssetGc(plan, data.options), /native_storage_ownership_bridge_unconfigured/u);
    assert.equal(fs.existsSync(path.join(data.store, 'backups/current-backup/backup.bin')), true);
});

test('terminal failed cleanup and obsolete assets select only exact owned files and old directory/image never grants rollback', context =>
{
    const data = fixture(context);
    const failed = addFile(data, 'staging/failed-task/part.js', 'failed-candidate', 'failed');
    addFile(data, 'releases/20260710010101-aaaaaaaaaaaa/obsolete.js', 'obsolete');
    const plan = planCurrentReleaseAssetGc(data.options);
    assert.deepEqual(plan.artifacts.filter(item => item.action === 'delete').map(item => item.path).sort(),
        ['releases/20260710010101-aaaaaaaaaaaa/obsolete.js', 'staging/failed-task/part.js']);
    // Same candidate was deliberately assigned another owned obsolete path:
    // the discard operation must reject that broader ownership, never guess.
    assert.throws(() => planCurrentReleaseRecovery('discard-unactivated-candidate', data.options.ownership,
        failed.owner.candidateId), /candidate-only ownership/u);
});

test('unactivated discard is exact-candidate only; active image rollback and unqualified backup restore fail closed', context =>
{
    const data = fixture(context);
    const failed = addFile(data, 'staging/failed-task/part.js', 'failed-candidate', 'failed');
    const recovery = planCurrentReleaseRecovery('discard-unactivated-candidate', data.options.ownership, failed.owner.candidateId);
    assert.deepEqual(recovery.cleanupPaths, [failed.path]);
    assert.deepEqual(recovery.activeUnchanged, data.options.ownership.active);
    assert.equal(recovery.executionEligible, false);
    assert.throws(() => planCurrentReleaseRecovery('discard-unactivated-candidate', data.options.ownership,
        data.options.manifest.candidateId), /active candidate/u);
    assert.throws(() => planCurrentReleaseRecovery('old-image-restart', data.options.ownership, failed.owner.candidateId), /rollback is forbidden/u);
    assert.throws(() => planCurrentReleaseRecovery('verified-backup-restore', data.options.ownership, failed.owner.candidateId), /native_verified_backup/u);
});

test('unknown user file, symlink, root alias and external hardlink block the entire plan', context =>
{
    const data = fixture(context);
    const extra = path.join(data.store, 'user-data.txt');
    fs.writeFileSync(extra, 'do not delete');
    assert.throws(() => planCurrentReleaseAssetGc(data.options), /unknown-owned root/u);
    fs.rmSync(extra);
    const symlink = path.join(data.store, 'releases/unknown-link');
    fs.symlinkSync(data.source.source, symlink);
    assert.throws(() => planCurrentReleaseAssetGc(data.options), /symlink/u);
    fs.rmSync(symlink);
    const first = data.options.ownership.entries[0];
    const outside = path.join(data.source.root, 'outside-shared-link');
    fs.linkSync(path.join(data.store, first.path), outside);
    assert.throws(() => planCurrentReleaseAssetGc(data.options), /external hardlink/u);
    fs.rmSync(outside);
    const alias = path.join(data.source.root, 'store-alias');
    fs.symlinkSync(data.store, alias);
    assert.throws(() => planCurrentReleaseAssetGc({ ...data.options, storeDirectory: alias }), /exact signed manifest|symlink/u);
});

test('stale plan, ownership/receipt/hash tamper and unknown extra file refuse independent current verification', context =>
{
    const data = fixture(context);
    addFile(data, 'staging/obsolete/part.bin', 'obsolete');
    const plan = planCurrentReleaseAssetGc(data.options);
    assert.throws(() =>
    {
        plan.artifacts[0].action = 'delete';
    }, TypeError);
    const changed = structuredClone(plan);
    changed.artifacts[0].action = 'delete';
    assert.throws(() => verifyCurrentReleaseAssetGcPlan(seal(changed), data.options), /closure mismatch/u);
    fs.writeFileSync(data.receiptPath, 'tampered owner bytes');
    assert.throws(() => verifyCurrentReleaseAssetGcPlan(plan, data.options), /receipt byte binding/u);
});

test('obsolete release count increases eligible bytes without increasing protected current occupation', context =>
{
    const data = fixture(context);
    const before = planCurrentReleaseAssetGc(data.options);
    for (let index = 0; index < 10; index++)
    {
        addFile(data, `staging/obsolete-${index}/part.bin`, 'obsolete');
    }
    const after = planCurrentReleaseAssetGc(data.options);
    assert.equal(after.occupation.active, before.occupation.active);
    assert.ok(after.occupation.obsolete > 0);
    assert.equal(after.artifacts.filter(item => item.action === 'delete').length, 10);
});

test('current CLI requires pinned explicit inputs, emits only a non-executing plan and refuses apply before deletion', context =>
{
    const data = fixture(context);
    const obsolete = addFile(data, 'staging/obsolete-control/part.bin', 'obsolete');
    const manifestPath = path.join(data.source.root, 'signed-manifest.json');
    const ownershipPath = path.join(data.source.root, 'current-ownership.json');
    const manifestBytes = Buffer.from(canonicalize(data.options.manifest));
    const ownershipBytes = Buffer.from(canonicalize(data.options.ownership));
    fs.writeFileSync(manifestPath, manifestBytes);
    fs.writeFileSync(ownershipPath, ownershipBytes);
    const arguments_ = [path.resolve(import.meta.dirname, '../../tools/storage/gc-release-assets.mjs'),
        '--ownership', ownershipPath, '--ownership-sha256', digest(ownershipBytes),
        '--release-manifest', manifestPath, '--release-manifest-sha256', digest(manifestBytes),
        '--trust-policy', data.options.trustPolicyReference, '--trust-policy-sha256', data.options.trustPolicySha256,
        '--store', data.store];
    const planned = spawnSync(process.execPath, arguments_, { encoding: 'utf8' });
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.deleteExecutionEligible, false);
    assert.ok(plan.artifacts.some(entry => entry.path === obsolete.path && entry.action === 'delete'));
    const applied = spawnSync(process.execPath, [...arguments_, '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 1);
    assert.match(applied.stdout, /native_storage_ownership_bridge_unconfigured/u);
    assert.equal(fs.existsSync(path.join(data.store, obsolete.path)), true);
    const drift = [...arguments_];
    drift[drift.indexOf('--ownership-sha256') + 1] = digest('different');
    const rejected = spawnSync(process.execPath, drift, { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /digest mismatch/u);
});

test('exact filesystem closure rejects newly added files, disappeared candidates and changed owned bytes', context =>
{
    const data = fixture(context);
    const obsolete = addFile(data, 'staging/obsolete-control/part.bin', 'obsolete');
    const plan = planCurrentReleaseAssetGc(data.options);
    const extra = path.join(data.store, 'staging/another-run.bin');
    fs.writeFileSync(extra, 'another run');
    assert.throws(() => verifyCurrentReleaseAssetGcPlan(plan, data.options), /exactly own every/u);
    fs.rmSync(extra);
    fs.writeFileSync(path.join(data.store, obsolete.path), 'different bytes');
    assert.throws(() => verifyCurrentReleaseAssetGcPlan(plan, data.options), /hash\/size drift/u);
    fs.rmSync(path.join(data.store, obsolete.path));
    assert.throws(() => verifyCurrentReleaseAssetGcPlan(plan, data.options), /exactly own every/u);
});

test('ownership reseal cannot hide actual active byte drift after independent artifact verification', context =>
{
    const data = fixture(context);
    const active = data.options.ownership.entries.find(entry => entry.path.endsWith('/assets/current.js'));
    const absolute = path.join(data.store, active.path);
    const verifiedBytes = fs.readFileSync(absolute);
    const readBytes = data.options.readBytes;
    data.options.readBytes = reference => reference === absolute ? verifiedBytes : readBytes(reference);
    const changed = Buffer.from('changed after artifact verification');
    fs.writeFileSync(absolute, changed);
    active.sha256 = digest(changed);
    active.bytes = changed.length;
    data.options.ownership = seal(data.options.ownership);
    assert.throws(() => planCurrentReleaseAssetGc(data.options), /filesystem asset differs from the signed inventory/u);
});
