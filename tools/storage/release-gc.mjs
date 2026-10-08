import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Reuse the release authority's canonical bytes and artifact verification.
// eslint-disable-next-line import-x/no-relative-parent-imports
import { canonicalize } from '../fact-extractors/lib/canonicalize.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports
import { verifyReleaseManifestArtifacts } from '../release/release-manifest-signature-contract.mjs';

import { normalizeReleaseId, sha256File, writeJsonAtomic } from './release-assets.mjs';

export const RELEASE_GC_STATE_SCHEMA = 'fsusblog.release-assets.gc-state.v1';
export const RELEASE_GC_EVIDENCE_SCHEMA = 'fsusblog.release-assets.gc-evidence.v1';
export const RELEASE_GC_PLAN_SCHEMA = 'fsusblog.release-assets.gc-plan.v1';
export const CURRENT_STORAGE_OWNERSHIP_SCHEMA = 'fsusblog.release-assets.storage-ownership.v2';
export const CURRENT_STORAGE_GC_PLAN_SCHEMA = 'fsusblog.release-assets.gc-plan.v2';

const currentStorageDigest = value => `sha256:${crypto.createHash('sha256').update(canonicalize(value)).digest('hex')}`;
const currentDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const storageOwnerKinds = new Set(['active-current', 'current-candidate', 'current-operation',
    'backup-owned', 'failed-candidate', 'obsolete', 'shared', 'user']);
function freezeCurrentStoragePlan(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freezeCurrentStoragePlan);
        Object.freeze(value);
    }
    return value;
}

// The current version lives in the existing GC owner. Its byte-bound planning
// surface cannot replace durable native activation/backup/deletion admission.
export function normalizeCurrentStorageOwnership(value)
{
    assertExactFields(value, ['schema', 'active', 'entries', 'contentDigest'], 'current storage ownership');
    if (value.schema !== CURRENT_STORAGE_OWNERSHIP_SCHEMA || !Array.isArray(value.entries) || value.entries.length > 100000)
    {
        throw new Error('current storage ownership requires the closed current registry');
    }
    assertExactFields(value.active, ['candidateId', 'manifestContentDigest', 'releaseId', 'assetManifestSha256'], 'current storage active identity');
    normalizeReleaseId(value.active.releaseId);
    if (![value.active.candidateId, value.active.manifestContentDigest, value.active.assetManifestSha256].every(currentDigest))
    {
        throw new Error('current storage active identity is missing or ambiguous');
    }
    const seen = new Set();
    for (const entry of value.entries)
    {
        assertExactFields(entry, ['path', 'sha256', 'bytes', 'owner'], 'current storage entry');
        if (typeof entry.path !== 'string' || !/^(?:releases|objects|staging|backups)\/[A-Za-z0-9._/-]+$/u.test(entry.path)
            || entry.path.split('/').some(part => !part || ['.', '..', 'latest', 'previous', 'stable'].includes(part))
            || seen.has(entry.path) || !currentDigest(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
        {
            throw new Error('current storage entry path/hash/size is invalid or duplicated');
        }
        seen.add(entry.path);
        const owner = entry.owner;
        assertExactFields(owner, ['kind', 'candidateId', 'manifestContentDigest', 'ownerId', 'state', 'receipt'], 'current storage owner');
        if (!storageOwnerKinds.has(owner.kind) || !currentDigest(owner.candidateId) || !currentDigest(owner.manifestContentDigest)
            || typeof owner.ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(owner.ownerId)
            || !['prepared', 'running', 'completed', 'failed', 'abandoned', 'owned'].includes(owner.state))
        {
            throw new Error('current storage owner identity/state is invalid');
        }
        if (owner.kind === 'failed-candidate' && !['failed', 'abandoned'].includes(owner.state)
            || owner.kind === 'obsolete' && owner.state !== 'owned')
        {
            throw new Error('current storage terminal cleanup ownership is inconsistent');
        }
        assertExactFields(owner.receipt, ['reference', 'sha256'], 'current storage owner receipt');
        if (typeof owner.receipt.reference !== 'string' || !path.isAbsolute(owner.receipt.reference)
            || path.resolve(owner.receipt.reference) !== owner.receipt.reference
            || owner.receipt.reference.split(path.sep).some(part => ['latest', 'previous', 'stable'].includes(part))
            || !currentDigest(owner.receipt.sha256))
        {
            throw new Error('current storage requires explicit owner receipt reference/digest');
        }
    }
    const { contentDigest, ...payload } = value;
    if (currentStorageDigest(payload) !== contentDigest)
    {
        throw new Error('current storage ownership content seal mismatch');
    }
    return structuredClone(value);
}

function currentStorageFiles(store)
{
    assertSafeStoreRoot(store);
    const rows = [];
    const visit = directory =>
    {
        for (const name of fs.readdirSync(directory).sort())
        {
            const absolute = path.join(directory, name);
            const metadata = fs.lstatSync(absolute, { bigint: true });
            if (metadata.isSymbolicLink() || fs.realpathSync(absolute) !== absolute)
            {
                throw new Error('current storage contains a symlink or noncanonical path');
            }
            if (metadata.isDirectory())
            {
                visit(absolute);
            }
            else if (metadata.isFile())
            {
                rows.push({ path: path.relative(store, absolute).split(path.sep).join('/'), bytes: Number(metadata.size),
                    sha256: sha256File(absolute), inode: `${metadata.dev}:${metadata.ino}`, links: Number(metadata.nlink) });
            }
            else
            {
                throw new Error('current storage contains an unsupported entry');
            }
        }
    };
    for (const name of fs.readdirSync(store).sort())
    {
        const absolute = path.join(store, name);
        if (!['releases', 'objects', 'staging', 'backups'].includes(name) || !fs.lstatSync(absolute).isDirectory())
        {
            throw new Error(`current storage contains unknown-owned root entry: ${name}`);
        }
        visit(absolute);
    }
    const counts = new Map();
    for (const row of rows)
    {
        counts.set(row.inode, (counts.get(row.inode) ?? 0) + 1);
    }
    if (rows.some(row => row.links !== counts.get(row.inode)))
    {
        throw new Error('current storage file has an unknown/shared external hardlink reference');
    }
    return rows;
}

export function planCurrentReleaseAssetGc(options)
{
    const { storeDirectory, ownership, manifest, readBytes } = options;
    const store = path.resolve(storeDirectory);
    const registry = normalizeCurrentStorageOwnership(ownership);
    const verified = verifyReleaseManifestArtifacts(options);
    const active = registry.active;
    if (active.candidateId !== manifest.candidateId || active.manifestContentDigest !== manifest.contentDigest
        || active.releaseId !== manifest.releaseId || active.assetManifestSha256 !== manifest.identity.frontend.assetManifest.sha256
        || manifest.identity.frontend.assetManifest.reference !== path.join(store, 'releases', manifest.releaseId, 'asset-manifest.json'))
    {
        throw new Error('current storage active identity does not match the exact signed manifest in this store');
    }
    const files = currentStorageFiles(store);
    const byPath = new Map(registry.entries.map(entry => [entry.path, entry]));
    const filesByPath = new Map(files.map(file => [file.path, file]));
    if (byPath.size !== files.length || files.some(file => !byPath.has(file.path)))
    {
        throw new Error('current storage registry must exactly own every filesystem artifact; unknown/extra refs block GC');
    }
    for (const asset of verified.currentAssets)
    {
        const actual = filesByPath.get(`releases/${active.releaseId}/${asset.path}`);
        if (!actual || actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes)
        {
            throw new Error('current filesystem asset differs from the signed inventory bytes');
        }
    }
    for (const artifact of verified.artifacts)
    {
        const relative = path.relative(store, artifact.reference).split(path.sep).join('/');
        const actual = filesByPath.get(relative);
        if (actual && (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes))
        {
            throw new Error('current filesystem artifact differs from the verified manifest bytes');
        }
    }
    const activeHashes = new Set(verified.currentAssets.map(asset => asset.sha256));
    activeHashes.add(active.assetManifestSha256);
    const activePaths = new Set(verified.currentAssets.map(asset => `releases/${active.releaseId}/${asset.path}`));
    activePaths.add(`releases/${active.releaseId}/asset-manifest.json`);
    for (const artifact of verified.artifacts)
    {
        const relative = path.relative(store, artifact.reference);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
        {
            activePaths.add(relative.split(path.sep).join('/'));
            activeHashes.add(artifact.sha256);
        }
    }
    for (const protectedPath of activePaths)
    {
        if (!byPath.has(protectedPath))
        {
            throw new Error('current active asset or manifest reference is missing from storage ownership');
        }
    }
    const ownerBytes = new Map();
    const occupation = { active: 0, candidate: 0, operation: 0, backup: 0, shared: 0, user: 0, obsolete: 0 };
    const artifacts = files.map(file =>
    {
        const entry = byPath.get(file.path);
        if (file.sha256 !== entry.sha256 || file.bytes !== entry.bytes)
        {
            throw new Error('current storage artifact hash/size drift');
        }
        const receipt = entry.owner.receipt;
        if (!ownerBytes.has(receipt.reference))
        {
            const bytes = readBytes(receipt.reference, receipt.sha256);
            if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024
                || `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== receipt.sha256)
            {
                throw new Error('current storage owner receipt byte binding mismatch');
            }
            ownerBytes.set(receipt.reference, { bytes, sha256: receipt.sha256 });
        }
        if (ownerBytes.get(receipt.reference).sha256 !== receipt.sha256)
        {
            throw new Error('ambiguous current storage owner receipt binding');
        }
        // Receipt byte ownership conservatively retains operations/backups. It
        // never qualifies their native state, a backup restore or delete execution.
        const protectedActive = activePaths.has(file.path) || activeHashes.has(file.sha256)
            || file.path.startsWith(`releases/${active.releaseId}/`)
            || entry.owner.candidateId === active.candidateId;
        let category;
        let reason;
        let action = 'retain';
        if (protectedActive)
        {
            category = 'active';
            reason = 'exact-current-active';
        }
        else if (['shared', 'user'].includes(entry.owner.kind))
        {
            category = entry.owner.kind;
            reason = `${category}-owned`;
        }
        else if (entry.owner.kind === 'backup-owned')
        {
            category = 'backup';
            reason = 'explicit-backup-owner';
        }
        else if (['current-candidate', 'current-operation'].includes(entry.owner.kind))
        {
            category = entry.owner.kind === 'current-candidate' ? 'candidate' : 'operation';
            reason = 'explicit-operation-owner';
        }
        else if (['failed-candidate', 'obsolete'].includes(entry.owner.kind))
        {
            category = 'obsolete';
            reason = entry.owner.kind === 'failed-candidate' ? 'terminal-candidate-only' : 'explicit-obsolete-owner';
            action = 'delete';
        }
        else
        {
            throw new Error('unrecognized active owner cannot become obsolete');
        }
        occupation[category] += file.bytes;
        return { path: file.path, sha256: file.sha256, bytes: file.bytes, owner: entry.owner,
            activeCandidateId: active.candidateId, protectedActive, action, reason };
    });
    const payload = { schema: CURRENT_STORAGE_GC_PLAN_SCHEMA, storeDirectory: store,
        ownershipContentDigest: registry.contentDigest, active, artifacts, occupation,
        deleteExecutionEligible: false, recovery: 'native-storage-ownership-bridge-unconfigured' };
    return freezeCurrentStoragePlan({ ...payload, contentDigest: currentStorageDigest(payload) });
}

export function verifyCurrentReleaseAssetGcPlan(plan, options)
{
    const expected = planCurrentReleaseAssetGc(options);
    if (canonicalize(plan) !== canonicalize(expected))
    {
        throw new Error('current GC plan/ownership/active/filesystem closure mismatch');
    }
    return expected;
}

export function executeCurrentReleaseAssetGc(plan, options)
{
    verifyCurrentReleaseAssetGcPlan(plan, options);
    // Original physical owner must provide durable active/operation observation,
    // locked crash checkpoints and native backup qualification before cutover.
    throw new Error('native_storage_ownership_bridge_unconfigured');
}

export function planCurrentReleaseRecovery(mode, ownership, candidateId)
{
    const registry = normalizeCurrentStorageOwnership(ownership);
    if (!currentDigest(candidateId) || candidateId === registry.active.candidateId)
    {
        throw new Error('current recovery cannot discard or restart the active candidate');
    }
    if (mode === 'discard-unactivated-candidate')
    {
        const entries = registry.entries.filter(entry => entry.owner.candidateId === candidateId);
        if (entries.length === 0 || entries.some(entry => entry.owner.kind !== 'failed-candidate'
            || !['failed', 'abandoned'].includes(entry.owner.state)))
        {
            throw new Error('current recovery requires exact terminal unactivated candidate-only ownership');
        }
        return { mode, candidateId, activeUnchanged: registry.active, cleanupPaths: entries.map(entry => entry.path).sort(), executionEligible: false };
    }
    if (mode === 'forward-fix')
    {
        return { mode, candidateId, executionEligible: false, requirement: 'new-exact-current-admission' };
    }
    if (mode === 'verified-backup-restore')
    {
        throw new Error('native_verified_backup_restore_bridge_unconfigured');
    }
    throw new Error('old-directory/image/current-schema rollback is forbidden');
}

const GC_STATE_FIELDS = [
    'activeReleaseId', 'drainingReleaseIds', 'minimumRetainedReleaseCount', 'previousReleaseId',
    'referencedReleaseIds', 'retentionReleaseIds', 'schema'
];
const GC_PLAN_FIELDS = ['objects', 'planSha256', 'protectedManifestBindings', 'releases', 'schema', 'state', 'storeDirectory'];
const GC_EVIDENCE_FIELDS = [
    'activeProtection', 'after', 'before', 'dryRun', 'errors', 'lockFile',
    'objectActions', 'plan', 'planSha256', 'protectedReleaseIds', 'releaseActions',
    'schema', 'status', 'storeDirectory'
];
const GC_PROTECTION_REASONS = new Set([
    'active',
    'draining',
    'external-reference',
    'minimum-retention-count',
    'previous',
    'retention-window'
]);

export function normalizeGcState(state)
{
    if (!state || typeof state !== 'object' || Array.isArray(state))
    {
        throw new Error('GC state must be an object');
    }
    assertExactFields(state, GC_STATE_FIELDS, 'GC state');
    if (state.schema !== RELEASE_GC_STATE_SCHEMA)
    {
        throw new Error(`GC state schema must be ${RELEASE_GC_STATE_SCHEMA}`);
    }
    const activeReleaseId = normalizeReleaseId(state.activeReleaseId);
    const previousReleaseId = state.previousReleaseId === null ? null : normalizeReleaseId(state.previousReleaseId);
    const drainingReleaseIds = normalizeReleaseIds(state.drainingReleaseIds, 'drainingReleaseIds');
    const retentionReleaseIds = normalizeReleaseIds(state.retentionReleaseIds, 'retentionReleaseIds');
    const referencedReleaseIds = normalizeReleaseIds(state.referencedReleaseIds, 'referencedReleaseIds');
    const minimumRetainedReleaseCount = state.minimumRetainedReleaseCount ?? 2;
    if (!Number.isSafeInteger(minimumRetainedReleaseCount) || minimumRetainedReleaseCount < 2 || minimumRetainedReleaseCount > 100)
    {
        throw new Error('minimumRetainedReleaseCount must be an integer from 2 through 100');
    }
    return {
        schema: RELEASE_GC_STATE_SCHEMA,
        activeReleaseId,
        previousReleaseId,
        drainingReleaseIds,
        retentionReleaseIds,
        referencedReleaseIds,
        minimumRetainedReleaseCount
    };
}

export function planReleaseAssetGc({ storeDirectory, state })
{
    const store = path.resolve(storeDirectory);
    assertSafeStoreRoot(store);
    const normalizedState = normalizeGcState(state);
    const releaseRoot = path.join(store, 'releases');
    const releaseIds = listDirectories(releaseRoot).map(normalizeReleaseId);
    if (!releaseIds.includes(normalizedState.activeReleaseId))
    {
        throw new Error(`active release assets are missing: ${normalizedState.activeReleaseId}`);
    }
    if (normalizedState.previousReleaseId && !releaseIds.includes(normalizedState.previousReleaseId))
    {
        throw new Error(`previous release assets are missing: ${normalizedState.previousReleaseId}`);
    }
    for (const [label, protectedReleaseIds] of [
        ['draining', normalizedState.drainingReleaseIds],
        ['retention', normalizedState.retentionReleaseIds],
        ['referenced', normalizedState.referencedReleaseIds]
    ])
    {
        for (const releaseId of protectedReleaseIds)
        {
            if (!releaseIds.includes(releaseId))
            {
                throw new Error(`${label} release assets are missing: ${releaseId}`);
            }
        }
    }

    const protectedReasons = new Map();
    protect(protectedReasons, normalizedState.activeReleaseId, 'active');
    if (normalizedState.previousReleaseId)
    {
        protect(protectedReasons, normalizedState.previousReleaseId, 'previous');
    }
    for (const releaseId of normalizedState.drainingReleaseIds)
    {
        protect(protectedReasons, releaseId, 'draining');
    }
    for (const releaseId of normalizedState.retentionReleaseIds)
    {
        protect(protectedReasons, releaseId, 'retention-window');
    }
    for (const releaseId of normalizedState.referencedReleaseIds)
    {
        protect(protectedReasons, releaseId, 'external-reference');
    }

    const newest = releaseIds
        .map(releaseId => ({ releaseId, mtimeMs: fs.statSync(path.join(releaseRoot, releaseId)).mtimeMs }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs || right.releaseId.localeCompare(left.releaseId, 'en'))
        .slice(0, normalizedState.minimumRetainedReleaseCount);
    for (const { releaseId } of newest)
    {
        protect(protectedReasons, releaseId, 'minimum-retention-count');
    }

    const releases = releaseIds.sort((left, right) => left.localeCompare(right, 'en')).map(releaseId => ({
        releaseId,
        protected: protectedReasons.has(releaseId),
        reasons: [...(protectedReasons.get(releaseId) ?? [])].sort(),
        action: protectedReasons.has(releaseId) ? 'retain' : 'delete'
    }));

    const protectedManifestBindings = [];
    const retainedObjectHashes = new Set();
    for (const release of releases.filter(release => release.protected))
    {
        const { manifest, manifestSha256 } = readAssetManifest(path.join(releaseRoot, release.releaseId));
        protectedManifestBindings.push({ releaseId: release.releaseId, assetManifestSha256: manifestSha256 });
        for (const file of manifest.files)
        {
            retainedObjectHashes.add(file.sha256.slice('sha256:'.length));
        }
    }
    const objects = listDirectories(path.join(store, 'objects'))
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map(sha256 =>
        {
            if (!/^[0-9a-f]{64}$/u.test(sha256))
            {
                throw new Error(`unknown-owned object directory is not a canonical digest: ${sha256}`);
            }
            return {
                sha256: `sha256:${sha256}`,
                protected: retainedObjectHashes.has(sha256),
                action: retainedObjectHashes.has(sha256) ? 'retain' : 'delete'
            };
        });

    const payload = {
        schema: RELEASE_GC_PLAN_SCHEMA,
        storeDirectory: store,
        state: normalizedState,
        protectedManifestBindings,
        releases,
        objects
    };
    return Object.freeze({ ...payload, planSha256: digestJson(payload) });
}

export function verifyReleaseAssetGcPlan(plan)
{
    if (!plan || typeof plan !== 'object' || Array.isArray(plan))
    {
        throw new Error('GC plan must be an object');
    }
    assertExactFields(plan, GC_PLAN_FIELDS, 'GC plan');
    if (plan.schema !== RELEASE_GC_PLAN_SCHEMA)
    {
        throw new Error(`GC plan schema must be ${RELEASE_GC_PLAN_SCHEMA}`);
    }
    const normalized = {
        schema: RELEASE_GC_PLAN_SCHEMA,
        storeDirectory: path.resolve(plan.storeDirectory),
        state: normalizeGcState(plan.state),
        protectedManifestBindings: normalizeProtectedManifestBindings(plan.protectedManifestBindings),
        releases: normalizeReleaseActions(plan.releases),
        objects: normalizeObjectActions(plan.objects),
        planSha256: String(plan.planSha256 ?? '')
    };
    const { planSha256, ...payload } = normalized;
    if (!/^sha256:[0-9a-f]{64}$/u.test(planSha256))
    {
        throw new Error('GC plan digest must be a lowercase sha256 digest');
    }
    if (digestJson(payload) !== planSha256)
    {
        throw new Error('GC plan digest does not match its closed content');
    }
    if (JSON.stringify(normalized.protectedManifestBindings.map(entry => entry.releaseId))
      !== JSON.stringify(normalized.releases.filter(release => release.protected).map(release => release.releaseId)))
    {
        throw new Error('GC protected manifest bindings must match the protected release set');
    }
    assertSafeStoreRoot(normalized.storeDirectory);
    return Object.freeze(normalized);
}

export function executeReleaseAssetGc({
    storeDirectory,
    state,
    apply = false,
    evidenceFile = null,
    lockFile = null,
    activeProtection = null,
    refreshProtection = null,
    reviewedDryRun = null
})
{
    const store = path.resolve(storeDirectory);
    const resolvedLockFile = path.resolve(lockFile ?? path.join(store, '.gc.lock'));
    fs.mkdirSync(path.dirname(resolvedLockFile), { recursive: true, mode: 0o700 });
    let lockDescriptor;
    try
    {
        lockDescriptor = fs.openSync(resolvedLockFile, 'wx', 0o600);
        fs.writeFileSync(lockDescriptor, `${JSON.stringify({ schema: 'fsusblog.release-assets.gc-lock.v1', pid: process.pid, token: crypto.randomUUID() })}\n`);
    }
    catch (error)
    {
        if (error?.code === 'EEXIST')
        {
            throw new Error(`release asset GC lock already exists: ${resolvedLockFile}`);
        }
        throw error;
    }

    try
    {
        const plan = verifyReleaseAssetGcPlan(planReleaseAssetGc({ storeDirectory: store, state }));
        const reviewed = apply ? normalizeReviewedDryRunEvidence(reviewedDryRun, store) : null;
        const before = snapshotStore(store);
        if (apply)
        {
            assertReviewedPlanMatches(reviewed.plan, plan);
            const protection = normalizeActiveProtection(activeProtection);
            if (protection.releaseId !== plan.state.activeReleaseId)
            {
                throw new Error('GC active protection does not match the planned active release');
            }
            if (typeof refreshProtection !== 'function')
            {
                throw new Error('GC apply requires a durable active identity refresh');
            }
            const refreshed = normalizeActiveProtection(refreshProtection());
            if (JSON.stringify(refreshed) !== JSON.stringify(protection))
            {
                throw new Error('durable active identity changed after GC planning');
            }
            verifyReleaseAssetGcPlan(plan);
            const releaseTargets = plan.releases.filter(release => release.action === 'delete')
                .map(release => path.join(store, 'releases', release.releaseId));
            const objectTargets = plan.objects.filter(object => object.action === 'delete')
                .map(object => path.join(store, 'objects', object.sha256.slice('sha256:'.length)));
            for (const target of releaseTargets)
            {
                assertDeletionTarget(store, target, protection.releaseId);
            }
            for (const target of objectTargets)
            {
                assertDeletionTarget(store, target, null);
            }
            for (const target of [...releaseTargets, ...objectTargets])
            {
                fs.rmSync(target, { recursive: true, force: false });
            }
        }
        const after = snapshotStore(store);
        const evidence = {
            schema: RELEASE_GC_EVIDENCE_SCHEMA,
            status: apply ? 'ok' : 'dry-run',
            dryRun: !apply,
            storeDirectory: store,
            lockFile: resolvedLockFile,
            plan,
            planSha256: plan.planSha256,
            activeProtection: apply ? normalizeActiveProtection(activeProtection) : null,
            protectedReleaseIds: plan.releases.filter(release => release.protected).map(release => release.releaseId),
            releaseActions: plan.releases,
            objectActions: plan.objects,
            before,
            after,
            errors: []
        };
        if (evidenceFile)
        {
            writeJsonAtomic(evidenceFile, evidence);
        }
        return evidence;
    }
    finally
    {
        if (lockDescriptor !== undefined)
        {
            fs.closeSync(lockDescriptor);
        }
        fs.rmSync(resolvedLockFile, { force: true });
    }
}

function normalizeReleaseIds(value, label)
{
    if (!Array.isArray(value))
    {
        throw new Error(`${label} must be an array`);
    }
    const normalized = value.map(normalizeReleaseId);
    if (new Set(normalized).size !== normalized.length)
    {
        throw new Error(`${label} contains duplicate release identity`);
    }
    return normalized;
}

function protect(reasons, releaseId, reason)
{
    const existing = reasons.get(releaseId) ?? new Set();
    existing.add(reason);
    reasons.set(releaseId, existing);
}

function listDirectories(root)
{
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
    {
        return [];
    }
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

function readAssetManifest(releaseDirectory)
{
    const manifestFile = path.join(releaseDirectory, 'asset-manifest.json');
    const metadata = fs.lstatSync(manifestFile, { throwIfNoEntry: false });
    if (!metadata?.isFile() || metadata.isSymbolicLink())
    {
        throw new Error(`protected release asset manifest must be a regular non-symlink file: ${manifestFile}`);
    }
    let manifest;
    try
    {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`cannot read protected release asset manifest ${manifestFile}: ${error.message}`);
    }
    assertExactFields(manifest, [
        'compatibilityFile', 'files', 'frontendBuildId', 'releaseId', 'schema', 'slot'
    ], 'release asset manifest');
    if (manifest.schema !== 'fsusblog.release-assets.v1'
      || manifest.releaseId !== path.basename(releaseDirectory)
      || manifest.frontendBuildId !== manifest.releaseId
      || !['blue', 'green'].includes(manifest.slot)
      || (manifest.compatibilityFile !== null && manifest.compatibilityFile !== 'release-compatibility.json')
      || !Array.isArray(manifest.files)
      || manifest.files.some(file =>
      {
          assertExactFields(file, ['bytes', 'cacheControl', 'class', 'path', 'releaseUrl', 'sha256'], 'release asset manifest file');
          return !/^sha256:[0-9a-f]{64}$/u.test(String(file.sha256))
          || !Number.isSafeInteger(file.bytes) || file.bytes < 0
          || !['mutable-entry', 'immutable-static'].includes(file.class)
          || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(segment => !segment || segment === '.' || segment === '..')
          || file.releaseUrl !== `/release-assets/${manifest.releaseId}/${file.path}`
          || typeof file.cacheControl !== 'string' || file.cacheControl.length === 0;
      }))
    {
        throw new Error(`protected release asset manifest is invalid: ${manifestFile}`);
    }
    return { manifest, manifestSha256: sha256File(manifestFile) };
}

function normalizeActiveProtection(value)
{
    assertExactFields(value, [
        'deploymentGeneration', 'imageDigest', 'releaseId', 'rolloutId', 'slot'
    ], 'GC active protection');
    return {
        releaseId: normalizeReleaseId(value.releaseId),
        slot: ['blue', 'green'].includes(value.slot) ? value.slot : invalid('GC active protection slot is invalid'),
        imageDigest: /^sha256:[0-9a-f]{64}$/u.test(value.imageDigest) ? value.imageDigest : invalid('GC active protection image digest is invalid'),
        deploymentGeneration: Number.isSafeInteger(value.deploymentGeneration) && value.deploymentGeneration > 0
            ? value.deploymentGeneration : invalid('GC active protection generation is invalid'),
        rolloutId: /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(value.rolloutId)
            ? value.rolloutId : invalid('GC active protection rollout id is invalid')
    };
}

function assertSafeStoreRoot(store)
{
    const metadata = fs.lstatSync(store, { throwIfNoEntry: false });
    if (metadata?.isSymbolicLink())
    {
        throw new Error('release asset store root must not be a symlink');
    }
    if (metadata && !metadata.isDirectory())
    {
        throw new Error('release asset store root must be a directory');
    }
    if (metadata && fs.realpathSync(store) !== path.resolve(store))
    {
        throw new Error('release asset store path contains a symlink or non-canonical segment');
    }
    for (const child of ['releases', 'objects'])
    {
        const childPath = path.join(store, child);
        const childMetadata = fs.lstatSync(childPath, { throwIfNoEntry: false });
        if (childMetadata?.isSymbolicLink())
        {
            throw new Error(`release asset ${child} root must not be a symlink`);
        }
        if (childMetadata && !childMetadata.isDirectory())
        {
            throw new Error(`release asset ${child} root must be a directory`);
        }
    }
}

function assertDeletionTarget(store, target, activeReleaseId)
{
    const relative = path.relative(store, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    {
        throw new Error('GC deletion target escapes the release asset store');
    }
    const metadata = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!metadata?.isDirectory() || metadata.isSymbolicLink())
    {
        throw new Error(`GC deletion target is not an owned directory: ${target}`);
    }
    const canonicalStore = fs.realpathSync(store);
    const canonicalTarget = fs.realpathSync(target);
    if (canonicalTarget !== path.resolve(target)
      || !canonicalTarget.startsWith(`${canonicalStore}${path.sep}`))
    {
        throw new Error('GC deletion target escapes the canonical release asset store');
    }
    if (activeReleaseId && path.basename(target) === activeReleaseId)
    {
        throw new Error('GC deletion target is the active release');
    }
    rejectSymlinks(target);
}

function rejectSymlinks(root)
{
    for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    {
        const candidate = path.join(root, entry.name);
        if (entry.isSymbolicLink())
        {
            throw new Error(`GC deletion target contains a symlink: ${candidate}`);
        }
        if (entry.isDirectory())
        {
            rejectSymlinks(candidate);
        }
    }
}

function digestJson(value)
{
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeProtectedManifestBindings(value)
{
    if (!Array.isArray(value))
    {
        throw new Error('GC protected manifest bindings must be an array');
    }
    const seen = new Set();
    return value.map(entry =>
    {
        assertExactFields(entry, ['assetManifestSha256', 'releaseId'], 'GC protected manifest binding');
        const releaseId = normalizeReleaseId(entry.releaseId);
        if (seen.has(releaseId))
        {
            throw new Error('GC protected manifest bindings contain duplicate release identity');
        }
        seen.add(releaseId);
        const assetManifestSha256 = String(entry.assetManifestSha256 ?? '');
        if (!/^sha256:[0-9a-f]{64}$/u.test(assetManifestSha256))
        {
            throw new Error('GC protected manifest binding digest must be a lowercase sha256 digest');
        }
        return { releaseId, assetManifestSha256 };
    });
}

function normalizeReleaseActions(value)
{
    if (!Array.isArray(value))
    {
        throw new Error('GC release actions must be an array');
    }
    const seen = new Set();
    return value.map(entry =>
    {
        assertExactFields(entry, ['action', 'protected', 'reasons', 'releaseId'], 'GC release action');
        const releaseId = normalizeReleaseId(entry.releaseId);
        if (seen.has(releaseId))
        {
            throw new Error('GC release actions contain duplicate release identity');
        }
        seen.add(releaseId);
        if (typeof entry.protected !== 'boolean')
        {
            throw new Error('GC release action protection flag is invalid');
        }
        if (!Array.isArray(entry.reasons))
        {
            throw new Error('GC release action reasons must be an array');
        }
        const reasons = entry.reasons.map(reason =>
        {
            const normalizedReason = String(reason ?? '');
            if (!GC_PROTECTION_REASONS.has(normalizedReason))
            {
                throw new Error(`GC release action reason is invalid: ${normalizedReason}`);
            }
            return normalizedReason;
        });
        if (new Set(reasons).size !== reasons.length)
        {
            throw new Error('GC release action reasons contain duplicates');
        }
        const action = entry.action === 'retain' || entry.action === 'delete'
            ? entry.action : invalid('GC release action is invalid');
        if (entry.protected !== (action === 'retain'))
        {
            throw new Error('GC release action does not match the protection state');
        }
        if (entry.protected !== (reasons.length > 0))
        {
            throw new Error('GC release action reasons do not match the protection state');
        }
        return { releaseId, protected: entry.protected, reasons, action };
    });
}

function normalizeObjectActions(value)
{
    if (!Array.isArray(value))
    {
        throw new Error('GC object actions must be an array');
    }
    const seen = new Set();
    return value.map(entry =>
    {
        assertExactFields(entry, ['action', 'protected', 'sha256'], 'GC object action');
        const sha256 = String(entry.sha256 ?? '');
        if (!/^sha256:[0-9a-f]{64}$/u.test(sha256))
        {
            throw new Error('GC object action digest is invalid');
        }
        if (seen.has(sha256))
        {
            throw new Error('GC object actions contain duplicate object identity');
        }
        seen.add(sha256);
        if (typeof entry.protected !== 'boolean')
        {
            throw new Error('GC object action protection flag is invalid');
        }
        const action = entry.action === 'retain' || entry.action === 'delete'
            ? entry.action : invalid('GC object action is invalid');
        if (entry.protected !== (action === 'retain'))
        {
            throw new Error('GC object action does not match the protection state');
        }
        return { sha256, protected: entry.protected, action };
    });
}

function normalizeReviewedDryRunEvidence(value, store)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error('GC apply requires reviewed dry-run evidence');
    }
    assertExactFields(value, GC_EVIDENCE_FIELDS, 'GC reviewed dry-run evidence');
    if (value.schema !== RELEASE_GC_EVIDENCE_SCHEMA)
    {
        throw new Error(`GC reviewed dry-run evidence schema must be ${RELEASE_GC_EVIDENCE_SCHEMA}`);
    }
    if (value.status !== 'dry-run' || value.dryRun !== true)
    {
        throw new Error('GC reviewed evidence must come from a successful dry-run');
    }
    if (value.activeProtection !== null)
    {
        throw new Error('GC reviewed dry-run evidence cannot include active protection');
    }
    if (!Array.isArray(value.errors) || value.errors.length !== 0)
    {
        throw new Error('GC reviewed dry-run evidence must not contain errors');
    }
    if (path.resolve(value.storeDirectory) !== store)
    {
        throw new Error('GC reviewed dry-run evidence store does not match this collector run');
    }
    if (typeof value.lockFile !== 'string' || value.lockFile.length === 0)
    {
        throw new Error('GC reviewed dry-run evidence lock file is invalid');
    }

    const plan = verifyReleaseAssetGcPlan(value.plan);
    if (plan.storeDirectory !== store)
    {
        throw new Error('GC reviewed dry-run plan store does not match this collector run');
    }
    if (value.planSha256 !== plan.planSha256)
    {
        throw new Error('GC reviewed dry-run evidence plan digest does not match its sealed plan');
    }
    if (JSON.stringify(value.releaseActions) !== JSON.stringify(plan.releases))
    {
        throw new Error('GC reviewed dry-run evidence release actions do not match its sealed plan');
    }
    if (JSON.stringify(value.objectActions) !== JSON.stringify(plan.objects))
    {
        throw new Error('GC reviewed dry-run evidence object actions do not match its sealed plan');
    }
    const protectedReleaseIds = plan.protectedManifestBindings.map(entry => entry.releaseId);
    if (JSON.stringify(value.protectedReleaseIds) !== JSON.stringify(protectedReleaseIds))
    {
        throw new Error('GC reviewed dry-run evidence protected releases do not match its sealed plan');
    }
    return { ...value, plan };
}

function assertReviewedPlanMatches(reviewedPlan, currentPlan)
{
    if (reviewedPlan.planSha256 === currentPlan.planSha256)
    {
        return;
    }
    const driftedReleases = findDriftedProtectedReleases(reviewedPlan.protectedManifestBindings, currentPlan.protectedManifestBindings);
    if (driftedReleases.length > 0)
    {
        throw new Error(`protected release asset manifests drifted after reviewed dry-run: ${driftedReleases.join(', ')}`);
    }
    throw new Error('GC plan changed after reviewed dry-run');
}

function findDriftedProtectedReleases(reviewed, current)
{
    const currentBindings = new Map(current.map(entry => [entry.releaseId, entry.assetManifestSha256]));
    const reviewedReleaseIds = reviewed.map(entry => entry.releaseId);
    const drifted = reviewed.filter(entry => currentBindings.get(entry.releaseId) !== entry.assetManifestSha256)
        .map(entry => entry.releaseId);
    for (const entry of current)
    {
        if (!reviewedReleaseIds.includes(entry.releaseId))
        {
            drifted.push(entry.releaseId);
        }
    }
    return [...new Set(drifted)].sort((left, right) => left.localeCompare(right, 'en'));
}

function assertExactFields(value, expectedFields, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} must be an object`);
    }
    if (Object.keys(value).sort().join(',') !== [...expectedFields].sort().join(','))
    {
        throw new Error(`${label} fields are not closed exact`);
    }
}

function invalid(message)
{
    throw new Error(message);
}

function snapshotStore(store)
{
    const releases = listDirectories(path.join(store, 'releases')).sort();
    const objects = listDirectories(path.join(store, 'objects')).sort();
    const manifests = releases.map(releaseId =>
    {
        const file = path.join(store, 'releases', releaseId, 'asset-manifest.json');
        return {
            releaseId,
            sha256: fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? sha256File(file) : null
        };
    });
    return { releases, objects: objects.map(sha256 => `sha256:${sha256}`), manifests };
}
