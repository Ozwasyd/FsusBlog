import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath, URL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Scheduler admission consumes the canonical BehaviorDoc receipt validator.
import { validateBehaviorDocStaticAdmissionReceipt } from '../docs/behavior-doc-static-admission.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Scheduler fingerprints use the canonical source-identity owner.
import { sealSourceIdentity } from '../fact-extractors/identity.mjs';
import {
    attachCurrentRunEvidenceHandoff,
    parseCurrentRunEvidenceHandoffs,
    resumeCurrentRunEvidenceCheckpoint
// eslint-disable-next-line import-x/no-relative-parent-imports -- Producer terminal handoffs are scheduler checkpoint inputs.
} from '../test/current-run-evidence-checkpoint.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Finalizer admission consumes exact current-run bindings.
import { locateCurrentRunEvidence } from '../test/current-run-evidence-locator.mjs';
import {
    loadPhysicalExecutionProcessPolicy,
    residentServiceTransferSchema,
    resourceServiceContainmentIsComplete,
    runPhysicalExecution,
    terminatePhysicalExecutionAuthoritySync
// eslint-disable-next-line import-x/no-relative-parent-imports -- Scheduler containment reuses the canonical process-tree authority.
} from '../test/physical-execution-process-tree.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Scheduler observations reuse the canonical process identity collector.
import { collectProcessIdentity } from '../test/process-identity.mjs';
import {
    validateRunBoundConsumerEvidence,
    validateRunBoundProjection
// eslint-disable-next-line import-x/no-relative-parent-imports -- Run-bound evidence is owned by the shared execution contract.
} from '../test/run-once.mjs';
import {
    createSchedulerReplayActual,
    validateSchedulerReplayPlan
// eslint-disable-next-line import-x/no-relative-parent-imports -- Scheduler replay contracts are owned by the execution contract layer.
} from '../test/scheduler-replay-contract.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Scheduler admission needs host-accurate Darwin available memory.
import { availableMemoryBytes, availableMemoryGiB } from '../test/system-memory.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Temporal replay validation is shared with the execution owner.
import { verifyTemporalReplay } from '../test/temporal-context.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Resident transfer binds the canonical owner receipt digest.
import { digestCanonical } from '../test-fixtures/receipt/canonical.mjs';

import {
    readAndValidateArtifactDigestTable,
    validateArtifactRefs
} from './artifact-digest-table.mjs';
import { createAsyncLogPipeline } from './async-log-pipeline.mjs';
import { RunEvidenceObjectStore } from './content-addressed-evidence-store.mjs';
import { validateCorrectnessInputManifest } from './correctness-input-manifest.mjs';
import {
    artifactSubstitutionBindingDigest,
    externalEvidenceReceiptDigest,
    resolveRunBoundArtifactDeclaration
} from './local-profile.mjs';
import {
    assertRetainedMySqlFixtureRecoveryComplete,
    reconcileRetainedMySqlFixtureServices
} from './mysql-fixture-recovery.mjs';
import { createProductionResourceEnforcer } from './production-resource-enforcement.mjs';
import { inspectProductionSystemdServiceBinding } from './production-systemd-resource-boundary.mjs';
import { createReleaseFinalSpawnSeal } from './release-final-spawn-seal.mjs';
import {
    applyReleaseFinalizerSpawnDecision,
    validateRepositoryReleaseFinalStaticBoundary
} from './release-final-static-boundary.mjs';
import { releaseReliabilityResourceConflict } from './release-reliability-scheduler-projection.mjs';
import {
    createResidentLeaseHandoff,
    observeResidentService,
    readResidentLeaseDocument,
    reconcileResidentLeaseInventory,
    validateResidentLeaseHandoff,
    validateResidentLeaseInventory,
    writeResidentLeaseDocument
} from './resident-resource-leases.mjs';
import {
    createLinuxProcessTreeCollector,
    createWaitLedger,
    prioritySchemas,
    rankReadyTiers,
    resolveResourceSampleIntervalMs,
    startupAdmissionOrder
} from './scheduler-admission-support.mjs';
import { finalizeSchedulerCorrectness } from './scheduler-correctness-finalizer.mjs';
import {
    acquireSchedulerRunLock,
    createSchedulerTierAdmission,
    schedulerCandidateIdentityDigest,
    schedulerRunLockActivity,
    schedulerRunLockIsActive,
    schedulerRunOwnerIdentityMatches,
    schedulerRunOwnerIsComplete,
    writeSchedulerTierAdmission
} from './scheduler-run-owner.mjs';

export {
    reclaimSchedulerRunLock,
    schedulerRunLockActivity,
    schedulerRunLockIsActive
} from './scheduler-run-owner.mjs';

const { validateCurrentRunEvidenceContext, validateEvidenceLocatorRegistry } = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));
const { requireCleanAttemptConsumerAdmission } = await import(new URL('../release/browser-release-clean-attempt-consumers.mjs', import.meta.url));

const checkpointSchema = 'fsusblog.test-matrix.checkpoint.v1';
// Consumer requirements from the candidate owner contract. This does not collect, create or admit a cohort.
export const schedulerReleaseCandidateRequiredFields = Object.freeze([
    'schema', 'identityVersion', 'sourceCommit', 'worktreeFingerprint', 'repositorySubmoduleOrAliasDigests',
    'lockfileDigests', 'configurationDigests', 'testMatrixDigest', 'coverageRegistryDigest',
    'requiredEvidenceCatalogDigest', 'projectionCatalogDigests', 'stateDomainCatalogDigest', 'retryPolicyDigest',
    'outcomeNormalizationPolicyDigest', 'immutableBuildReceiptDigest', 'immutableBuildArtifactSetDigest',
    'imageDigest', 'fixtureSchemaDigest', 'fixtureSeedDigest', 'fixturePolicyDigest', 'executionEnvelopePlanDigest',
    'replayPlanDigest', 'randomSeedRoot', 'temporalContextDigest', 'businessEpochUtc', 'timezone', 'culture',
    'browserIdentityDigest', 'serviceImageDigests', 'networkPolicyDigest', 'candidateIdentityDigest'
]);
const schedulerResourceRecoveries = new WeakMap();
const currentRunPreexecutedTierBindingSchema =
    'fsusblog.test-matrix.current-run-preexecuted-tier-binding.v1';
const currentRunBehaviorDocAdmissionBindingSchema =
    'fsusblog.test-matrix.current-run-behavior-doc-admission-binding.v1';
const currentRunBehaviorDocAdmissionTierId = 'behavior-doc-static-admission';
const runtimeCleanupAttemptLedgerSchema = 'fsusblog.production-fresh.runtime-cleanup-attempt-ledger.v1';
const protectedSupersedesPattern = /(^|[^a-z])(property|model|perf|performance|benchmark|runtime)([^a-z]|$)/i;
const protectedAssertionTypes = new Set(['runtime', 'browser', 'perf', 'fuzz', 'mutation']);
const protectedExecutionVariants = new Set(['property', 'model', 'performance', 'runtime']);
const fingerprintEnvironmentPrefixes = ['FSUSBLOG_', 'PLAYWRIGHT_', 'MATRIX_', 'VITE_'];
const fingerprintEnvironmentKeys = new Set(['CI', 'NODE_ENV', 'DOTNET_ROOT']);
const orchestrationOnlyFingerprintEnvironmentKeys = new Set([
    'FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS',
    'FSUSBLOG_TEST_EXECUTION_SOURCE',
    'FSUSBLOG_TIER_CPU_UNITS',
    'FSUSBLOG_TIER_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_MEMORY_GIB',
    'FSUSBLOG_VITEST_MAX_WORKERS',
    'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
    'FSUSBLOG_PLAYWRIGHT_WORKERS',
    'FSUSBLOG_SCHEDULER_CHECKPOINT',
    'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE',
    'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_RUN_ID',
    'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID',
    'FSUSBLOG_CGROUP_BUNDLE_PATH',
    'FSUSBLOG_CGROUP_EFFECTIVE_CPU_MAX',
    'FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_HIGH_BYTES',
    'FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_MAX_BYTES',
    'FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX'
]);
const checkpointPersistence = new Map();
const timeoutPhases = new Set([
    'preparation',
    'measurement',
    'post-measurement',
    'termination',
    'scheduler',
    'global'
]);
function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function fingerprint(value)
{
    const serialized = JSON.stringify(stableValue(value));
    return sha256(serialized === undefined ? 'undefined' : serialized);
}

function normalizedRepositoryRelativePath(value, label)
{
    const normalized = String(value ?? '')
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\.\//u, '');
    if (!normalized
    || path.posix.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../'))
    {
        throw new Error(`${label} must be a repository-relative path`);
    }
    return path.posix.normalize(normalized);
}

function currentRunPreexecutedTierBindingPayload(binding)
{
    return {
        schema: binding.schema,
        tierId: binding.tierId,
        schedulerRunId: binding.schedulerRunId,
        sourceState: binding.sourceState,
        executionKey: binding.executionKey,
        consumerId: binding.consumerId,
        consumerEvidenceFile: binding.consumerEvidenceFile,
        consumerEvidenceDigest: binding.consumerEvidenceDigest,
        temporalPlanFile: binding.temporalPlanFile,
        temporalPlanDigest: binding.temporalPlanDigest,
        temporalActualFile: binding.temporalActualFile,
        temporalActualDigest: binding.temporalActualDigest,
        temporalReceiptFile: binding.temporalReceiptFile,
        temporalReceiptDigest: binding.temporalReceiptDigest
    };
}

function currentRunBehaviorDocAdmissionBindingPayload(binding)
{
    return {
        schema: binding.schema,
        tierId: binding.tierId,
        schedulerRunId: binding.schedulerRunId,
        admissionRunId: binding.admissionRunId,
        sourceState: binding.sourceState,
        admissionSourceIdentity: binding.admissionSourceIdentity,
        receiptFile: binding.receiptFile,
        receiptContentDigest: binding.receiptContentDigest
    };
}

function normalizedCurrentRunSourceState(sourceState)
{
    return {
        commit: String(sourceState?.commit ?? '').trim(),
        worktreeFingerprint: String(sourceState?.worktreeFingerprint ?? '')
            .trim()
            .replace(/^sha256:/u, '')
    };
}

function assertCurrentRunSourceState(sourceState)
{
    if (!/^[a-f0-9]{40}$/u.test(sourceState.commit)
    || !/^[a-f0-9]{64}$/u.test(sourceState.worktreeFingerprint))
    {
        throw new Error('current-run preexecuted tier binding requires source identity');
    }
}

function currentRunTemporalEvidence(root, consumerEvidence)
{
    const normalizedRoot = path.resolve(root);
    const runDirectory = String(consumerEvidence.schedulerRunId ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    const receiptDirectory = path.posix.join(
        '.tmp',
        'physical-executions',
        runDirectory,
        'receipts',
        consumerEvidence.executionKey
    );
    const prefix = consumerEvidence.executionKey;
    const relativeFiles = {
        plan: path.posix.join(receiptDirectory, `${prefix}-temporal-plan.json`),
        actual: path.posix.join(receiptDirectory, `${prefix}-temporal-actual.json`),
        receipt: path.posix.join(receiptDirectory, `${prefix}-temporal-receipt.json`)
    };
    const documents = {};
    for (const [kind, relativeFile] of Object.entries(relativeFiles))
    {
        const absoluteFile = path.resolve(normalizedRoot, relativeFile);
        if (absoluteFile === normalizedRoot
        || !absoluteFile.startsWith(`${normalizedRoot}${path.sep}`))
        {
            throw new Error(`current-run preexecuted tier temporal ${kind} escapes repository`);
        }
        const stat = fs.lstatSync(absoluteFile);
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            throw new Error(`current-run preexecuted tier temporal ${kind} is not a regular file`);
        }
        const realRoot = fs.realpathSync(normalizedRoot);
        const realFile = fs.realpathSync(absoluteFile);
        if (!realFile.startsWith(`${realRoot}${path.sep}`))
        {
            throw new Error(`current-run preexecuted tier temporal ${kind} escapes repository`);
        }
        documents[kind] = JSON.parse(fs.readFileSync(realFile, 'utf8'));
    }
    const verification = verifyTemporalReplay({
        plan: documents.plan,
        actual: documents.actual,
        receipt: documents.receipt
    });
    return { relativeFiles, documents, verification };
}

export function createCurrentRunPreexecutedTierBinding({
    root,
    tierId,
    schedulerRunId,
    sourceState,
    consumerEvidenceFile,
    consumerEvidence
})
{
    const normalizedTierId = String(tierId ?? '').trim();
    const normalizedRunId = String(schedulerRunId ?? '').trim();
    const normalizedSourceState = normalizedCurrentRunSourceState(sourceState);
    const normalizedEvidenceFile = normalizedRepositoryRelativePath(
        consumerEvidenceFile,
        'current-run preexecuted tier consumer evidence'
    );
    if (!normalizedTierId
    || !normalizedRunId)
    {
        throw new Error('current-run preexecuted tier binding requires tier, run and source identity');
    }
    assertCurrentRunSourceState(normalizedSourceState);
    validateRunBoundConsumerEvidence(consumerEvidence, {
        runId: normalizedRunId,
        key: consumerEvidence?.executionKey,
        consumerId: normalizedTierId
    });
    const receipt = consumerEvidence.physicalExecutionReceiptDocument;
    if (receipt.commit !== normalizedSourceState.commit)
    {
        throw new Error('current-run preexecuted tier physical receipt commit mismatch');
    }
    const temporalEvidence = currentRunTemporalEvidence(root, consumerEvidence);
    const expectedSourceFingerprint = `sha256:${normalizedSourceState.worktreeFingerprint}`;
    const temporalReceipt = temporalEvidence.documents.receipt;
    if (temporalReceipt.source?.commit !== normalizedSourceState.commit
    || temporalReceipt.source?.fingerprint !== expectedSourceFingerprint
    || temporalReceipt.run?.schedulerRunId !== normalizedRunId
    || temporalReceipt.producer?.producerId !== normalizedTierId)
    {
        throw new Error('current-run preexecuted tier temporal source identity mismatch');
    }
    const payload = {
        schema: currentRunPreexecutedTierBindingSchema,
        tierId: normalizedTierId,
        schedulerRunId: normalizedRunId,
        sourceState: normalizedSourceState,
        executionKey: consumerEvidence.executionKey,
        consumerId: consumerEvidence.consumerId,
        consumerEvidenceFile: normalizedEvidenceFile,
        consumerEvidenceDigest: consumerEvidence.evidenceDigest,
        temporalPlanFile: temporalEvidence.relativeFiles.plan,
        temporalPlanDigest: temporalEvidence.documents.plan.digest,
        temporalActualFile: temporalEvidence.relativeFiles.actual,
        temporalActualDigest: temporalEvidence.documents.actual.digest,
        temporalReceiptFile: temporalEvidence.relativeFiles.receipt,
        temporalReceiptDigest: temporalEvidence.verification.receiptDigest
    };
    return { ...payload, bindingDigest: fingerprint(payload) };
}

export function createCurrentRunBehaviorDocAdmissionBinding({
    root,
    tierId,
    schedulerRunId,
    admissionRunId,
    sourceState,
    receiptFile
})
{
    const normalizedRoot = path.resolve(root);
    const normalizedTierId = String(tierId ?? '').trim();
    const normalizedRunId = String(schedulerRunId ?? '').trim();
    const normalizedAdmissionRunId = String(admissionRunId ?? '').trim();
    const normalizedSourceState = normalizedCurrentRunSourceState(sourceState);
    if (!normalizedTierId || !normalizedRunId || !normalizedAdmissionRunId)
    {
        throw new Error(
            'current-run BehaviorDoc admission binding requires tier, scheduler run and admission run'
        );
    }
    assertCurrentRunSourceState(normalizedSourceState);
    const absoluteReceiptFile = path.resolve(receiptFile);
    if (absoluteReceiptFile === normalizedRoot
    || !absoluteReceiptFile.startsWith(`${normalizedRoot}${path.sep}`))
    {
        throw new Error('current-run BehaviorDoc admission receipt escapes repository');
    }
    const normalizedReceiptFile = normalizedRepositoryRelativePath(
        path.relative(normalizedRoot, absoluteReceiptFile).replaceAll(path.sep, '/'),
        'current-run BehaviorDoc admission receipt'
    );
    let receiptStat;
    try
    {
        receiptStat = fs.lstatSync(absoluteReceiptFile);
    }
    catch (error)
    {
        throw new Error('current-run BehaviorDoc admission receipt is missing', { cause: error });
    }
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink())
    {
        throw new Error('current-run BehaviorDoc admission receipt is not a regular file');
    }
    const realRoot = fs.realpathSync(normalizedRoot);
    const realReceiptFile = fs.realpathSync(absoluteReceiptFile);
    if (!realReceiptFile.startsWith(`${realRoot}${path.sep}`))
    {
        throw new Error('current-run BehaviorDoc admission receipt escapes repository');
    }
    const receipt = JSON.parse(fs.readFileSync(realReceiptFile, 'utf8'));
    const admissionSourceIdentity = sealSourceIdentity(normalizedRoot);
    if (admissionSourceIdentity.sourceCommit !== normalizedSourceState.commit)
    {
        throw new Error('current-run BehaviorDoc admission commit mismatches scheduler source');
    }
    validateBehaviorDocStaticAdmissionReceipt(receipt, {
        expectedRunId: normalizedAdmissionRunId,
        expectedSourceIdentity: admissionSourceIdentity,
        expectedWorktree: normalizedRoot
    });
    const payload = {
        schema: currentRunBehaviorDocAdmissionBindingSchema,
        tierId: normalizedTierId,
        schedulerRunId: normalizedRunId,
        admissionRunId: normalizedAdmissionRunId,
        sourceState: normalizedSourceState,
        admissionSourceIdentity,
        receiptFile: normalizedReceiptFile,
        receiptContentDigest: receipt.contentDigest
    };
    return { ...payload, bindingDigest: fingerprint(payload) };
}

function validateCurrentRunPreexecutedTierBinding(binding, {
    runId,
    sourceState,
    tier
})
{
    const payload = currentRunPreexecutedTierBindingPayload(binding ?? {});
    if (payload.schema !== currentRunPreexecutedTierBindingSchema
    || payload.tierId !== tier.id
    || payload.schedulerRunId !== runId
    || payload.consumerId !== tier.id
    || !payload.executionKey
    || !payload.consumerEvidenceDigest
    || !payload.temporalPlanDigest
    || !payload.temporalActualDigest
    || !payload.temporalReceiptDigest
    || payload.sourceState?.commit !== sourceState.commit
    || payload.sourceState?.worktreeFingerprint
      !== String(sourceState.worktreeFingerprint).replace(/^sha256:/u, '')
    || binding.bindingDigest !== fingerprint(payload))
    {
        throw new Error(`current-run preexecuted tier binding is invalid: ${tier.id}`);
    }
    normalizedRepositoryRelativePath(
        payload.consumerEvidenceFile,
        'current-run preexecuted tier consumer evidence'
    );
    for (const [field, label] of [
        ['temporalPlanFile', 'temporal plan'],
        ['temporalActualFile', 'temporal actual'],
        ['temporalReceiptFile', 'temporal receipt']
    ])
    {
        normalizedRepositoryRelativePath(
            payload[field],
            `current-run preexecuted tier ${label}`
        );
    }
    return payload;
}

function validateCurrentRunBehaviorDocAdmissionBinding(binding, {
    root,
    runId,
    sourceState,
    tier,
    ownedOutputs,
    tierEnvironment
})
{
    const payload = currentRunBehaviorDocAdmissionBindingPayload(binding ?? {});
    const normalizedSourceState = normalizedCurrentRunSourceState(sourceState);
    if (payload.schema !== currentRunBehaviorDocAdmissionBindingSchema
    || payload.tierId !== tier.id
    || payload.schedulerRunId !== runId
    || !payload.admissionRunId
    || payload.sourceState?.commit !== normalizedSourceState.commit
    || payload.sourceState?.worktreeFingerprint !== normalizedSourceState.worktreeFingerprint
    || payload.admissionSourceIdentity?.sourceCommit !== normalizedSourceState.commit
    || !/^[a-f0-9]{64}$/u.test(
        payload.admissionSourceIdentity?.worktreeFingerprint ?? ''
    )
    || !/^[a-f0-9]{64}$/u.test(payload.receiptContentDigest ?? '')
    || binding.bindingDigest !== fingerprint(payload))
    {
        throw new Error(`current-run BehaviorDoc admission binding is invalid: ${tier.id}`);
    }
    const normalizedReceiptFile = normalizedRepositoryRelativePath(
        payload.receiptFile,
        'current-run BehaviorDoc admission receipt'
    );
    const receiptPath = path.resolve(root, normalizedReceiptFile);
    const declaredOwnedFiles = ownedOutputs.map((declaration) =>
        path.resolve(root, resolveRunBoundArtifactDeclaration(root, declaration, tierEnvironment)));
    if (!declaredOwnedFiles.includes(receiptPath))
    {
        throw new Error(
            `current-run BehaviorDoc admission receipt is not owned by tier: ${tier.id}`
        );
    }
    const rebuiltBinding = createCurrentRunBehaviorDocAdmissionBinding({
        root,
        tierId: tier.id,
        schedulerRunId: runId,
        admissionRunId: payload.admissionRunId,
        sourceState,
        receiptFile: receiptPath
    });
    if (rebuiltBinding.bindingDigest !== binding.bindingDigest
    || rebuiltBinding.receiptContentDigest !== payload.receiptContentDigest)
    {
        throw new Error(
            `current-run BehaviorDoc admission receipt binding drifted: ${tier.id}`
        );
    }
    return payload;
}

async function verifyCurrentRunPreexecutedTierBinding({
    binding,
    root,
    runId,
    sourceState,
    tier,
    ownedOutputs,
    tierEnvironment
})
{
    if (binding?.schema === currentRunBehaviorDocAdmissionBindingSchema)
    {
        validateCurrentRunBehaviorDocAdmissionBinding(binding, {
            root,
            runId,
            sourceState,
            tier,
            ownedOutputs,
            tierEnvironment
        });
        return;
    }
    const payload = validateCurrentRunPreexecutedTierBinding(binding, {
        runId,
        sourceState,
        tier
    });
    const evidenceFile = path.resolve(root, payload.consumerEvidenceFile);
    if (evidenceFile !== root && !evidenceFile.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`current-run preexecuted tier evidence escapes repository: ${tier.id}`);
    }
    const evidenceStat = fs.lstatSync(evidenceFile);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink())
    {
        throw new Error(`current-run preexecuted tier evidence is not a regular file: ${tier.id}`);
    }
    const declaredEvidenceFiles = ownedOutputs.map((declaration) =>
        path.resolve(root, resolveRunBoundArtifactDeclaration(root, declaration, tierEnvironment)));
    if (!declaredEvidenceFiles.includes(evidenceFile))
    {
        throw new Error(`current-run preexecuted tier evidence is not owned by tier: ${tier.id}`);
    }
    const consumerEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    const rebuiltBinding = createCurrentRunPreexecutedTierBinding({
        root,
        tierId: tier.id,
        schedulerRunId: runId,
        sourceState,
        consumerEvidenceFile: payload.consumerEvidenceFile,
        consumerEvidence
    });
    if (rebuiltBinding.bindingDigest !== binding.bindingDigest
    || consumerEvidence.evidenceDigest !== payload.consumerEvidenceDigest)
    {
        throw new Error(`current-run preexecuted tier evidence binding drifted: ${tier.id}`);
    }
    const validatedProjection = await validateRunBoundProjection({
        root: path.join(root, '.tmp', 'physical-executions'),
        runId,
        key: payload.executionKey,
        consumerId: tier.id,
        projectionFile: path.resolve(root, consumerEvidence.sourceProjection),
        receiptFile: path.resolve(root, consumerEvidence.physicalExecutionReceipt)
    });
    if (fingerprint(validatedProjection.projection)
      !== consumerEvidence.sourceProjectionDocumentDigest
    || validatedProjection.receipt.receiptDigest
      !== consumerEvidence.physicalExecutionReceiptDigest)
    {
        throw new Error(`current-run preexecuted tier live receipt binding drifted: ${tier.id}`);
    }
}

function gitHead(root)
{
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function registryEntry(coverageRegistry, coverageId)
{
    if (coverageRegistry instanceof Map)
    {
        return coverageRegistry.get(coverageId);
    }
    if (Array.isArray(coverageRegistry))
    {
        return coverageRegistry.find((entry) => entry?.id === coverageId);
    }
    return coverageRegistry?.[coverageId];
}

export function validateSupersedesRules(tiers, coverageRegistry = new Map())
{
    const errors = [];
    const byId = new Map(tiers.map((tier) => [tier.id, tier]));
    const claimed = new Map();
    const edges = new Map();

    for (const replacement of tiers)
    {
        if (!Array.isArray(replacement.supersedes))
        {
            continue;
        }
        for (const targetId of replacement.supersedes)
        {
            const targets = edges.get(replacement.id) ?? [];
            targets.push(targetId);
            edges.set(replacement.id, targets);
            const target = byId.get(targetId);
            if (!target)
            {
                errors.push(`${replacement.id}.supersedes references missing tier ${targetId}`);
                continue;
            }
            if (targetId === replacement.id)
            {
                errors.push(`${replacement.id} must not supersede itself`);
                continue;
            }
            if (claimed.has(targetId))
            {
                errors.push(`${targetId} is superseded by both ${claimed.get(targetId)} and ${replacement.id}`);
            }
            else
            {
                claimed.set(targetId, replacement.id);
            }
            if (!replacement.executionKey || !target.executionKey || replacement.executionKey !== target.executionKey)
            {
                errors.push(`${replacement.id} may supersede ${targetId} only when both tiers use the same executionKey`);
            }
            if (replacement.executionVariant !== 'coverage' || target.executionVariant !== 'ordinary')
            {
                errors.push(`${replacement.id} may supersede ${targetId} only with executionVariant=coverage replacing executionVariant=ordinary`);
            }

            const replacementCoverage = new Set(replacement.coverage ?? []);
            const targetCoverage = new Set(target.coverage ?? []);
            const coversTarget = [...targetCoverage].every((coverageId) => replacementCoverage.has(coverageId));
            if (targetCoverage.size === 0 || !coversTarget)
            {
                errors.push(`${replacement.id} may supersede ${targetId} only when target coverage is a non-empty subset of replacement coverage`);
            }
            const missingCoverageMetadata = [...targetCoverage].filter((coverageId) => !registryEntry(coverageRegistry, coverageId));
            if (missingCoverageMetadata.length > 0)
            {
                errors.push(`${replacement.id} cannot validate ${targetId} without coverage registry metadata for ${missingCoverageMetadata.join(',')}`);
            }

            const protectedText = [
                target.id,
                target.executionKey,
                target.command,
                ...(target.coverage ?? [])
            ].filter(Boolean).join(' ');
            const protectedByRegistry = [...targetCoverage].some((coverageId) =>
            {
                const assertionType = registryEntry(coverageRegistry, coverageId)?.assertionType;
                return assertionType && assertionType !== 'unit';
            });
            if (
                target.resourceClass === 'benchmark'
        || protectedExecutionVariants.has(target.executionVariant)
        || protectedSupersedesPattern.test(protectedText)
        || protectedByRegistry
        || [...targetCoverage].some((coverageId) => protectedAssertionTypes.has(registryEntry(coverageRegistry, coverageId)?.assertionType))
            )
            {
                errors.push(`${replacement.id} must not supersede protected property/model/perf/runtime tier ${targetId}`);
            }
        }
    }

    const visiting = new Set();
    const visited = new Set();
    const visit = (tierId, stack = []) =>
    {
        if (visited.has(tierId))
        {
            return;
        }
        if (visiting.has(tierId))
        {
            errors.push(`supersedes cycle detected: ${[...stack, tierId].join(' -> ')}`);
            return;
        }
        visiting.add(tierId);
        for (const targetId of edges.get(tierId) ?? [])
        {
            visit(targetId, [...stack, tierId]);
        }
        visiting.delete(tierId);
        visited.add(tierId);
    };
    for (const tierId of edges.keys())
    {
        visit(tierId);
    }

    const supersededIds = new Set([...edges.values()].flat());
    for (const tierId of edges.keys())
    {
        if (supersededIds.has(tierId))
        {
            errors.push(`supersedes chain is ambiguous at tier ${tierId}`);
        }
    }

    return errors;
}

export function applySupersedes(tiers)
{
    const selectedIds = new Set(tiers.map((tier) => tier.id));
    const replacementByTarget = new Map();
    for (const replacement of tiers)
    {
        for (const targetId of replacement.supersedes ?? [])
        {
            if (selectedIds.has(targetId))
            {
                replacementByTarget.set(targetId, replacement.id);
            }
        }
    }

    const resolveReplacement = (tierId) =>
    {
        const seen = new Set();
        let current = tierId;
        while (replacementByTarget.has(current) && !seen.has(current))
        {
            seen.add(current);
            current = replacementByTarget.get(current);
        }
        return current;
    };

    return tiers
        .filter((tier) => !replacementByTarget.has(tier.id))
        .map((tier) =>
        {
            const field = 'executionDependsOn' in tier ? 'executionDependsOn' : 'dependsOn';
            return {
                ...tier,
                [field]: [...new Set(tierExecutionDependencies(tier)
                    .map(resolveReplacement)
                    .filter((dependencyId) => dependencyId !== tier.id))],
                ...('requiresEvidenceFrom' in tier ? {
                    requiresEvidenceFrom: [...new Set(tierEvidenceDependencies(tier)
                        .map(resolveReplacement)
                        .filter((dependencyId) => dependencyId !== tier.id))]
                } : {})
            };
        });
}

function tierExecutionDependencies(tier)
{
    return tier?.executionDependsOn ?? tier?.dependsOn ?? [];
}

function tierEvidenceDependencies(tier)
{
    return tier?.requiresEvidenceFrom ?? [];
}

function tierSchedulerDependencies(tier)
{
    return [...new Set([
        ...tierExecutionDependencies(tier),
        ...tierEvidenceDependencies(tier)
    ])];
}

function worktreePaths(root)
{
    const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: 128 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        return [];
    }
    return result.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

function dirtyWorktreeEntries(root)
{
    const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: 128 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        return new Map();
    }
    const records = result.stdout.toString('utf8').split('\0');
    const entries = new Map();
    for (let index = 0; index < records.length; index += 1)
    {
        const record = records[index];
        if (!record)
        {
            continue;
        }
        const status = record.slice(0, 2);
        const relativePath = record.slice(3).replaceAll(path.sep, '/');
        const renamed = status.includes('R') || status.includes('C');
        const originalPath = renamed ? records[++index]?.replaceAll(path.sep, '/') ?? null : null;
        entries.set(relativePath, { status, originalPath });
    }
    return entries;
}

function gitIndexEntries(root)
{
    const result = spawnSync('git', ['ls-files', '--stage', '-z'], {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: 128 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        return new Map();
    }
    const entries = new Map();
    for (const record of result.stdout.toString('utf8').split('\0').filter(Boolean))
    {
        const match = record.match(/^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/);
        if (!match)
        {
            continue;
        }
        const [, mode, objectId, stage, rawPath] = match;
        const relativePath = rawPath.replaceAll(path.sep, '/');
        const values = entries.get(relativePath) ?? [];
        values.push(`${mode}:${objectId}:${stage}`);
        entries.set(relativePath, values);
    }
    return new Map([...entries].map(([relativePath, values]) => [relativePath, values.sort().join('|')]));
}

function pathContentFingerprint(root, relativePath)
{
    const absolutePath = path.join(root, relativePath);
    try
    {
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink())
        {
            return `symlink:${sha256(fs.readlinkSync(absolutePath))}`;
        }
        if (stat.isFile())
        {
            return `file:${sha256(fs.readFileSync(absolutePath))}`;
        }
        if (stat.isDirectory())
        {
            return 'directory';
        }
        return `other:${stat.mode}`;
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
        {
            return 'missing';
        }
        throw error;
    }
}

export async function snapshotGitWorktree(root)
{
    const dirtyEntries = dirtyWorktreeEntries(root);
    const indexEntries = gitIndexEntries(root);
    let hashedPathCount = 0;
    const entries = {};
    for (const [relativePath, statusEntry] of [...dirtyEntries].sort(([left], [right]) => left.localeCompare(right)))
    {
        const absolutePath = path.join(root, relativePath);
        let mode = null;
        let content = 'missing';
        try
        {
            const stat = fs.lstatSync(absolutePath);
            mode = stat.mode;
            content = pathContentFingerprint(root, relativePath);
            if (stat.isFile() || stat.isSymbolicLink())
            {
                hashedPathCount += 1;
            }
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw error;
            }
        }
        entries[relativePath] = {
            status: statusEntry.status,
            originalPath: statusEntry.originalPath,
            mode,
            index: indexEntries.get(relativePath) ?? null,
            content
        };
    }
    return { entries, fingerprint: fingerprint(entries), hashedPathCount };
}

export async function snapshotSourceState(root)
{
    const snapshot = await snapshotGitWorktree(root);
    return {
        commit: gitHead(root),
        worktreeFingerprint: snapshot.fingerprint
    };
}

export async function collectSchedulerSourceState(root, { snapshotWorktree = () => snapshotGitWorktree(root) } = {})
{
    const snapshot = await snapshotWorktree();
    const envCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const envFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    return {
        sourceState: {
            commit: envCommit || gitHead(root) || 'unversioned',
            worktreeFingerprint: envFingerprint || snapshot.fingerprint
        },
        snapshot
    };
}

function changedSnapshotPaths(before, after)
{
    const beforeEntries = before?.entries ?? {};
    const afterEntries = after?.entries ?? {};
    const paths = new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)]);
    return [...paths].filter((item) => fingerprint(beforeEntries[item]) !== fingerprint(afterEntries[item])).sort();
}

function wildcardPattern(value)
{
    const normalized = value.replaceAll('\\', '/');
    let source = '';
    for (let index = 0; index < normalized.length; index += 1)
    {
        const character = normalized[index];
        if (character === '*' && normalized[index + 1] === '*')
        {
            if (normalized[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
        }
        else if (character === '*')
        {
            source += '[^/]*';
        }
        else if (character === '?')
        {
            source += '[^/]';
        }
        else
        {
            source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

function hasWildcard(value)
{
    return value.includes('*') || value.includes('?');
}

function walkOutputPaths(rootDirectory)
{
    const paths = [];
    const visit = (absolutePath) =>
    {
        let stat;
        try
        {
            stat = fs.lstatSync(absolutePath);
        }
        catch (error)
        {
            if (error.code === 'ENOENT')
            {
                return;
            }
            throw error;
        }
        paths.push(absolutePath);
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            return;
        }
        for (const name of fs.readdirSync(absolutePath).sort())
        {
            visit(path.join(absolutePath, name));
        }
    };
    visit(rootDirectory);
    return paths;
}

function outputPathFingerprint(absolutePath)
{
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink())
    {
        return `symlink:${sha256(fs.readlinkSync(absolutePath))}`;
    }
    if (stat.isFile())
    {
        return `file:${stat.mode}:${stat.size}:${sha256(fs.readFileSync(absolutePath))}`;
    }
    if (!stat.isDirectory())
    {
        return `other:${stat.mode}:${stat.size}`;
    }
    const entries = fs.readdirSync(absolutePath).sort().map((name) => [name, outputPathFingerprint(path.join(absolutePath, name))]);
    return `directory:${fingerprint(entries)}`;
}

function wildcardSearchRoot(root, pattern)
{
    const wildcardIndex = pattern.search(/[?*]/u);
    const prefix = wildcardIndex < 0 ? pattern : pattern.slice(0, wildcardIndex);
    const directoryPrefix = prefix.endsWith('/') ? prefix : path.posix.dirname(prefix);
    const absolutePath = path.resolve(root, directoryPrefix === '.' ? '' : directoryPrefix);
    return absolutePath.startsWith(`${root}${path.sep}`) || absolutePath === root ? absolutePath : root;
}

export function aggregateArtifactPathExists({ root: rootValue, downloadedRoot: downloadedRootValue, declaration })
{
    const root = path.resolve(rootValue);
    const downloadedRoot = path.resolve(downloadedRootValue);
    const normalized = String(declaration ?? '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/^\.\//u, '')
        .replaceAll('\\', '/');
    if (!normalized || path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        return false;
    }

    const direct = path.resolve(root, normalized);
    if (direct.startsWith(`${root}${path.sep}`) || direct === root)
    {
        if (!hasWildcard(normalized) && fs.existsSync(direct))
        {
            return true;
        }
        if (hasWildcard(normalized))
        {
            const matcher = wildcardPattern(normalized);
            const searchRoot = wildcardSearchRoot(root, normalized);
            if (fs.existsSync(searchRoot) && walkOutputPaths(searchRoot).some((candidate) => (
                matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/'))
            )))
            {
                return true;
            }
        }
    }

    if (!fs.existsSync(downloadedRoot))
    {
        return false;
    }
    const downloadedPaths = walkOutputPaths(downloadedRoot)
        .map((candidate) => path.relative(downloadedRoot, candidate).replaceAll(path.sep, '/'));
    if (hasWildcard(normalized))
    {
        const suffixMatcher = wildcardPattern(`**/${normalized}`);
        return downloadedPaths.some((candidate) => suffixMatcher.test(candidate));
    }
    return downloadedPaths.some((candidate) => candidate === normalized || candidate.endsWith(`/${normalized}`));
}

export function snapshotTierOutputs(rootValue, tier, env = process.env)
{
    const root = path.resolve(rootValue);
    const declarations = [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])].map(String))].sort();
    const entries = {};
    let reusable = true;
    for (const declaration of declarations)
    {
        const normalized = declaration.replace(/^\.\//u, '').replaceAll('\\', '/');
        const resolvedDeclaration = resolveRunBoundArtifactDeclaration(root, normalized, env);
        const matcher = wildcardPattern(resolvedDeclaration);
        const absoluteDeclaration = path.resolve(root, resolvedDeclaration);
        if (!absoluteDeclaration.startsWith(`${root}${path.sep}`) && absoluteDeclaration !== root)
        {
            entries[normalized] = 'outside-root';
            reusable = false;
            continue;
        }
        if (!hasWildcard(resolvedDeclaration))
        {
            if (!fs.existsSync(absoluteDeclaration))
            {
                entries[normalized] = 'missing';
                reusable = false;
            }
            else
            {
                entries[normalized] = outputPathFingerprint(absoluteDeclaration);
            }
            continue;
        }

        const searchRoot = wildcardSearchRoot(root, resolvedDeclaration);
        const matches = fs.existsSync(searchRoot)
            ? walkOutputPaths(searchRoot)
        .map((absolutePath) => path.relative(root, absolutePath).replaceAll(path.sep, '/'))
        .filter((relativePath) => matcher.test(relativePath))
        .sort()
            : [];
        if (matches.length === 0)
        {
            entries[normalized] = 'missing-wildcard';
            reusable = false;
        }
        else
        {
            entries[normalized] = matches.map((relativePath) => [relativePath, outputPathFingerprint(path.join(root, relativePath))]);
        }
    }
    return { entries, fingerprint: fingerprint(entries), reusable };
}

function generatedOutputDeclaration(value)
{
    const normalized = String(value ?? '').replace(/^\.\//u, '').replaceAll('\\', '/');
    return normalized.startsWith('.tmp/')
    || normalized.startsWith('src/frontend/test-results/')
    || normalized.startsWith('src/frontend/playwright-report/')
    || normalized.startsWith('src/frontend/coverage/');
}

function declarationPrefix(value)
{
    const normalized = String(value ?? '').replace(/^\.\//u, '').replaceAll('\\', '/');
    const wildcardIndex = normalized.search(/[?*]/u);
    return (wildcardIndex < 0 ? normalized : normalized.slice(0, wildcardIndex)).replace(/\/$/u, '');
}

function declarationsOverlap(left, right)
{
    const leftPrefix = declarationPrefix(left);
    const rightPrefix = declarationPrefix(right);
    return leftPrefix === rightPrefix
    || leftPrefix.startsWith(`${rightPrefix}/`)
    || rightPrefix.startsWith(`${leftPrefix}/`);
}

function ownedGeneratedDeclarations(tier, byId)
{
    if (/tools\/test\/lanes\/noop\.sh\b/u.test(String(tier.command)))
    {
        return [];
    }
    const dependencyDeclarations = [];
    const visitedDependencies = new Set([tier.id]);
    const collectDependencyDeclarations = (dependencyId) =>
    {
        if (visitedDependencies.has(dependencyId))
        {
            return;
        }
        visitedDependencies.add(dependencyId);
        const dependency = byId.get(dependencyId);
        if (!dependency)
        {
            return;
        }
        dependencyDeclarations.push(...(dependency.artifacts ?? []), ...(dependency.evidence ?? []));
        for (const ancestorId of tierSchedulerDependencies(dependency))
        {
            collectDependencyDeclarations(ancestorId);
        }
    };
    for (const dependencyId of tierSchedulerDependencies(tier))
    {
        collectDependencyDeclarations(dependencyId);
    }
    const candidates = [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])])]
        .filter(generatedOutputDeclaration)
        .filter((declaration) => !dependencyDeclarations.some((dependency) => declarationsOverlap(declaration, dependency)));
    return candidates.filter((declaration) =>
    {
        if (hasWildcard(String(declaration)))
        {
            return true;
        }
        const prefix = declarationPrefix(declaration);
        return !candidates.some((other) => other !== declaration && declarationPrefix(other).startsWith(`${prefix}/`));
    });
}

function outputProvenance(root, declarations, env = process.env)
{
    const entries = {};
    for (const declaration of declarations)
    {
        const normalized = String(declaration).replace(/^\.\//u, '').replaceAll('\\', '/');
        const resolvedDeclaration = resolveRunBoundArtifactDeclaration(root, normalized, env);
        const matcher = wildcardPattern(resolvedDeclaration);
        const absolute = path.resolve(root, resolvedDeclaration);
        const matches = hasWildcard(resolvedDeclaration)
            ? (fs.existsSync(wildcardSearchRoot(root, resolvedDeclaration))
          ? walkOutputPaths(wildcardSearchRoot(root, resolvedDeclaration)).filter((candidate) => matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/')))
          : [])
            : (fs.existsSync(absolute) ? [absolute] : []);
        for (const candidate of matches.sort())
        {
            const relativePath = path.relative(root, candidate).replaceAll(path.sep, '/');
            const stat = fs.lstatSync(candidate);
            entries[relativePath] = {
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
                size: stat.size,
                fingerprint: outputPathFingerprint(candidate)
            };
        }
    }
    return { entries, fingerprint: fingerprint(entries) };
}

function cleanFreshOwnedFiles(root, declarations, env = process.env)
{
    for (const declaration of declarations)
    {
        const normalized = String(declaration).replace(/^\.\//u, '').replaceAll('\\', '/');
        const resolvedDeclaration = resolveRunBoundArtifactDeclaration(root, normalized, env);
        if (hasWildcard(resolvedDeclaration))
        {
            const searchRoot = wildcardSearchRoot(root, resolvedDeclaration);
            if (!fs.existsSync(searchRoot))
            {
                continue;
            }
            const matcher = wildcardPattern(resolvedDeclaration);
            const matches = walkOutputPaths(searchRoot)
                .filter((candidate) => matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/')))
                .sort((left, right) => right.length - left.length);
            for (const candidate of matches)
            {
                fs.rmSync(candidate, { recursive: true, force: true });
            }
            continue;
        }
        const absolute = path.resolve(root, resolvedDeclaration);
        if (fs.existsSync(absolute))
        {
            fs.rmSync(absolute, { recursive: true, force: true });
        }
    }
}

function cacheInputEntries(root, patterns)
{
    if (!Array.isArray(patterns) || patterns.length === 0)
    {
        return {};
    }
    const candidates = worktreePaths(root);
    const entries = {};
    for (const rawPattern of patterns)
    {
        const pattern = String(rawPattern).replace(/^\.\//, '').replaceAll('\\', '/');
        const absolutePath = path.resolve(root, pattern);
        if (!pattern.includes('*') && !pattern.includes('?') && fs.existsSync(absolutePath))
        {
            const stat = fs.statSync(absolutePath);
            if (stat.isDirectory())
            {
                const prefix = `${pattern.replace(/\/$/, '')}/`;
                for (const candidate of candidates.filter((item) => item.startsWith(prefix)))
                {
                    entries[candidate] = pathContentFingerprint(root, candidate);
                }
            }
            else
            {
                entries[pattern] = pathContentFingerprint(root, pattern);
            }
            continue;
        }
        const matcher = wildcardPattern(pattern);
        const matches = candidates.filter((candidate) => matcher.test(candidate));
        if (matches.length === 0)
        {
            entries[pattern] = 'missing';
        }
        for (const candidate of matches)
        {
            entries[candidate] = pathContentFingerprint(root, candidate);
        }
    }
    return entries;
}

function repositoryInputFingerprint(root)
{
    const entries = {};
    for (const relativePath of worktreePaths(root))
    {
        entries[relativePath] = pathContentFingerprint(root, relativePath);
    }
    return fingerprint(entries);
}

function commandInputPath(command)
{
    const tokens = String(command ?? '').match(/(?:"[^"]*"|'[^']*'|\S+)/gu)?.map((token) => token.replace(/^['"]|['"]$/gu, '')) ?? [];
    return tokens.find((token, index) => (
    index === 0
        ? /^(?:\.\/)?(?:tools|tests|src)\//u.test(token)
        : /^(?:\.\/)?(?:tools|tests|src)\/.*\.(?:mjs|js|sh|ts)$/u.test(token)
    ))?.replace(/^\.\//u, '') ?? null;
}

export function effectiveCacheInputs(tier)
{
    const hasDeclaredInputs = (tier.cacheInputs?.length ?? 0) > 0;
    const inputs = new Set((tier.cacheInputs ?? []).map(String));
    inputs.add('tests/matrix.yml');
    inputs.add('tests/coverage-registry.json');
    const commandPath = commandInputPath(tier.command);
    if (commandPath)
    {
        inputs.add(commandPath);
    }
    if (!hasDeclaredInputs)
    {
        for (const value of [...(tier.triggerPaths ?? []), ...(tier.triggerFiles ?? [])])
        {
            inputs.add(String(value));
        }
    }

    if (tier.id === 'coverage-frontend' || String(tier.id).startsWith('frontend-'))
    {
        for (const value of ['src/frontend/package.json', 'tests/frontend', 'src/frontend/vitest*.config.ts', 'src/frontend/vitest.shared.mjs'])
        {
            inputs.add(value);
        }
    }

    const dependencyOnlyAggregate = tierExecutionDependencies(tier).length > 0 && /tools\/test\/lanes\/noop\.sh\b/u.test(String(tier.command));
    if (!hasDeclaredInputs && !dependencyOnlyAggregate && (tier.triggerPaths?.length ?? 0) === 0 && (tier.triggerFiles?.length ?? 0) === 0)
    {
        inputs.add('tools');
        const backend = tier.requiresDotnet === true || tier.owner === 'ServerContractAgent' || ['backend', 'full'].includes(tier.cacheProfile);
        const frontend = tier.requiresNode === true || tier.owner === 'InteropGlueAgent' || ['frontend', 'full'].includes(tier.cacheProfile);
        if (backend)
        {
            for (const value of ['Directory.Build.props', 'Directory.Packages.props', 'FsusBlog.slnx', 'global.json', 'src/backend', 'src/core', 'src/shared', 'tests/backend'])
            {
                inputs.add(value);
            }
        }
        if (frontend)
        {
            for (const value of ['src/frontend/package.json', 'src/frontend/package-lock.json', 'src/frontend/src', 'tests/frontend'])
            {
                inputs.add(value);
            }
        }
        if (/governance|evidence|security|privacy|perception|release|quality/u.test(String(tier.id)))
        {
            for (const value of ['.github', 'docs', 'security'])
            {
                inputs.add(value);
            }
        }
    }
    return [...inputs].sort();
}

function fingerprintEnvironment(env)
{
    return Object.fromEntries(Object.entries(env ?? {})
        .filter(([key]) => !['FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT'].includes(key))
        .filter(([key]) => !orchestrationOnlyFingerprintEnvironmentKeys.has(key))
        .filter(([key]) => fingerprintEnvironmentKeys.has(key) || fingerprintEnvironmentPrefixes.some((prefix) => key.startsWith(prefix)))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, String(value)]));
}

export function tierInputFingerprint(tier, root, context = {})
{
    const declaredCacheInputs = effectiveCacheInputs(tier);
    const inputManifest = context.inputManifest
        ? validateCorrectnessInputManifest(context.inputManifest, { root, entryCommand: tier.command }) : null;
    return fingerprint({
        executionKey: tier.executionKey ?? tier.id,
        command: tier.command,
        cacheInputs: declaredCacheInputs,
        ...(inputManifest ? { inputManifestDigest: inputManifest.closureDigest } : {}),
        inputs: declaredCacheInputs.length > 0
            ? cacheInputEntries(root, declaredCacheInputs)
            : { conservativeRepositoryFingerprint: context.repositoryFingerprint ?? repositoryInputFingerprint(root) },
        runtime: {
            environment: fingerprintEnvironment(context.env ?? process.env),
            platform: context.platform ?? process.platform,
            arch: context.arch ?? process.arch,
            nodeVersion: context.nodeVersion ?? process.version
        }
    });
}

function normalizeExecutionResult(value)
{
    if (typeof value === 'number')
    {
        return { code: value, signal: null };
    }
    return {
        code: value?.code ?? value?.status ?? 0,
        signal: value?.signal ?? null,
        error: value?.error ?? null,
        physicalExecutionTermination: value?.physicalExecutionTermination ?? null
    };
}

function signalProcessTree(child, signal)
{
    if (!child)
    {
        return;
    }
    if (process.platform === 'win32' && child.pid)
    {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        return;
    }
    if (process.platform !== 'win32' && child.pid)
    {
        try
        {
            // The process-group leader (the shell created by spawn(..., { shell: true }))
            // can exit on SIGTERM while a descendant keeps the inherited output pipes
            // open.  The group remains addressable after its leader exits, so always
            // signal the saved pgid instead of treating the leader exit as tree exit.
            process.kill(-child.pid, signal);
            return;
        }
        catch (error)
        {
            if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null)
            {
                child.kill(signal);
            }
            return;
        }
    }

    if (child.exitCode === null && child.signalCode === null)
    {
        child.kill(signal);
    }
}

function durableSubprocessSpec(tier, { root, env })
{
    const authorityId = crypto.randomUUID();
    if (process.platform === 'linux')
    {
        const unitName = `fsusblog-build-${sha256(`${process.pid}:${authorityId}:${tier.id}`).slice(0, 32)}`;
        const setEnvironment = Object.entries(env)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) =>
            {
                const normalized = String(value);
                if (normalized.includes('\0') || normalized.includes('\n'))
                {
                    throw new Error(`durable process containment cannot encode environment variable ${key}`);
                }
                return `--setenv=${key}=${normalized}`;
            });
        return {
            command: 'systemd-run',
            args: [
                '--user',
                '--quiet',
                '--wait',
                '--pipe',
                '--collect',
                '--service-type=exec',
                '--property=KillMode=control-group',
                `--working-directory=${root}`,
                `--unit=${unitName}`,
                ...setEnvironment,
                '/bin/bash',
                '-lc',
                tier.command
            ],
            authority: {
                schema: 'fsusblog.durable-process-containment.v1',
                platform: 'linux',
                kind: 'systemd-transient-service',
                authorityId,
                unitName,
                killPolicy: 'control-group',
                createdAt: new Date().toISOString()
            }
        };
    }
    if (process.platform === 'win32')
    {
        const supervisorScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-job-supervisor.ps1');
        const jobName = `Local\\FsusBlog-${authorityId}`;
        const handshakeRoot = path.join(os.tmpdir(), `fsusblog-job-${authorityId}`);
        fs.mkdirSync(handshakeRoot, { mode: 0o700 });
        const readyFile = path.join(handshakeRoot, 'ready');
        const startFile = path.join(handshakeRoot, 'start');
        return {
            command: 'powershell.exe',
            args: [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                supervisorScript,
                '-JobName',
                jobName,
                '-ReadyFile',
                readyFile,
                '-StartFile',
                startFile,
                '-WorkingDirectory',
                root,
                '-CommandBase64',
                Buffer.from(tier.command, 'utf16le').toString('base64')
            ],
            authority: {
                schema: 'fsusblog.durable-process-containment.v1',
                platform: 'win32',
                kind: 'windows-job-object',
                authorityId,
                jobName,
                killPolicy: 'kill-on-job-close',
                supervisorScriptDigest: `sha256:${sha256(fs.readFileSync(supervisorScript))}`,
                readyFile,
                startFile,
                handshakeRoot,
                createdAt: new Date().toISOString()
            }
        };
    }
    if (process.platform === 'darwin')
    {
        return {
            command: '/bin/bash',
            args: ['-lc', tier.command],
            authority: {
                schema: 'fsusblog.durable-process-containment.v1',
                platform: 'darwin',
                kind: 'darwin-process-group',
                authorityId,
                killPolicy: 'process-group-with-descendant-ledger',
                createdAt: new Date().toISOString()
            }
        };
    }
    throw new Error(`durable process containment is unavailable on ${process.platform}`);
}

async function waitForSuspendedProcess(child)
{
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline)
    {
        if (child.exitCode !== null || child.signalCode !== null)
        {
            throw new Error('scheduler child exited before its registration handshake completed');
        }
        try
        {
            if (process.platform === 'linux')
            {
                const value = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
                const close = value.lastIndexOf(')');
                if (
                    close >= 0 &&
                    value
                        .slice(close + 2)
                        .trim()
                        .split(/\s+/u)[0] === 'T'
                )
                {
                    return;
                }
            }
            else if (process.platform === 'darwin')
            {
                const state = spawnSync('ps', ['-o', 'state=', '-p', String(child.pid)], {
                    encoding: 'utf8'
                }).stdout.trim();
                if (state.startsWith('T'))
                {
                    return;
                }
            }
            else
            {
                throw new Error('scheduler registration handshake is unavailable on this platform');
            }
        }
        catch (error)
        {
            if (error?.code !== 'ENOENT')
            {
                throw error;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('timed out waiting for scheduler child registration handshake');
}

async function waitForFile(file, child)
{
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline)
    {
        if (fs.existsSync(file))
        {
            return;
        }
        if (child.exitCode !== null || child.signalCode !== null)
        {
            throw new Error('durable process supervisor exited before its registration handshake completed');
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('timed out waiting for durable process containment handshake');
}

function beginSubprocess(
    tier,
    { root, env, outputPipeline, terminationGraceMs, suspendForAttach = false, durableContainment = false }
)
{
    const durableSpec = durableContainment ? durableSubprocessSpec(tier, { root, env }) : null;
    const suspendedEntry = suspendForAttach && process.platform !== 'win32';
    let child;
    if (suspendedEntry)
    {
        child = spawn(
            '/bin/bash',
            [
                '-c',
                'kill -STOP $$; exec "$@"',
                'fsusblog-contained-entry',
                durableSpec?.command ?? '/bin/bash',
                ...(durableSpec?.args ?? ['-lc', tier.command])
            ],
            {
                cwd: root,
                env,
                shell: false,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            }
        );
    }
    else
    {
        child = spawn(durableSpec?.command ?? tier.command, durableSpec?.args ?? [], {
            cwd: root,
            env,
            shell: durableSpec === null,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
    }
    outputPipeline.attach(child.stdout, 'stdout');
    outputPipeline.attach(child.stderr, 'stderr');

    let settled = false;
    let budgetExpired = false;
    let terminationStarted = false;
    let entryResumed = !suspendedEntry && durableSpec?.authority?.kind !== 'windows-job-object';
    let terminationAuthority = null;
    const tierBudgetMs =
        Number.isFinite(Number(tier.producerExecutionBudgetMs)) &&
        Number(tier.producerExecutionBudgetMs) > 0
            ? Number(tier.producerExecutionBudgetMs)
            : Number.isFinite(Number(tier.budgetMs)) && Number(tier.budgetMs) > 0
              ? Number(tier.budgetMs)
              : null;
    let budgetTimer = null;
    let escalationTimer = null;
    let forcedSettleTimer = null;
    let resolvePromise = null;

    const closePipes = () =>
    {
        for (const stream of [child.stdin, child.stdout, child.stderr])
        {
            stream?.destroy();
        }
    };
    const settle = (result) =>
    {
        if (settled)
        {
            return;
        }
        settled = true;
        if (budgetTimer)
        {
            clearTimeout(budgetTimer);
        }
        if (escalationTimer)
        {
            clearTimeout(escalationTimer);
        }
        if (forcedSettleTimer)
        {
            clearTimeout(forcedSettleTimer);
        }
        resolvePromise(result);
    };
    const timeoutResult = () => ({
        code: 124,
        signal: null,
        timeoutPhase: tier.producerTimeoutPhase ?? 'termination',
        error: new Error(`bundle budget exceeded (${tierBudgetMs}ms)`)
    });
    const beginTermination = () =>
    {
        if (settled || terminationStarted)
        {
            return;
        }
        terminationStarted = true;
        if (process.platform !== 'win32')
        {
            const leader = collectProcessIdentity(child.pid);
            const processGroupAuthority = leader.status === 'verified'
                ? {
                    schema: 'fsusblog.process-group-or-job-identity.v1',
                    platform: process.platform,
                    kind: 'process-group',
                    groupId: child.pid,
                    leaderPid: child.pid,
                    leaderProcessStartIdentity: leader.processStartIdentity
                }
                : null;
            if (suspendedEntry && !entryResumed)
            {
                // The service does not exist yet. Never resume its launcher merely to clean up a rejected admission.
                terminationAuthority = processGroupAuthority;
                const termination = terminatePhysicalExecutionAuthoritySync({
                    authority: terminationAuthority,
                    expectedIdentities: leader.status === 'verified' ? [leader] : [],
                    reason: budgetExpired ? 'producer-deadline-before-admission' : 'scheduler-cancel-before-admission',
                    policy: { ...loadPhysicalExecutionProcessPolicy(), gracefulTerminationMs: 0 }
                });
                closePipes();
                settle({
                    ...(budgetExpired ? timeoutResult() : { code: 1, signal: 'SIGKILL' }),
                    physicalExecutionTermination: termination,
                    ...(termination.terminated ? {} : {
                        error: new Error(`unreleased launcher termination failed closed: ${termination.reason}`)
                    })
                });
                return;
            }
            const authority = durableSpec?.authority?.kind === 'darwin-process-group'
                ? processGroupAuthority
                : durableSpec?.authority ?? (
                leader.status === 'verified'
                    ? processGroupAuthority
                    : null
            );
            terminationAuthority = authority;
            if (durableSpec?.authority?.kind !== 'systemd-transient-service')
            {
                signalProcessTree(child, 'SIGTERM');
                escalationTimer = setTimeout(() =>
                {
                    signalProcessTree(child, 'SIGKILL');
                    closePipes();
                    forcedSettleTimer = setTimeout(() =>
                    {
                        const termination = terminatePhysicalExecutionAuthoritySync({
                            authority: terminationAuthority,
                            reason: budgetExpired ? 'producer-deadline' : 'scheduler-cancel',
                            policy: {
                                ...loadPhysicalExecutionProcessPolicy(),
                                gracefulTerminationMs: 0
                            }
                        });
                        settle({
                            ...(budgetExpired ? timeoutResult() : { code: 1, signal: 'SIGKILL' }),
                            physicalExecutionTermination: termination,
                            logComplete: false,
                            logTruncationReason: 'forced-pipe-close-after-sigkill',
                            ...(termination.terminated
                                ? {}
                                : {
                                    error: new Error(
                                        `physical execution termination failed closed: ${termination.reason}`
                                    )
                                })
                        });
                    }, Math.max(25, Math.min(250, terminationGraceMs || 25)));
                }, terminationGraceMs);
                return;
            }
            const physicalPolicy = {
                ...loadPhysicalExecutionProcessPolicy(),
                gracefulTerminationMs: terminationGraceMs
            };
            const termination = terminatePhysicalExecutionAuthoritySync({
                authority,
                reason: budgetExpired ? 'producer-deadline' : 'scheduler-cancel',
                policy: physicalPolicy
            });
            closePipes();
            settle({
                ...(budgetExpired ? timeoutResult() : { code: 1, signal: 'SIGTERM' }),
                physicalExecutionTermination: termination,
                ...(termination.terminated
                    ? {}
                    : {
                        error: new Error(
                            `physical execution termination failed closed: ${termination.reason}`
                        )
                    })
            });
            return;
        }
        signalProcessTree(child, 'SIGTERM');
        escalationTimer = setTimeout(() =>
        {
            // Do not rely on ChildProcess.close here: a descendant may have survived
            // the shell and still own its inherited stdout/stderr descriptors.
            signalProcessTree(child, 'SIGKILL');
            closePipes();
            const pipeCloseGraceMs = Math.max(25, Math.min(250, terminationGraceMs || 25));
            forcedSettleTimer = setTimeout(() =>
            {
                settle({
                    ...(budgetExpired ? timeoutResult() : { code: 1, signal: 'SIGKILL' }),
                    logComplete: false,
                    logTruncationReason: 'forced-pipe-close-after-sigkill'
                });
            }, pipeCloseGraceMs);
        }, terminationGraceMs);
    };
    const promise = new Promise((resolve) =>
    {
        resolvePromise = resolve;
        child.once('error', (error) =>
        {
            closePipes();
            settle({ code: 1, signal: null, error });
        });
        child.once('close', (code, signal) =>
        {
            if (terminationStarted && process.platform !== 'win32' && terminationAuthority)
            {
                const termination = terminatePhysicalExecutionAuthoritySync({
                    authority: terminationAuthority,
                    reason: budgetExpired ? 'producer-deadline' : 'scheduler-cancel',
                    policy: {
                        ...loadPhysicalExecutionProcessPolicy(),
                        gracefulTerminationMs: 0
                    }
                });
                settle({
                    ...(budgetExpired ? timeoutResult() : { code: code ?? 1, signal }),
                    physicalExecutionTermination: termination,
                    ...(termination.terminated
                        ? {}
                        : {
                            error: new Error(
                                `physical execution termination failed closed: ${termination.reason}`
                            )
                        })
                });
                return;
            }
            settle(budgetExpired ? timeoutResult() : { code: code ?? 1, signal });
        });
        if (tierBudgetMs !== null)
        {
            budgetTimer = setTimeout(() =>
            {
                if (settled)
                {
                    return;
                }
                budgetExpired = true;
                beginTermination();
            }, tierBudgetMs);
            budgetTimer.unref?.();
        }
    });

    let registrationReady = Promise.resolve();
    if (suspendedEntry)
    {
        registrationReady = waitForSuspendedProcess(child);
    }
    else if (durableSpec?.authority?.kind === 'windows-job-object')
    {
        registrationReady = waitForFile(durableSpec.authority.readyFile, child);
    }
    return {
        child,
        containmentAuthority: durableSpec?.authority ?? null,
        promise,
        registrationReady,
        resume()
        {
            if (terminationStarted || settled)
            {
                return false;
            }
            if (suspendedEntry)
            {
                child.kill('SIGCONT');
            }
            if (durableSpec?.authority?.kind === 'windows-job-object')
            {
                fs.writeFileSync(durableSpec.authority.startFile, `${durableSpec.authority.authorityId}\n`, {
                    mode: 0o600
                });
            }
            entryResumed = true;
            return true;
        },
        terminate()
        {
            beginTermination();
        },
        cleanupContainmentHandshake()
        {
            if (durableSpec?.authority?.kind === 'windows-job-object')
            {
                fs.rmSync(durableSpec.authority.handshakeRoot, { recursive: true, force: true });
            }
        }
    };
}

function beginResourceService(tier, { root, env, outputPipeline, boundary, resourceContext, processOwner, terminationGraceMs, residualRoot })
{
    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    outputPipeline.attach(stdout, 'stdout');
    outputPipeline.attach(stderr, 'stderr');
    const drained = Promise.all([finished(stdout, { cleanup: true }), finished(stderr, { cleanup: true })]);
    drained.catch(() =>
    {});
    let resolveRegistration;
    let rejectRegistration;
    let release;
    let rootPid = null;
    let budgetExpired = false;
    const registrationReady = new Promise((resolve, reject) =>
    {
        resolveRegistration = resolve;
        rejectRegistration = reject;
    });
    registrationReady.catch(() =>
    {});
    const releaseReady = new Promise((resolve) =>
    {
        release = resolve;
    });
    const terminate = (reason = new Error('scheduler cancelled resource-bound execution')) =>
    {
        controller.abort(reason);
        release();
    };
    const removeLogFailure = outputPipeline.onFailure((error) =>
    {
        terminate(error);
        stdout.destroy(error);
        stderr.destroy(error);
    });
    const tierBudgetMs = Number.isFinite(Number(tier.producerExecutionBudgetMs)) && Number(tier.producerExecutionBudgetMs) > 0
        ? Number(tier.producerExecutionBudgetMs)
        : Number.isFinite(Number(tier.budgetMs)) && Number(tier.budgetMs) > 0 ? Number(tier.budgetMs) : null;
    const budgetTimer = tierBudgetMs === null ? null : setTimeout(() =>
    {
        budgetExpired = true;
        terminate(new Error(`bundle budget exceeded (${tierBudgetMs}ms)`));
    }, tierBudgetMs);
    budgetTimer?.unref?.();
    const promise = (async () =>
    {
        let result;
        let evidence;
        try
        {
            evidence = await runPhysicalExecution({ command: ['/bin/bash', '-lc', tier.command], cwd: root, env,
                resourceBoundary: boundary, resourceContext, residualRoot,
                residentServiceOutput: tier.residentLeaseProducer === true,
                processOwner: { ...processOwner, async register(identity, authority)
                {
                    const receipt = await processOwner.register(identity, authority);
                    rootPid ??= identity.pid;
                    resolveRegistration({ identity, authority, receipt });
                    await releaseReady;
                    if (controller.signal.aborted)
                    {
                        throw controller.signal.reason;
                    }
                    return receipt;
                } },
                policy: { ...loadPhysicalExecutionProcessPolicy(), gracefulTerminationMs: terminationGraceMs },
                signal: controller.signal, stdout, stderr });
            result = { code: 0, signal: null };
        }
        catch (error)
        {
            evidence = error.physicalExecution;
            const timeoutPhase = controller.signal.reason?.timeoutPhase === 'global' ? 'global'
                : budgetExpired ? tier.producerTimeoutPhase ?? 'termination' : null;
            result = { code: timeoutPhase ? 124 : error.exitCode ?? 1, signal: error.signal ?? null, error,
                ...(timeoutPhase ? { timeoutPhase } : {}) };
        }
        finally
        {
            if (budgetTimer)
            {
                clearTimeout(budgetTimer);
            }
            stdout.end();
            stderr.end();
            try
            {
                await drained;
            }
            catch (error)
            {
                result = { ...result, code: result?.code || 1, error: result?.error ?? error,
                    logComplete: false, logTruncationReason: 'writer-error' };
            }
            removeLogFailure();
        }
        rejectRegistration(result.error ?? new Error('resource-bound execution ended before registration'));
        return { ...result,
            physicalExecutionTermination: { terminated: evidence?.postObservation === 'zero-members',
                postObservation: evidence?.postObservation ?? 'unverifiable',
                reason: evidence?.cleanup?.reason ?? (result.error?.message ?? 'completed') },
            physicalExecutionAuthority: evidence?.containmentAuthority ?? null,
            physicalExecutionNested: evidence?.nestedExecution ?? null,
            resourceExecutionAdmission: evidence?.resourceExecutionAdmission ?? null,
            logComplete: result.logComplete !== false && evidence?.logComplete === true,
            logTruncationReason: result.logTruncationReason ?? evidence?.logTruncationReason ?? null };
    })();
    return { promise, registrationReady, resume: release, terminate, ownsProcessTree: true,
        signal: controller.signal,
        get rootPid()
        {
            return rootPid;
        } };
}

/** Re-read real resident PID identities and cgroup ancestry before an enforced handoff or grant update. */
export function verifyResidentProcessResourceScope(inventory, expectedPath, { serviceControlGroup = null } = {})
{
    if (inventory.enforcement?.mode !== 'enforced')
    {
        return { status: 'not-enforced', processes: [] };
    }
    if (process.platform !== 'linux' || !path.isAbsolute(expectedPath ?? '')
        || inventory.enforcement.processScope?.path !== expectedPath
        || path.resolve(expectedPath) !== expectedPath || fs.realpathSync(expectedPath) !== expectedPath)
    {
        throw new Error('resident process enforcement scope differs from its actual Linux resource ancestor');
    }
    const relative = path.relative('/sys/fs/cgroup', expectedPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`))
    {
        throw new Error('resident process enforcement scope is outside cgroup v2');
    }
    const expectedGroup = `/${relative.split(path.sep).join('/')}`;
    if (serviceControlGroup !== null && (typeof serviceControlGroup !== 'string'
        || !serviceControlGroup.startsWith(`${expectedGroup}/`)
        || serviceControlGroup.endsWith('/') || serviceControlGroup.includes('//')))
    {
        throw new Error('resident service cgroup differs from its enforced resource ancestor');
    }
    const processes = inventory.services.filter((service) => service.kind === 'process').map((service) =>
    {
        const pid = service.identity.pid;
        const startTimeTicks = service.identity.startTimeTicks;
        const readStart = () =>
        {
            let stat;
            try
            {
                stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            }
            catch (error)
            {
                if (error.code === 'ENOENT')
                {
                    return null;
                }
                throw error;
            }
            const closingName = stat.lastIndexOf(')');
            const actual = closingName < 0 ? null : stat.slice(closingName + 2).trim().split(/\s+/u)[19];
            if (!actual)
            {
                throw new Error(`resident process ${service.id} has an invalid kernel identity`);
            }
            return actual;
        };
        const before = readStart();
        if (before === null)
        {
            return { id: service.id, pid, status: 'exited' };
        }
        if (before !== startTimeTicks)
        {
            throw new Error(`resident process ${service.id} identity changed before cgroup read-back`);
        }
        const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
        const group = /^0::(\/[^\n]*)$/u.exec(cgroup)?.[1];
        const after = readStart();
        if (after !== startTimeTicks)
        {
            throw new Error(`resident process ${service.id} identity changed during cgroup read-back`);
        }
        if (!group || (group !== expectedGroup && !group.startsWith(`${expectedGroup}/`)))
        {
            throw new Error(`resident process ${service.id} is outside its enforced resource ancestor`);
        }
        if (serviceControlGroup !== null && group !== serviceControlGroup
            && !group.startsWith(`${serviceControlGroup}/`))
        {
            throw new Error(`resident process ${service.id} is outside its exact bound service`);
        }
        return { id: service.id, pid, status: 'live', cgroup: group };
    });
    return { status: 'verified', expectedPath, processes };
}

/** A resident PID in the bundle slice is insufficient: it must remain in the producer's exact owned service. */
function verifyResidentProcessServiceScope(inventory, expectedPath, authority, expectedContext)
{
    if (!resourceServiceContainmentIsComplete(authority) || !authority.residentOutput
        || !['pre-exec', 'resident-transferred'].includes(authority.phase)
        || fingerprint(authority.serviceBinding.reference.context) !== fingerprint(expectedContext))
    {
        throw new Error('resident process has no exact retained producer service authority');
    }
    const serviceControlGroup = authority.serviceBinding.identity?.controlGroup;
    if (typeof serviceControlGroup !== 'string')
    {
        throw new Error('resident producer service has no retained cgroup identity');
    }
    const scope = verifyResidentProcessResourceScope(inventory, expectedPath, { serviceControlGroup });
    const live = scope.processes.filter((entry) => entry.status === 'live');
    if (live.length > 0)
    {
        const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, {
            commandBudgetMs: authority.commandBudgetMs
        });
        if (observed.status !== 'present' || observed.unit.ActiveState !== 'active'
            || live.some((entry) => !observed.group.processIds.includes(entry.pid)))
        {
            throw new Error('resident process is not live in its exact retained producer service');
        }
    }
    return scope;
}

function defaultSystemResources()
{
    return {
        cpuCount: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
        availableMemoryGiB: availableMemoryGiB(),
        load1: process.platform === 'win32' ? 0 : os.loadavg()[0]
    };
}

function resourceBudget(resources)
{
    const cpuCount = Math.max(1, Number(resources.cpuCount) || 1);
    const load1 = Math.max(0, Number(resources.load1) || 0);
    const explicitCpuUnits = Number(resources.availableCpuUnits);
    return {
        cpuUnits: Number.isFinite(explicitCpuUnits) && explicitCpuUnits > 0
            ? Math.min(cpuCount, explicitCpuUnits)
            : Math.max(1, cpuCount - Math.ceil(load1)),
        memoryGiB: Math.max(0.1, Number(resources.availableMemoryGiB) || 0.1)
    };
}


export function tierResourceUnits(tier)
{
    const cpuUnits = Number(tier.cpuUnits);
    const memoryGiB = Number(tier.memoryGiB);
    if (!Number.isFinite(cpuUnits) || cpuUnits <= 0 || !Number.isFinite(memoryGiB) || memoryGiB <= 0)
    {
        throw new Error(`tier ${tier.id ?? '<unknown>'} has no resolved resource grant`);
    }
    return {
        cpuUnits,
        memoryGiB
    };
}

function activeUsage(activeEntries)
{
    return {
        cpuUnits: activeEntries.reduce((total, entry) => total + tierResourceUnits(entry.tier).cpuUnits, 0),
        memoryGiB: activeEntries.reduce((total, entry) => total + tierResourceUnits(entry.tier).memoryGiB, 0)
    };
}

function criticalPath(tiers, tierResults)
{
    const selectedIds = new Set(tiers.map((tier) => tier.id));
    const paths = new Map();
    for (const tier of tiers)
    {
        const dependencies = tierSchedulerDependencies(tier)
            .filter((dependencyId) => selectedIds.has(dependencyId));
        const longestDependency = dependencies
            .map((dependencyId) => paths.get(dependencyId) ?? { durationMs: 0, tierIds: [] })
            .sort((left, right) => right.durationMs - left.durationMs)[0] ?? { durationMs: 0, tierIds: [] };
        paths.set(tier.id, {
            durationMs: longestDependency.durationMs + Math.max(0, Number(tierResults[tier.id]?.durationMs) || 0),
            tierIds: [...longestDependency.tierIds, tier.id]
        });
    }
    return [...paths.values()].sort((left, right) => right.durationMs - left.durationMs)[0] ?? {
        durationMs: 0,
        tierIds: []
    };
}

function intersects(left, right)
{
    const rightSet = new Set(right ?? []);
    return (left ?? []).some((item) => rightSet.has(item));
}

function canShareAdmission(tier, admittedEntries, maxParallel)
{
    if (admittedEntries.length >= maxParallel)
    {
        return false;
    }
    if (admittedEntries.length > 0 && tier.parallelizable !== true)
    {
        return false;
    }
    if (admittedEntries.some((entry) => entry.tier.parallelizable !== true))
    {
        return false;
    }
    if (admittedEntries.some((entry) => intersects(tier.exclusiveResources, entry.tier.exclusiveResources)))
    {
        return false;
    }
    if (admittedEntries.some((entry) => (
        (tier.services?.length ?? 0) > 0
    && (entry.tier.services?.length ?? 0) > 0
    && intersects(tier.services, entry.tier.services)
    )))
    {
        return false;
    }

    const sameClass = admittedEntries.filter((entry) => entry.tier.resourceClass === tier.resourceClass);
    if (sameClass.length >= Math.max(1, Number(tier.maxParallel) || 1))
    {
        return false;
    }
    if (sameClass.some((entry) => sameClass.length >= Math.max(1, Number(entry.tier.maxParallel) || 1)))
    {
        return false;
    }
    return true;
}

function startupMinCpuUnits(tier)
{
    return Math.max(1, Math.floor(Number(tier.startupMinCpuUnits ?? tier.minCpuUnits) || 1));
}

function steadyMinCpuUnits(tier)
{
    return Math.max(1, Math.floor(Number(tier.minCpuUnits) || 1));
}

function startupMemoryWeight(tier)
{
    return Number(tier.startupMemoryWeight ?? tier.memoryWeight);
}

function weightedIntegerAllocation(
    tiers,
    totalUnits,
    minimumForTier = (tier) => tier.minCpuUnits,
    weightForTier = (tier) => tier.cpuWeight
)
{
    const minimums = tiers.map((tier) => Math.max(1, Math.floor(Number(minimumForTier(tier)) || 1)));
    const minimumTotal = minimums.reduce((total, value) => total + value, 0);
    if (minimumTotal > totalUnits)
    {
        return null;
    }
    const weights = tiers.map((tier) => Math.max(Number.EPSILON, Number(weightForTier(tier)) || 1));
    const weightTotal = weights.reduce((total, value) => total + value, 0);
    const quotas = weights.map((weight) => totalUnits * weight / weightTotal);
    const values = quotas.map((quota, index) => Math.max(minimums[index], Math.floor(quota)));
    let allocated = values.reduce((total, value) => total + value, 0);
    while (allocated < totalUnits)
    {
        let selected = 0;
        for (let index = 1; index < values.length; index += 1)
        {
            if (quotas[index] - values[index] > quotas[selected] - values[selected])
            {
                selected = index;
            }
        }
        values[selected] += 1;
        allocated += 1;
    }
    while (allocated > totalUnits)
    {
        let selected = -1;
        for (let index = 0; index < values.length; index += 1)
        {
            if (values[index] <= minimums[index])
            {
                continue;
            }
            if (selected < 0 || values[index] - quotas[index] > values[selected] - quotas[selected])
            {
                selected = index;
            }
        }
        if (selected < 0)
        {
            return null;
        }
        values[selected] -= 1;
        allocated -= 1;
    }
    return new Map(tiers.map((tier, index) => [tier.id, values[index]]));
}

function startupIntegerAllocation(tiers, totalUnits)
{
    const startupMinimums = new Map(tiers.map((tier) => [tier.id, startupMinCpuUnits(tier)]));
    let remaining = totalUnits - [...startupMinimums.values()].reduce((total, value) => total + value, 0);
    if (remaining < 0)
    {
        return null;
    }
    for (const tier of [...tiers].sort(startupAdmissionOrder))
    {
        const steadyMinimum = Math.max(1, Math.floor(Number(tier.minCpuUnits) || 1));
        const deficit = Math.max(0, steadyMinimum - startupMinimums.get(tier.id));
        const addition = Math.min(remaining, deficit);
        startupMinimums.set(tier.id, startupMinimums.get(tier.id) + addition);
        remaining -= addition;
        if (remaining === 0)
        {
            break;
        }
    }
    return weightedIntegerAllocation(
        tiers,
        totalUnits,
        (tier) => startupMinimums.get(tier.id),
        (tier) => tier.cpuWeight
    );
}

function tierPhase(tier)
{
    const value = Number(tier.phase);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

function applyCheckpointPatch(state, payload)
{
    let result = structuredClone(state);
    for (const operation of payload?.operations ?? [])
    {
        const segments = operation.path;
        if (!Array.isArray(segments))
        {
            throw new Error('scheduler checkpoint patch path must be an array');
        }
        if (segments.length === 0)
        {
            if (operation.kind !== 'set')
            {
                throw new Error('scheduler checkpoint root patch must use set');
            }
            result = structuredClone(operation.value);
            continue;
        }
        let parent = result;
        for (const segment of segments.slice(0, -1))
        {
            if (!parent || typeof parent !== 'object')
            {
                throw new Error('scheduler checkpoint patch traverses a non-object');
            }
            parent = parent[segment];
        }
        const key = segments.at(-1);
        if (operation.kind === 'set')
        {
            parent[key] = structuredClone(operation.value);
        }
        else if (operation.kind === 'delete')
        {
            delete parent[key];
        }
        else if (operation.kind === 'append')
        {
            if (!Array.isArray(parent[key]))
            {
                throw new Error('scheduler checkpoint append target must be an array');
            }
            parent[key].push(...structuredClone(operation.values));
        }
        else
        {
            throw new Error(`unsupported scheduler checkpoint patch operation: ${operation.kind}`);
        }
    }
    return result;
}

const projectionResumeTransactionSchema =
    'fsusblog.test-matrix.projection-resume-transaction.v1';

function projectionResumeTransactionFile(checkpointFile)
{
    return `${checkpointFile}.projection-resume-transaction.json`;
}

function projectionResumeTransactionDigest(transaction)
{
    return fingerprint({
        schema: transaction.schema,
        state: transaction.state,
        runId: transaction.runId,
        sourceState: transaction.sourceState,
        baselineBytes: transaction.baselineBytes,
        baselineDigest: transaction.baselineDigest,
        baselineObjectRef: transaction.baselineObjectRef,
        expectedSuccessBytes: transaction.expectedSuccessBytes,
        expectedSuccessDigest: transaction.expectedSuccessDigest,
        expectedSuccessObjectRef: transaction.expectedSuccessObjectRef,
        expectedRevision: transaction.expectedRevision
    });
}

function readProjectionResumeTransaction(checkpointFile)
{
    const file = projectionResumeTransactionFile(checkpointFile);
    if (!fs.existsSync(file))
    {
        return null;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('projection resume transaction authority must be a regular file');
    }
    const transaction = JSON.parse(fs.readFileSync(file, 'utf8'));
    let baseline;
    let expectedSuccess;
    try
    {
        baseline = checkpointProjectionContent(JSON.parse(transaction.baselineBytes));
        expectedSuccess = checkpointProjectionContent(JSON.parse(transaction.expectedSuccessBytes));
    }
    catch
    {
        throw new Error('projection resume transaction checkpoint bytes are invalid');
    }
    if (transaction?.schema !== projectionResumeTransactionSchema
    || transaction.state !== 'prepared'
    || baseline?.schema !== checkpointSchema
    || expectedSuccess?.schema !== checkpointSchema
    || transaction.runId !== baseline.runId
    || transaction.runId !== expectedSuccess.runId
    || !sameCheckpointSource(transaction.sourceState, baseline.sourceState)
    || !sameCheckpointSource(transaction.sourceState, expectedSuccess.sourceState)
    || transaction.baselineDigest !== sha256(transaction.baselineBytes)
    || transaction.expectedSuccessDigest !== sha256(transaction.expectedSuccessBytes)
    || transaction.expectedRevision !== expectedSuccess.revision
    || transaction.expectedRevision !== Number(baseline.revision) + 1
    || transaction.contentDigest !== projectionResumeTransactionDigest(transaction)
    || !isProjectionOnlyCheckpointFailure(baseline)
    || expectedSuccess.status !== 'success')
    {
        throw new Error('projection resume transaction authority is invalid');
    }
    const store = new RunEvidenceObjectStore({
        root: path.join(path.dirname(checkpointFile), 'evidence-store'),
        runId: transaction.runId, sourceState: transaction.sourceState, readOnly: true
    });
    if (fingerprint(store.readObject(transaction.baselineObjectRef).value) !== fingerprint(baseline)
        || fingerprint(store.readObject(transaction.expectedSuccessObjectRef).value) !== fingerprint(expectedSuccess))
    {
        throw new Error('projection resume transaction immutable checkpoint refs mismatch');
    }
    return { file, transaction, baseline, expectedSuccess };
}

function projectionResumeStore(checkpointFile, transaction)
{
    return new RunEvidenceObjectStore({
        root: path.join(path.dirname(checkpointFile), 'evidence-store'),
        runId: transaction.runId,
        sourceState: transaction.sourceState
    });
}

function recoverProjectionResumeStore(store)
{
    return store.recover((state, _event, payload) => applyCheckpointPatch(state, payload));
}

function validateCommittedProjectionResumeTransaction(checkpointFile, authority)
{
    const store = projectionResumeStore(checkpointFile, authority.transaction);
    const recovered = recoverProjectionResumeStore(store);
    const compact = store.readCompactCheckpoint();
    if (!compact
    || recovered.lastSequence !== compact.checkpoint.lastSequence
    || fingerprint(recovered.state) !== fingerprint(authority.expectedSuccess)
    || fingerprint(compact.state) !== fingerprint(authority.expectedSuccess))
    {
        throw new Error('projection resume transaction journal/compact witness is inconsistent');
    }
    const metricsFile = path.join(path.dirname(checkpointFile), 'evidence-storage-metrics.json');
    const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
    if (metrics.projectionCheckpointDigest !== authority.transaction.expectedSuccessDigest
    || metrics.projectionCheckpointRevision !== authority.transaction.expectedRevision)
    {
        throw new Error('projection resume transaction metrics witness is inconsistent');
    }
}

function projectionResumeTransactionState(checkpointFile)
{
    const authority = readProjectionResumeTransaction(checkpointFile);
    if (!authority)
    {
        return null;
    }
    const checkpointBytes = fs.readFileSync(checkpointFile, 'utf8');
    const checkpointDigest = sha256(checkpointBytes);
    if (checkpointDigest === authority.transaction.baselineDigest
    && checkpointBytes === authority.transaction.baselineBytes)
    {
        return { ...authority, state: 'prepared' };
    }
    if (checkpointDigest === authority.transaction.expectedSuccessDigest
    && checkpointBytes === authority.transaction.expectedSuccessBytes)
    {
        validateCommittedProjectionResumeTransaction(checkpointFile, authority);
        return { ...authority, state: 'committed' };
    }
    throw new Error('projection resume transaction compatibility checkpoint is inconsistent');
}

function prepareProjectionResumeTransaction(checkpointFile, checkpoint, successfulCheckpoint)
{
    const existing = readProjectionResumeTransaction(checkpointFile);
    if (existing)
    {
        const state = projectionResumeTransactionState(checkpointFile);
        if (state.state !== 'prepared'
      || fingerprint(existing.baseline) !== fingerprint(checkpoint)
      || fingerprint(existing.expectedSuccess.logicalTierProjection)
        !== fingerprint(successfulCheckpoint.logicalTierProjection))
        {
            throw new Error('projection resume transaction baseline drifted');
        }
        return existing;
    }
    const baselineBytes = fs.readFileSync(checkpointFile, 'utf8');
    if (fingerprint(checkpointProjectionContent(JSON.parse(baselineBytes))) !== fingerprint(checkpoint))
    {
        throw new Error('projection resume transaction baseline bytes drifted');
    }
    const expectedSuccess = structuredClone(successfulCheckpoint);
    expectedSuccess.revision = Math.max(0, Number(checkpoint.revision) || 0) + 1;
    expectedSuccess.updatedAt = new Date().toISOString();
    expectedSuccess.completedTiers = Object.entries(expectedSuccess.tiers)
        .filter(([, value]) => value.status === 'success')
        .map(([tierId]) => tierId)
        .sort();
    expectedSuccess.contentDigest = checkpointContentDigest(expectedSuccess);
    const expectedSuccessBytes = `${JSON.stringify(expectedSuccess, null, 2)}\n`;
    const store = schedulerPersistence(checkpointFile, checkpoint).store;
    const transaction = {
        schema: projectionResumeTransactionSchema,
        state: 'prepared',
        runId: checkpoint.runId,
        sourceState: structuredClone(checkpoint.sourceState),
        baselineBytes,
        baselineDigest: sha256(baselineBytes),
        baselineObjectRef: store.publishObject(checkpoint).digest,
        expectedSuccessBytes,
        expectedSuccessDigest: sha256(expectedSuccessBytes),
        expectedSuccessObjectRef: store.publishObject(expectedSuccess).digest,
        expectedRevision: expectedSuccess.revision,
        contentDigest: null
    };
    transaction.contentDigest = projectionResumeTransactionDigest(transaction);
    const file = projectionResumeTransactionFile(checkpointFile);
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(transaction, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
    });
    fs.renameSync(temporary, file);
    return { file, transaction, baseline: checkpoint, expectedSuccess };
}

function checkpointProjectionContent(document)
{
    const fields = new Set(['storeCheckpointRef', 'storeCheckpointDigest', 'lastSequence', 'projectionDigest']);
    return Object.fromEntries(Object.entries(document).filter(([field]) => !fields.has(field)));
}

function checkpointContentDigest(checkpoint)
{
    const payload = { ...checkpoint };
    delete payload.contentDigest;
    return `sha256:${fingerprint(payload)}`;
}

function checkpointProjection(checkpoint, compact, lastSequence)
{
    const projection = {
        ...checkpoint,
        storeCheckpointRef: compact?.checkpoint.stateReference.digest ?? null,
        storeCheckpointDigest: compact?.checkpoint.contentDigest ?? null,
        lastSequence
    };
    projection.projectionDigest = `sha256:${fingerprint(projection)}`;
    return projection;
}

/** Read only the explicit run's immutable objects and validated journal. JSON is a disposable projection. */
export function readCanonicalSchedulerCheckpoint(checkpointFileValue, { repairProjection = false } = {})
{
    const checkpointFile = path.resolve(checkpointFileValue);
    const runId = safeRunId(path.basename(path.dirname(checkpointFile)));
    const storeRoot = path.join(path.dirname(checkpointFile), 'evidence-store');
    if (!fs.existsSync(storeRoot))
    {
        if (fs.existsSync(checkpointFile))
        {
            throw new Error('contract.missing-canonical-checkpoint: compatibility JSON is not authority');
        }
        return null;
    }
    const compactFile = path.join(storeRoot, 'checkpoints', `${runId}.json`);
    const journalFile = path.join(storeRoot, 'journals', `${runId}.jsonl`);
    const identityFile = fs.existsSync(compactFile) ? compactFile : journalFile;
    if (!fs.existsSync(identityFile))
    {
        throw new Error('contract.missing-canonical-checkpoint: no compact or journal identity');
    }
    const identityStat = fs.lstatSync(identityFile);
    if (identityStat.isSymbolicLink() || !identityStat.isFile())
    {
        throw new Error('canonical checkpoint identity must be a regular file');
    }
    const source = identityFile === compactFile
        ? JSON.parse(fs.readFileSync(compactFile, 'utf8'))
        : JSON.parse(fs.readFileSync(journalFile, 'utf8').split('\n')[0] || '{}');
    if (source.runId !== runId)
    {
        throw new Error('contract.checkpoint-identity-mismatch: runId');
    }
    const store = new RunEvidenceObjectStore({ root: storeRoot, runId,
        sourceState: source.sourceState, readOnly: true });
    const recovered = store.recover((state, _event, payload) => applyCheckpointPatch(state, payload));
    let checkpoint = recovered.state;
    const transaction = fs.existsSync(projectionResumeTransactionFile(checkpointFile))
        ? projectionResumeTransactionState(checkpointFile) : null;
    if (transaction?.state === 'prepared')
    {
        // A prepared projection transaction may have durable success bytes but no commit witness.
        // Its immutable baseline remains the admitted view until the original transaction commits.
        checkpoint = store.readObject(transaction.transaction.baselineObjectRef).value;
    }
    if (checkpoint?.schema !== checkpointSchema || checkpoint.runId !== runId
        || !sameCheckpointSource(checkpoint.sourceState, source.sourceState))
    {
        throw new Error('contract.checkpoint-identity-mismatch: recovered run/source/schema');
    }
    if (checkpoint.contentDigest && checkpoint.contentDigest !== checkpointContentDigest(checkpoint))
    {
        throw new Error('canonical checkpoint content digest mismatch');
    }
    const compact = store.readCompactCheckpoint();
    const projection = checkpointProjection(checkpoint, compact, recovered.lastSequence);
    let projectionStatus = 'missing';
    if (fs.existsSync(checkpointFile))
    {
        const stat = fs.lstatSync(checkpointFile);
        if (stat.isSymbolicLink() || !stat.isFile())
        {
            throw new Error('compatibility checkpoint must be a regular file');
        }
        try
        {
            projectionStatus = fingerprint(JSON.parse(fs.readFileSync(checkpointFile, 'utf8')))
                === fingerprint(projection) ? 'current' : 'drift';
        }
        catch
        {
            projectionStatus = 'invalid';
        }
    }
    if (repairProjection && projectionStatus !== 'current' && !transaction)
    {
        const temporary = `${checkpointFile}.projection-${process.pid}-${crypto.randomUUID()}`;
        fs.writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(temporary, checkpointFile);
    }
    return { checkpoint, compactStateRef: compact?.checkpoint.stateReference.digest ?? null,
        compactDigest: compact?.checkpoint.contentDigest ?? null, lastSequence: recovered.lastSequence,
        checkpointDigest: checkpointContentDigest(checkpoint), projectionStatus };
}

function readCheckpoint(checkpointFile, { journalAuthority = false, requireCompleteJournal = false } = {})
{
    const projectionTransaction = journalAuthority ? null : projectionResumeTransactionState(checkpointFile);
    if (projectionTransaction)
    {
        return structuredClone(
      projectionTransaction.state === 'prepared'
          ? projectionTransaction.baseline
          : projectionTransaction.expectedSuccess
        );
    }
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile, { repairProjection: !requireCompleteJournal });
    if (requireCompleteJournal && canonical?.lastSequence === 0)
    {
        throw new Error('scheduler resource retention journal is missing or truncated before its compact checkpoint');
    }
    return canonical?.checkpoint ?? null;
}

function resumeTierCandidates(previous, tierIds)
{
    const candidates = {};
    if (!previous)
    {
        return candidates;
    }
    const terminalFailures = Object.entries(previous.tiers ?? {})
        .filter(([, result]) => result?.status !== 'success')
        .map(([tierId]) => tierId)
        .sort();
    if (terminalFailures.length > 0)
    {
        throw new Error(
            `correctness resume cannot re-execute failed tiers; start an independent run: ${terminalFailures.join(', ')}`
        );
    }

    const retainSuccessful = (tierId, value, fallbackSourceState) =>
    {
        if (!tierIds.has(tierId))
        {
            return;
        }
        const candidate = value?.schema === 'fsusblog.test-matrix.resume-candidate.v1'
            ? value
            : {
          schema: 'fsusblog.test-matrix.resume-candidate.v1',
          sourceState: value?.reuseSourceState ?? fallbackSourceState ?? null,
          tierResult: value
        };
        if (candidate.tierResult?.status === 'success')
        {
            candidates[tierId] = candidate;
        }
        else
        {
            delete candidates[tierId];
        }
    };

    for (const [tierId, candidate] of Object.entries(previous.resumeCandidates ?? {}))
    {
        retainSuccessful(tierId, candidate, previous.sourceState);
    }
    // Results recorded by the most recent attempt are newer than carried
    // candidates. A failure/cancellation therefore retires any older candidate
    // for the same tier instead of allowing a later resume to hide that result.
    for (const [tierId, result] of Object.entries(previous.tiers ?? {}))
    {
        retainSuccessful(tierId, result, previous.sourceState);
    }
    return candidates;
}

function checkpointPatch(before, after)
{
    const operations = [];
    const visit = (left, right, currentPath) =>
    {
        if (Object.is(left, right))
        {
            return;
        }
        if (Array.isArray(left) && Array.isArray(right))
        {
            const prefixMatches = left.length <= right.length
        && left.every((value, index) => JSON.stringify(stableValue(value)) === JSON.stringify(stableValue(right[index])));
            if (prefixMatches)
            {
                if (right.length > left.length)
                {
                    operations.push({ kind: 'append', path: currentPath, values: right.slice(left.length) });
                }
                return;
            }
            operations.push({ kind: 'set', path: currentPath, value: right });
            return;
        }
        const leftObject = left && typeof left === 'object';
        const rightObject = right && typeof right === 'object';
        if (!leftObject || !rightObject || Array.isArray(left) || Array.isArray(right))
        {
            operations.push({ kind: 'set', path: currentPath, value: right });
            return;
        }
        for (const key of Object.keys(left))
        {
            if (!Object.hasOwn(right, key))
            {
                operations.push({ kind: 'delete', path: [...currentPath, key] });
            }
        }
        for (const key of Object.keys(right))
        {
            if (!Object.hasOwn(left, key))
            {
                operations.push({ kind: 'set', path: [...currentPath, key], value: right[key] });
            }
            else
            {
                visit(left[key], right[key], [...currentPath, key]);
            }
        }
    };
    visit(before, after, []);
    return { operations };
}

function schedulerPersistence(checkpointFile, checkpoint)
{
    const key = path.resolve(checkpointFile);
    let persistence = checkpointPersistence.get(key);
    if (persistence
    && (!fs.existsSync(persistence.store.root)
      || persistence.store.runId !== checkpoint.runId
      || !sameCheckpointSource(persistence.store.sourceState, checkpoint.sourceState)))
    {
        checkpointPersistence.delete(key);
        persistence = null;
    }
    if (!persistence)
    {
        const store = new RunEvidenceObjectStore({
            root: path.join(path.dirname(checkpointFile), 'evidence-store'),
            runId: checkpoint.runId,
            sourceState: checkpoint.sourceState
        });
        let previous = null;
        try
        {
            previous = store.recover((state, _event, payload) => applyCheckpointPatch(state, payload)).state;
        }
        catch (error)
        {
            if (fs.existsSync(path.join(store.checkpointsDirectory, `${checkpoint.runId}.json`)))
            {
                throw error;
            }
        }
        persistence = {
            store,
            previous,
            compatibilityWrites: fs.existsSync(checkpointFile) ? 1 : 0,
            compatibilityBytesWritten: fs.existsSync(checkpointFile) ? fs.statSync(checkpointFile).size : 0
        };
        checkpointPersistence.set(key, persistence);
    }
    return persistence;
}

function writeCheckpoint(checkpointFile, checkpoint, {
    boundary = false,
    stage = null,
    eventType = 'scheduler-state-updated',
    tier = null,
    step = null
} = {})
{
    if (projectionResumeTransactionState(checkpointFile))
    {
        throw new Error('generic checkpoint writer cannot enter a projection resume transaction');
    }
    checkpoint.revision = Math.max(0, Number(checkpoint.revision) || 0) + 1;
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.completedTiers = Object.entries(checkpoint.tiers)
        .filter(([, value]) => value.status === 'success')
        .map(([tierId]) => tierId)
        .sort();
    checkpoint.contentDigest = checkpointContentDigest(checkpoint);
    const persistence = schedulerPersistence(checkpointFile, checkpoint);
    const patch = checkpointPatch(persistence.previous, checkpoint);
    const event = persistence.store.appendJournalEvent({
        eventType,
        tier,
        step,
        status: checkpoint.status,
        payload: patch
    });
    persistence.previous = structuredClone(checkpoint);
    if (!boundary)
    {
        return;
    }
    publishCheckpointBoundary(checkpointFile, checkpoint, persistence, { stage, lastSequence: event.sequence });
}

function publishCheckpointBoundary(checkpointFile, checkpoint, persistence, { stage, lastSequence })
{
    const compact = persistence.store.writeCompactCheckpoint({
        stage: stage ?? (checkpoint.status === 'running' ? 'run-start' : 'run-complete'),
        state: checkpoint,
        lastSequence,
        retention: {
            activeRun: checkpoint.status === 'running',
            releaseBinding: checkpoint.status === 'success'
        }
    });
    const serialized = `${JSON.stringify(checkpointProjection(checkpoint, compact, lastSequence), null, 2)}\n`;
    const temporaryFile = `${checkpointFile}.next-${process.pid}`;
    fs.writeFileSync(temporaryFile, serialized);
    fs.renameSync(temporaryFile, checkpointFile);
    persistence.compatibilityWrites += 1;
    persistence.compatibilityBytesWritten += Buffer.byteLength(serialized);
    if (checkpoint.status !== 'running')
    {
        const metrics = {
            ...persistence.store.metrics(),
            schedulerCompatibilityCheckpointWrites: persistence.compatibilityWrites,
            schedulerCompatibilityCheckpointBytesWritten: persistence.compatibilityBytesWritten
        };
        const metricsFile = path.join(path.dirname(checkpointFile), 'evidence-storage-metrics.json');
        const metricsTemporary = `${metricsFile}.next-${process.pid}`;
        fs.writeFileSync(metricsTemporary, `${JSON.stringify(metrics, null, 2)}\n`);
        fs.renameSync(metricsTemporary, metricsFile);
    }
}

function writeProjectionResumeCheckpoint(
    checkpointFile,
    authority,
    faultInjector = null
)
{
    if (typeof faultInjector !== 'function' && faultInjector !== null)
    {
        throw new Error('projection resume persistence fault injector must be a function');
    }
    const transaction = projectionResumeTransactionState(checkpointFile);
    if (!transaction || transaction.state !== 'prepared'
    || transaction.transaction.contentDigest !== authority.transaction.contentDigest)
    {
        throw new Error('projection resume transaction is not prepared');
    }
    const store = projectionResumeStore(checkpointFile, transaction.transaction);
    let recovered = recoverProjectionResumeStore(store);
    let lastSequence = recovered.lastSequence;
    if (fingerprint(recovered.state) !== fingerprint(transaction.expectedSuccess))
    {
        const patch = checkpointPatch(recovered.state, transaction.expectedSuccess);
        if (fingerprint(applyCheckpointPatch(recovered.state, patch))
      !== fingerprint(transaction.expectedSuccess))
        {
            throw new Error('projection resume journal patch does not produce the expected checkpoint');
        }
        const event = store.appendJournalEvent({
            eventType: 'evidence-finalized',
            tier: transaction.expectedSuccess.targetTierId,
            step: 'resume-evidence',
            status: transaction.expectedSuccess.status,
            payload: patch
        });
        lastSequence = event.sequence;
    }
    faultInjector?.('journal-durable');
    store.writeCompactCheckpoint({
        stage: 'evidence-finalized',
        state: transaction.expectedSuccess,
        lastSequence,
        retention: { activeRun: false, releaseBinding: true }
    });
    recovered = recoverProjectionResumeStore(store);
    if (recovered.lastSequence !== lastSequence
    || fingerprint(recovered.state) !== fingerprint(transaction.expectedSuccess))
    {
        throw new Error('projection resume compact checkpoint does not match the journal tail');
    }
    faultInjector?.('compact-durable');
    const stagedSuccessCheckpoint =
        `${checkpointFile}.projection-success-${transaction.transaction.expectedSuccessDigest}`;
    if (fs.existsSync(stagedSuccessCheckpoint))
    {
        const stat = fs.lstatSync(stagedSuccessCheckpoint);
        if (!stat.isFile() || stat.isSymbolicLink()
      || fs.readFileSync(stagedSuccessCheckpoint, 'utf8')
        !== transaction.transaction.expectedSuccessBytes)
        {
            throw new Error('projection resume staged compatibility checkpoint is invalid');
        }
    }
    else
    {
        fs.writeFileSync(
            stagedSuccessCheckpoint,
            transaction.transaction.expectedSuccessBytes,
            { encoding: 'utf8', flag: 'wx' }
        );
    }
    faultInjector?.('compatibility-staged');
    const metrics = {
        ...store.metrics(),
        schedulerCompatibilityCheckpointWrites: 2,
        schedulerCompatibilityCheckpointBytesWritten:
      Buffer.byteLength(transaction.transaction.baselineBytes)
      + Buffer.byteLength(transaction.transaction.expectedSuccessBytes),
        projectionCheckpointDigest: transaction.transaction.expectedSuccessDigest,
        projectionCheckpointRevision: transaction.transaction.expectedRevision
    };
    const metricsFile = path.join(path.dirname(checkpointFile), 'evidence-storage-metrics.json');
    const metricsTemporary = `${metricsFile}.projection-next-${process.pid}`;
    fs.writeFileSync(metricsTemporary, `${JSON.stringify(metrics, null, 2)}\n`);
    fs.renameSync(metricsTemporary, metricsFile);
    faultInjector?.('metrics-durable');
    checkpointPersistence.delete(path.resolve(checkpointFile));
    faultInjector?.('commit-before');
    const baselineStat = fs.lstatSync(checkpointFile);
    const baselineBytes = fs.readFileSync(checkpointFile, 'utf8');
    if (!baselineStat.isFile() || baselineStat.isSymbolicLink()
    || baselineBytes !== transaction.transaction.baselineBytes
    || sha256(baselineBytes) !== transaction.transaction.baselineDigest)
    {
        throw new Error('projection resume baseline checkpoint changed before commit');
    }
    const stagedStat = fs.lstatSync(stagedSuccessCheckpoint);
    const stagedBytes = fs.readFileSync(stagedSuccessCheckpoint, 'utf8');
    if (!stagedStat.isFile() || stagedStat.isSymbolicLink()
    || stagedBytes !== transaction.transaction.expectedSuccessBytes
    || sha256(stagedBytes) !== transaction.transaction.expectedSuccessDigest)
    {
        throw new Error('projection resume staged checkpoint changed before commit');
    }
    validateCommittedProjectionResumeTransaction(stagedSuccessCheckpoint, transaction);
    fs.renameSync(stagedSuccessCheckpoint, checkpointFile);
    return transaction.expectedSuccess;
}

export function markCheckpointWallClockTimeout(checkpointFile, failure, finishedAt = new Date().toISOString())
{
    const checkpoint = readCheckpoint(checkpointFile);
    if (!checkpoint)
    {
        throw new Error(`cannot mark missing scheduler checkpoint timed out: ${checkpointFile}`);
    }
    checkpoint.status = 'failure';
    checkpoint.timedOut = true;
    checkpoint.failure ??= failure;
    checkpoint.failurePoint ??= failure.tierId ?? checkpoint.targetTierId;
    if (!(checkpoint.failures ?? []).some((entry) => (
        entry?.tierId === failure.tierId && entry?.reason === failure.reason
    )))
    {
        checkpoint.failures = [...(checkpoint.failures ?? []), failure];
    }
    checkpoint.finishedAt = finishedAt;
    writeCheckpoint(checkpointFile, checkpoint, {
        boundary: true,
        stage: 'wall-clock-timeout',
        eventType: 'run-timed-out',
        tier: failure.tierId ?? checkpoint.targetTierId,
        step: 'scheduler'
    });
    return checkpoint;
}

function createEarlyFailureCheckpoint(expectedRunId, failure, options)
{
    if (typeof options?.targetTierId !== 'string' || !options.targetTierId)
    {
        throw new Error('early scheduler checkpoint requires targetTierId');
    }
    if (typeof options?.sourceState?.commit !== 'string'
    || typeof options?.sourceState?.worktreeFingerprint !== 'string')
    {
        throw new Error('early scheduler checkpoint requires sourceState');
    }
    const startedAt = options.startedAt ?? new Date().toISOString();
    return {
        schema: checkpointSchema,
        runId: expectedRunId,
        targetTierId: options.targetTierId,
        mode: options.mode ?? 'fresh',
        authoritative: (options.mode ?? 'fresh') === 'fresh',
        status: 'failure',
        startedAt,
        updatedAt: startedAt,
        finishedAt: new Date().toISOString(),
        sourceState: structuredClone(options.sourceState),
        ...(options.runtimeNamespace ? { runtimeNamespace: options.runtimeNamespace } : {}),
        completedTiers: [],
        tiers: {},
        failure,
        failurePoint: failure.tierId ?? options.targetTierId,
        failures: [failure]
    };
}

function appendCheckpointFailure(checkpoint, failure)
{
    checkpoint.status = 'failure';
    checkpoint.failure ??= failure;
    checkpoint.failurePoint ??= failure.tierId ?? checkpoint.targetTierId;
    checkpoint.failures ??= [];
    if (!checkpoint.failures.some((entry) => (
        entry?.tierId === failure.tierId && entry?.reason === failure.reason
    )))
    {
        checkpoint.failures.push(failure);
    }
    checkpoint.finishedAt = new Date().toISOString();
}

function readOrCreateFailureCheckpoint(checkpointFile, expectedRunId, failure, options)
{
    const checkpoint = readCheckpoint(checkpointFile);
    if (checkpoint)
    {
        if (checkpoint.runId !== expectedRunId)
        {
            throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFile}`);
        }
        return checkpoint;
    }
    if (failure === null)
    {
        throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFile}`);
    }
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    return createEarlyFailureCheckpoint(expectedRunId, failure, options);
}

export function recordCheckpointFailure(checkpointFileValue, expectedRunId, failure, options = {})
{
    const checkpointFile = path.resolve(checkpointFileValue);
    const runDirectory = path.dirname(checkpointFile);
    const runsRoot = path.dirname(runDirectory);
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    try
    {
        const checkpoint = readOrCreateFailureCheckpoint(
            checkpointFile,
            expectedRunId,
            failure,
            options);
        appendCheckpointFailure(checkpoint, failure);
        writeCheckpoint(checkpointFile, checkpoint, {
            boundary: true,
            stage: options.stage ?? 'run-failed',
            eventType: options.eventType ?? 'run-failed',
            tier: failure.tierId ?? checkpoint.targetTierId,
            step: options.step ?? 'scheduler'
        });
        return checkpoint;
    }
    finally
    {
        releaseLock();
    }
}

export function recordCheckpointRuntimeCleanup(
    checkpointFileValue,
    expectedRunId,
    runtimeCleanup,
    failure = null,
    options = {}
)
{
    const checkpointFile = path.resolve(checkpointFileValue);
    const runDirectory = path.dirname(checkpointFile);
    const runsRoot = path.dirname(runDirectory);
    const phases = Object.entries(runtimeCleanup ?? {});
    if (phases.length === 0 || phases.some(([phase, evidence]) => (
        !['preflight', 'postflight'].includes(phase)
    || typeof evidence?.path !== 'string'
    || !evidence.path
    || !['complete', 'blocked'].includes(evidence.status)
    || !/^sha256:[a-f0-9]{64}$/u.test(String(evidence.digest ?? ''))
    )))
    {
        throw new Error('checkpoint runtime cleanup evidence is invalid');
    }
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    try
    {
        const checkpoint = readOrCreateFailureCheckpoint(
            checkpointFile,
            expectedRunId,
            failure,
            options);
        for (const [phase, evidence] of phases)
        {
            if (checkpoint.runtimeCleanup?.[phase]?.status === 'blocked'
        && evidence.status === 'complete')
            {
                throw new Error(`checkpoint runtime cleanup ${phase} cannot upgrade blocked evidence`);
            }
        }
        checkpoint.runtimeCleanup = structuredClone(runtimeCleanup);
        if (failure !== null)
        {
            appendCheckpointFailure(checkpoint, failure);
        }
        writeCheckpoint(checkpointFile, checkpoint, {
            boundary: true,
            stage: failure === null ? 'runtime-cleanup-recorded' : 'runtime-cleanup-blocked',
            eventType: failure === null ? 'runtime-cleanup-recorded' : 'runtime-cleanup-blocked',
            tier: checkpoint.targetTierId,
            step: 'runtime-cleanup'
        });
        return checkpoint;
    }
    finally
    {
        releaseLock();
    }
}

export function recordCheckpointProductionCapacityReservation(
    checkpointFileValue,
    expectedRunId,
    evidence,
    failure = null,
    options = {}
)
{
    if (!evidence
    || typeof evidence.reservationId !== 'string'
    || typeof evidence.planDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(evidence.planDigest)
    || typeof evidence.producerDeclarationDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(evidence.producerDeclarationDigest)
    || typeof evidence.releaseReceiptFile !== 'string'
    || !path.isAbsolute(evidence.releaseReceiptFile)
    || !/^sha256:[a-f0-9]{64}$/u.test(evidence.releaseReceiptDigest ?? '')
    || !['released', 'aborted'].includes(evidence.status))
    {
        throw new Error('checkpoint Production capacity reservation evidence is invalid');
    }
    const checkpointFile = path.resolve(checkpointFileValue);
    const runsRoot = path.dirname(path.dirname(checkpointFile));
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    try
    {
        const checkpoint = readOrCreateFailureCheckpoint(
            checkpointFile,
            expectedRunId,
            failure,
            options);
        checkpoint.productionCapacityReservation = structuredClone(evidence);
        if (failure !== null)
        {
            appendCheckpointFailure(checkpoint, failure);
        }
        writeCheckpoint(checkpointFile, checkpoint, {
            boundary: true,
            stage: failure === null ? 'capacity-reservation-released' : 'capacity-reservation-release-failed',
            eventType: failure === null ? 'capacity-reservation-released' : 'capacity-reservation-release-failed',
            tier: checkpoint.targetTierId,
            step: 'capacity-reservation'
        });
        return checkpoint;
    }
    finally
    {
        releaseLock();
    }
}

function runtimeCleanupAttemptLedger(checkpoint, {
    expectedRunId,
    targetTierId,
    schedulerRunId,
    invocationId,
    repositoryRoot
})
{
    if (!checkpoint
    || checkpoint.runId !== expectedRunId
    || checkpoint.targetTierId !== targetTierId)
    {
        throw new Error('runtime cleanup attempt ledger checkpoint identity is invalid');
    }
    const ledger = checkpoint.runtimeCleanupAttemptLedger;
    if (!ledger
    || ledger.schema !== runtimeCleanupAttemptLedgerSchema
    || ledger.schedulerRunId !== schedulerRunId
    || ledger.invocationId !== invocationId
    || ledger.repositoryRoot !== repositoryRoot
    || !['complete', 'blocked'].includes(ledger.status)
    || !Array.isArray(ledger.attempts))
    {
        throw new Error('runtime cleanup attempt ledger identity is invalid');
    }
    if (ledger.attempts.some((attempt) => (
        !/^[a-f0-9]{32}$/u.test(String(attempt?.attemptId ?? ''))
    || attempt.phase !== 'preflight'
    || !['complete', 'blocked'].includes(attempt.status)
    || !/^sha256:[a-f0-9]{64}$/u.test(String(attempt.digest ?? ''))
    || typeof attempt.receiptFile !== 'string'
    || !path.isAbsolute(attempt.receiptFile)
    )))
    {
        throw new Error('runtime cleanup attempt ledger contains invalid evidence');
    }
    if (new Set(ledger.attempts.map((attempt) => attempt.attemptId)).size !== ledger.attempts.length)
    {
        throw new Error('runtime cleanup attempt ledger contains duplicate attempts');
    }
    const blockedAttempts = ledger.attempts.filter((attempt) => attempt.status === 'blocked');
    if ((ledger.status === 'blocked') !== (blockedAttempts.length > 0)
    || (ledger.status === 'blocked'
      && ledger.blockedAttemptId !== blockedAttempts[0].attemptId)
    || (ledger.status === 'complete' && ledger.blockedAttemptId !== null))
    {
        throw new Error('runtime cleanup attempt ledger sealed status is invalid');
    }
    return ledger;
}

export function readRuntimeCleanupAttemptLedger(
    checkpointFileValue,
    expectedRunId,
    identity
)
{
    const checkpointFile = path.resolve(checkpointFileValue);
    const runsRoot = path.dirname(path.dirname(checkpointFile));
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    try
    {
        const checkpoint = readCheckpoint(checkpointFile);
        if (!checkpoint)
        {
            return {
                schema: runtimeCleanupAttemptLedgerSchema,
                schedulerRunId: identity.schedulerRunId,
                invocationId: identity.invocationId,
                repositoryRoot: identity.repositoryRoot,
                status: 'complete',
                blockedAttemptId: null,
                attempts: [],
                checkpointRevision: 0
            };
        }
        const ledger = runtimeCleanupAttemptLedger(checkpoint, {
            expectedRunId,
            ...identity
        });
        return {
            ...structuredClone(ledger),
            checkpointRevision: checkpoint.revision
        };
    }
    finally
    {
        releaseLock();
    }
}

export function recordRuntimeCleanupAttempt(
    checkpointFileValue,
    expectedRunId,
    identity,
    attempt
)
{
    const checkpointFile = path.resolve(checkpointFileValue);
    const runsRoot = path.dirname(path.dirname(checkpointFile));
    if (typeof identity?.targetTierId !== 'string' || !identity.targetTierId
    || typeof identity?.schedulerRunId !== 'string' || !identity.schedulerRunId
    || typeof identity?.invocationId !== 'string' || !identity.invocationId
    || typeof identity?.repositoryRoot !== 'string' || !path.isAbsolute(identity.repositoryRoot)
    || typeof identity?.sourceState?.commit !== 'string'
    || typeof identity?.sourceState?.worktreeFingerprint !== 'string')
    {
        throw new Error('runtime cleanup attempt ledger identity is incomplete');
    }
    if (!/^[a-f0-9]{32}$/u.test(String(attempt?.attemptId ?? ''))
    || attempt.phase !== 'preflight'
    || !['complete', 'blocked'].includes(attempt.status)
    || !/^sha256:[a-f0-9]{64}$/u.test(String(attempt.digest ?? ''))
    || typeof attempt.receiptFile !== 'string'
    || !path.isAbsolute(attempt.receiptFile))
    {
        throw new Error('runtime cleanup attempt evidence is invalid');
    }
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    try
    {
        let checkpoint = readCheckpoint(checkpointFile);
        if (!checkpoint)
        {
            const startedAt = attempt.startedAt ?? new Date().toISOString();
            checkpoint = {
                schema: checkpointSchema,
                runId: expectedRunId,
                targetTierId: identity.targetTierId,
                mode: 'fresh',
                authoritative: true,
                status: 'running',
                startedAt,
                updatedAt: startedAt,
                sourceState: structuredClone(identity.sourceState),
                completedTiers: [],
                tiers: {},
                failure: null,
                failures: [],
                runtimeCleanupAttemptLedger: {
                    schema: runtimeCleanupAttemptLedgerSchema,
                    schedulerRunId: identity.schedulerRunId,
                    invocationId: identity.invocationId,
                    repositoryRoot: identity.repositoryRoot,
                    status: 'complete',
                    blockedAttemptId: null,
                    attempts: []
                }
            };
            fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
        }
        const ledger = runtimeCleanupAttemptLedger(checkpoint, {
            expectedRunId,
            ...identity
        });
        const duplicate = ledger.attempts.find((entry) => entry.attemptId === attempt.attemptId);
        if (duplicate)
        {
            if (JSON.stringify(stableValue(duplicate)) !== JSON.stringify(stableValue(attempt)))
            {
                throw new Error(`runtime cleanup attempt ${attempt.attemptId} was already sealed with different evidence`);
            }
            return {
                ...structuredClone(ledger),
                checkpointRevision: checkpoint.revision
            };
        }
        ledger.attempts.push(structuredClone(attempt));
        const blockedAttempt = ledger.attempts.find((entry) => entry.status === 'blocked') ?? null;
        ledger.status = blockedAttempt ? 'blocked' : 'complete';
        ledger.blockedAttemptId = blockedAttempt?.attemptId ?? null;
        checkpoint.status = blockedAttempt ? 'failure' : 'success';
        checkpoint.finishedAt = attempt.finishedAt ?? new Date().toISOString();
        if (blockedAttempt)
        {
            checkpoint.failure = {
                tierId: identity.targetTierId,
                exitCode: 1,
                reason: `Production Fresh runtime cleanup attempt ${blockedAttempt.attemptId} is blocked`
            };
            checkpoint.failurePoint = identity.targetTierId;
            checkpoint.failures = [checkpoint.failure];
        }
        else
        {
            checkpoint.failure = null;
            delete checkpoint.failurePoint;
            checkpoint.failures = [];
        }
        writeCheckpoint(checkpointFile, checkpoint, {
            boundary: true,
            stage: blockedAttempt
                ? 'runtime-cleanup-attempt-blocked'
                : 'runtime-cleanup-attempt-complete',
            eventType: 'runtime-cleanup-attempt-sealed',
            tier: identity.targetTierId,
            step: 'runtime-cleanup'
        });
        return {
            ...structuredClone(ledger),
            checkpointRevision: checkpoint.revision
        };
    }
    finally
    {
        releaseLock();
    }
}

export function recordCheckpointResidentLeaseCleanup(
    checkpointFileValue,
    expectedRunId,
    updateCheckpoint
)
{
    if (typeof updateCheckpoint !== 'function')
    {
        throw new Error('resident lease cleanup checkpoint update must be a function');
    }
    const checkpointFile = path.resolve(checkpointFileValue);
    const runsRoot = path.dirname(path.dirname(checkpointFile));
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    try
    {
        const checkpoint = readCheckpoint(checkpointFile);
        if (!checkpoint || checkpoint.runId !== expectedRunId)
        {
            throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFileValue}`);
        }
        const sourceState = structuredClone(checkpoint.sourceState);
        const updated = updateCheckpoint(checkpoint) ?? checkpoint;
        if (updated !== checkpoint
      || updated.runId !== expectedRunId
      || updated.schema !== checkpointSchema
      || !sameCheckpointSource(updated.sourceState, sourceState))
        {
            throw new Error('resident lease cleanup may only mutate the locked scheduler checkpoint');
        }
        writeCheckpoint(checkpointFile, checkpoint, {
            boundary: true,
            stage: 'resident-lease-cleanup-recorded',
            eventType: 'resident-lease-cleanup-recorded',
            tier: checkpoint.targetTierId,
            step: 'resident-resource-leases'
        });
        return checkpoint;
    }
    finally
    {
        releaseLock();
    }
}

function plainObject(value)
{
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameCheckpointSource(left, right)
{
    return String(left?.commit ?? '') === String(right?.commit ?? '')
    && String(left?.worktreeFingerprint ?? '') === String(right?.worktreeFingerprint ?? '');
}

function bundleSummaryOutput(checkpoint, root, bundleId)
{
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(String(bundleId ?? '')))
    {
        throw new Error(`logicalTierProjection physicalBundleId is invalid: ${String(bundleId)}`);
    }
    const physicalTierId = `local-${checkpoint.targetTierId}-${bundleId}`;
    const physical = checkpoint.tiers?.[physicalTierId];
    if (physical?.status !== 'success' || physical?.reused !== false)
    {
        throw new Error(`logicalTierProjection physical bundle ${physicalTierId} must be fresh and successful`);
    }
    const summaryPath = `.tmp/local-${checkpoint.targetTierId}/${bundleId}/summary.json`;
    const recordedDigest = physical.outputs?.[summaryPath];
    if (typeof recordedDigest !== 'string' || !recordedDigest.startsWith('file:'))
    {
        throw new Error(`checkpoint output has no recorded digest for ${summaryPath}`);
    }
    const absoluteSummary = path.resolve(root, summaryPath);
    if (!absoluteSummary.startsWith(`${root}${path.sep}`) || !fs.existsSync(absoluteSummary))
    {
        throw new Error(`checkpoint bundle summary is missing: ${summaryPath}`);
    }
    const currentDigest = outputPathFingerprint(absoluteSummary);
    if (recordedDigest !== currentDigest)
    {
        throw new Error(`checkpoint output digest does not match current bundle summary: ${summaryPath}`);
    }
    let summary;
    try
    {
        summary = JSON.parse(fs.readFileSync(absoluteSummary, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`checkpoint bundle summary is invalid JSON: ${summaryPath} (${error.message})`, { cause: error });
    }
    if (!plainObject(summary) || !plainObject(summary.members))
    {
        throw new Error(`checkpoint bundle summary has no member evidence: ${summaryPath}`);
    }
    return { physicalTierId, summaryPath, summary };
}

function validateCheckpointBundleSummaries(checkpoint, root)
{
    const prefix = `local-${checkpoint.targetTierId}-`;
    const physicalTierIds = Object.keys(checkpoint.tiers ?? {})
        .filter((tierId) => tierId.startsWith(prefix))
        .sort();
    if (physicalTierIds.length === 0)
    {
        throw new Error(`checkpoint ${checkpoint.runId} has no local physical bundle tiers`);
    }
    for (const physicalTierId of physicalTierIds)
    {
        bundleSummaryOutput(checkpoint, root, physicalTierId.slice(prefix.length));
    }
}

function sameSortedStrings(left, right)
{
    return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateArtifactSubstitutionProofs(entry, tierId, artifactTable = null)
{
    if (!plainObject(entry.artifactSubstitutionProofs))
    {
        throw new Error(`logicalTierProjection entry ${tierId} artifactSubstitutionProofs must be an object`);
    }
    if (!Array.isArray(entry.matrixRuntimePaths)
    || entry.matrixRuntimePaths.some((declaration) => typeof declaration !== 'string' || !declaration.trim())
    || new Set(entry.matrixRuntimePaths).size !== entry.matrixRuntimePaths.length
    || entry.matrixRuntimePaths.some((declaration, index) => index > 0 && entry.matrixRuntimePaths[index - 1] > declaration))
    {
        throw new Error(`logicalTierProjection entry ${tierId} matrixRuntimePaths must be sorted unique non-empty strings`);
    }
    const canonicalPaths = Object.keys(entry.artifactSubstitutionProofs).sort();
    const expectedProofMode = canonicalPaths.length > 0
        ? 'matrix-runtime-artifacts-with-substitutions'
        : (entry.matrixRuntimePaths.length > 0 ? 'matrix-runtime-artifacts' : 'command-log-and-test-ids');
    if (entry.artifactProofMode !== expectedProofMode)
    {
        throw new Error(`logicalTierProjection entry ${tierId} artifactProofMode must be ${expectedProofMode}`);
    }
    for (const declaration of entry.matrixRuntimePaths)
    {
        if (!Object.hasOwn(entry.artifactDigests, declaration))
        {
            throw new Error(`logicalTierProjection entry ${tierId} is missing matrix runtime digest: ${declaration}`);
        }
    }
    for (const canonicalPath of canonicalPaths)
    {
        if (!entry.matrixRuntimePaths.includes(canonicalPath))
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution canonical path is not declared: ${canonicalPath}`);
        }
        const proof = entry.artifactSubstitutionProofs[canonicalPath];
        if (!plainObject(proof))
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution proof must be an object: ${canonicalPath}`);
        }
        const expectedFields = artifactTable
            ? ['actualDigests', 'actualPaths', 'actualRefs', 'canonicalArtifactRef', 'canonicalDigest', 'canonicalPath']
            : ['actualDigests', 'actualPaths', 'canonicalDigest', 'canonicalPath'];
        if (!sameSortedStrings(Object.keys(proof).sort(), expectedFields))
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution proof has unexpected fields: ${canonicalPath}`);
        }
        if (proof.canonicalPath !== canonicalPath)
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution canonicalPath must match its key: ${canonicalPath}`);
        }
        if (!Array.isArray(proof.actualPaths)
      || proof.actualPaths.length === 0
      || proof.actualPaths.some((actualPath) => typeof actualPath !== 'string' || !actualPath.trim())
      || new Set(proof.actualPaths).size !== proof.actualPaths.length
      || proof.actualPaths.some((actualPath, index) => index > 0 && proof.actualPaths[index - 1] > actualPath)
      || proof.actualPaths.some((actualPath) => canonicalPaths.includes(actualPath)))
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution actualPaths are invalid: ${canonicalPath}`);
        }
        if (!plainObject(proof.actualDigests)
      || !sameSortedStrings(Object.keys(proof.actualDigests).sort(), proof.actualPaths))
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution actualDigests must exactly match actualPaths: ${canonicalPath}`);
        }
        for (const actualPath of proof.actualPaths)
        {
            const actualDigest = proof.actualDigests[actualPath];
            if (!/^sha256:[a-f0-9]{64}$/u.test(String(actualDigest ?? '')))
            {
                throw new Error(`logicalTierProjection entry ${tierId} substitution actual digest must be sha256: ${actualPath}`);
            }
            if (entry.artifactDigests[actualPath] !== actualDigest)
            {
                throw new Error(`logicalTierProjection entry ${tierId} substitution actual digest must match artifactDigests: ${actualPath}`);
            }
            if (artifactTable && proof.actualRefs?.[actualPath] !== entry.artifactRefs?.[actualPath])
            {
                throw new Error(`logicalTierProjection entry ${tierId} substitution actual ref must match artifactRefs: ${actualPath}`);
            }
        }
        const bindingDigest = artifactSubstitutionBindingDigest(canonicalPath, proof.actualDigests);
        if (proof.canonicalDigest !== bindingDigest)
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution canonicalDigest is invalid: ${canonicalPath}`);
        }
        if (entry.artifactDigests[canonicalPath] !== bindingDigest)
        {
            throw new Error(`logicalTierProjection entry ${tierId} substitution canonical digest must match artifactDigests: ${canonicalPath}`);
        }
        if (artifactTable)
        {
            if (!plainObject(proof.actualRefs)
        || !sameSortedStrings(Object.keys(proof.actualRefs).sort(), proof.actualPaths))
            {
                throw new Error(`logicalTierProjection entry ${tierId} substitution actualRefs must exactly match actualPaths: ${canonicalPath}`);
            }
            if (proof.canonicalArtifactRef !== entry.artifactRefs?.[canonicalPath])
            {
                throw new Error(`logicalTierProjection entry ${tierId} substitution canonical ref must match artifactRefs: ${canonicalPath}`);
            }
            const substitutionRecord = artifactTable.artifacts?.[proof.canonicalArtifactRef];
            if (!substitutionRecord || substitutionRecord.pathType !== 'substitution'
        || substitutionRecord.digest !== bindingDigest
        || fingerprint(substitutionRecord.actualArtifactRefs) !== fingerprint(proof.actualRefs))
            {
                throw new Error(`logicalTierProjection entry ${tierId} substitution artifact ref is invalid: ${canonicalPath}`);
            }
        }
    }
    return new Set(canonicalPaths);
}

function validateProjectionEntry(entry, tierId, projection, checkpoint, root, artifactTable = null)
{
    if (!plainObject(entry))
    {
        throw new Error(`logicalTierProjection entry ${tierId} must be an object`);
    }
    if (!tierId || entry.tierId !== tierId)
    {
        throw new Error(`logicalTierProjection entry ${tierId} tierId must match its key`);
    }
    if (!['executed', 'summary-only', 'external-executed'].includes(entry.evidenceKind))
    {
        throw new Error(`logicalTierProjection entry ${tierId} evidenceKind is invalid`);
    }
    const summaryOnly = entry.evidenceKind === 'summary-only';
    const externalExecuted = entry.evidenceKind === 'external-executed';
    const expectedStatus = summaryOnly ? 'collected-blocked' : 'success';
    const expectedSource = (summaryOnly || externalExecuted) ? 'external-environment' : 'fresh';
    if (entry.status !== expectedStatus)
    {
        throw new Error(`logicalTierProjection entry ${tierId} status must be ${expectedStatus}`);
    }
    if (entry.executionSource !== expectedSource)
    {
        throw new Error(`logicalTierProjection entry ${tierId} executionSource must be ${expectedSource}`);
    }
    if (!Array.isArray(entry.testIds)
    || entry.testIds.some((testId) => typeof testId !== 'string' || !testId.trim())
    || new Set(entry.testIds).size !== entry.testIds.length
    || entry.testIds.some((testId, index) => index > 0 && entry.testIds[index - 1] > testId))
    {
        throw new Error(`logicalTierProjection entry ${tierId} testIds must be sorted unique non-empty strings`);
    }
    if ((entry.evidenceKind === 'executed' && entry.testIds.length === 0) || (summaryOnly && entry.testIds.length !== 0))
    {
        throw new Error(`logicalTierProjection entry ${tierId} testIds do not match its evidenceKind`);
    }
    if (!plainObject(entry.artifactDigests) || Object.keys(entry.artifactDigests).length === 0)
    {
        throw new Error(`logicalTierProjection entry ${tierId} artifactDigests must be a non-empty object`);
    }
    if (artifactTable && !externalExecuted)
    {
        validateArtifactRefs(entry.artifactDigests, entry.artifactRefs, artifactTable);
    }
    const sealedBundle = (summaryOnly || externalExecuted)
        ? null
        : bundleSummaryOutput(checkpoint, root, entry.physicalBundleId);
    const sealedMember = sealedBundle?.summary?.members?.[tierId];
    if (!summaryOnly && !externalExecuted && !plainObject(sealedMember))
    {
        throw new Error(`logicalTierProjection entry ${tierId} has no sealed member evidence in ${sealedBundle.summaryPath}`);
    }
    const substitutionCanonicalPaths = (summaryOnly || externalExecuted)
        ? new Set()
        : validateArtifactSubstitutionProofs(entry, tierId, artifactTable);
    for (const [artifactPath, digest] of Object.entries(entry.artifactDigests))
    {
        if (!artifactPath.trim() || path.isAbsolute(artifactPath) || artifactPath === '..' || artifactPath.startsWith('../'))
        {
            throw new Error(`logicalTierProjection entry ${tierId} artifact digest path is invalid`);
        }
        if (!/^sha256:[a-f0-9]{64}$/u.test(String(digest)))
        {
            throw new Error(`logicalTierProjection entry ${tierId} artifactDigests must contain sha256 digests`);
        }
        let currentDigest;
        if (substitutionCanonicalPaths.has(artifactPath))
        {
            currentDigest = digest;
        }
        else if (externalExecuted)
        {
            const absoluteArtifact = path.resolve(root, artifactPath);
            if (!absoluteArtifact.startsWith(`${root}${path.sep}`) || !fs.existsSync(absoluteArtifact)
        || !fs.lstatSync(absoluteArtifact).isFile() || fs.lstatSync(absoluteArtifact).isSymbolicLink())
            {
                throw new Error(`logicalTierProjection entry ${tierId} external receipt artifact is missing or invalid: ${artifactPath}`);
            }
            let receipt;
            try
            {
                receipt = JSON.parse(fs.readFileSync(absoluteArtifact, 'utf8'));
            }
            catch
            {
                throw new Error(`logicalTierProjection entry ${tierId} external receipt artifact is not JSON`);
            }
            currentDigest = externalEvidenceReceiptDigest(receipt);
        }
        else if (summaryOnly && !artifactTable)
        {
            const absoluteArtifact = path.resolve(root, artifactPath);
            if (artifactPath.includes('*')
        || artifactPath.includes('?')
        || !absoluteArtifact.startsWith(`${root}${path.sep}`)
        || !fs.existsSync(absoluteArtifact)
        || !fs.lstatSync(absoluteArtifact).isFile()
        || fs.lstatSync(absoluteArtifact).isSymbolicLink())
            {
                throw new Error(`logicalTierProjection entry ${tierId} artifact is missing or invalid: ${artifactPath}`);
            }
            currentDigest = `sha256:${sha256(fs.readFileSync(absoluteArtifact))}`;
        }
        else if (summaryOnly)
        {
            currentDigest = artifactTable.artifacts[entry.artifactRefs[artifactPath]].digest;
        }
        else
        {
            currentDigest = sealedMember.artifactDigests?.[artifactPath];
        }
        if (currentDigest !== digest)
        {
            throw new Error(`logicalTierProjection entry ${tierId} artifact digest does not match: ${artifactPath}`);
        }
    }
    if (summaryOnly || externalExecuted)
    {
        if (entry.physicalBundleId !== null)
        {
            throw new Error(`logicalTierProjection entry ${tierId} physicalBundleId must be null`);
        }
        if (entry.durationMs !== null)
        {
            throw new Error(`logicalTierProjection entry ${tierId} durationMs must be null`);
        }
        if (externalExecuted)
        {
            if (!plainObject(entry.blockedPlaceholder) || typeof entry.authorityId !== 'string' || !entry.authorityId
        || entry.schedulerRunId !== checkpoint.runId || !plainObject(entry.buildIdentity)
        || !Array.isArray(entry.coverageIds) || entry.coverageIds.length === 0
        || !Array.isArray(entry.assertionIds) || entry.assertionIds.length === 0)
            {
                throw new Error(`logicalTierProjection entry ${tierId} external receipt binding is invalid`);
            }
            const placeholder = entry.blockedPlaceholder;
            const placeholderPath = placeholder.evidencePath;
            const absolutePlaceholder = typeof placeholderPath === 'string' ? path.resolve(root, placeholderPath) : null;
            if (!absolutePlaceholder || !absolutePlaceholder.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolutePlaceholder)
        || !fs.lstatSync(absolutePlaceholder).isFile() || fs.lstatSync(absolutePlaceholder).isSymbolicLink())
            {
                throw new Error(`logicalTierProjection entry ${tierId} blocked placeholder is missing or invalid`);
            }
            let placeholderDocument;
            try
            {
                placeholderDocument = JSON.parse(fs.readFileSync(absolutePlaceholder, 'utf8'));
            }
            catch
            {
                throw new Error(`logicalTierProjection entry ${tierId} blocked placeholder is not JSON`);
            }
            if (placeholder.schema !== 'fsusblog.local-production.summary-only.v1' || placeholder.tierId !== tierId
        || placeholder.status !== 'collected-blocked' || placeholder.executionSource !== 'external-environment'
        || placeholder.schedulerRunId !== checkpoint.runId
        || placeholderDocument.schema !== placeholder.schema || placeholderDocument.tierId !== tierId
        || placeholderDocument.status !== 'collected-blocked' || placeholderDocument.executionSource !== 'external-environment'
        || placeholderDocument.schedulerRunId !== checkpoint.runId
        || String(placeholderDocument.sourceState?.commit ?? '') !== String(checkpoint.sourceState?.commit ?? '')
        || String(placeholderDocument.sourceState?.worktreeFingerprint ?? '') !== String(checkpoint.sourceState?.worktreeFingerprint ?? '')
        || placeholder.artifactDigest !== `sha256:${sha256(fs.readFileSync(absolutePlaceholder))}`)
            {
                throw new Error(`logicalTierProjection entry ${tierId} blocked placeholder binding is invalid`);
            }
            const receiptPath = Object.keys(entry.artifactDigests)[0];
            let receipt;
            try
            {
                receipt = JSON.parse(fs.readFileSync(path.resolve(root, receiptPath), 'utf8'));
            }
            catch
            {
                throw new Error(`logicalTierProjection entry ${tierId} external receipt is not JSON`);
            }
            if (receipt.contentDigest !== entry.artifactDigests[receiptPath]
        || receipt.authorityId !== entry.authorityId || receipt.schedulerRunId !== entry.schedulerRunId
        || JSON.stringify(receipt.testIds?.toSorted?.() ?? []) !== JSON.stringify(entry.testIds)
        || JSON.stringify(receipt.coverageIds?.toSorted?.() ?? []) !== JSON.stringify(entry.coverageIds)
        || JSON.stringify(receipt.assertionIds?.toSorted?.() ?? []) !== JSON.stringify(entry.assertionIds)
        || JSON.stringify(receipt.sourceState) !== JSON.stringify(entry.sourceState)
        || JSON.stringify(receipt.buildIdentity) !== JSON.stringify(entry.buildIdentity)
        || receipt.contentDigest !== externalEvidenceReceiptDigest(receipt))
            {
                throw new Error(`logicalTierProjection entry ${tierId} external receipt does not match its binding`);
            }
        }
    }
    else
    {
        if (!Number.isFinite(entry.durationMs) || entry.durationMs < 0)
        {
            throw new Error(`logicalTierProjection entry ${tierId} durationMs must be non-negative`);
        }
        const sealedFields = {
            status: sealedMember.status,
            durationMs: Number(sealedMember.durationMs),
            testIds: [...(sealedMember.testIds ?? [])].sort(),
            artifactProofMode: sealedMember.artifactProofMode,
            matrixRuntimePaths: [...(sealedMember.matrixRuntimePaths ?? [])],
            artifactSubstitutionProofs: sealedMember.artifactSubstitutionProofs,
            artifactDigests: sealedMember.artifactDigests,
            ...(artifactTable ? { artifactRefs: sealedMember.artifactRefs } : {})
        };
        const projectedFields = {
            status: entry.status,
            durationMs: entry.durationMs,
            testIds: entry.testIds,
            artifactProofMode: entry.artifactProofMode,
            matrixRuntimePaths: entry.matrixRuntimePaths,
            artifactSubstitutionProofs: entry.artifactSubstitutionProofs,
            artifactDigests: entry.artifactDigests,
            ...(artifactTable ? { artifactRefs: entry.artifactRefs } : {})
        };
        if (fingerprint(projectedFields) !== fingerprint(sealedFields))
        {
            throw new Error(`logicalTierProjection entry ${tierId} does not match sealed bundle member evidence`);
        }
    }
    if (!projection.logicalTierIds.includes(tierId))
    {
        throw new Error(`logicalTierProjection entry ${tierId} is not declared in logicalTierIds`);
    }
}

function validateCheckpointEvidence(checkpoint, evidence, root)
{
    if (!plainObject(evidence))
    {
        throw new Error('checkpoint evidence must be an object');
    }
    const supportedFields = new Set(['logicalTierProjection']);
    for (const field of Object.keys(evidence))
    {
        if (!supportedFields.has(field))
        {
            throw new Error(`unsupported checkpoint evidence field: ${field}`);
        }
    }
    const projection = evidence.logicalTierProjection;
    if (!plainObject(projection) || projection.schema !== 'fsusblog.local-profile-projection.v1')
    {
        throw new Error('logicalTierProjection must use schema fsusblog.local-profile-projection.v1');
    }
    if (projection.runId !== checkpoint.runId)
    {
        throw new Error(`logicalTierProjection run ${projection.runId} does not match checkpoint run ${checkpoint.runId}`);
    }
    if (projection.executionSource !== 'fresh')
    {
        throw new Error('logicalTierProjection executionSource must be fresh');
    }
    if (projection.profileId !== checkpoint.targetTierId
    || !['complete-success', 'complete-failure', 'incomplete-external-evidence'].includes(projection.status))
    {
        throw new Error('logicalTierProjection profileId/status is invalid for the checkpoint target');
    }
    let artifactTable = null;
    if (projection.artifactDigestTable !== undefined)
    {
        const descriptor = projection.artifactDigestTable;
        if (!plainObject(descriptor) || typeof descriptor.path !== 'string'
      || path.isAbsolute(descriptor.path) || descriptor.path === '..' || descriptor.path.startsWith('../'))
        {
            throw new Error('logicalTierProjection artifactDigestTable descriptor is invalid');
        }
        artifactTable = readAndValidateArtifactDigestTable(path.resolve(root, descriptor.path), {
            root,
            runId: checkpoint.runId,
            sourceState: checkpoint.sourceState,
            expectedContentDigest: descriptor.contentDigest
        });
        if (descriptor.schema !== artifactTable.schema
      || descriptor.runId !== artifactTable.runId
      || descriptor.sourceState?.commit !== artifactTable.sourceState?.commit
      || descriptor.sourceState?.worktreeFingerprint !== artifactTable.sourceState?.worktreeFingerprint
      || descriptor.artifactCount !== Object.keys(artifactTable.artifacts ?? {}).length)
        {
            throw new Error('logicalTierProjection artifactDigestTable descriptor does not match its table');
        }
    }
    if (!projection.entries || typeof projection.entries !== 'object' || Array.isArray(projection.entries))
    {
        throw new Error('logicalTierProjection entries must be an object');
    }
    const entryIds = Object.keys(projection.entries).sort();
    if (!Number.isInteger(projection.logicalTierCount) || projection.logicalTierCount !== entryIds.length)
    {
        throw new Error('logicalTierProjection logicalTierCount must match its entries');
    }
    if (!Array.isArray(projection.logicalTierIds)
    || projection.logicalTierIds.some((tierId) => typeof tierId !== 'string' || !tierId.trim())
    || new Set(projection.logicalTierIds).size !== projection.logicalTierIds.length
    || projection.logicalTierIds.some((tierId, index) => index > 0 && projection.logicalTierIds[index - 1] > tierId))
    {
        throw new Error('logicalTierProjection logicalTierIds must be sorted unique non-empty strings');
    }
    const declaredTierIds = projection.logicalTierIds;
    if (declaredTierIds.length !== entryIds.length
    || declaredTierIds.some((tierId, index) => tierId !== entryIds[index]))
    {
        throw new Error('logicalTierProjection logicalTierIds must exactly match its entries');
    }
    if (!Array.isArray(projection.requiredSummaryOnlyTierIds)
    || projection.requiredSummaryOnlyTierIds.some((tierId) => typeof tierId !== 'string' || !tierId)
    || projection.requiredSummaryOnlyTierIds.some((tierId) => !Object.hasOwn(projection.entries, tierId)))
    {
        throw new Error('logicalTierProjection required summary-only entries must remain present');
    }
    const summaryOnlyTierCount = Object.values(projection.entries)
        .filter((entry) => entry?.evidenceKind === 'summary-only').length;
    if (!Number.isInteger(projection.summaryOnlyTierCount)
    || !Number.isInteger(projection.executedTierCount)
    || projection.summaryOnlyTierCount !== summaryOnlyTierCount
    || projection.executedTierCount !== entryIds.length - summaryOnlyTierCount)
    {
        throw new Error('logicalTierProjection executed/summary-only counts must match its entries');
    }
    const qualificationEligible = summaryOnlyTierCount === 0;
    if (typeof projection.qualificationEligible !== 'boolean'
    || projection.qualificationEligible !== qualificationEligible)
    {
        throw new Error('logicalTierProjection qualificationEligible must match summary-only entries');
    }
    if (summaryOnlyTierCount > 0
    && (!['incomplete-external-evidence', 'complete-failure'].includes(projection.status) || projection.qualificationEligible))
    {
        throw new Error('logicalTierProjection summary-only entries must be incomplete or failed and unqualified');
    }
    if (summaryOnlyTierCount === 0
    && (projection.status !== 'complete-success' || !projection.qualificationEligible))
    {
        throw new Error('logicalTierProjection complete-success requires no summary-only entries and qualification eligibility');
    }
    if (String(projection.sourceState?.commit ?? '') !== String(checkpoint.sourceState?.commit ?? '')
    || String(projection.sourceState?.worktreeFingerprint ?? '') !== String(checkpoint.sourceState?.worktreeFingerprint ?? ''))
    {
        throw new Error('logicalTierProjection sourceState must match the checkpoint');
    }
    for (const tierId of entryIds)
    {
        validateProjectionEntry(projection.entries[tierId], tierId, projection, checkpoint, root, artifactTable);
    }
}

export function validateLocalProfileCheckpointEvidence(checkpoint, root)
{
    if (!plainObject(checkpoint) || !plainObject(checkpoint.logicalTierProjection))
    {
        throw new Error('qualified local-profile checkpoint has no logicalTierProjection');
    }
    validateCheckpointEvidence(checkpoint, { logicalTierProjection: checkpoint.logicalTierProjection }, root);
    return checkpoint.logicalTierProjection;
}

async function validateCurrentCheckpointSource(checkpoint, root, snapshotWorktree)
{
    const snapshot = await (snapshotWorktree ?? (() => snapshotGitWorktree(root)))();
    const current = {
        commit: gitHead(root) || 'unversioned',
        worktreeFingerprint: snapshot?.fingerprint
    };
    if (!String(current.worktreeFingerprint ?? '').trim() || !sameCheckpointSource(current, checkpoint.sourceState))
    {
        throw new Error('checkpoint sourceState does not match the current repository source');
    }
    return current;
}

function persistEvidenceFailure(checkpointFile, expectedRunId, error)
{
    const checkpoint = readCheckpoint(checkpointFile);
    if (!checkpoint || checkpoint.runId !== expectedRunId || checkpoint.status !== 'success')
    {
        return;
    }
    const failure = {
        tierId: checkpoint.targetTierId,
        exitCode: 1,
        signal: null,
        reason: `checkpoint evidence finalization failed: ${error.message}`,
        changedPaths: []
    };
    checkpoint.status = 'failure';
    checkpoint.failure = failure;
    checkpoint.failurePoint = checkpoint.targetTierId;
    checkpoint.finishedAt = new Date().toISOString();
    checkpoint.ungeneratedEvidence = [{
        tierId: checkpoint.targetTierId,
        declaration: 'logicalTierProjection'
    }];
    writeCheckpoint(checkpointFile, checkpoint, {
        boundary: true,
        stage: 'evidence-finalization-failed',
        eventType: 'evidence-finalization-failed',
        tier: checkpoint.targetTierId,
        step: 'finalize-evidence'
    });
}

export function attachCheckpointCurrentRunEvidence(checkpointFileValue, expectedRunId, {
    expectedRevision, context, entry, handoff, registry, repositoryRoot
})
{
    const checkpointFile = path.resolve(checkpointFileValue);
    // Observe the original recovered revision before lock acquisition, then
    // compare it again under ownership. A failed compact publication can
    // leave the compatibility JSON behind the durable journal revision.
    if (expectedRevision === undefined)
    {
        expectedRevision = readCheckpoint(checkpointFile)?.revision;
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision <= 0)
    {
        throw new Error('checkpoint evidence attach requires a positive expectedRevision');
    }
    const releaseLock = acquireRunLock(path.dirname(path.dirname(checkpointFile)), expectedRunId);
    let failure = null;
    let cleanupFailure = null;
    let result;
    try
    {
        const checkpoint = readCheckpoint(checkpointFile);
        if (!checkpoint || checkpoint.runId !== expectedRunId
        || context.schedulerRunId !== expectedRunId)
        {
            throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFileValue}`);
        }
        if (checkpoint.revision !== expectedRevision)
        {
            throw new Error(`checkpoint revision ${checkpoint.revision} does not match expected revision ${expectedRevision}`);
        }
        if (checkpoint.sourceState?.commit !== context.sourceCommit
        || checkpoint.sourceState?.worktreeFingerprint !== context.worktreeFingerprint)
        {
            throw new Error('scheduler checkpoint source identity mismatch');
        }
        const baseline = structuredClone(checkpoint);
        attachCurrentRunEvidenceHandoff({ checkpoint, context, entry, handoff, registry, repositoryRoot });
        // A different process may have advanced this run since our last
        // attachment. Reconstruct the original writer's baseline under the
        // same lock as the fresh read/CAS; a cached prior epoch is not valid.
        checkpointPersistence.delete(checkpointFile);
        const persistence = schedulerPersistence(checkpointFile, baseline);
        if (persistence.previous !== null
        && fingerprint(persistence.previous) !== fingerprint(baseline))
        {
            throw new Error('scheduler checkpoint journal baseline does not match the locked revision');
        }
        writeCheckpoint(checkpointFile, checkpoint, {
            boundary: true,
            stage: 'current-run-evidence-attached',
            eventType: 'current-run-evidence-attached',
            tier: checkpoint.targetTierId,
            step: 'attach-current-run-evidence'
        });
        result = checkpoint;
    }
    catch (error)
    {
        failure = error;
        throw error;
    }
    finally
    {
        try
        {
            releaseLock(failure === null ? 'complete' : 'failed');
        }
        catch (cleanupError)
        {
            if (failure === null)
            {
                cleanupFailure = cleanupError;
            }
            else
            {
                failure.checkpointLockFinalizeError = cleanupError;
            }
        }
    }
    if (cleanupFailure !== null)
    {
        throw cleanupFailure;
    }
    return result;
}

export async function attachCheckpointEvidence(checkpointFileValue, expectedRunId, evidenceOrBuilder, options = {})
{
    const checkpointFile = path.resolve(checkpointFileValue);
    const runDirectory = path.dirname(checkpointFile);
    const runsRoot = path.dirname(runDirectory);
    const root = path.resolve(options.root ?? '');
    if (!options.root)
    {
        throw new Error('checkpoint evidence attach requires options.root');
    }
    if (!Number.isInteger(options.expectedRevision) || options.expectedRevision <= 0)
    {
        throw new Error('checkpoint evidence attach requires a positive expectedRevision');
    }
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    let finalizationStarted = false;
    try
    {
        const checkpoint = readCheckpoint(checkpointFile);
        if (!checkpoint)
        {
            throw new Error(`missing or invalid scheduler checkpoint: ${checkpointFileValue}`);
        }
        if (checkpoint.runId !== expectedRunId)
        {
            throw new Error(`checkpoint run ${checkpoint.runId} does not match expected run ${expectedRunId}`);
        }
        if (checkpoint.revision !== options.expectedRevision)
        {
            throw new Error(`checkpoint revision ${checkpoint.revision} does not match expected revision ${options.expectedRevision}`);
        }
        if (checkpoint.status !== 'success')
        {
            throw new Error(`checkpoint ${checkpoint.runId} must be successful before attaching evidence`);
        }
        finalizationStarted = true;
        await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree);
        validateCheckpointBundleSummaries(checkpoint, root);
        const evidence = typeof evidenceOrBuilder === 'function'
            ? await evidenceOrBuilder(checkpoint)
            : evidenceOrBuilder;
        await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree);
        validateCheckpointBundleSummaries(checkpoint, root);
        validateCheckpointEvidence(checkpoint, evidence, root);
        checkpoint.logicalTierProjection = evidence.logicalTierProjection;
        writeCheckpoint(checkpointFile, checkpoint, {
            boundary: true,
            stage: 'evidence-finalized',
            eventType: 'evidence-finalized',
            tier: checkpoint.targetTierId,
            step: 'finalize-evidence'
        });
        return checkpoint;
    }
    catch (error)
    {
        if (finalizationStarted)
        {
            persistEvidenceFailure(checkpointFile, expectedRunId, error);
        }
        throw error;
    }
    finally
    {
        releaseLock();
    }
}

export function isProjectionOnlyCheckpointFailure(checkpoint)
{
    const projectionFailure = String(checkpoint?.failure?.reason ?? '')
        .startsWith('checkpoint evidence finalization failed:');
    const onlyProjectionMissing = checkpoint?.ungeneratedEvidence?.length === 1
    && checkpoint.ungeneratedEvidence[0]?.tierId === checkpoint.targetTierId
    && checkpoint.ungeneratedEvidence[0]?.declaration === 'logicalTierProjection';
    const physicalTiers = Object.values(checkpoint?.tiers ?? {});
    const physicalTiersSucceeded = physicalTiers.length > 0
    && physicalTiers.every((tier) => tier?.status === 'success' && tier?.reused === false);
    return checkpoint?.status === 'failure'
    && checkpoint?.mode === 'fresh'
    && checkpoint?.authoritative === true
    && projectionFailure
    && onlyProjectionMissing
    && physicalTiersSucceeded;
}

export async function resumeCheckpointEvidence(checkpointFileValue, expectedRunId, evidenceBuilder, options = {})
{
    const checkpointFile = path.resolve(checkpointFileValue);
    const runsRoot = path.dirname(path.dirname(checkpointFile));
    const root = path.resolve(options.root ?? '');
    if (!options.root)
    {
        throw new Error('checkpoint evidence resume requires options.root');
    }
    if (typeof evidenceBuilder !== 'function')
    {
        throw new Error('checkpoint evidence resume requires an evidence builder');
    }
    const releaseLock = acquireRunLock(runsRoot, expectedRunId);
    try
    {
        const checkpoint = readCheckpoint(checkpointFile);
        if (!checkpoint || checkpoint.runId !== expectedRunId)
        {
            throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFileValue}`);
        }
        if (!isProjectionOnlyCheckpointFailure(checkpoint))
        {
            throw new Error('checkpoint is not a projection-only failure with fresh successful physical tiers');
        }
        await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree);
        validateCheckpointBundleSummaries(checkpoint, root);
        const successfulCheckpoint = structuredClone(checkpoint);
        successfulCheckpoint.status = 'success';
        successfulCheckpoint.failure = null;
        delete successfulCheckpoint.failurePoint;
        delete successfulCheckpoint.ungeneratedEvidence;
        const evidence = await evidenceBuilder(successfulCheckpoint);
        const finalizerSource = await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree);
        validateCheckpointBundleSummaries(checkpoint, root);
        validateCheckpointEvidence(successfulCheckpoint, evidence, root);
        if (evidence.logicalTierProjection.status !== 'complete-success'
      || evidence.logicalTierProjection.qualificationEligible !== true)
        {
            throw new Error('projection-only resume requires a qualification-eligible complete-success projection');
        }
        const preparedCheckpoint = structuredClone(successfulCheckpoint);
        preparedCheckpoint.logicalTierProjection = evidence.logicalTierProjection;
        preparedCheckpoint.evidenceFinalization = {
            mode: 'projection-resume',
            finalizedAt: new Date().toISOString(),
            finalizerSource
        };
        const transaction = prepareProjectionResumeTransaction(
            checkpointFile,
            checkpoint,
            preparedCheckpoint
        );
        if (typeof options.beforeCommit !== 'function')
        {
            throw new Error('projection-only resume requires a beforeCommit completion callback');
        }
        await options.beforeCommit({
            checkpoint: structuredClone(transaction.expectedSuccess),
            evidence: structuredClone(evidence),
            checkpointFile
        });
        await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree);
        validateCheckpointBundleSummaries(checkpoint, root);
        return writeProjectionResumeCheckpoint(
            checkpointFile,
            transaction,
            options.projectionPersistenceFaultInjector
        );
    }
    finally
    {
        releaseLock();
    }
}

function safeRunId(value)
{
    return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

export function createRunId(prefix = 'matrix')
{
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    return safeRunId(`${prefix}-${timestamp}-${process.pid}`);
}

export function findLatestRunId(runsRoot, targetTierId = null)
{
    throw new Error(`contract.missing-resume-identity: automatic latest-run selection is forbidden (${String(targetTierId ?? '')}, ${String(runsRoot)})`);
}

/** A viewer result cannot be passed as an authoritative resume selector. */
export function findDiagnosticRecentRun(runsRoot, targetTierId = null)
{
    if (!fs.existsSync(runsRoot))
    {
        return null;
    }
    const latest = fs.readdirSync(runsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ runId: entry.name, checkpoint: readCheckpoint(path.join(runsRoot, entry.name, 'checkpoint.json')) }))
        .filter((entry) => entry.checkpoint && (!targetTierId || entry.checkpoint.targetTierId === targetTierId))
        .sort((left, right) => String(right.checkpoint.updatedAt).localeCompare(String(left.checkpoint.updatedAt)))[0];
    return latest ? { runId: latest.runId, authority: 'diagnostic-only', qualificationEligible: false,
        active: latest.checkpoint.status === 'running' && runLockIsActive(runsRoot, latest.runId) } : null;
}

function resolveRealOrAncestralPath(targetPath)
{
    const resolved = path.resolve(targetPath);
    if (fs.existsSync(resolved))
    {
        return fs.realpathSync(resolved);
    }
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent))
    {
        return path.join(fs.realpathSync(parent), path.basename(resolved));
    }
    return resolved;
}

function resetFreshRunDirectory(runDirectory, preservation = null)
{
    if (preservation === null || preservation === undefined)
    {
        fs.rmSync(runDirectory, { recursive: true, force: true });
        return;
    }
    if (!plainObject(preservation)
    || !Array.isArray(preservation.entries)
    || preservation.entries.length === 0)
    {
        throw new Error('fresh run directory preservation must declare non-empty entries');
    }
    if (!fs.existsSync(runDirectory))
    {
        throw new Error(`prepared fresh run directory is missing: ${runDirectory}`);
    }
    const runStat = fs.lstatSync(runDirectory);
    if (!runStat.isDirectory() || runStat.isSymbolicLink())
    {
        throw new Error(`prepared fresh run directory is invalid: ${runDirectory}`);
    }
    const expected = new Map();
    for (const entry of preservation.entries)
    {
        if (!plainObject(entry)
      || typeof entry.name !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)
      || !['file', 'directory'].includes(entry.type)
      || expected.has(entry.name))
        {
            throw new Error('fresh run directory preservation entry is invalid');
        }
        expected.set(entry.name, entry.type);
    }
    const assertPreservedEntries = () =>
    {
        for (const [name, type] of expected)
        {
            const candidate = path.join(runDirectory, name);
            if (!fs.existsSync(candidate))
            {
                throw new Error(`prepared fresh run directory entry is missing: ${name}`);
            }
            const stat = fs.lstatSync(candidate);
            const validType = type === 'file' ? stat.isFile() : stat.isDirectory();
            if (stat.isSymbolicLink() || !validType)
            {
                throw new Error(`prepared fresh run directory entry has invalid type: ${name}`);
            }
        }
    };
    assertPreservedEntries();
    for (const name of fs.readdirSync(runDirectory))
    {
        if (expected.has(name))
        {
            continue;
        }
        fs.rmSync(path.join(runDirectory, name), { recursive: true, force: true });
    }
    assertPreservedEntries();
}

function validateSchedulerGrantDocument(document, runId, checkpoint = null)
{
    const units = (value, minimum) => plainObject(value)
        && Object.keys(value).sort().join(',') === 'cpuUnits,memoryGiB'
        && Object.values(value).every((number) => typeof number === 'number' && Number.isFinite(number)
            && (minimum === 0 ? number >= 0 : number > 0));
    if (!plainObject(document) || document.schema !== 'fsusblog.test-matrix.resource-grants.v1'
        || document.runId !== runId || !units(document.resourceBudget, 1) || !units(document.residentReservation, 0)
        || !plainObject(document.grants) || Object.entries(document.grants).some(([id, grant]) =>
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(id) || !units(grant, 1))
        || !Number.isFinite(Date.parse(document.generatedAt)))
    {
        throw new Error('scheduler resource grant projection is incomplete or invalid');
    }
    if (checkpoint && (!sameCheckpointSource(document.sourceState, checkpoint.sourceState)
        || document.schedulerOwnerToken !== checkpoint.schedulerRunOwnerToken
        || typeof document.schedulerOwnerToken !== 'string' || !document.schedulerOwnerToken))
    {
        throw new Error('scheduler resource grant journal owner or source binding differs');
    }
}

function readSchedulerGrantProjection(file, runId)
{
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat)
    {
        return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== file
        || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)))
    {
        throw new Error('scheduler resource grant projection must be an owned, literal, singly linked regular file');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try
    {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.ctimeMs !== stat.ctimeMs)
        {
            throw new Error('scheduler resource grant projection changed during open');
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (after.ctimeMs !== opened.ctimeMs || after.size !== opened.size)
        {
            throw new Error('scheduler resource grant projection changed during observation');
        }
        const document = JSON.parse(bytes.toString('utf8'));
        validateSchedulerGrantDocument(document, runId);
        return document;
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function schedulerResourcesUnsettled(checkpointFile, runId,
    checkpoint = readCheckpoint(checkpointFile, { journalAuthority: true }))
{
    const retained = checkpoint?.resourceUtilization?.retainedResourceGrants;
    if (retained !== undefined && (!plainObject(retained) || Object.keys(retained).length > 0))
    {
        return true;
    }
    const mysql = checkpoint?.mysqlFixtureServices;
    if (mysql !== undefined && (!plainObject(mysql) || Object.values(mysql).some((record) =>
        record?.status !== 'cleaned' || record.cleanup?.containerAbsent !== true || record.cleanup?.credentialsRemoved !== true)))
    {
        return true;
    }
    const projection = readSchedulerGrantProjection(path.join(path.dirname(checkpointFile), 'resource-grants.json'), runId);
    const journal = checkpoint?.resourceUtilization?.resourceGrants;
    if (journal !== undefined && journal !== null)
    {
        validateSchedulerGrantDocument(journal, runId, checkpoint);
        if (!projection || fingerprint(journal) !== fingerprint(projection))
        {
            throw new Error('scheduler resource grant projection differs from its durable journal; independent owner reconciliation required');
        }
    }
    for (const document of [journal, projection])
    {
        if (document && (Object.keys(document.grants).length > 0
            || document.residentReservation.cpuUnits > 0 || document.residentReservation.memoryGiB > 0))
        {
            return true;
        }
    }
    if (!schedulerResourceReconciliationIsComplete(checkpoint)
        && ((checkpoint && Object.hasOwn(checkpoint, 'resourceCleanupFailure'))
            || (checkpoint?.status === 'running' && checkpoint.resourceEnforcement?.mode === 'enforced')))
    {
        // Neither zero worker grants nor interrupted creation proves resource-owner cleanup.
        return true;
    }
    return false;
}

function readOriginalSchedulerResourceCheckpoint({ root, runId, namespace, sourceState, schedulerOwner })
{
    if (!schedulerRunOwnerIsComplete(schedulerOwner) || schedulerOwner.runId !== runId
        || schedulerOwner.candidateIdentityDigest !== schedulerCandidateIdentityDigest({
            runId, namespace, sourceState, targetTierId: schedulerOwner.targetTierId,
            budgetPolicyDigest: schedulerOwner.budgetPolicyDigest ?? null
        }))
    {
        throw new Error('scheduler resource retention requires its exact independently retained owner');
    }
    const directory = path.join(path.resolve(root), '.tmp/test-runs', safeRunId(runId));
    if (!fs.existsSync(path.join(directory, 'evidence-store')))
    {
        throw new Error('scheduler resource retention is missing its durable journal');
    }
    const checkpointFile = path.join(directory, 'checkpoint.json');
    const checkpoint = readCheckpoint(checkpointFile, { journalAuthority: true, requireCompleteJournal: true });
    if (!checkpoint || checkpoint.runId !== runId || checkpoint.namespace !== namespace
        || !sameCheckpointSource(checkpoint.sourceState, sourceState)
        || checkpoint.schedulerRunOwnerToken !== schedulerOwner.ownerToken
        || checkpoint.schedulerCandidateIdentityDigest !== schedulerOwner.candidateIdentityDigest
        || checkpoint.targetTierId !== schedulerOwner.targetTierId
        || (checkpoint.budgetPolicyDigest ?? null) !== (schedulerOwner.budgetPolicyDigest ?? null))
    {
        throw new Error('scheduler resource retention journal differs from the original build owner');
    }
    return { checkpointFile, checkpoint };
}

/** Observe the original build owner's grant journal without acquiring, resetting or releasing it. */
export function inspectSchedulerResourceRetention(binding)
{
    const { checkpointFile, checkpoint } = readOriginalSchedulerResourceCheckpoint(binding);
    // Absence of a grant record cannot certify a resource-bound build as settled.
    const retained = !checkpoint.resourceUtilization?.resourceGrants
        || schedulerResourcesUnsettled(checkpointFile, binding.runId, checkpoint);
    return { status: retained ? 'retained' : 'released' };
}

function schedulerResourceReconciliationIsComplete(checkpoint)
{
    const record = checkpoint?.resourceReconciliation;
    if (record === undefined)
    {
        return false;
    }
    const grants = checkpoint.resourceUtilization?.resourceGrants;
    const owner = record?.recoveryOwner;
    if (!record || record.schema !== 'fsusblog.scheduler-resource-reconciliation.v1'
        || !schedulerRunOwnerIsComplete(owner) || owner.runId !== checkpoint.runId
        || owner.ownerToken === checkpoint.schedulerRunOwnerToken
        || owner.candidateIdentityDigest !== checkpoint.schedulerCandidateIdentityDigest
        || owner.targetTierId !== checkpoint.targetTierId
        || (owner.budgetPolicyDigest ?? null) !== (checkpoint.budgetPolicyDigest ?? null)
        || record.reference?.runId !== checkpoint.runId || record.reference?.namespace !== checkpoint.namespace
        || record.reference?.sourceCommit !== checkpoint.sourceState?.commit
        || record.reference?.worktreeFingerprint !== checkpoint.sourceState?.worktreeFingerprint
        || fingerprint(record.priorCleanupFailure) !== fingerprint(checkpoint.resourceCleanupFailure ?? null)
        || checkpoint.status === 'running' || checkpoint.status === 'success'
        || !plainObject(record.priorRetainedResourceGrants) || !grants)
    {
        throw new Error('scheduler resource reconciliation binding is invalid');
    }
    validateSchedulerGrantDocument(record.priorResourceGrants, checkpoint.runId, checkpoint);
    validateSchedulerGrantDocument(grants, checkpoint.runId, checkpoint);
    if (fingerprint(grants) !== fingerprint({ ...record.priorResourceGrants,
        generatedAt: record.completedAt, grants: {}, residentReservation: { cpuUnits: 0, memoryGiB: 0 } })
        || Object.keys(checkpoint.resourceUtilization.retainedResourceGrants ?? {}).length !== 0)
    {
        throw new Error('scheduler resource reconciliation differs from its settled journal');
    }
    assertRetainedMySqlFixtureRecoveryComplete({ allocations: checkpoint.mysqlFixtureServices,
        records: record.mysqlFixtureReconciliation ?? [], requireCleaned: true });
    return true;
}

function assertMySqlFixtureRecoveryComplete(checkpoint, records, lifecycle)
{
    if (Object.keys(checkpoint.mysqlFixtureServices ?? {}).length > 0 && !lifecycle)
    {
        throw new Error('MySQL scheduler grant release requires the canonical lifecycle observer');
    }
    assertRetainedMySqlFixtureRecoveryComplete({ allocations: checkpoint.mysqlFixtureServices, records, lifecycle });
}

/** Only the scheduler can mint this in-process capability; serialized owners or reports are not leases. */
export function assertSchedulerResourceRecovery(capability, { reference, schedulerOwner })
{
    const recovery = schedulerResourceRecoveries.get(capability);
    if (!recovery || fingerprint(reference) !== fingerprint(recovery.reference)
        || !schedulerRunOwnerIdentityMatches(schedulerOwner, recovery.binding.schedulerOwner))
    {
        throw new Error('resource reconciliation requires an acquired scheduler recovery capability');
    }
    recovery.assertAdmission?.();
    const activity = schedulerRunLockActivity({ runsRoot: recovery.runsRoot, runId: reference.runId,
        candidateIdentityDigest: schedulerOwner.candidateIdentityDigest, targetTierId: schedulerOwner.targetTierId });
    const metadata = fs.lstatSync(recovery.controller.lockPath);
    if (activity.status !== 'active' || activity.owner?.pid !== process.pid
        || !schedulerRunOwnerIdentityMatches(recovery.controller.owner, activity.owner)
        || metadata.dev !== recovery.lockIdentity.dev || metadata.ino !== recovery.lockIdentity.ino
        || !metadata.isDirectory() || metadata.isSymbolicLink()
        || fs.realpathSync.native(recovery.controller.lockPath) !== recovery.controller.lockPath)
    {
        throw new Error('scheduler resource recovery lease changed or is no longer active');
    }
    return { status: 'verified' };
}

/** Called by the build owner only while its reclaim exclusion and exact OS absence observations still hold. */
export function completeSchedulerResourceRecovery(capability, binding)
{
    assertSchedulerResourceRecovery(capability, binding);
    const recovery = schedulerResourceRecoveries.get(capability);
    const { checkpointFile, checkpoint } = readOriginalSchedulerResourceCheckpoint(recovery.binding);
    if (fingerprint(checkpoint) !== recovery.checkpointDigest)
    {
        throw new Error('scheduler resource journal changed during original-owner recovery');
    }
    assertMySqlFixtureRecoveryComplete(checkpoint, recovery.mysqlFixtureReconciliation, recovery.mysqlFixtureLifecycle);
    assertSchedulerResourceRecovery(capability, binding);
    let reconciled = schedulerResourceReconciliationIsComplete(checkpoint);
    if (reconciled)
    {
        // Publication retry consumes the original sealed proof, not a newly hashed cleanup observation.
        assertMySqlFixtureRecoveryComplete(checkpoint, checkpoint.resourceReconciliation.mysqlFixtureReconciliation ?? [],
            recovery.mysqlFixtureLifecycle);
        assertSchedulerResourceRecovery(capability, binding);
    }
    if (!reconciled)
    {
        const completedAt = new Date().toISOString();
        checkpoint.resourceReconciliation = {
            schema: 'fsusblog.scheduler-resource-reconciliation.v1', completedAt,
            reference: recovery.reference, recoveryOwner: structuredClone(recovery.controller.owner),
            priorCheckpointDigest: recovery.checkpointDigest, priorStatus: checkpoint.status,
            priorResourceGrants: structuredClone(checkpoint.resourceUtilization.resourceGrants),
            priorRetainedResourceGrants: structuredClone(checkpoint.resourceUtilization.retainedResourceGrants),
            priorCleanupFailure: checkpoint.resourceCleanupFailure ?? null
        };
        if (Object.keys(checkpoint.mysqlFixtureServices ?? {}).length > 0)
        {
            checkpoint.resourceReconciliation.mysqlFixtureReconciliation = structuredClone(recovery.mysqlFixtureReconciliation);
            for (const record of recovery.mysqlFixtureReconciliation)
            {
                checkpoint.mysqlFixtureServices[record.tierId].status = 'cleaned';
                checkpoint.mysqlFixtureServices[record.tierId].cleanup = structuredClone(record.cleanup);
            }
        }
        checkpoint.resourceUtilization.resourceGrants = {
            ...checkpoint.resourceUtilization.resourceGrants, generatedAt: completedAt,
            grants: {}, residentReservation: { cpuUnits: 0, memoryGiB: 0 }
        };
        checkpoint.resourceUtilization.retainedResourceGrants = {};
        if (checkpoint.status === 'running')
        {
            const failure = { tierId: checkpoint.targetTierId, exitCode: 1, signal: null,
                reason: 'original scheduler controller interrupted; resources reconciled without resuming execution', changedPaths: [] };
            checkpoint.status = 'failure';
            checkpoint.failure ??= failure;
            checkpoint.failurePoint ??= checkpoint.targetTierId;
            checkpoint.failures.push(failure);
            checkpoint.finishedAt = completedAt;
        }
        reconciled = schedulerResourceReconciliationIsComplete(checkpoint);
        // This existing fsynced journal is authoritative even if projection publication is interrupted.
        checkpointPersistence.delete(path.resolve(checkpointFile));
        writeCheckpoint(checkpointFile, checkpoint, { boundary: true, stage: 'resource-reconciled',
            eventType: 'resource-grants-reconciled', step: 'scheduler' });
        recovery.checkpointDigest = fingerprint(checkpoint);
    }
    else
    {
        // A prior journal fsync may have succeeded before compact/compatibility publication failed.
        // Re-materialize those views without creating a second release event or changing the original failure.
        checkpointPersistence.delete(path.resolve(checkpointFile));
        const persistence = schedulerPersistence(checkpointFile, checkpoint);
        publishCheckpointBoundary(checkpointFile, checkpoint, persistence, {
            stage: 'resource-reconciled', lastSequence: persistence.store.readJournal().at(-1).sequence
        });
    }
    if (!reconciled)
    {
        throw new Error('scheduler resource reconciliation did not settle its original journal');
    }
    assertSchedulerResourceRecovery(capability, binding);
    const grantFile = path.join(path.dirname(checkpointFile), 'resource-grants.json');
    const temporary = `${grantFile}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(checkpoint.resourceUtilization.resourceGrants, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, grantFile);
    if (schedulerResourcesUnsettled(checkpointFile, binding.reference.runId, checkpoint))
    {
        throw new Error('scheduler resource reconciliation remains unsettled');
    }
}

/** Reconcile only the original retained build's resources; never adopt them into another execution. */
export async function reconcileSchedulerResourceGrants(reference, { assertAdmission = null } = {})
{
    if (assertAdmission !== null && typeof assertAdmission !== 'function')
    {
        throw new Error('scheduler resource recovery admission guard must be callable');
    }
    assertAdmission?.();
    const build = await import(new URL('./production-build-layout.mjs', import.meta.url));
    const original = build.inspectProductionBuildRecoveryBinding(reference);
    const binding = { ...original, root: reference.repositoryRoot, runId: reference.runId };
    const { checkpointFile, checkpoint } = readOriginalSchedulerResourceCheckpoint(binding);
    const grants = checkpoint.resourceUtilization?.resourceGrants;
    validateSchedulerGrantDocument(grants, reference.runId, checkpoint);
    const reconciled = schedulerResourceReconciliationIsComplete(checkpoint);
    const priorGrants = reconciled ? checkpoint.resourceReconciliation.priorResourceGrants : grants;
    if (checkpoint.status === 'success' || !plainObject(checkpoint.resourceUtilization.retainedResourceGrants)
        || !['not-acquired', 'released'].includes(checkpoint.residentResourceLeases?.status)
        || priorGrants.residentReservation.cpuUnits !== 0 || priorGrants.residentReservation.memoryGiB !== 0
        || Object.keys(priorGrants.grants).some((id) => !original.resourceBundleIds.includes(id))
        || Object.keys(checkpoint.resourceUtilization.retainedResourceGrants).some((id) => !original.resourceBundleIds.includes(id)))
    {
        throw new Error('scheduler resource recovery cannot reconcile success, resident or unbound bundle grants');
    }
    const projection = readSchedulerGrantProjection(path.join(path.dirname(checkpointFile), 'resource-grants.json'), reference.runId);
    if (!projection || (fingerprint(projection) !== fingerprint(grants)
        && (!reconciled || fingerprint(projection) !== fingerprint(priorGrants))))
    {
        throw new Error('scheduler resource recovery projection is not the exact original or settled journal');
    }
    if (reconciled && fingerprint(checkpoint.resourceReconciliation.reference) !== fingerprint(reference))
    {
        throw new Error('scheduler resource recovery reference differs from prior reconciliation');
    }
    const runsRoot = path.dirname(path.dirname(checkpointFile));
    const previous = schedulerRunLockActivity({ runsRoot, runId: reference.runId,
        candidateIdentityDigest: original.schedulerOwner.candidateIdentityDigest, targetTierId: original.schedulerOwner.targetTierId });
    if (previous.status !== 'inactive'
        || (previous.owner && !schedulerRunOwnerIdentityMatches(previous.owner, original.schedulerOwner)))
    {
        throw new Error('scheduler resource recovery original owner is active, changed or unverifiable');
    }
    const controller = acquireSchedulerRunLock({ runsRoot, runId: reference.runId,
        candidateIdentityDigest: original.schedulerOwner.candidateIdentityDigest,
        targetTierId: original.schedulerOwner.targetTierId, budgetPolicyDigest: original.schedulerOwner.budgetPolicyDigest ?? null });
    const capability = Object.freeze({});
    schedulerResourceRecoveries.set(capability, { reference: structuredClone(reference), binding,
        checkpointDigest: fingerprint(checkpoint), runsRoot, controller, lockIdentity: fs.lstatSync(controller.lockPath), assertAdmission });
    let failure;
    let result;
    try
    {
        assertSchedulerResourceRecovery(capability, { reference, schedulerOwner: original.schedulerOwner });
        const recovery = schedulerResourceRecoveries.get(capability);
        if (Object.keys(checkpoint.mysqlFixtureServices ?? {}).length > 0)
        {
            recovery.mysqlFixtureLifecycle = await import(new URL('../test-fixtures/services/mysql.mjs', import.meta.url));
        }
        recovery.mysqlFixtureReconciliation = await reconcileRetainedMySqlFixtureServices({
            allocations: checkpoint.mysqlFixtureServices, binding, lifecycle: recovery.mysqlFixtureLifecycle,
            assertRecovery: () => assertSchedulerResourceRecovery(capability, { reference, schedulerOwner: original.schedulerOwner })
        });
        result = build.recoverProductionBuildResourceTree(reference, { schedulerRecovery: capability });
    }
    catch (error)
    {
        failure = error;
    }
    finally
    {
        schedulerResourceRecoveries.delete(capability);
    }
    try
    {
        if (!controller.finalize('failed'))
        {
            throw new Error('scheduler resource recovery could not release its exact scheduler lease');
        }
    }
    catch (error)
    {
        if (failure)
        {
            failure.resourceRecoveryLeaseError = error.message;
        }
        else
        {
            failure = error;
        }
    }
    if (failure)
    {
        throw failure;
    }
    return result;
}

function assertPriorSchedulerResourcesSettled(checkpointFile, runId)
{
    if (schedulerResourcesUnsettled(checkpointFile, runId))
    {
        throw new Error(`scheduler run ${runId} retains unsettled resource grants; independent owner reconciliation required`);
    }
}

async function runDagUnlocked(options)
{
    const root = path.resolve(options.root);
    const releaseFinalStaticBoundaryErrors = validateRepositoryReleaseFinalStaticBoundary(root);
    if (releaseFinalStaticBoundaryErrors.length > 0)
    {
        throw new Error(
            'production release-final static boundary rejected scheduler dispatch:\n'
            + releaseFinalStaticBoundaryErrors.join('\n')
        );
    }
    const runsRoot = resolveRealOrAncestralPath(options.runsRoot ?? path.join(root, '.tmp/test-runs'));
    const runId = safeRunId(options.runId ?? createRunId(options.targetTierId ?? 'matrix'));
    const runDirectory = path.join(runsRoot, runId);
    const releaseFinalSchedulerNonce = crypto.randomBytes(32).toString('hex');
    const checkpointFile = path.join(runDirectory, 'checkpoint.json');
    assertPriorSchedulerResourcesSettled(checkpointFile, runId);
    const resourceGrantFile = path.join(runDirectory, 'resource-grants.json');
    const residentLeaseFile = path.join(runDirectory, 'resident-resource-leases.json');
    const residentHandoffFile = path.join(runDirectory, 'resident-resource-handoff.json');
    const tierLogDirectory = path.join(runDirectory, 'tiers');
    const snapshotWorktree = options.snapshotWorktree ?? (() => snapshotGitWorktree(root));
    const runSourceSnapshot = options.runSourceSnapshot ?? (await snapshotWorktree());
    // Honor explicit source-identity env overrides so prepareProductionBuildLayout
    // (which seeds layout.json from the same env) and onSourceState bind once with
    // the same commit/fingerprint. Without this, fixture/CI overrides in
    // FSUSBLOG_TEST_SOURCE_* would pre-bind the layout, then git-derived values
    // here would fail closed as an immutable identity mismatch (#1069 / #1079).
    const envCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const envFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    const sourceState = options.sourceState ?? {
        commit: envCommit || gitHead(root) || 'unversioned',
        worktreeFingerprint: envFingerprint || runSourceSnapshot.fingerprint
    };
    await options.onSourceState?.(sourceState);
    const resources = options.systemResources ?? defaultSystemResources();
    const budget = resourceBudget(resources);
    const injectedMemoryTelemetry = typeof options.currentFreeMemoryGiB === 'function';
    const currentFreeMemoryGiB = () =>
    {
        const measured = Number(options.currentFreeMemoryGiB?.() ?? availableMemoryGiB());
        return Number.isFinite(measured) && measured >= 0 ? measured : budget.memoryGiB;
    };
    // The existing internal admission seam also supplies controlled test telemetry.
    // Default runs still sample the host; injected observations cannot confer authority.
    const telemetryAvailableMemoryBytes = () => injectedMemoryTelemetry
        ? currentFreeMemoryGiB() * (1024 ** 3)
        : availableMemoryBytes();
    const maxParallel = Math.max(1, Math.floor(Number(options.maxParallel) || resources.cpuCount || 1));
    const terminationGraceMs = Math.max(0, Number(options.terminationGraceMs) || 5000);
    const wallClockBudgetMs = Number.isFinite(Number(options.wallClockBudgetMs)) && Number(options.wallClockBudgetMs) > 0
        ? Number(options.wallClockBudgetMs)
        : null;
    const mode = options.mode ?? (options.resume === true ? 'resume' : 'fresh');
    const collectFailures = options.collectFailures === true;
    if (!['fresh', 'resume'].includes(mode))
    {
        throw new Error(`invalid scheduler mode: ${mode}`);
    }
    if (options.resume === true && mode !== 'resume')
    {
        throw new Error('resume=true requires mode=resume');
    }
    const resume = mode === 'resume';
    const currentRunPreexecutedTierBindings = new Map();
    for (const binding of options.currentRunPreexecutedTierBindings ?? [])
    {
        const tierId = String(binding?.tierId ?? '').trim();
        if (!tierId || currentRunPreexecutedTierBindings.has(tierId))
        {
            throw new Error(`current-run preexecuted tier binding is duplicated or unnamed: ${tierId}`);
        }
        if (resume
      && (binding?.schema !== currentRunBehaviorDocAdmissionBindingSchema
        || tierId !== currentRunBehaviorDocAdmissionTierId))
        {
            throw new Error(
                `resume current-run preexecution only accepts schema `
              + `${currentRunBehaviorDocAdmissionBindingSchema} for tier `
              + `${currentRunBehaviorDocAdmissionTierId}; received schema `
              + `${String(binding?.schema ?? '<missing>')} for tier ${tierId}`
            );
        }
        currentRunPreexecutedTierBindings.set(tierId, binding);
    }
    if (resume && options.freshRunDirectoryPreservation !== undefined)
    {
        throw new Error('fresh run directory preservation cannot be used by resume');
    }
    const budgetPolicyDigest = options.budgetPolicyDigest ?? null;
    if (budgetPolicyDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(budgetPolicyDigest))
    {
        throw new Error('scheduler budget policy digest is invalid');
    }
    const supersedesUniverse = options.supersedesUniverse ?? options.tiers ?? [];
    const supersedesErrors = validateSupersedesRules(supersedesUniverse, options.coverageRegistry);
    if (supersedesErrors.length > 0)
    {
        throw new Error(`invalid supersedes metadata: ${supersedesErrors.join('; ')}`);
    }
    const tiers = applySupersedes(options.tiers ?? []);
    const schedulerReplayPlan = options.executionReplayPlan ?? null;
    if (schedulerReplayPlan)
    {
        validateSchedulerReplayPlan(schedulerReplayPlan, { tiers, maxParallel });
        if (schedulerReplayPlan.schedulerRunId !== runId)
        {
            throw new Error('scheduler replay plan run identity drift');
        }
        if (schedulerReplayPlan.sourceCommit !== sourceState.commit
        || schedulerReplayPlan.worktreeFingerprint !== sourceState.worktreeFingerprint)
        {
            throw new Error('scheduler replay plan source identity drift');
        }
    }
    for (const tierId of currentRunPreexecutedTierBindings.keys())
    {
        if (typeof tierId !== 'string' || !tiers.some((tier) => tier.id === tierId))
        {
            throw new Error(`current-run preexecuted tier is unknown: ${String(tierId)}`);
        }
    }
    for (const tier of tiers)
    {
        if (tier.resourceGrantMode === 'dynamic')
        {
            const declaredStartupMemoryWeight = startupMemoryWeight(tier);
            if (!Number.isFinite(Number(tier.cpuWeight)) || Number(tier.cpuWeight) <= 0
        || !Number.isFinite(Number(tier.memoryWeight)) || Number(tier.memoryWeight) <= 0
        || !Number.isInteger(Number(tier.minCpuUnits)) || Number(tier.minCpuUnits) < 1
        || !Number.isInteger(Number(tier.startupMinCpuUnits ?? tier.minCpuUnits))
        || Number(tier.startupMinCpuUnits ?? tier.minCpuUnits) < 1
        || startupMinCpuUnits(tier) > Number(tier.minCpuUnits)
        || !Number.isFinite(declaredStartupMemoryWeight)
        || declaredStartupMemoryWeight <= 0
        || !Number.isFinite(Number(tier.startupPriority ?? 0))
        || Number(tier.startupPriority ?? 0) < 0)
            {
                throw new Error(`tier ${tier.id} has unresolved dynamic resource policy`);
            }
            continue;
        }
        tierResourceUnits(tier);
    }
    const byId = new Map(tiers.map((tier) => [tier.id, tier]));
    const residentLeaseProducers = tiers.filter((tier) => tier.residentLeaseProducer === true);
    const residentLeaseConsumers = tiers.filter((tier) => tier.residentLeaseConsumer === true);
    if (residentLeaseProducers.length !== residentLeaseConsumers.length
    || residentLeaseProducers.length > 1)
    {
        throw new Error('resident lease topology requires exactly one producer/consumer pair or neither');
    }
    const residentConsumerBundleId = residentLeaseConsumers.length === 1
        ? (residentLeaseConsumers[0].physicalBundleId ?? residentLeaseConsumers[0].id)
        : null;
    if (residentLeaseProducers.length === 1
    && residentLeaseProducers[0].residentLeaseTarget !== residentConsumerBundleId)
    {
        throw new Error('resident lease producer target must match its consumer');
    }
    const requestedSystemdBoundary = options.resourceEnforcementOptions?.systemdBoundary;
    const systemdContext = requestedSystemdBoundary ? { root: fs.realpathSync(root), runId, namespace: options.namespace,
        sourceState, schedulerOwnerToken: options.schedulerRunOwnerToken } : null;
    if (requestedSystemdBoundary && (typeof options.retainManagedContainment !== 'function'
        || typeof options.markManagedContainmentCreationAttempt !== 'function'
        || typeof options.registerManagedProcess !== 'function'
        || (requestedSystemdBoundary.context && fingerprint(requestedSystemdBoundary.context) !== fingerprint(systemdContext))))
    {
        throw new Error('scheduler systemd boundary requires exact scheduler context and independent process-owner callbacks');
    }
    const resourceEnforcer = await createProductionResourceEnforcer({
        ...(options.resourceEnforcementOptions ?? {}),
        ...(requestedSystemdBoundary ? { systemdBoundary: { ...requestedSystemdBoundary, context: systemdContext } } : {}),
        runId,
        bundleIds: tiers.map((tier) => tier.physicalBundleId ?? tier.id),
        machine: { cpuUnits: budget.cpuUnits, memoryGiB: budget.memoryGiB },
        mode: options.resourceEnforcementMode ?? (tiers.some((tier) => tier.id === 'release-reliability-fresh') ? 'auto' : 'advisory')
    });
    let resourceEnforcerFinalized = false;
    const finalizeResourceEnforcer = () =>
    {
        if (resourceEnforcerFinalized)
        {
            return;
        }
        resourceEnforcerFinalized = true;
        try
        {
            resourceEnforcer.sample();
            const cleanup = resourceEnforcer.cleanup();
            if (!['removed', 'not-applicable'].includes(cleanup?.status))
            {
                throw new Error(`resource enforcement cleanup incomplete: ${cleanup?.status ?? 'missing-result'}`);
            }
        }
        catch (error)
        {
            error.resourceEnforcement = resourceEnforcer.evidence();
            throw error;
        }
    };
    options.registerSchedulerFinalizer?.(finalizeResourceEnforcer);
    const conservativeRepositoryFingerprint = tiers.some((tier) => effectiveCacheInputs(tier).length === 0)
        ? repositoryInputFingerprint(root)
        : null;

    if (!resume)
    {
        checkpointPersistence.delete(path.resolve(checkpointFile));
        resetFreshRunDirectory(runDirectory, options.freshRunDirectoryPreservation);
    }
    fs.mkdirSync(tierLogDirectory, { recursive: true });
    const previous = resume ? readCheckpoint(checkpointFile) : null;
    const correctnessTier = tiers.find((tier) => tier.id === 'production-correctness');
    let correctnessAttempt = null;
    if (correctnessTier)
    {
        const targetAttemptId = `correctness-attempt-${crypto.randomUUID()}`;
        const attemptRoot = path.join(runDirectory, 'correctness-attempts', targetAttemptId);
        fs.mkdirSync(path.dirname(attemptRoot), { recursive: true });
        fs.mkdirSync(attemptRoot, { recursive: false });
        correctnessAttempt = { targetAttemptId, root: attemptRoot,
            provisionalPacketFile: path.join(attemptRoot, 'provisional-packet.json'),
            previousAttemptId: previous?.correctnessAttempt?.targetAttemptId ?? null,
            createdFromCheckpointRevision: null, status: 'pending' };
    }
    const resumeSourceChanged = Boolean(previous)
    && (previous.sourceState?.commit !== sourceState.commit
      || previous.sourceState?.worktreeFingerprint !== sourceState.worktreeFingerprint);
    const resumeBudgetPolicyChanged = Boolean(previous) &&
    previous.budgetPolicyDigest !== budgetPolicyDigest;
    const requestedWallClockStartedAtMs = options.wallClockStartedAtMs === undefined
        ? Date.now()
        : Number(options.wallClockStartedAtMs);
    if (!Number.isFinite(requestedWallClockStartedAtMs) || requestedWallClockStartedAtMs <= 0)
    {
        throw new Error('wallClockStartedAtMs must be a positive finite epoch timestamp');
    }
    const effectiveWallClockStartedAtMs = previous?.startedAt
        ? Date.parse(previous.startedAt)
        : requestedWallClockStartedAtMs;
    if (!Number.isFinite(effectiveWallClockStartedAtMs) || effectiveWallClockStartedAtMs > Date.now())
    {
        throw new Error('wall clock start must be a valid timestamp that is not in the future');
    }
    const evidenceContextPath = String(options.env?.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT
      ?? process.env.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT ?? '').trim();
    const currentRunEvidenceContext = evidenceContextPath
        ? validateCurrentRunEvidenceContext(
            JSON.parse(fs.readFileSync(path.resolve(root, evidenceContextPath), 'utf8'))
        )
        : null;
    const currentRunSourceFingerprint = String(sourceState.worktreeFingerprint).startsWith('sha256:')
        ? sourceState.worktreeFingerprint
        : `sha256:${sourceState.worktreeFingerprint}`;
    if (currentRunEvidenceContext
    && (currentRunEvidenceContext.schedulerRunId !== runId
      || currentRunEvidenceContext.sourceCommit !== sourceState.commit
      || currentRunEvidenceContext.worktreeFingerprint !== currentRunSourceFingerprint))
    {
        throw new Error('scheduler current-run evidence context does not match run/source identity');
    }
    const currentRunEvidenceRegistry = currentRunEvidenceContext
        ? validateEvidenceLocatorRegistry(JSON.parse(fs.readFileSync(path.join(root,
            'config/testing/evidence-locator-registry.json'), 'utf8')))
        : null;
    const checkpoint = {
        schema: checkpointSchema,
        runId,
        targetTierId: options.targetTierId ?? tiers.at(-1)?.id ?? null,
        namespace: options.namespace,
        schedulerCandidateIdentityDigest: options.schedulerCandidateIdentityDigest,
        releaseCandidateIdentity: options.verifiedCandidateIdentity ?? null,
        candidateIdentityValidated: options.verifiedCandidateIdentity !== null && options.verifiedCandidateIdentity !== undefined,
        resumeInvocation: options.resumeInvocation ?? null,
        correctnessAttempt,
        schedulerRunOwnerToken: options.schedulerRunOwnerToken,
        mode,
        authoritative: mode === 'fresh' && !injectedMemoryTelemetry,
        status: 'running',
        startedAt: new Date(effectiveWallClockStartedAtMs).toISOString(),
        updatedAt: new Date().toISOString(),
        resourceBudget: budget,
        budgetMs: wallClockBudgetMs,
        budgetPolicyDigest,
        timedOut: false,
        resourcePeaks: {
            load1: Math.max(0, Number(os.loadavg()[0]) || 0),
            usedMemoryGiB: Math.max(0, (os.totalmem() - telemetryAvailableMemoryBytes()) / (1024 ** 3)),
            reservedCpuUnits: 0,
            reservedMemoryGiB: 0
        },
        resourceUtilization: {
            status: 'collecting',
            samples: [],
            curveCompactions: 0,
            waits: null,
            retainedResourceGrants: {}
        },
        resourceEnforcement: resourceEnforcer.evidence(),
        residentResourceLeases: {
            status: 'not-acquired',
            inventoryFile: path.relative(root, residentLeaseFile).replaceAll(path.sep, '/'),
            handoffFile: path.relative(root, residentHandoffFile).replaceAll(path.sep, '/'),
            ownerBundleId: null,
            generation: null,
            digest: null,
            resourceGrant: null,
            reservation: { cpuUnits: 0, memoryGiB: 0 },
            services: {},
            events: [],
            handoff: null,
            releasedAt: null
        },
        maxParallel,
        sourceState,
        executionReplay: schedulerReplayPlan ? {
      planDigest: schedulerReplayPlan.planDigest,
      schedulerReadyOrderPolicy: schedulerReplayPlan.schedulerReadyOrderPolicy,
      schedulerShuffleSeed: schedulerReplayPlan.schedulerShuffleSeed,
      dependencyCatalogDigest: schedulerReplayPlan.dependencyCatalogDigest,
      eligibleStepIds: schedulerReplayPlan.eligibleStepIds,
      expectedAdmissionSequence: schedulerReplayPlan.expectedAdmissionSequence,
      actual: null
    } : null,
        ...(options.runtimeNamespace ? { runtimeNamespace: options.runtimeNamespace } : {}),
        resumePolicy: resume ? {
      sourceChanged: resumeSourceChanged,
      budgetPolicyChanged: resumeBudgetPolicyChanged,
      reuseAcrossSourceChanges: false
    } : null,
        // A resume attempt may fail before it reaches otherwise reusable tiers.
        // Keep those prior successes separate from this attempt's completed tiers;
        // each candidate must still pass every normal reuse check before promotion.
        resumeCandidates: resume ? resumeTierCandidates(previous, byId) : {},
        completedTiers: [],
        tiers: {},
        ...(currentRunEvidenceContext ? {
            currentRunEvidenceReferences: resumeCurrentRunEvidenceCheckpoint(resume ? previous : null,
                currentRunEvidenceContext)
        } : {}),
        failure: null,
        failurePoint: null,
        failures: [],
        schedulerAdmissions: {}
    };
    const dynamicPriorityEnabled = !schedulerReplayPlan && options.dynamicPriority !== false
    && String(options.env?.FSUSBLOG_TEST_DYNAMIC_PRIORITY
      ?? process.env.FSUSBLOG_TEST_DYNAMIC_PRIORITY
      ?? '1') !== '0';
    checkpoint.priorityScheduling = {
        schema: prioritySchemas.score,
        modelVersion: 1,
        enabled: dynamicPriorityEnabled,
        inputSchema: options.priorityInput?.schema ?? null,
        waves: []
    };
    if (resumeSourceChanged)
    {
        checkpointPersistence.delete(path.resolve(checkpointFile));
        fs.rmSync(path.join(runDirectory, 'evidence-store'), { recursive: true, force: true });
    }
    writeCheckpoint(checkpointFile, checkpoint, {
        boundary: true,
        stage: 'run-start',
        eventType: 'run-started',
        tier: checkpoint.targetTierId,
        step: 'scheduler'
    });

    const pending = [...tiers];
    const completed = new Set();
    const failed = new Set();
    const resultFingerprints = new Map();
    const active = new Map();
    const startingExecutions = new Set();
    // A settled promise is not proof that its independent owner reclaimed the work.
    const retainedResourceGrants = new Map();
    let schedulerAdmissionSequence = Math.max(
        0,
        ...Object.values(checkpoint.schedulerAdmissions ?? {})
            .map((entry) => Number(entry.admissionSequence) || 0)
    );
    const schedulerWaitLedger = createWaitLedger();
    let resolveInterrupt = null;
    let interrupted = null;
    const interruptHandlers = new Map();
    let interruptPromise;
    interruptPromise = new Promise((resolve) =>
    {
        resolveInterrupt = resolve;
    });
    for (const [signal, exitCode] of [
        ['SIGINT', 130],
        ['SIGTERM', 143]
    ])
    {
        const handler = () =>
        {
            if (interrupted)
            {
                return;
            }
            interrupted = { signal, exitCode };
            for (const execution of startingExecutions)
            {
                execution.terminate(Object.assign(new Error(`scheduler interrupted by ${signal}`), {
                    name: 'AbortError', signal, exitCode
                }));
            }
            for (const entry of active.values())
            {
                entry.cancelRequested = true;
                entry.terminate();
            }
            resolveInterrupt({ interrupted: true, signal, exitCode });
        };
        interruptHandlers.set(signal, handler);
        process.on(signal, handler);
    }
    const removeInterruptHandlers = () =>
    {
        for (const [signal, handler] of interruptHandlers)
        {
            process.off(signal, handler);
        }
        interruptHandlers.clear();
    };
    options.registerSchedulerFinalizer?.(removeInterruptHandlers);
    const reusedTiers = [];
    const readyAges = new Map();
    let priorityWaveNumber = 0;
    let schedulerReplayAdmissionIndex = 0;
    let firstFailure = null;
    let producerAdmissionClosed = false;
    let settlementAdmissionClosed = false;
    let residentState = null;
    const transferredServiceAuthorities = new Map();
    let lastResidentSampleAtMs = 0;
    const residentSampleIntervalMs = Math.max(
        500,
        Math.round(5_000 / Math.sqrt(Math.max(1, budget.cpuUnits)))
    );
    const residentEvidence = checkpoint.residentResourceLeases;
    const recordResidentEvent = (type, details = {}) =>
    {
        residentEvidence.events.push({ type, at: new Date().toISOString(), ...details });
        if (residentEvidence.events.length > 1024)
        {
            residentEvidence.events = residentEvidence.events.filter((_, index) => index % 2 === 0);
        }
    };
    const residentUsage = () => residentState?.reconciliation?.reservation ?? { cpuUnits: 0, memoryGiB: 0 };
    const accountedUsage = (entries) =>
    {
        const active = activeUsage([...entries, ...retainedResourceGrants.values()]);
        const resident = residentUsage();
        return {
            cpuUnits: active.cpuUnits + resident.cpuUnits,
            memoryGiB: active.memoryGiB + resident.memoryGiB
        };
    };
    const appendResidentObservation = (reconciliation) =>
    {
        for (const service of reconciliation.services)
        {
            const evidence = residentEvidence.services[service.id] ??= {
                generation: service.generation,
                reservation: residentState.inventory.services.find((item) => item.id === service.id)?.reservation ?? null,
                history: [],
                restartCount: 0,
                releasedAt: null
            };
            if (evidence.generation !== service.generation)
            {
                evidence.generation = service.generation;
                evidence.reservation = residentState.inventory.services
                    .find((item) => item.id === service.id)?.reservation ?? null;
                evidence.restartCount += 1;
            }
            evidence.history.push(service);
            if (evidence.history.length > 4096)
            {
                evidence.history = evidence.history.filter((_, index) => index % 2 === 0);
            }
            if (service.status === 'exited' && evidence.releasedAt === null)
            {
                evidence.releasedAt = service.observedAt;
            }
        }
    };
    const reconcileResidentEnforcement = (inventory, state) =>
    {
        if (!inventory.enforcement)
        {
            throw new Error('resident lease inventory has no cgroup/OCI enforcement binding');
        }
        const expectedProcessScope = resourceEnforcer.environment(state.enforcementBundleId);
        if (inventory.enforcement.mode !== resourceEnforcer.mode
      || (resourceEnforcer.mode === 'enforced'
        && inventory.enforcement.processScope?.path !== expectedProcessScope.FSUSBLOG_CGROUP_BUNDLE_PATH))
        {
            throw new Error('resident lease enforcement scope does not match scheduler cgroup evidence');
        }
        if (resourceEnforcer.mode === 'enforced')
        {
            if (requestedSystemdBoundary)
            {
                verifyResidentProcessServiceScope(inventory, expectedProcessScope.FSUSBLOG_CGROUP_BUNDLE_PATH,
                    state.serviceAuthority, { ...systemdContext, bundleId: state.enforcementBundleId });
            }
            else
            {
                verifyResidentProcessResourceScope(inventory, expectedProcessScope.FSUSBLOG_CGROUP_BUNDLE_PATH);
            }
        }
        const processReservation = inventory.services
            .filter((service) => service.kind === 'process')
            .reduce((total, service) => ({
                cpuUnits: total.cpuUnits + service.reservation.cpuUnits,
                memoryGiB: total.memoryGiB + service.reservation.memoryGiB
            }), { cpuUnits: 0, memoryGiB: 0 });
        if (processReservation.cpuUnits > 0 && processReservation.memoryGiB > 0)
        {
            resourceEnforcer.update(state.enforcementBundleId, processReservation);
        }
        residentEvidence.enforcement = inventory.enforcement;
    };
    const reconcileResidentState = ({ force = false } = {}) =>
    {
        if (!residentState)
        {
            return null;
        }
        const now = Date.now();
        if (!force && now - lastResidentSampleAtMs < residentSampleIntervalMs)
        {
            return residentState.reconciliation;
        }
        lastResidentSampleAtMs = now;
        let previousInventory = null;
        if (fs.existsSync(residentLeaseFile))
        {
            const current = readResidentLeaseDocument(residentLeaseFile);
            validateResidentLeaseInventory(current, {
                runId,
                namespace: residentState.inventory.namespace,
                ownerBundleId: residentState.inventory.ownerBundleId,
                resourceGrantHistory: residentState.resourceGrantHistory,
                resourceBudget: budget,
                requiredServiceIds: residentState.requiredServiceIds,
                sourceState: sourceState.commit ? sourceState : undefined
            });
            if (current.digest !== residentState.inventory.digest)
            {
                const previousGeneration = residentState.inventory.generation;
                previousInventory = residentState.inventory;
                reconcileResidentEnforcement(current, residentState);
                residentState.inventory = current;
                recordResidentEvent('generation-replaced', {
                    previousGeneration,
                    generation: current.generation,
                    ownerBundleId: current.ownerBundleId,
                    reservation: current.reservation,
                    enforcementMode: current.enforcement.mode
                });
            }
        }
        const reconciliation = reconcileResidentLeaseInventory(residentState.inventory, {
            observeService: resourceEnforcer.mode === 'enforced'
                ? (service) => service.kind === 'process'
                    ? observeResidentService(service)
                    : (options.observeResidentService?.(service) ?? observeResidentService(service))
                : options.observeResidentService
        });
        if (resourceEnforcer.mode === 'enforced')
        {
            const expectedPath = resourceEnforcer.environment(residentState.enforcementBundleId).FSUSBLOG_CGROUP_BUNDLE_PATH;
            const scope = requestedSystemdBoundary
                ? verifyResidentProcessServiceScope(residentState.inventory, expectedPath,
                    residentState.serviceAuthority, { ...systemdContext, bundleId: residentState.enforcementBundleId })
                : verifyResidentProcessResourceScope(residentState.inventory, expectedPath);
            for (const process of scope.processes)
            {
                const service = reconciliation.services.find((entry) => entry.id === process.id);
                if (process.status === 'live' && service.status === 'exited')
                {
                    throw new Error(`resident process ${process.id} cannot release a live enforced scope`);
                }
                if (process.status === 'exited' && service.status === 'live')
                {
                    service.status = 'unknown';
                    service.reason = 'process-exited-during-scope-readback';
                    reconciliation.healthy = false;
                }
                if (process.status === 'live')
                {
                    service.cgroup = process.cgroup;
                }
            }
        }
        residentState.reconciliation = reconciliation;
        residentEvidence.generation = residentState.inventory.generation;
        residentEvidence.digest = residentState.inventory.digest;
        residentEvidence.reservation = reconciliation.reservation;
        appendResidentObservation(reconciliation);
        if (fs.existsSync(residentHandoffFile))
        {
            const handoff = readResidentLeaseDocument(residentHandoffFile);
            if (handoff.consumedBy === residentConsumerBundleId && residentEvidence.handoff?.status !== 'consumed')
            {
                const validateConsumed = (inventory) => validateResidentLeaseHandoff(handoff, {
                    inventory,
                    consumerBundleId: residentConsumerBundleId,
                    sourceState: sourceState.commit ? sourceState : undefined,
                    requireConsumed: true
                });
                try
                {
                    validateConsumed(residentState.inventory);
                }
                catch (error)
                {
                    if (!previousInventory)
                    {
                        throw error;
                    }
                    validateConsumed(previousInventory);
                }
                residentEvidence.status = 'handed-off';
                residentEvidence.ownerBundleId = handoff.consumedBy;
                residentEvidence.handoff = {
                    ...residentEvidence.handoff,
                    status: 'consumed',
                    consumedAt: handoff.consumedAt,
                    consumedBy: handoff.consumedBy,
                    digest: handoff.digest
                };
                recordResidentEvent('handoff-consumed', {
                    digest: handoff.digest,
                    consumerBundleId: handoff.consumedBy
                });
            }
        }
        if (reconciliation.fullyReleased)
        {
            residentEvidence.status = 'released';
            residentEvidence.releasedAt ??= new Date().toISOString();
            recordResidentEvent('released', { ownerBundleId: residentEvidence.ownerBundleId });
        }
        else if (!reconciliation.healthy)
        {
            residentEvidence.status = 'identity-review-required';
        }
        return reconciliation;
    };
    const acquireResidentState = (tier, tierEnvironment, {
        publishHandoff = true,
        resourceGrantHistory = [tierResourceUnits(tier)],
        serviceAuthority = null
    } = {}) =>
    {
        if (!fs.existsSync(residentLeaseFile))
        {
            throw new Error(`resident lease producer did not publish ${path.relative(root, residentLeaseFile)}`);
        }
        const inventory = readResidentLeaseDocument(residentLeaseFile);
        validateResidentLeaseInventory(inventory, {
            runId,
            namespace: tierEnvironment.FSUSBLOG_TEST_NAMESPACE,
            ownerBundleId: tier.physicalBundleId ?? tier.id,
            resourceGrantHistory,
            resourceBudget: budget,
            ...(tier.residentLeaseServiceIds ? { requiredServiceIds: tier.residentLeaseServiceIds } : {}),
            sourceState: sourceState.commit ? sourceState : undefined
        });
        if (serviceAuthority?.phase === 'resident-transferred'
            && `sha256:${inventory.digest}` !== serviceAuthority.residentTransfer.inventoryDigest)
        {
            throw new Error('resident lease inventory changed after exact service transfer');
        }
        residentState = {
            inventory,
            reconciliation: null,
            enforcementBundleId: tier.physicalBundleId ?? tier.id,
            resourceGrantHistory,
            requiredServiceIds: tier.residentLeaseServiceIds,
            serviceAuthority
        };
        residentEvidence.status = 'acquired';
        residentEvidence.ownerBundleId = inventory.ownerBundleId;
        residentEvidence.resourceGrant = inventory.schedulerResourceGrant ?? inventory.resourceGrant;
        residentEvidence.acquiredAt = new Date().toISOString();
        residentEvidence.enforcement = inventory.enforcement ?? null;
        recordResidentEvent('acquired', {
            ownerBundleId: inventory.ownerBundleId,
            generation: inventory.generation,
            digest: inventory.digest
        });
        const reconciliation = reconcileResidentState({ force: true });
        if (!reconciliation.healthy && publishHandoff)
        {
            throw new Error('resident lease producer published non-live or changed service identities');
        }
        reconcileResidentEnforcement(inventory, residentState);
        if (!publishHandoff)
        {
            residentEvidence.status = 'partial';
            recordResidentEvent('partial-evidence-retained', {
                reservation: reconciliation.reservation,
                healthy: reconciliation.healthy
            });
            return;
        }
        const receipt = createResidentLeaseHandoff({
            inventory,
            toOwnerBundleId: residentConsumerBundleId,
            readiness: {
                status: 'ready',
                checkedAt: new Date().toISOString(),
                services: reconciliation.services.map((service) => ({
                    id: service.id,
                    generation: service.generation,
                    status: service.status
                }))
            }
        });
        writeResidentLeaseDocument(residentHandoffFile, receipt);
        residentEvidence.handoff = {
            status: 'published',
            digest: receipt.digest,
            fromOwnerBundleId: receipt.fromOwnerBundleId,
            toOwnerBundleId: receipt.toOwnerBundleId,
            generatedAt: receipt.generatedAt,
            consumedAt: null
        };
        recordResidentEvent('handoff-published', { digest: receipt.digest });
    };
    const sampleResourcePeaks = () =>
    {
        reconcileResidentState();
        const usage = accountedUsage([...active.values()]);
        checkpoint.resourcePeaks.load1 = Math.max(checkpoint.resourcePeaks.load1, Math.max(0, Number(os.loadavg()[0]) || 0));
        checkpoint.resourcePeaks.usedMemoryGiB = Math.max(
            checkpoint.resourcePeaks.usedMemoryGiB,
            Math.max(0, (os.totalmem() - telemetryAvailableMemoryBytes()) / (1024 ** 3))
        );
        checkpoint.resourcePeaks.reservedCpuUnits = Math.max(checkpoint.resourcePeaks.reservedCpuUnits, usage.cpuUnits);
        checkpoint.resourcePeaks.reservedMemoryGiB = Math.max(checkpoint.resourcePeaks.reservedMemoryGiB, usage.memoryGiB);
        checkpoint.resourceUtilization.samples.push({
            atMs: Date.now(),
            load1: Math.max(0, Number(os.loadavg()[0]) || 0),
            runnableQueue: pending.filter((tier) => dependenciesReady(tier)).length,
            pendingCount: pending.length,
            activeCount: active.size,
            reservedCpuUnits: usage.cpuUnits,
            reservedMemoryGiB: usage.memoryGiB,
            hostUsedMemoryGiB: Math.max(0, (os.totalmem() - telemetryAvailableMemoryBytes()) / (1024 ** 3))
        });
        resourceEnforcer.sample();
        const maximumCurveSamples = Math.max(1024, Math.min(16384, Math.ceil(budget.cpuUnits * 512)));
        if (checkpoint.resourceUtilization.samples.length > maximumCurveSamples)
        {
            checkpoint.resourceUtilization.samples = checkpoint.resourceUtilization.samples
                .filter((_, index) => index % 2 === 0);
            checkpoint.resourceUtilization.curveCompactions += 1;
        }
    };
    const resourceTimer = setInterval(sampleResourcePeaks, 500);
    resourceTimer.unref?.();
    let budgetTimer = null;
    const remainingWallClockBudgetMs = wallClockBudgetMs === null
        ? null
        : Math.max(0, wallClockBudgetMs - (Date.now() - effectiveWallClockStartedAtMs));
    let budgetPromise = wallClockBudgetMs === null
        ? null
        : new Promise((resolve) =>
{
        budgetTimer = setTimeout(() =>
        {
            for (const execution of startingExecutions)
            {
                execution.terminate(Object.assign(new Error(`wall-clock budget exceeded (${wallClockBudgetMs}ms)`), {
                    name: 'TimeoutError', timeoutPhase: 'global'
                }));
            }
            resolve({ budgetExpired: true });
        }, remainingWallClockBudgetMs);
        budgetTimer.unref?.();
      });
    let deadlineExpired = remainingWallClockBudgetMs === 0;
    if (deadlineExpired)
    {
        budgetPromise = null;
        const timedOutTierId = pending[0]?.id ?? checkpoint.targetTierId;
        firstFailure = {
            tierId: timedOutTierId,
            exitCode: 124,
            signal: null,
            timeoutPhase: 'global',
            reason: `wall-clock budget exceeded (${wallClockBudgetMs}ms)`,
            changedPaths: []
        };
        checkpoint.timedOut = true;
        checkpoint.failure = firstFailure;
        checkpoint.failurePoint = timedOutTierId;
        checkpoint.failures.push(firstFailure);
        writeCheckpoint(checkpointFile, checkpoint, {
            eventType: 'run-timed-out',
            tier: timedOutTierId,
            step: 'scheduler'
        });
    }

    const dependenciesReady = (tier) => tierSchedulerDependencies(tier)
        .every((dependencyId) => completed.has(dependencyId) || !byId.has(dependencyId));
    const failedDependencies = (tier) => tierSchedulerDependencies(tier)
        .filter((dependencyId) => failed.has(dependencyId));
    const dependencyFingerprint = (tier) => fingerprint(tierSchedulerDependencies(tier).map((dependencyId) => ({
        id: dependencyId,
        fingerprint: resultFingerprints.get(dependencyId) ?? 'external'
    })));

    const writeActiveResourceGrants = () =>
    {
        const grants = Object.fromEntries([...active.values(), ...retainedResourceGrants.values()]
            .map(({ tier }) => [tier.id, {
                cpuUnits: tierResourceUnits(tier).cpuUnits,
                memoryGiB: tierResourceUnits(tier).memoryGiB
            }])
            .sort(([left], [right]) => left.localeCompare(right)));
        const state = {
            schema: 'fsusblog.test-matrix.resource-grants.v1',
            runId,
            sourceState,
            schedulerOwnerToken: options.schedulerRunOwnerToken,
            resourceBudget: budget,
            residentReservation: residentUsage(),
            grants
        };
        for (const { tier } of active.values())
        {
            resourceEnforcer.update(tier.physicalBundleId ?? tier.id, tierResourceUnits(tier));
        }
        // Consumers may observe only grants whose kernel controls have been read back.
        const previous = checkpoint.resourceUtilization.resourceGrants;
        const previousState = { ...(previous ?? {}) };
        delete previousState.generatedAt;
        delete previousState.generation;
        delete previousState.schedulerCheckpointRevision;
        const document = previous && fingerprint(previousState) === fingerprint(state)
            ? previous : { ...state, generation: (previous?.generation ?? 0) + 1,
                schedulerCheckpointRevision: checkpoint.revision + 1, generatedAt: new Date().toISOString() };
        if (document !== previous)
        {
            checkpoint.resourceUtilization.resourceGrants = document;
            // The existing fsynced journal precedes the mutable worker projection and payload release.
            writeCheckpoint(checkpointFile, checkpoint, { eventType: 'resource-grants-updated', step: 'scheduler' });
        }
        const temporary = `${resourceGrantFile}.next-${process.pid}`;
        fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, resourceGrantFile);
    };

    const rebalanceActiveDynamicGrants = ({ expand = true } = {}) =>
    {
        const elastic = [...active.values()].filter((entry) => entry.tier.resourceGrantDynamic === true);
        if (elastic.length === 0)
        {
            writeActiveResourceGrants();
            return;
        }
        let usage = accountedUsage([...active.values()]);
        let excessCpuUnits = Math.max(0, Math.ceil(usage.cpuUnits - budget.cpuUnits));
        for (const entry of [...elastic].sort((left, right) => right.tier.cpuUnits - left.tier.cpuUnits
      || left.tier.id.localeCompare(right.tier.id)))
        {
            const floor = Math.max(1, startupMinCpuUnits(entry.tier));
            const reduction = Math.min(excessCpuUnits, Math.max(0, Math.floor(entry.tier.cpuUnits - floor)));
            entry.tier.cpuUnits -= reduction;
            excessCpuUnits -= reduction;
            if (excessCpuUnits <= 0)
            {
                break;
            }
        }
        if (excessCpuUnits > 0)
        {
            throw new Error('resident reservation exceeds elastic CPU reclaim capacity');
        }

        // Startup minima let coordination-heavy bundles enter the first wave, but
        // a long-lived bundle may later need its steady floor before it can launch
        // expensive worker hosts. Rebalance units held above a sibling's steady
        // minimum even when the machine has no completely free CPU units.
        let steadyDeficitCpuUnits = elastic.reduce(
            (total, entry) => total + Math.max(0, steadyMinCpuUnits(entry.tier) - entry.tier.cpuUnits),
            0
        );
        while (steadyDeficitCpuUnits > 0)
        {
            const receiver = [...elastic]
                .filter((entry) => entry.tier.cpuUnits < steadyMinCpuUnits(entry.tier))
                .sort((left, right) => (
                    steadyMinCpuUnits(right.tier) - right.tier.cpuUnits
            - (steadyMinCpuUnits(left.tier) - left.tier.cpuUnits)
          || startupAdmissionOrder(left.tier, right.tier)
                ))[0];
            const donor = [...elastic]
                .filter((entry) => entry.tier.cpuUnits > steadyMinCpuUnits(entry.tier))
                .sort((left, right) => (
                    right.tier.cpuUnits - steadyMinCpuUnits(right.tier)
            - (left.tier.cpuUnits - steadyMinCpuUnits(left.tier))
          || right.tier.cpuWeight - left.tier.cpuWeight
          || left.tier.id.localeCompare(right.tier.id)
                ))[0];
            if (!receiver || !donor)
            {
                break;
            }
            receiver.tier.cpuUnits += 1;
            donor.tier.cpuUnits -= 1;
            steadyDeficitCpuUnits -= 1;
        }

        usage = accountedUsage([...active.values()]);
        let excessMemoryGiB = Math.max(0, usage.memoryGiB - budget.memoryGiB);
        for (const entry of [...elastic].sort((left, right) => right.tier.memoryGiB - left.tier.memoryGiB
      || left.tier.id.localeCompare(right.tier.id)))
        {
            const floor = Number.EPSILON;
            const reduction = Math.min(excessMemoryGiB, Math.max(0, entry.tier.memoryGiB - floor));
            entry.tier.memoryGiB -= reduction;
            excessMemoryGiB -= reduction;
            if (excessMemoryGiB <= Number.EPSILON)
            {
                break;
            }
        }
        if (excessMemoryGiB > Number.EPSILON)
        {
            throw new Error('resident reservation exceeds elastic memory reclaim capacity');
        }

        usage = accountedUsage([...active.values()]);
        let freeCpuUnits = Math.max(0, Math.floor(budget.cpuUnits - usage.cpuUnits));
        while (expand && freeCpuUnits > 0)
        {
            const selected = [...elastic].sort((left, right) =>
            {
                const leftDeficit = Math.max(0, Number(left.tier.minCpuUnits) - Number(left.tier.cpuUnits));
                const rightDeficit = Math.max(0, Number(right.tier.minCpuUnits) - Number(right.tier.cpuUnits));
                if (leftDeficit !== rightDeficit)
                {
                    return rightDeficit - leftDeficit;
                }
                const leftShare = Number(left.tier.cpuUnits) / Math.max(Number.EPSILON, Number(left.tier.cpuWeight));
                const rightShare = Number(right.tier.cpuUnits) / Math.max(Number.EPSILON, Number(right.tier.cpuWeight));
                return leftShare - rightShare || left.tier.id.localeCompare(right.tier.id);
            })[0];
            selected.tier.cpuUnits += 1;
            freeCpuUnits -= 1;
        }

        const currentUsage = accountedUsage([...active.values()]);
        const liveMemoryEnvelope = Math.min(
            budget.memoryGiB,
            currentUsage.memoryGiB + currentFreeMemoryGiB()
        );
        const freeMemoryGiB = Math.max(0, liveMemoryEnvelope - currentUsage.memoryGiB);
        if (expand && freeMemoryGiB > 0)
        {
            const weightTotal = elastic.reduce(
                (total, entry) => total + Math.max(Number.EPSILON, Number(entry.tier.memoryWeight)),
                0
            );
            for (const entry of elastic)
            {
                entry.tier.memoryGiB += freeMemoryGiB
          * Math.max(Number.EPSILON, Number(entry.tier.memoryWeight))
          / weightTotal;
            }
        }
        for (const entry of elastic)
        {
            entry.resourceGrantHistory ??= [];
            const grant = tierResourceUnits(entry.tier);
            const previous = entry.resourceGrantHistory.at(-1);
            if (!previous || previous.cpuUnits !== grant.cpuUnits || previous.memoryGiB !== grant.memoryGiB)
            {
                entry.resourceGrantHistory.push({
                    ...grant,
                    effectiveAt: new Date().toISOString()
                });
            }
        }
        writeActiveResourceGrants();
    };

    const admissionWave = () =>
    {
        if (pending.length === 0 || active.size >= maxParallel)
        {
            return [];
        }
        const activeEntries = [...active.values()];
        const usage = accountedUsage(activeEntries);
        const barrierPhase = Math.min(
            ...pending.map(tierPhase),
            ...activeEntries.map((entry) => tierPhase(entry.tier))
        );
        const ready = pending.filter((tier) => tierPhase(tier) === barrierPhase && dependenciesReady(tier))
            .sort(startupAdmissionOrder);
        const priority = rankReadyTiers(ready, options.priorityInput, {
            enabled: dynamicPriorityEnabled,
            minimumSamples: options.priorityMinimumSamples,
            agingCap: options.priorityAgingCap,
            readyAges
        });
        const readyById = new Map(ready.map((tier) => [tier.id, tier]));
        let orderedReady = priority.ranked.map((entry) => readyById.get(entry.tierId));
        if (schedulerReplayPlan)
        {
            orderedReady = [...ready].sort((left, right) =>
            {
                if (schedulerReplayPlan.schedulerReadyOrderPolicy === 'canonical')
                {
                    return startupAdmissionOrder(left, right);
                }
                const replayRank = (tier) => crypto.createHash('sha256')
                    .update(`${schedulerReplayPlan.schedulerShuffleSeed}\u0000${priorityWaveNumber + 1}\u0000${tier.id}`)
                    .digest('hex');
                return replayRank(left).localeCompare(replayRank(right)) || startupAdmissionOrder(left, right);
            });
        }
        const priorityById = new Map(priority.ranked.map((entry) => [entry.tierId, entry]));
        const selected = [];
        const decisions = [];
        let fixedCpu = 0;
        let fixedMemory = 0;
        let dynamicMinimumCpu = 0;
        const availableCpu = Math.max(0, Math.floor(budget.cpuUnits - usage.cpuUnits));
        const availableMemory = Math.max(0, Math.min(
            budget.memoryGiB - usage.memoryGiB,
            currentFreeMemoryGiB()
        ));

        for (const tier of orderedReady)
        {
            const admittedEntries = [...activeEntries, ...selected.map((item) => ({ tier: item }))];
            let excludedBy = null;
            let excludedDetail = null;
            if (!canShareAdmission(tier, admittedEntries, maxParallel))
            {
                if (admittedEntries.length >= maxParallel)
                {
                    excludedBy = 'max-parallel';
                }
                else if (admittedEntries.length > 0 && tier.parallelizable !== true)
                {
                    excludedBy = 'tier-non-parallel';
                }
                else if (admittedEntries.some((entry) => entry.tier.parallelizable !== true))
                {
                    excludedBy = 'active-non-parallel';
                }
                else if (admittedEntries.some((entry) => intersects(tier.exclusiveResources, entry.tier.exclusiveResources)))
                {
                    excludedBy = 'exclusive-resource';
                    excludedDetail = releaseReliabilityResourceConflict(
                        tier,
                        admittedEntries.map((entry) => entry.tier)
                    );
                }
                else if (admittedEntries.some((entry) => (
                    (tier.services?.length ?? 0) > 0
          && (entry.tier.services?.length ?? 0) > 0
          && intersects(tier.services, entry.tier.services)
                )))
                {
                    excludedBy = 'service-resource';
                }
                else
                {
                    excludedBy = 'resource-class-parallel-limit';
                }
            }
            if (excludedBy)
            {
                decisions.push({
                    ...priorityById.get(tier.id),
                    admitted: false,
                    hardConstraint: excludedBy,
                    ...(excludedDetail === null ? {} : { hardConstraintDetail: excludedDetail })
                });
                continue;
            }
            if (tier.resourceGrantMode === 'dynamic')
            {
                const minimum = startupMinCpuUnits(tier);
                if (fixedCpu + dynamicMinimumCpu + minimum > availableCpu || availableMemory - fixedMemory <= 0)
                {
                    decisions.push({
                        ...priorityById.get(tier.id),
                        admitted: false,
                        hardConstraint: fixedCpu + dynamicMinimumCpu + minimum > availableCpu ? 'cpu-budget' : 'memory-budget'
                    });
                    continue;
                }
                dynamicMinimumCpu += minimum;
            }
            else
            {
                const request = tierResourceUnits(tier);
                if (fixedCpu + dynamicMinimumCpu + request.cpuUnits > availableCpu
          || fixedMemory + request.memoryGiB > availableMemory)
                {
                    decisions.push({
                        ...priorityById.get(tier.id),
                        admitted: false,
                        hardConstraint: fixedCpu + dynamicMinimumCpu + request.cpuUnits > availableCpu ? 'cpu-budget' : 'memory-budget'
                    });
                    continue;
                }
                fixedCpu += request.cpuUnits;
                fixedMemory += request.memoryGiB;
            }
            selected.push(tier);
            decisions.push({ ...priorityById.get(tier.id), admitted: true, hardConstraint: null });
        }

        const selectedIds = new Set(selected.map((tier) => tier.id));
        for (const tier of ready)
        {
            if (selectedIds.has(tier.id))
            {
                readyAges.delete(tier.id);
            }
            else
            {
                readyAges.set(tier.id, (readyAges.get(tier.id) ?? 0) + 1);
            }
        }
        checkpoint.priorityScheduling.waves.push({
            wave: ++priorityWaveNumber,
            mode: priority.mode,
            fallbackReason: priority.fallbackReason,
            readyTierIds: ready.map((tier) => tier.id),
            admissionOrder: orderedReady.map((tier) => tier.id),
            decisions
        });
        const dynamic = selected.filter((tier) => tier.resourceGrantMode === 'dynamic');
        const dynamicCpu = Math.max(0, Math.floor(availableCpu - fixedCpu));
        const cpuAllocations = dynamic.length > 0
            ? startupIntegerAllocation(dynamic, dynamicCpu)
            : new Map();
        if (dynamic.length > 0 && cpuAllocations === null)
        {
            return [];
        }
        const dynamicMemory = Math.max(0, availableMemory - fixedMemory);
        const memoryWeightTotal = dynamic.reduce(
            (total, tier) => total + startupMemoryWeight(tier),
            0
        );
        const admittedAtMs = Date.now();
        if (schedulerReplayPlan)
        {
            for (const tier of selected)
            {
                const expectedTierId = schedulerReplayPlan.expectedAdmissionSequence[schedulerReplayAdmissionIndex];
                if (tier.id !== expectedTierId)
                {
                    throw new Error(
                        `scheduler replay admission drift at ${schedulerReplayAdmissionIndex}: expected ${expectedTierId}, got ${tier.id}`
                    );
                }
                schedulerReplayAdmissionIndex += 1;
            }
        }
        return selected.map((tier) =>
        {
            const priorityDecision = decisions.find((entry) => entry.tierId === tier.id);
            return tier.resourceGrantMode === 'dynamic'
                ? {
          ...tier,
          resourceGrantMode: 'granted',
          resourceGrantDynamic: true,
          cpuUnits: cpuAllocations.get(tier.id),
          memoryGiB: dynamicMemory * startupMemoryWeight(tier) / memoryWeightTotal,
          startupGrant: {
            cpuUnits: cpuAllocations.get(tier.id),
            memoryGiB: dynamicMemory * startupMemoryWeight(tier) / memoryWeightTotal
          },
          admittedAtMs,
          priorityDecision
        }
                : { ...tier, admittedAtMs, priorityDecision };
        });
    };

    const completeReusedTier = (tier, inputFingerprint, dependencyFingerprintValue, tierEnvironment) =>
    {
        const candidate = checkpoint.resumeCandidates?.[tier.id];
        const previousTier = candidate?.tierResult;
        const currentOutputs = snapshotTierOutputs(root, tier, tierEnvironment);
        if (
            resumeBudgetPolicyChanged
      || !sameCheckpointSource(candidate?.sourceState, sourceState)
      || !options.verifiedCandidateIdentity
      || !isDeepStrictEqual(previous.releaseCandidateIdentity, options.verifiedCandidateIdentity)
      // A static manifest cannot prove runtime reads; keep reuse disabled until its real trace owner is connected.
      || options.correctnessInputManifests?.[tier.id] !== undefined
      || (tier.reuseClass !== undefined && tier.reuseClass !== 'correctness')
      || tier.id === 'production-correctness'
      || !Object.is(previousTier?.status, 'success')
      || previousTier.inputFingerprint !== inputFingerprint
      || previousTier.dependencyFingerprint !== dependencyFingerprintValue
      || previousTier.outputFingerprint !== currentOutputs.fingerprint
      || currentOutputs.reusable !== true
      || (tier.services?.length ?? 0) > 0
      || tier.selfBootstraps === true
        )
        {
            return false;
        }

        const resultFingerprint = previousTier.resultFingerprint ?? fingerprint({ inputFingerprint, dependencyFingerprint: dependencyFingerprintValue });
        completed.add(tier.id);
        resultFingerprints.set(tier.id, resultFingerprint);
        reusedTiers.push(tier.id);
        delete checkpoint.resumeCandidates[tier.id];
        checkpoint.tiers[tier.id] = {
            ...previousTier,
            reused: true,
            reuseSourceState: candidate.sourceState,
            logFile: path.relative(root, path.join(tierLogDirectory, `${tier.id}.log`)).replaceAll(path.sep, '/')
        };
        writeCheckpoint(checkpointFile, checkpoint, {
            eventType: 'tier-reused',
            tier: tier.id,
            step: 'resume'
        });
        options.onTierReused?.(tier, checkpoint.tiers[tier.id]);
        return true;
    };

    const dataScaleRuntimeOwners = new Map();
    const startTier = async (tier) =>
    {
        schedulerWaitLedger.observe(tier.id, null);
        const enforcementBundleId = tier.physicalBundleId ?? tier.id;
        let effectiveEnforcement = resourceEnforcer.update(enforcementBundleId, tierResourceUnits(tier));
        let mysqlScope = null;
        if ((tier.services ?? []).includes('mysql'))
        {
            const productionBundle = tier.physicalBundleId === 'backend-tests'
                && tier.logicalMembers?.includes('backend-unit');
            const matrixUnit = tier.id === 'backend-unit' && !tier.physicalBundleId;
            if (!isDeepStrictEqual(tier.services, ['mysql']) || (!productionBundle && !matrixUnit)
                || options.executeTier || !requestedSystemdBoundary)
            {
                throw new Error('MySQL service admission requires its exact physical Migration producer');
            }
            const [{ loadExecutionServiceCatalog, validateExecutionServiceCatalog }, admission, lifecycle] = await Promise.all([
                import(new URL('../test/execution-envelope-services.mjs', import.meta.url)),
                import(new URL('../test/mysql-fixture-admission.mjs', import.meta.url)),
                import(new URL('../test-fixtures/services/mysql.mjs', import.meta.url))
            ]);
            const catalog = loadExecutionServiceCatalog();
            const catalogErrors = validateExecutionServiceCatalog(catalog,
                { tiers: [{ services: Object.keys(catalog.services ?? {}) }] });
            if (catalogErrors.length)
            {
                throw new Error(`MySQL scheduler service catalog is invalid: ${catalogErrors.join('; ')}`);
            }
            const service = catalog.services.mysql;
            const identity = { root: fs.realpathSync(root), runId, namespace: options.namespace,
                bundleId: productionBundle ? 'backend-tests' : 'matrix:backend-unit',
                stepId: 'migration-services', sourceState };
            const context = { ...identity, resourceGrant: structuredClone(service.resourceGrant),
                startupBudgetMs: service.lifecycleBudgets.startupMs,
                commandBudgetMs: service.lifecycleBudgets.commandMs,
                cleanupBudgetMs: service.lifecycleBudgets.cleanupMs };
            const lease = resourceEnforcer.reserveContainerResources(enforcementBundleId, {
                id: 'mysql-migration', identity, limits: context.resourceGrant
            });
            const scope = { context, lease, lifecycle, admission, service: null, binding: null,
                released: false, cleanupPromise: null };
            scope.cleanup = () => scope.cleanupPromise ??= lease.releaseAfterCleanup(async () =>
            {
                if (scope.service)
                {
                    await scope.service.cleanup();
                }
                if (!scope.binding)
                {
                    // The lifecycle cannot create until it has retained this binding.
                    // A preflight/source failure therefore has no container to remove.
                    return { containerAbsent: true, credentialsRemoved: true };
                }
                return lifecycle.verifyMySqlFixtureServiceCleanup(context,
                    { expectedBindingDigest: scope.binding.bindingDigest }).cleanup;
            }).then((result) =>
            {
                scope.released = true;
                if (checkpoint.mysqlFixtureServices?.[tier.id])
                {
                    checkpoint.mysqlFixtureServices[tier.id].status = 'cleaned';
                    checkpoint.mysqlFixtureServices[tier.id].cleanup = result;
                    writeCheckpoint(checkpointFile, checkpoint, { eventType: 'mysql-service-cleaned',
                        tier: tier.id, step: 'migration-services' });
                }
                return result;
            }).catch((error) =>
            {
                scope.cleanupPromise = null;
                throw error;
            });
            mysqlScope = scope;
            options.registerSchedulerFinalizer?.(async () =>
            {
                if (!scope.released)
                {
                    await scope.cleanup();
                }
            });
            effectiveEnforcement = resourceEnforcer.update(enforcementBundleId, tierResourceUnits(tier));
        }
        schedulerAdmissionSequence += 1;
        const releaseFinalRecorded = checkpoint.tiers?.['release-final'];
        const releaseFinalSpawnCountBeforeAdmission = active.has('release-final')
            || releaseFinalRecorded != null
            ? Math.max(1, Number(releaseFinalRecorded?.producerSpawnCount) || 0)
            : 0;
        const admission = createSchedulerTierAdmission({
            runId,
            targetTierId: checkpoint.targetTierId,
            currentTierId: tier.id,
            namespace: checkpoint.namespace,
            mode: checkpoint.mode,
            sourceState: checkpoint.sourceState,
            schedulerCandidateIdentityDigest: checkpoint.schedulerCandidateIdentityDigest,
            schedulerOwnerToken: options.schedulerRunOwnerToken,
            budgetPolicyDigest: checkpoint.budgetPolicyDigest ?? null,
            schedulerCheckpointRevision: Math.max(0, Number(checkpoint.revision) || 0) + 1,
            admissionSequence: schedulerAdmissionSequence,
            activeTierIds: [...active.keys()].sort(),
            releaseFinalSpawnCountBeforeAdmission
        });
        const publishedAdmission = writeSchedulerTierAdmission({ runsRoot, admission });
        const schedulerAdmissionReference = {
            schema: publishedAdmission.schema,
            ref: path.relative(root, publishedAdmission.file).replaceAll(path.sep, '/'),
            fileDigest: publishedAdmission.fileDigest,
            contentDigest: publishedAdmission.contentDigest,
            currentTierId: publishedAdmission.currentTierId,
            admissionSequence: publishedAdmission.admissionSequence
        };
        checkpoint.schedulerAdmissions[tier.id] = schedulerAdmissionReference;
        if (tier.id === 'production-correctness')
        {
            checkpoint.correctnessAttempt.createdFromCheckpointRevision = checkpoint.revision + 1;
            checkpoint.correctnessAttempt.status = 'running';
        }
        writeCheckpoint(checkpointFile, checkpoint, {
            eventType: 'tier-admitted',
            tier: tier.id,
            step: 'scheduler'
        });
        let tierEnvironment = {
            ...process.env,
            ...(options.env ?? {}),
            ...(options.envForTier?.(tier) ?? {}),
            FSUSBLOG_TEST_EXECUTION_SOURCE: mode,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_SCHEDULER_CHECKPOINT: publishedAdmission.file,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit ?? '',
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: resourceGrantFile,
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_RUN_ID: runId,
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: tier.id,
            ...(tier.id === 'production-correctness' ? {
                FSUSBLOG_CORRECTNESS_TARGET_ATTEMPT_ID: checkpoint.correctnessAttempt.targetAttemptId,
                FSUSBLOG_CORRECTNESS_PROVISIONAL_PACKET: checkpoint.correctnessAttempt.provisionalPacketFile,
                FSUSBLOG_CORRECTNESS_CHECKPOINT_REVISION: String(checkpoint.correctnessAttempt.createdFromCheckpointRevision)
            } : {}),
            ...(mysqlScope ? { FSUSBLOG_MYSQL_FIXTURE_ADMISSION_FILE:
                mysqlScope.admission.mysqlFixtureAdmissionFile(mysqlScope.context) } : {}),
            ...(tier.residentLeaseConsumer === true ? {
        FSUSBLOG_RESIDENT_LEASE_INVENTORY: residentLeaseFile,
        FSUSBLOG_RESIDENT_LEASE_HANDOFF: residentHandoffFile
      } : {}),
            ...resourceEnforcer.environment(enforcementBundleId),
            FSUSBLOG_CGROUP_EFFECTIVE_CPU_MAX: effectiveEnforcement.cpuMax,
            FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_HIGH_BYTES: String(effectiveEnforcement.memoryHighBytes),
            FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_MAX_BYTES: String(effectiveEnforcement.memoryMaxBytes),
            FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX: String(effectiveEnforcement.pidsMax)
        };
        let releaseFinalSpawnSeal = null;
        let releaseFinalSpawnSealAuthority = null;
        if (tier.id === 'release-final')
        {
            if (!currentRunEvidenceContext || !currentRunEvidenceRegistry)
            {
                throw new Error('release-final requires a validated current-run evidence context and registry');
            }
            const evidenceBindings = [
                [
                    'evidence-consumer.release.check-release-final',
                    tierEnvironment.FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH
                ],
                [
                    'evidence-consumer.release.release-final-domain-evidence',
                    tierEnvironment.FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH
                ]
            ].map(([consumerId, explicitInput]) =>
            {
                const registryEntry = currentRunEvidenceRegistry.entries.find((entry) => (
                    entry.consumerId === consumerId
                ));
                if (!registryEntry)
                {
                    throw new Error(`release-final evidence registry entry is missing: ${consumerId}`);
                }
                return locateCurrentRunEvidence({
                    context: currentRunEvidenceContext,
                    registry: currentRunEvidenceRegistry,
                    registryEntry,
                    repositoryRoot: root,
                    explicitInputs: [String(explicitInput ?? '').trim()]
                }).bindingReceipt;
            });
            releaseFinalSpawnSealAuthority = {
                schedulerNonce: releaseFinalSchedulerNonce,
                schedulerRunId: runId,
                schedulerCandidateIdentityDigest: options.schedulerCandidateIdentityDigest,
                sourceState,
                context: currentRunEvidenceContext,
                evidenceBindings
            };
            releaseFinalSpawnSeal = createReleaseFinalSpawnSeal(releaseFinalSpawnSealAuthority);
        }
        tierEnvironment = applyReleaseFinalizerSpawnDecision(tier, tierEnvironment, {
            repositoryRoot: root,
            spawnSeal: releaseFinalSpawnSeal,
            spawnSealAuthority: releaseFinalSpawnSealAuthority,
            requireEligible: true
        });
        const inputFingerprint = tierInputFingerprint(tier, root, {
            env: tierEnvironment,
            platform: options.platform,
            arch: options.arch,
            nodeVersion: options.nodeVersion,
            repositoryFingerprint: conservativeRepositoryFingerprint,
            inputManifest: options.correctnessInputManifests?.[tier.id]
        });
        const dependencyFingerprintValue = dependencyFingerprint(tier);
        const ownedOutputs = ownedGeneratedDeclarations(tier, byId);
        const currentRunPreexecutedTierBinding =
            currentRunPreexecutedTierBindings.get(tier.id) ?? null;
        let currentRunPreexecutedTierBindingVerified = false;
        if (resume && currentRunPreexecutedTierBinding)
        {
            await verifyCurrentRunPreexecutedTierBinding({
                binding: currentRunPreexecutedTierBinding,
                root,
                runId,
                sourceState,
                tier,
                ownedOutputs,
                tierEnvironment
            });
            currentRunPreexecutedTierBindingVerified = true;
        }
        if (resume && completeReusedTier(tier, inputFingerprint, dependencyFingerprintValue, tierEnvironment))
        {
            return false;
        }
        // The capacity authority must re-observe live headroom after scheduling
        // admission but before output retirement, cleanup, log creation or spawn.
        // A rejection at this hook therefore has a producer spawn count of zero.
        try
        {
            await options.beforeTierStart?.(tier, {
                runId,
                sourceState,
                activeTierIds: [...active.keys()].sort()
            });
            if (tier.id === 'release-reliability-fresh')
            {
                const { createDataScaleRuntimeSchedulerOwner } = await import(new URL('../test/data-scale-runtime-scheduler-owner.mjs', import.meta.url));
                const owner = await createDataScaleRuntimeSchedulerOwner({
                    root, runsRoot, admission, admissionReference: schedulerAdmissionReference,
                    environment: tierEnvironment, resourceEnforcer,
                    resourceGrant: effectiveEnforcement.totalGrant ?? effectiveEnforcement,
                    registerRetainedFinalizer: options.registerSchedulerFinalizer,
                    checkpointFile,
                    checkpointAuthority(file, update)
                    {
                        if (file !== checkpointFile || checkpoint.runId !== admission.runId)
                        {
                            throw new Error('DataScale checkpoint authority is bound to the current scheduler run');
                        }
                        // Preserve the canonical five-service resident owner. The
                        // DataScale inventory is a distinct entry in this same
                        // authoritative checkpoint and evidence journal.
                        const view = { ...checkpoint, residentResourceLeases: checkpoint.dataScaleResourceLeases ?? { status: 'not-acquired' } };
                        const next = update(view);
                        checkpoint.dataScaleResourceLeases = next.residentResourceLeases;
                        writeCheckpoint(checkpointFile, checkpoint, {
                            boundary: true, eventType: 'data-scale-resident-state-updated',
                            tier: tier.id, step: 'data-scale-runtime-owner'
                        });
                        return next;
                    }
                });
                dataScaleRuntimeOwners.set(tier.id, owner);
                Object.assign(tierEnvironment, owner.environment);
                options.registerSchedulerFinalizer?.(() => owner.dispose());
            }
        }
        catch (error)
        {
            producerAdmissionClosed = true;
            const failure = {
                tierId: tier.id,
                exitCode: 1,
                signal: null,
                reason: error?.message ?? 'producer admission failed',
                changedPaths: [],
                producerSpawnCount: 0
            };
            firstFailure ??= failure;
            failed.add(tier.id);
            checkpoint.tiers[tier.id] = {
                status: 'failure',
                durationMs: 0,
                reason: failure.reason,
                producerSpawnCount: 0,
                reused: false
            };
            checkpoint.failures.push(failure);
            checkpoint.failure = firstFailure;
            checkpoint.failurePoint = firstFailure.tierId;
            for (const entry of active.values())
            {
                entry.cancelRequested = true;
                entry.terminate();
            }
            writeCheckpoint(checkpointFile, checkpoint, {
                eventType: 'producer-admission-blocked',
                tier: tier.id,
                step: 'capacity-live-guard'
            });
            return false;
        }

        // Once execution is about to begin, the old success is no longer a safe
        // fallback: the command may mutate its outputs before failing or being
        // interrupted. Persist the retirement before spawning any work so a killed
        // resume remains fail-closed on the next attempt.
        if (resume && checkpoint.resumeCandidates?.[tier.id])
        {
            delete checkpoint.resumeCandidates[tier.id];
            writeCheckpoint(checkpointFile, checkpoint, {
                eventType: 'resume-candidate-retired',
                tier: tier.id,
                step: 'resume'
            });
        }

        if (currentRunPreexecutedTierBinding
      && !currentRunPreexecutedTierBindingVerified)
        {
            await verifyCurrentRunPreexecutedTierBinding({
                binding: currentRunPreexecutedTierBinding,
                root,
                runId,
                sourceState,
                tier,
                ownedOutputs,
                tierEnvironment
            });
        }
        if (currentRunPreexecutedTierBinding
      && snapshotTierOutputs(root, tier, tierEnvironment).reusable !== true)
        {
            throw new Error(
                `current-run preexecuted tier outputs are missing before admission: ${tier.id}`
            );
        }
        if (!resume && !currentRunPreexecutedTierBinding)
        {
            cleanFreshOwnedFiles(root, ownedOutputs, tierEnvironment);
        }
        const beforeOutputProvenance = outputProvenance(root, ownedOutputs, tierEnvironment);

        const logFile = path.join(tierLogDirectory, `${tier.id}.log`);
        const outputPipeline = createAsyncLogPipeline({
            root,
            file: logFile,
            teeOutput: options.teeOutput === true,
            highWaterMark: options.logHighWaterMark,
            indexHighWaterMark: options.logIndexHighWaterMark,
            consoleMaxBufferedBytes: options.consoleLogMaxBufferedBytes
        });
        const writeOutput = (chunk, stderr = false) =>
        {
            return outputPipeline.write(chunk, stderr ? 'stderr' : 'stdout');
        };
        const beforeSnapshot = await snapshotWorktree();
        const startedAt = Date.now();
        const context = {
            env: tierEnvironment,
            logFile,
            logIndexFile: outputPipeline.indexFile,
            logEvidenceFile: outputPipeline.evidenceFile,
            writeOutput,
            runId,
            runDirectory
        };
        const requiresProcessRegistration =
            resourceEnforcer.mode === 'enforced' || Boolean(options.registerManagedProcess);
        let execution;
        let mysqlRegistration = null;
        const serviceBoundary = options.executeTier ? null : resourceEnforcer.executionBoundary(enforcementBundleId);
        if (mysqlScope && !serviceBoundary)
        {
            throw new Error('MySQL fixture requires its original managed systemd execution boundary');
        }
        if (options.executeTier)
        {
            execution = {
                promise: Promise.resolve()
                    .then(() => options.executeTier(tier, context))
                    .then(normalizeExecutionResult, (error) => ({ code: 1, signal: null, error })),
                terminate: () => options.abortTier?.(tier)
            };
        }
        else if (serviceBoundary)
        {
            execution = beginResourceService(tier, { root, env: tierEnvironment, outputPipeline,
                boundary: serviceBoundary, terminationGraceMs,
                resourceContext: { ...systemdContext, bundleId: enforcementBundleId },
                residualRoot: path.join(runDirectory, 'physical-execution-residuals'),
                processOwner: { commandBudgetMs: requestedSystemdBoundary.commandBudgetMs,
                    retain: (authority) => options.retainManagedContainment(authority, tier),
                    beforeCreation: (authority, creationSender) =>
                        options.markManagedContainmentCreationAttempt(authority, tier, creationSender),
                    register: (identity, authority) => options.registerManagedProcess(identity, tier, authority),
                    ...(tier.residentLeaseProducer === true && typeof options.transferManagedResidentService === 'function'
                        ? { transfer: async (authority, captured) =>
                        {
                            if (!resourceServiceContainmentIsComplete(authority) || authority.phase !== 'pre-exec'
                                || !authority.residentOutput || !fs.existsSync(residentLeaseFile))
                            {
                                throw new Error('resident producer lacks its exact live service or inventory');
                            }
                            const inventory = readResidentLeaseDocument(residentLeaseFile);
                            validateResidentLeaseInventory(inventory, { runId,
                                namespace: tierEnvironment.FSUSBLOG_TEST_NAMESPACE,
                                ownerBundleId: enforcementBundleId,
                                resourceGrantHistory: active.get(tier.id)?.resourceGrantHistory ?? [tierResourceUnits(tier)],
                                resourceBudget: budget,
                                ...(tier.residentLeaseServiceIds ? { requiredServiceIds: tier.residentLeaseServiceIds } : {}),
                                sourceState: sourceState.commit ? sourceState : undefined });
                            const expectedPath = resourceEnforcer.environment(enforcementBundleId).FSUSBLOG_CGROUP_BUNDLE_PATH;
                            const scope = verifyResidentProcessServiceScope(inventory, expectedPath, authority,
                                { ...systemdContext, bundleId: enforcementBundleId });
                            const memberPids = new Set(captured.memberIdentities.map((identity) => identity.pid));
                            if (inventory.enforcement?.mode !== 'enforced'
                                || !scope.processes.some((entry) => entry.status === 'live')
                                || scope.processes.some((entry) => entry.status !== 'live' || !memberPids.has(entry.pid)))
                            {
                                throw new Error('resident producer inventory is not its exact live service roster');
                            }
                            const residentTransfer = { schema: residentServiceTransferSchema,
                                serviceBindingDigest: digestCanonical(authority.serviceBinding),
                                inventoryDigest: `sha256:${inventory.digest}`,
                                memberIdentities: captured.memberIdentities,
                                supervisorIdentity: captured.supervisorIdentity,
                                outputFiles: captured.outputFiles,
                                transferredAt: new Date().toISOString() };
                            const receipt = await options.transferManagedResidentService(authority, residentTransfer, tier);
                            return { ...receipt, residentTransfer };
                        } } : {}) } });
            startingExecutions.add(execution);
            // Admission failures settle through the ordinary failure/retained-resource ledger.
            mysqlRegistration = await execution.registrationReady.catch(() => null);
        }
        else
        {
            execution = beginSubprocess(tier, {
                root,
                env: tierEnvironment,
                outputPipeline,
                terminationGraceMs: Number.isFinite(Number(tier.terminationGraceMs)) &&
                Number(tier.terminationGraceMs) > 0
                    ? Number(tier.terminationGraceMs)
                    : terminationGraceMs,
                suspendForAttach: requiresProcessRegistration,
                durableContainment: Boolean(options.registerManagedProcess)
            });
        }
        if (execution.child && requiresProcessRegistration)
        {
            try
            {
                await execution.registrationReady;
            }
            catch (error)
            {
                execution.terminate();
                await execution.promise;
                await outputPipeline.close({ complete: false, truncationReason: 'registration-handshake-failed' });
                throw error;
            }
            const identity = collectProcessIdentity(execution.child.pid);
            if (identity.status !== 'verified')
            {
                execution.terminate();
                await execution.promise;
                await outputPipeline.close({ complete: false, truncationReason: 'registration-identity-failed' });
                throw new Error(`scheduler child identity is unverifiable: ${identity.reason}`);
            }
            try
            {
                options.registerManagedProcess?.(identity, tier, execution.containmentAuthority);
                await resourceEnforcer.attach(enforcementBundleId, execution.child.pid, identity);
                execution.resume?.();
            }
            catch (error)
            {
                execution.terminate();
                await execution.promise;
                await outputPipeline.close({ complete: false, truncationReason: 'cgroup-attach-failed' });
                throw new Error(`cgroup attach failed for ${enforcementBundleId}: ${error.message}`, { cause: error });
            }
        }
        if (mysqlScope)
        {
            try
            {
                if (!mysqlRegistration || !execution.ownsProcessTree)
                {
                    throw new Error('MySQL fixture requires a registered pre-exec systemd service');
                }
                resourceEnforcer.bindManagedService(enforcementBundleId,
                    mysqlRegistration.identity, mysqlRegistration.authority);
                mysqlScope.service = await mysqlScope.lifecycle.prepareMySqlFixtureService(mysqlScope.context, {
                    signal: execution.signal,
                    assertResourcesHeld: async (context) => mysqlScope.lease.assertHeld(context),
                    retainRecoveryBinding: async (binding) =>
                    {
                        if (mysqlScope.binding)
                        {
                            throw new Error('MySQL scheduler refuses a repeated recovery binding');
                        }
                        mysqlScope.binding = structuredClone(binding);
                        checkpoint.mysqlFixtureServices ??= {};
                        checkpoint.mysqlFixtureServices[tier.id] = {
                            ...structuredClone(binding), status: 'creating'
                        };
                        writeCheckpoint(checkpointFile, checkpoint, {
                            eventType: 'mysql-service-intent-retained', tier: tier.id, step: 'migration-services'
                        });
                    }
                });
                await mysqlScope.service.verify();
                const admissionFile = mysqlScope.admission.publishMySqlFixtureAdmission({
                    context: mysqlScope.context,
                    stateFile: mysqlScope.service.stateFile,
                    bindingDigest: mysqlScope.service.bindingDigest,
                    envelope: mysqlScope.service.envelope,
                    reservation: mysqlScope.lease.snapshot()
                });
                checkpoint.mysqlFixtureServices[tier.id].status = 'prepared';
                checkpoint.mysqlFixtureServices[tier.id].admissionFile = admissionFile;
                writeCheckpoint(checkpointFile, checkpoint, {
                    eventType: 'mysql-service-prepared', tier: tier.id, step: 'migration-services'
                });
            }
            catch (error)
            {
                execution.terminate(error);
                await execution.promise;
                startingExecutions.delete(execution);
                let failure = error;
                try
                {
                    await mysqlScope.cleanup();
                }
                catch (cleanupError)
                {
                    failure = new AggregateError([error, cleanupError],
                        error.message, { cause: error });
                }
                await outputPipeline.close({ complete: false, truncationReason: 'mysql-preparation-failed' });
                throw failure;
            }
        }
        const resourceCollector = execution.child || execution.rootPid
            ? createLinuxProcessTreeCollector({
          rootPid: execution.child?.pid ?? execution.rootPid,
          grantProvider: () => tierResourceUnits(tier),
          sampleIntervalMs: resolveResourceSampleIntervalMs({
            cpuUnits: tierResourceUnits(tier).cpuUnits,
            benchmark: tier.resourceClass === 'benchmark'
          })
        })
            : null;

        try
        {
            options.onTierStart?.(tier, { startedAt, logFile });
        }
        catch (error)
        {
            if (execution.ownsProcessTree)
            {
                execution.terminate(error);
                await execution.promise;
                startingExecutions.delete(execution);
                resourceCollector?.stop();
                await outputPipeline.close({ complete: false, truncationReason: 'tier-start-callback-failed' });
            }
            throw error;
        }
        const entry = {
            tier,
            mysqlScope,
            currentRunPreexecuted: currentRunPreexecutedTierBinding !== null,
            admittedAtMs: tier.admittedAtMs ?? startedAt,
            startupGrant: tier.startupGrant ?? tierResourceUnits(tier),
            firstExecutableStepAtMs: startedAt,
            cancelRequested: false,
            terminate: execution.terminate,
            promise: Promise.race([
                execution.promise.then((result) => ({ kind: 'execution', result })),
                outputPipeline.failure.then((error) => ({ kind: 'log-failure', error }))
            ]).then(async (outcome) =>
            {
                let executionResult;
                if (outcome.kind === 'log-failure')
                {
                    execution.terminate();
                    if (execution.child || execution.ownsProcessTree)
                    {
                        await execution.promise;
                    }
                    executionResult = {
                        code: 1,
                        signal: null,
                        error: new Error(`authoritative log pipeline failed: ${outcome.error.message}`, { cause: outcome.error }),
                        logComplete: false,
                        logTruncationReason: 'writer-error'
                    };
                }
                else
                {
                    executionResult = outcome.result;
                }
                if (mysqlScope)
                {
                    try
                    {
                        await mysqlScope.cleanup();
                    }
                    catch (error)
                    {
                        const executionFailed = executionResult.code !== 0
                            || executionResult.signal || executionResult.error;
                        executionResult = {
                            ...executionResult,
                            cleanupFailures: [...(executionResult.cleanupFailures ?? []), error],
                            ...(executionFailed ? {} : { code: 1, error })
                        };
                    }
                }
                const logFinalization = await outputPipeline.close({
                    complete: executionResult.logComplete !== false,
                    truncationReason: executionResult.logTruncationReason ?? null
                });
                execution.cleanupContainmentHandshake?.();
                if (logFinalization.error && !executionResult.error)
                {
                    executionResult = {
                        ...executionResult,
                        code: 1,
                        error: new Error(
                            `authoritative log pipeline failed: ${logFinalization.error.message}`,
                            { cause: logFinalization.error }
                        )
                    };
                }
                const resourceUtilization = resourceCollector?.stop() ?? {
                    status: 'unavailable',
                    platform: process.platform,
                    actualCpuSeconds: null,
                    grantedCpuSeconds: null,
                    cpuGrantEfficiency: null
                };
                const afterSnapshot = await snapshotWorktree();
                return {
                    executionResult,
                    resourceUtilization,
                    changedPaths: changedSnapshotPaths(beforeSnapshot, afterSnapshot),
                    durationMs: Math.max(0, Date.now() - startedAt),
                    inputFingerprint,
                    dependencyFingerprint: dependencyFingerprintValue,
                    ownedOutputs,
                    tierEnvironment,
                    beforeOutputProvenance,
                    logFile,
                    logIndexFile: logFinalization.indexFile,
                    logEvidenceFile: logFinalization.evidenceFile,
                    logEvidence: logFinalization.evidence
                };
            })
        };
        active.set(tier.id, entry);
        startingExecutions.delete(execution);
        // Publish the admitted grant before an in-process executor or a very fast
        // child can read it. The later expansion pass may grow this grant, but the
        // startup grant and current resident deduction must already be authoritative.
        writeActiveResourceGrants();
        if (execution.ownsProcessTree)
        {
            execution.resume();
        }
        if (tier.resourceGrantDynamic === true)
        {
            entry.resourceGrantHistory = [{
                ...entry.startupGrant,
                effectiveAt: new Date(startedAt).toISOString()
            }];
        }
        sampleResourcePeaks();
        return true;
    };

    const recordSettled = (entry, settled) =>
    {
        const { tier } = entry;
        const {
            executionResult,
            resourceUtilization,
            changedPaths,
            durationMs,
            inputFingerprint,
            dependencyFingerprint: dependencyFingerprintValue,
            ownedOutputs,
            tierEnvironment,
            beforeOutputProvenance,
            logFile,
            logIndexFile,
            logEvidenceFile,
            logEvidence
        } = settled;
        if (executionResult.physicalExecutionAuthority?.phase === 'resident-transferred'
            && resourceServiceContainmentIsComplete(executionResult.physicalExecutionAuthority))
        {
            transferredServiceAuthorities.set(tier.id, executionResult.physicalExecutionAuthority);
        }
        if (executionResult.code === 124)
        {
            const expectedTimeoutPhase = tier.producerTimeoutPhase ?? null;
            if (!timeoutPhases.has(executionResult.timeoutPhase)
        || (expectedTimeoutPhase !== null && executionResult.timeoutPhase !== expectedTimeoutPhase))
            {
                executionResult.code = 1;
                executionResult.error = new Error(`timeout phase is missing or invalid for ${tier.id}`);
            }
        }
        const commandFailed = executionResult.code !== 0 || executionResult.signal || executionResult.error;
        const polluted = changedPaths.length > 0;
        const cancelled = entry.cancelRequested && firstFailure !== null;
        const outputs = snapshotTierOutputs(root, tier, tierEnvironment);
        const outputInvalid = !commandFailed && outputs.reusable !== true;
        const afterOutputProvenance = outputProvenance(root, ownedOutputs, tierEnvironment);
        const staleOutputs = !commandFailed
      && !outputInvalid
      && entry.currentRunPreexecuted !== true
      && ownedOutputs.length > 0
      && beforeOutputProvenance.fingerprint === afterOutputProvenance.fingerprint;
        let success = !cancelled && !commandFailed && !polluted && !outputInvalid && !staleOutputs;
        const resultFingerprint = fingerprint({
            inputFingerprint,
            dependencyFingerprint: dependencyFingerprintValue,
            outputFingerprint: outputs.fingerprint
        });
        const relativeLogFile = path.relative(root, logFile).replaceAll(path.sep, '/');
        let reason = null;
        if (cancelled)
        {
            reason = 'cancelled after sibling failure';
        }
        else if (executionResult.error)
        {
            reason = executionResult.error.message;
        }
        else if (commandFailed)
        {
            reason = `${tier.command} exited ${executionResult.code}${executionResult.signal ? ` (${executionResult.signal})` : ''}`;
        }
        else if (polluted)
        {
            reason = `working tree pollution detected: ${changedPaths.join(', ')}`;
        }
        else if (outputInvalid)
        {
            const invalidOutputs = Object.entries(outputs.entries)
                .filter(([, value]) => value === 'missing' || value === 'missing-wildcard' || value === 'outside-root')
                .map(([declaration, value]) => `${declaration} (${value})`);
            reason = `required artifact/evidence missing or invalid: ${invalidOutputs.join(', ')}`;
        }
        else if (staleOutputs)
        {
            reason = `fresh tier did not produce or update its owned generated evidence: ${ownedOutputs.join(', ')}`;
        }

        if (success && currentRunEvidenceContext)
        {
            try
            {
                const handoffs = parseCurrentRunEvidenceHandoffs(fs.readFileSync(logFile, 'utf8'));
                for (const handoff of handoffs)
                {
                    const entry = currentRunEvidenceRegistry.entries.find((candidate) =>
                        candidate.authorityId === handoff.authorityId);
                    if (!entry)
                    {
                        throw new Error(`producer terminal handoff authority is unregistered: ${handoff.authorityId}`);
                    }
                    attachCurrentRunEvidenceHandoff({ checkpoint, context: currentRunEvidenceContext,
                        entry, handoff, registry: currentRunEvidenceRegistry, repositoryRoot: root });
                }
            }
            catch (error)
            {
                success = false;
                reason = error.message;
                executionResult.code = 1;
                executionResult.error = error;
            }
        }

        if (tier.residentLeaseProducer === true && !entry.settlementFailure)
        {
            if (fs.existsSync(residentLeaseFile) || success)
            {
                try
                {
                    acquireResidentState(tier, tierEnvironment, {
                        publishHandoff: success,
                        resourceGrantHistory: entry.resourceGrantHistory ?? [tierResourceUnits(tier)],
                        serviceAuthority: executionResult.physicalExecutionAuthority ?? null
                    });
                }
                catch (error)
                {
                    recordResidentEvent('acquisition-failed', { reason: error.message });
                    if (success)
                    {
                        success = false;
                        reason = error.message;
                        executionResult.code = 1;
                        executionResult.error = error;
                    }
                }
            }
            else
            {
                recordResidentEvent('partial-inventory-missing', { ownerBundleId: tier.physicalBundleId ?? tier.id });
            }
        }
        else if (residentState)
        {
            reconcileResidentState({ force: true });
        }

        checkpoint.tiers[tier.id] = {
            status: success ? 'success' : (cancelled ? 'cancelled' : 'failure'),
            ...(tier.id === 'production-correctness' ? {
                targetAttemptId: checkpoint.correctnessAttempt.targetAttemptId,
                commandExitCode: executionResult.code,
                outcomeValidated: success,
                postflightStatus: 'pending',
                checkpointCASCommitted: false
            } : {}),
            resourceGrant: tierResourceUnits(tier),
            admittedAtMs: entry.admittedAtMs,
            startupGrant: entry.startupGrant,
            firstExecutableStepAtMs: entry.firstExecutableStepAtMs,
            resourceGrantHistory: entry.resourceGrantHistory ?? [tierResourceUnits(tier)],
            priorityDecision: tier.priorityDecision ?? null,
            resourceUtilization,
            inputFingerprint,
            dependencyFingerprint: dependencyFingerprintValue,
            resultFingerprint,
            durationMs,
            timeoutPhase: executionResult.timeoutPhase ?? null,
            physicalExecutionTermination: executionResult.physicalExecutionTermination ?? null,
            physicalExecutionAuthority: executionResult.physicalExecutionAuthority ?? null,
            physicalExecutionNested: executionResult.physicalExecutionNested ?? null,
            resourceExecutionAdmission: executionResult.resourceExecutionAdmission ?? null,
            settlementFailure: entry.settlementFailure ?? null,
            ...(executionResult.cleanupFailures ? {
                cleanupFailures: executionResult.cleanupFailures.map((error) => ({
                    reason: error instanceof Error ? error.message : String(error)
                }))
            } : {}),
            exitCode: executionResult.code,
            signal: executionResult.signal,
            changedPaths,
            outputFingerprint: outputs.fingerprint,
            outputs: outputs.entries,
            outputsReusable: outputs.reusable,
            outputProvenanceFingerprint: afterOutputProvenance.fingerprint,
            ownedGeneratedOutputs: ownedOutputs,
            reason,
            logFile: relativeLogFile,
            log: {
                ...logEvidence,
                rawLog: relativeLogFile,
                index: path.relative(root, logIndexFile).replaceAll(path.sep, '/'),
                evidence: path.relative(root, logEvidenceFile).replaceAll(path.sep, '/')
            },
            reused: false
        };
        if (success)
        {
            completed.add(tier.id);
            resultFingerprints.set(tier.id, resultFingerprint);
        }
        options.onTierComplete?.(tier, checkpoint.tiers[tier.id]);
        writeCheckpoint(checkpointFile, checkpoint, {
            eventType: success ? 'tier-completed' : (cancelled ? 'tier-cancelled' : 'tier-failed'),
            tier: tier.id,
            step: 'execute'
        });
        return { success, cancelled, reason, changedPaths, executionResult };
    };

    while (pending.length > 0 || active.size > 0)
    {
        if (interrupted && active.size === 0)
        {
            break;
        }
        if (collectFailures)
        {
            let blockedAny = true;
            while (blockedAny)
            {
                blockedAny = false;
                for (let index = pending.length - 1; index >= 0; index -= 1)
                {
                    const blockedBy = failedDependencies(pending[index]);
                    if (blockedBy.length === 0)
                    {
                        continue;
                    }
                    const [blockedTier] = pending.splice(index, 1);
                    failed.add(blockedTier.id);
                    checkpoint.tiers[blockedTier.id] = {
                        status: 'blocked',
                        durationMs: 0,
                        reason: `blocked by failed dependencies: ${blockedBy.join(', ')}`,
                        reused: false
                    };
                    blockedAny = true;
                }
            }
        }
        if ((!firstFailure || collectFailures) && !deadlineExpired
            && !producerAdmissionClosed && !settlementAdmissionClosed)
        {
            const wave = admissionWave();
            const waveIds = new Set(wave.map((tier) => tier.id));
            const activeEntries = [...active.values()];
            const admissionEntries = [...activeEntries, ...wave.map((tier) => ({ tier }))];
            const usage = accountedUsage(admissionEntries);
            const barrierPhase = Math.min(
                ...pending.map(tierPhase),
                ...activeEntries.map((entry) => tierPhase(entry.tier))
            );
            for (const tier of pending)
            {
                if (waveIds.has(tier.id))
                {
                    continue;
                }
                if (tierPhase(tier) > barrierPhase)
                {
                    schedulerWaitLedger.observe(tier.id, { dependencies: [`phase:${barrierPhase}`] });
                    continue;
                }
                const dependencies = tierSchedulerDependencies(tier)
                    .filter((dependencyId) => byId.has(dependencyId)
                        && !completed.has(dependencyId));
                if (dependencies.length > 0)
                {
                    schedulerWaitLedger.observe(tier.id, { dependencies });
                    continue;
                }
                const exclusiveResources = (tier.exclusiveResources ?? []).filter((resource) =>
                    admissionEntries.some((entry) => (entry.tier.exclusiveResources ?? []).includes(resource)));
                const exclusiveResourceConflicts = admissionEntries
                    .map((entry) => releaseReliabilityResourceConflict(tier, [entry.tier]))
                    .filter(Boolean);
                const serviceResources = (tier.services ?? []).filter((service) =>
                    admissionEntries.some((entry) => (entry.tier.services ?? []).includes(service)))
                    .map((service) => `service:${service}`);
                exclusiveResources.push(...serviceResources);
                if (exclusiveResources.includes('benchmark-window'))
                {
                    schedulerWaitLedger.observe(tier.id, { benchmarkIsolation: true });
                }
                else if (exclusiveResources.length > 0)
                {
                    schedulerWaitLedger.observe(tier.id, {
                        exclusiveResources,
                        exclusiveResourceConflicts
                    });
                }
                else
                {
                    const request = tier.resourceGrantMode === 'dynamic'
                        ? { cpuUnits: startupMinCpuUnits(tier), memoryGiB: Number.EPSILON }
                        : tierResourceUnits(tier);
                    const capacity = {
                        cpu: admissionEntries.length >= maxParallel
              || !canShareAdmission(tier, admissionEntries, maxParallel)
              || usage.cpuUnits + request.cpuUnits > budget.cpuUnits,
                        memory: usage.memoryGiB + request.memoryGiB > Math.min(budget.memoryGiB, usage.memoryGiB + currentFreeMemoryGiB())
                    };
                    schedulerWaitLedger.observe(tier.id, tier.resourceGrantMode === 'dynamic'
                        ? { startupCapacity: capacity }
                        : { capacity });
                }
            }
            for (const grantedTier of wave)
            {
                const nextIndex = pending.findIndex((tier) => tier.id === grantedTier.id);
                if (nextIndex < 0)
                {
                    continue;
                }
                pending.splice(nextIndex, 1);
                await startTier(grantedTier);
            }
            // Admit newly-ready work before redistributing released capacity to
            // already-running elastic tiers. Otherwise an active tier can consume
            // every released CPU unit and indefinitely starve a downstream bundle
            // whose minimum grant would fit in that same envelope.
            rebalanceActiveDynamicGrants();
            if (wave.length > 0 && active.size === 0)
            {
                continue;
            }
        }

        if (active.size === 0)
        {
            if (settlementAdmissionClosed)
            {
                for (const tier of pending.splice(0))
                {
                    checkpoint.tiers[tier.id] = {
                        status: 'blocked',
                        durationMs: 0,
                        reason: `blocked by unsettled owner resources after settlement: ${[...retainedResourceGrants.keys()].join(', ')}`,
                        reused: false
                    };
                }
                break;
            }
            if (producerAdmissionClosed)
            {
                for (const tier of pending.splice(0))
                {
                    checkpoint.tiers[tier.id] = {
                        status: 'blocked',
                        durationMs: 0,
                        reason: `blocked by capacity admission failure: ${firstFailure?.tierId ?? 'unknown'}`,
                        reused: false
                    };
                }
                break;
            }
            if (deadlineExpired)
            {
                break;
            }
            if (pending.length > 0 && (!firstFailure || collectFailures))
            {
                const barrierPhase = Math.min(...pending.map(tierPhase));
                const readyTier = pending.find((tier) => tierPhase(tier) === barrierPhase && dependenciesReady(tier));
                const request = readyTier
                    ? (readyTier.resourceGrantMode === 'dynamic'
              ? { cpuUnits: startupMinCpuUnits(readyTier), memoryGiB: Number.EPSILON }
              : tierResourceUnits(readyTier))
                    : null;
                const liveMemoryCapacityGiB = Math.min(budget.memoryGiB, currentFreeMemoryGiB());
                const resident = residentUsage();
                const executableBudget = {
                    cpuUnits: Math.max(0, budget.cpuUnits - resident.cpuUnits),
                    memoryGiB: Math.max(0, liveMemoryCapacityGiB - resident.memoryGiB)
                };
                const unschedulable = request
          && (request.cpuUnits > executableBudget.cpuUnits || request.memoryGiB > executableBudget.memoryGiB);
                firstFailure = {
                    tierId: readyTier?.id ?? pending[0].id,
                    exitCode: 1,
                    signal: null,
                    reason: unschedulable
                        ? `unschedulable resource request for ${readyTier.id}: cpu=${request.cpuUnits}/${executableBudget.cpuUnits}, memoryGiB=${request.memoryGiB}/${executableBudget.memoryGiB} after resident reservation`
                        : 'no runnable tiers remain; check DAG dependencies and resource metadata',
                    changedPaths: []
                };
            }
            break;
        }

        const activePromises = [...active.entries()].map(([tierId, entry]) => (
            entry.promise.then((settled) => ({ tierId, settled }))
        ));
        const raceEntries = budgetPromise && (!firstFailure || collectFailures)
            ? [budgetPromise, ...activePromises]
            : activePromises;
        if (interruptPromise)
        {
            raceEntries.push(interruptPromise);
        }
        const outcome = await Promise.race(raceEntries);
        if (outcome.interrupted)
        {
            interruptPromise = null;
            deadlineExpired = true;
            firstFailure ??= {
                tierId: active.keys().next().value ?? pending[0]?.id ?? checkpoint.targetTierId,
                exitCode: outcome.exitCode,
                signal: outcome.signal,
                reason: `scheduler interrupted by ${outcome.signal}`,
                changedPaths: []
            };
            checkpoint.failure = firstFailure;
            checkpoint.failurePoint = firstFailure.tierId;
            checkpoint.failures.push(firstFailure);
            writeCheckpoint(checkpointFile, checkpoint, {
                eventType: 'run-interrupted',
                tier: firstFailure.tierId,
                step: 'scheduler'
            });
            continue;
        }
        if (outcome.budgetExpired)
        {
            deadlineExpired = true;
            budgetPromise = null;
            const timedOutTierId = active.keys().next().value ?? pending[0]?.id ?? checkpoint.targetTierId;
            firstFailure = {
                tierId: timedOutTierId,
                exitCode: 124,
                signal: null,
                timeoutPhase: 'global',
                reason: `wall-clock budget exceeded (${wallClockBudgetMs}ms)`,
                changedPaths: []
            };
            checkpoint.timedOut = true;
            checkpoint.failure = firstFailure;
            checkpoint.failurePoint = timedOutTierId;
            checkpoint.failures.push(firstFailure);
            writeCheckpoint(checkpointFile, checkpoint, {
                eventType: 'run-timed-out',
                tier: timedOutTierId,
                step: 'scheduler'
            });
            for (const entry of active.values())
            {
                entry.cancelRequested = true;
                entry.terminate();
            }
            continue;
        }
        const { tierId } = outcome;
        let { settled } = outcome;
        const entry = active.get(tierId);
        try
        {
            const termination = settled.executionResult.physicalExecutionTermination;
            const transferAuthority = settled.executionResult.physicalExecutionAuthority;
            const residentTransferred = entry.tier.residentLeaseProducer === true
                && termination?.postObservation === 'resident-transferred'
                && termination.terminated === false
                && resourceServiceContainmentIsComplete(transferAuthority)
                && transferAuthority.phase === 'resident-transferred';
            if (termination !== undefined && termination !== null
                && !residentTransferred
                && (termination.terminated !== true || termination.postObservation !== 'zero-members'))
            {
                throw new Error(
                    `physical execution termination incomplete: ${termination.reason ?? termination.postObservation ?? 'invalid-result'}`
                );
            }
            if (entry.mysqlScope)
            {
                const termination = settled.executionResult.physicalExecutionTermination;
                if (entry.mysqlScope.released !== true || termination?.terminated !== true
                    || termination.postObservation !== 'zero-members')
                {
                    throw new Error('MySQL execution resources remain held until exact service cleanup and zero-member termination');
                }
            }
            await dataScaleRuntimeOwners.get(entry.tier.id)?.dispose({
                success: settled.executionResult?.code === 0
            });
            await options.afterTierSettled?.(entry.tier, settled);
        }
        catch (error)
        {
            const reason = error instanceof Error ? error.message : String(error);
            entry.settlementFailure = {
                status: 'retained',
                bundleId: entry.tier.physicalBundleId ?? tierId,
                resourceGrant: tierResourceUnits(entry.tier),
                reason
            };
            retainedResourceGrants.set(tierId, {
                tier: { id: tierId, ...entry.settlementFailure.resourceGrant }
            });
            checkpoint.resourceUtilization.retainedResourceGrants[tierId] = entry.settlementFailure;
            settlementAdmissionClosed = true;
            const executionFailed = settled.executionResult.code !== 0
                || settled.executionResult.signal || settled.executionResult.error;
            settled = {
                ...settled,
                executionResult: executionFailed ? settled.executionResult : {
                    ...settled.executionResult,
                    code: 1,
                    error: error instanceof Error ? error : new Error(reason)
                }
            };
        }
        active.delete(tierId);
        const recorded = recordSettled(entry, settled);
        // A producer may have converted part of its released grant into resident
        // leases. Contract active elastic grants immediately, before another
        // admission/resource sample can observe an overcommitted envelope.
        rebalanceActiveDynamicGrants({ expand: false });
        if (!recorded.success && !recorded.cancelled && !firstFailure)
        {
            const failure = {
                tierId,
                exitCode: recorded.executionResult.code ?? 1,
                signal: recorded.executionResult.signal ?? null,
                timeoutPhase: recorded.executionResult.timeoutPhase ?? null,
                reason: recorded.reason,
                changedPaths: recorded.changedPaths
            };
            firstFailure = failure;
            failed.add(tierId);
            checkpoint.failures.push(failure);
            if (!collectFailures)
            {
                for (const sibling of active.values())
                {
                    sibling.cancelRequested = true;
                    sibling.terminate();
                }
            }
        }
        else if (!recorded.success && !recorded.cancelled && collectFailures)
        {
            const failure = {
                tierId,
                exitCode: recorded.executionResult.code ?? 1,
                signal: recorded.executionResult.signal ?? null,
                timeoutPhase: recorded.executionResult.timeoutPhase ?? null,
                reason: recorded.reason,
                changedPaths: recorded.changedPaths
            };
            failed.add(tierId);
            checkpoint.failures.push(failure);
        }
        if (settlementAdmissionClosed)
        {
            for (const sibling of active.values())
            {
                if (!sibling.cancelRequested)
                {
                    sibling.cancelRequested = true;
                    sibling.terminate();
                }
            }
        }
    }

    checkpoint.status = firstFailure ? 'failure' : 'success';
    checkpoint.failure = firstFailure;
    checkpoint.failurePoint = firstFailure?.tierId ?? null;
    checkpoint.finishedAt = new Date().toISOString();
    if (budgetTimer)
    {
        clearTimeout(budgetTimer);
    }
    clearInterval(resourceTimer);
    sampleResourcePeaks();
    for (const [tierId, authority] of transferredServiceAuthorities)
    {
        const residentReleased = residentState?.reconciliation?.fullyReleased === true;
        try
        {
            if (typeof options.settleManagedResidentService !== 'function')
            {
                throw new Error('transferred resident service has no independent build-owner settlement');
            }
            const settled = options.settleManagedResidentService(authority, { reason: firstFailure
                ? 'scheduler-failed-resident-cleanup' : 'resident-consumer-settled' });
            if (settled?.termination?.postObservation !== 'zero-members'
                || settled?.artifacts?.some((entry) => entry.status !== 'absent'))
            {
                throw new Error('transferred resident service settlement lacks exact zero-member artifact absence');
            }
            recordResidentEvent('resident-service-settled', { tierId, authorityId: authority.authorityId });
            if (!residentReleased && !firstFailure)
            {
                throw new Error('resident consumer did not release its live process before service settlement');
            }
        }
        catch (error)
        {
            const failure = { tierId, exitCode: 1, signal: null, reason: error.message, changedPaths: [] };
            checkpoint.failures.push(failure);
            checkpoint.failure ??= failure;
            checkpoint.failurePoint ??= tierId;
            checkpoint.status = 'failure';
            checkpoint.resourceUtilization.status = 'partial';
            firstFailure ??= failure;
            recordResidentEvent('resident-service-settlement-failed', { tierId, reason: error.message });
        }
    }
    checkpoint.criticalPath = criticalPath(tiers, checkpoint.tiers);
    checkpoint.resourceUtilization.status = firstFailure ? 'partial' : 'complete';
    checkpoint.resourceUtilization.waits = schedulerWaitLedger.finish();
    checkpoint.resourceUtilization.resourceGrantHistory = Object.fromEntries(Object.entries(checkpoint.tiers)
        .map(([tierId, result]) => [tierId, result.resourceGrantHistory ?? []]));
    if (schedulerReplayPlan)
    {
        try
        {
            checkpoint.executionReplay.actual = createSchedulerReplayActual({
                plan: schedulerReplayPlan,
                checkpoint
            });
        }
        catch (error)
        {
            checkpoint.status = 'failure';
            checkpoint.failure ??= {
                tierId: checkpoint.targetTierId,
                exitCode: 1,
                signal: null,
                reason: error.message,
                changedPaths: []
            };
            checkpoint.failurePoint ??= checkpoint.targetTierId;
            checkpoint.failures.push(checkpoint.failure);
            checkpoint.executionReplay.error = error.message;
        }
    }
    try
    {
        finalizeResourceEnforcer();
    }
    catch (error)
    {
        const cleanupFailure = {
            tierId: checkpoint.targetTierId,
            exitCode: 1,
            signal: null,
            reason: error.message,
            changedPaths: []
        };
        checkpoint.resourceCleanupFailure = cleanupFailure;
        checkpoint.failures.push(cleanupFailure);
        checkpoint.failure ??= cleanupFailure;
        checkpoint.failurePoint ??= cleanupFailure.tierId;
        checkpoint.status = 'failure';
        checkpoint.resourceUtilization.status = 'partial';
        firstFailure ??= checkpoint.failure;
    }
    checkpoint.resourceEnforcement = resourceEnforcer.evidence();
    removeInterruptHandlers();
    checkpoint.ungeneratedEvidence = firstFailure
        ? tiers.flatMap((tier) =>
{
        const result = checkpoint.tiers[tier.id];
        if (result?.status === 'success')
{
return [];
}
        return [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])])].map((declaration) => ({
          tierId: tier.id,
          declaration
        }));
      })
        : [];
    writeCheckpoint(checkpointFile, checkpoint, {
        boundary: true,
        stage: firstFailure ? 'run-failed' : 'run-complete',
        eventType: firstFailure ? 'run-failed' : 'run-completed',
        tier: firstFailure?.tierId ?? checkpoint.targetTierId,
        step: 'scheduler'
    });

    return {
        status: checkpoint.status,
        runId,
        runDirectory,
        checkpointPath: checkpointFile,
        reusedTiers,
        failure: firstFailure,
        checkpoint
    };
}

function runLockIsActive(runsRoot, runId)
{
    const checkpoint = readCheckpoint(path.join(runsRoot, runId, 'checkpoint.json'));
    if (
        !checkpoint ||
      checkpoint.runId !== runId ||
      typeof checkpoint.targetTierId !== 'string' ||
      !checkpoint.targetTierId ||
      typeof checkpoint.sourceState?.commit !== 'string' ||
      !checkpoint.sourceState.commit ||
      typeof checkpoint.sourceState?.worktreeFingerprint !== 'string' ||
      !checkpoint.sourceState.worktreeFingerprint ||
      typeof checkpoint.namespace !== 'string' ||
      !checkpoint.namespace ||
      !/^sha256:[a-f0-9]{64}$/u.test(checkpoint.schedulerCandidateIdentityDigest ?? '')
    )
    {
        throw new Error(`scheduler lock owner-unverifiable: candidate checkpoint identity is incomplete for ${runId}`);
    }
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId,
        targetTierId: checkpoint.targetTierId,
        namespace: checkpoint.namespace,
        sourceState: checkpoint.sourceState,
        budgetPolicyDigest: checkpoint.budgetPolicyDigest ?? null
    });
    if (candidateIdentityDigest !== checkpoint.schedulerCandidateIdentityDigest)
    {
        throw new Error(`scheduler lock owner-unverifiable: candidate checkpoint identity is invalid for ${runId}`);
    }
    return schedulerRunLockIsActive({
        runsRoot,
        runId,
        targetTierId: checkpoint.targetTierId,
        candidateIdentityDigest
    });
}

function acquireRunLock(
    runsRoot,
    runId,
    {
        sourceState = null,
        namespace = 'test-matrix',
        targetTierId = 'scheduler-coordination',
        budgetPolicyDigest = null,
        beforeStaleLockDelete = null
    } = {}
)
{
    const normalizedSourceState = {
        commit: String(sourceState?.commit ?? 'unversioned'),
        worktreeFingerprint: String(sourceState?.worktreeFingerprint ?? 'unbound')
    };
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId,
        targetTierId,
        namespace,
        sourceState: normalizedSourceState,
        budgetPolicyDigest
    });
    const controller = acquireSchedulerRunLock({
        runsRoot,
        runId,
        candidateIdentityDigest,
        budgetPolicyDigest,
        targetTierId,
        beforeStaleLockDelete
    });
    const release = (state = 'complete') =>
    {
        if (!controller.finalize(state))
        {
            throw new Error(`unable to finalize scheduler run owner for ${runId}`);
        }
    };
    release.markRunning = () =>
    {
        if (!controller.markRunning())
        {
            throw new Error(`unable to start scheduler run owner heartbeat for ${runId}`);
        }
    };
    release.markFinalizing = () =>
    {
        if (!controller.markFinalizing())
        {
            throw new Error(`unable to enter scheduler run owner finalizing state for ${runId}`);
        }
    };
    release.owner = controller.owner;
    return release;
}

/** Compare canonical state under the already acquired scheduler owner; never acquire a competing lock. */
/** Live grant consumers bind the exact canonical generation and active run owner.
 * This is a readback port, not the generic nested adapter or a live-admission receipt.
 */
export function readCanonicalSchedulerResourceGrant({ checkpointFile, runId, tierId, ownerToken,
    minimumGeneration = 1, expectedGeneration = null })
{
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
    const checkpoint = canonical?.checkpoint;
    if (!runId || !tierId || !ownerToken || checkpoint?.runId !== runId
        || checkpoint.schedulerRunOwnerToken !== ownerToken)
    {
        throw new Error('contract.scheduler-grant-identity-mismatch');
    }
    const activity = schedulerRunLockActivity({ runsRoot: path.dirname(path.dirname(checkpointFile)),
        runId, targetTierId: checkpoint.targetTierId, candidateIdentityDigest: checkpoint.schedulerCandidateIdentityDigest });
    if (activity.status !== 'active' || activity.owner?.ownerToken !== ownerToken)
    {
        throw new Error('contract.scheduler-grant-owner-inactive');
    }
    const document = checkpoint.resourceUtilization?.resourceGrants;
    validateSchedulerGrantDocument(document, runId, checkpoint);
    if (!Number.isInteger(document.generation) || document.generation < 1
        || !Number.isInteger(minimumGeneration) || minimumGeneration < 1 || document.generation < minimumGeneration
        || (expectedGeneration !== null && document.generation !== expectedGeneration)
        || !Number.isInteger(document.schedulerCheckpointRevision)
        || document.schedulerCheckpointRevision < 1 || document.schedulerCheckpointRevision > checkpoint.revision)
    {
        throw new Error('contract.scheduler-grant-generation-mismatch');
    }
    const projection = readSchedulerGrantProjection(path.join(path.dirname(checkpointFile), 'resource-grants.json'), runId);
    if (!isDeepStrictEqual(document, projection))
    {
        throw new Error('contract.scheduler-grant-projection-drift');
    }
    const grant = document.grants[tierId];
    const usage = Object.values(document.grants).reduce((total, value) => ({
        cpuUnits: total.cpuUnits + value.cpuUnits, memoryGiB: total.memoryGiB + value.memoryGiB
    }), { ...document.residentReservation });
    if (!grant || !Number.isInteger(grant.cpuUnits)
        || usage.cpuUnits > document.resourceBudget.cpuUnits
        || usage.memoryGiB > document.resourceBudget.memoryGiB + Number.EPSILON * 16)
    {
        throw new Error('contract.scheduler-grant-tier-or-envelope-invalid');
    }
    return { runId, tierId, ownerToken, generation: document.generation,
        schedulerCheckpointRevision: document.schedulerCheckpointRevision,
        grant: structuredClone(grant), resourceBudget: structuredClone(document.resourceBudget),
        checkpointDigest: canonical.checkpointDigest, grantReceiptDigest: fingerprint(document),
        qualificationEligible: false };
}

export function commitSchedulerCheckpointCAS({ checkpointFile, expectedRevision, expectedDigest, owner, update })
{
    if (projectionResumeTransactionState(checkpointFile))
    {
        throw new Error('contract.checkpoint-cas-projection-transaction-active');
    }
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
    const checkpoint = canonical?.checkpoint;
    if (!checkpoint || checkpoint.revision !== expectedRevision || canonical.checkpointDigest !== expectedDigest)
    {
        throw new Error('contract.checkpoint-cas-conflict: revision/digest');
    }
    const activity = schedulerRunLockActivity({ runsRoot: path.dirname(path.dirname(checkpointFile)),
        runId: checkpoint.runId, targetTierId: checkpoint.targetTierId,
        candidateIdentityDigest: checkpoint.schedulerCandidateIdentityDigest });
    if (activity.status !== 'active' || activity.owner?.ownerToken !== owner?.ownerToken
        || checkpoint.schedulerRunOwnerToken !== owner.ownerToken)
    {
        throw new Error('contract.checkpoint-cas-owner-mismatch');
    }
    const next = structuredClone(checkpoint);
    update(next);
    if (next.runId !== checkpoint.runId || next.revision !== checkpoint.revision
        || !sameCheckpointSource(next.sourceState, checkpoint.sourceState)
        || next.schedulerRunOwnerToken !== checkpoint.schedulerRunOwnerToken)
    {
        throw new Error('contract.checkpoint-cas-identity-drift');
    }
    writeCheckpoint(checkpointFile, next, { boundary: true, stage: 'correctness-terminal-commit',
        eventType: 'correctness-terminal-committed', tier: 'production-correctness', step: 'terminal-finalizer' });
    const committed = readCanonicalSchedulerCheckpoint(checkpointFile);
    if (committed?.checkpoint.revision !== expectedRevision + 1
        || committed.checkpointDigest !== next.contentDigest
        || !isDeepStrictEqual(committed.checkpoint, next))
    {
        throw new Error('contract.checkpoint-cas-readback-mismatch');
    }
    const after = schedulerRunLockActivity({ runsRoot: path.dirname(path.dirname(checkpointFile)),
        runId: next.runId, targetTierId: next.targetTierId,
        candidateIdentityDigest: next.schedulerCandidateIdentityDigest });
    if (after.status !== 'active' || after.owner?.ownerToken !== owner.ownerToken)
    {
        throw new Error('contract.checkpoint-cas-owner-drift');
    }
    return committed;
}

function resolveSchedulerResumeBinding({ checkpointFile, runId, targetTierId, namespace,
    sourceState, budgetPolicyDigest, expectedCandidateIdentityDigest, verifiedCandidateIdentity })
{
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(expectedCandidateIdentityDigest ?? '')))
    {
        throw new Error('contract.missing-resume-identity: explicit candidateIdentityDigest is required');
    }
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
    if (!canonical)
    {
        throw new Error(`contract.missing-resume-run: ${runId}`);
    }
    const checkpoint = canonical.checkpoint;
    const fields = { runId, targetTierId, namespace, sourceState, budgetPolicyDigest };
    for (const [field, expected] of Object.entries(fields))
    {
        if (!isDeepStrictEqual(checkpoint[field] ?? null, expected ?? null))
        {
            throw new Error(`contract.resume-identity-mismatch: ${field}`);
        }
    }
    const computed = schedulerCandidateIdentityDigest(fields);
    if (checkpoint.schedulerCandidateIdentityDigest !== computed
        || expectedCandidateIdentityDigest !== computed)
    {
        throw new Error('contract.resume-identity-mismatch: candidateIdentityDigest');
    }
    if (!verifiedCandidateIdentity)
    {
        throw new Error('contract.missing-resume-candidate-authority: full candidate owner validation is required');
    }
    if (verifiedCandidateIdentity)
    {
        for (const field of new Set([...Object.keys(verifiedCandidateIdentity),
            ...Object.keys(checkpoint.releaseCandidateIdentity ?? {})]))
        {
            if (!isDeepStrictEqual(checkpoint.releaseCandidateIdentity?.[field], verifiedCandidateIdentity[field]))
            {
                throw new Error(`contract.resume-identity-mismatch: releaseCandidateIdentity.${field}`);
            }
        }
    }
    return { schema: 'fsusblog.scheduler-explicit-resume.v1', selector: { kind: 'run-id', runId },
        candidateIdentityDigest: computed, canonicalCheckpointRef: canonical.compactStateRef,
        canonicalCheckpointDigest: canonical.checkpointDigest, lastSequence: canonical.lastSequence };
}

export async function runDag(options)
{
    const resume = options.resume === true || options.mode === 'resume';
    if (resume && !String(options.runId ?? '').trim())
    {
        throw new Error('contract.missing-resume-identity: explicit runId is required');
    }
    if (resume && (typeof options.runId !== 'string' || safeRunId(options.runId) !== options.runId
        || options.runId === '.' || options.runId === '..'))
    {
        throw new Error('contract.invalid-resume-identity: runId must name an exact run root');
    }
    if (options.reuseAcrossSourceChanges === true)
    {
        throw new Error('contract.cross-candidate-reuse-forbidden');
    }
    const root = path.resolve(options.root);
    const runsRoot = resolveRealOrAncestralPath(options.runsRoot ?? path.join(root, '.tmp/test-runs'));
    const runId = safeRunId(options.runId ?? createRunId(options.targetTierId ?? 'matrix'));
    const snapshotWorktree = options.snapshotWorktree ?? (() => snapshotGitWorktree(root));
    const runSourceSnapshot = await snapshotWorktree();
    const envCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const envFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    const sourceState = options.sourceState ?? {
        commit: envCommit || gitHead(root) || 'unversioned',
        worktreeFingerprint: envFingerprint || runSourceSnapshot.fingerprint || 'unbound'
    };
    const namespace = options.namespace ?? 'test-matrix';
    const targetTierId = options.targetTierId ?? options.tiers?.at(-1)?.id ?? 'matrix';
    const budgetPolicyDigest = options.budgetPolicyDigest ?? null;
    let verifiedCandidateIdentity = null;
    if (options.candidateIdentity !== undefined)
    {
        if (typeof options.verifyCandidateIdentity !== 'function')
        {
            throw new Error('contract.missing-candidate-identity-verifier');
        }
        verifiedCandidateIdentity = await options.verifyCandidateIdentity(structuredClone(options.candidateIdentity));
        for (const field of schedulerReleaseCandidateRequiredFields)
        {
            if (!Object.hasOwn(verifiedCandidateIdentity ?? {}, field))
            {
                throw new Error(`contract.missing-candidate-identity-field: ${field}`);
            }
        }
        if (!verifiedCandidateIdentity || !isDeepStrictEqual(verifiedCandidateIdentity, options.candidateIdentity)
            || verifiedCandidateIdentity.sourceCommit !== sourceState.commit
            || verifiedCandidateIdentity.worktreeFingerprint !== sourceState.worktreeFingerprint)
        {
            throw new Error('contract.candidate-identity-mismatch: source/verifier');
        }
    }
    const resumeBindingOptions = { checkpointFile: path.join(runsRoot, runId, 'checkpoint.json'),
        runId, targetTierId, namespace, sourceState, budgetPolicyDigest, verifiedCandidateIdentity,
        expectedCandidateIdentityDigest: options.resumeCandidateIdentityDigest
            ?? options.env?.FSUSBLOG_TEST_CANDIDATE_IDENTITY ?? process.env.FSUSBLOG_TEST_CANDIDATE_IDENTITY };
    if (!resume && options.tiers?.some((tier) => tier.id === 'production-correctness')
        && fs.existsSync(path.join(runsRoot, runId)))
    {
        throw new Error('contract.correctness-fresh-run-already-exists: preserve attempt history and use an independent run');
    }
    if (resume)
    {
        resolveSchedulerResumeBinding(resumeBindingOptions);
    }
    const releaseLock = acquireRunLock(runsRoot, runId, {
        sourceState,
        namespace,
        targetTierId,
        budgetPolicyDigest,
        beforeStaleLockDelete: options.beforeStaleLockDelete
    });
    const schedulerFinalizers = [];
    let schedulerOwnerTerminalState = 'failed';
    let schedulerFailure = null;
    let schedulerResult;
    const finalizationFailures = [];
    try
    {
        releaseLock.markRunning();
        const resumeInvocation = resume ? resolveSchedulerResumeBinding(resumeBindingOptions) : null;
        const result = await runDagUnlocked({
            ...options,
            root,
            runsRoot,
            runId,
            targetTierId,
            namespace,
            schedulerCandidateIdentityDigest: releaseLock.owner.candidateIdentityDigest,
            schedulerRunOwnerToken: releaseLock.owner.ownerToken,
            sourceState,
            runSourceSnapshot,
            verifiedCandidateIdentity,
            resumeInvocation,
            registerSchedulerFinalizer(finalizer)
            {
                schedulerFinalizers.push(finalizer);
            }
        });
        schedulerOwnerTerminalState = result.status === 'success' ? 'complete' : 'failed';
        schedulerResult = result;
    }
    catch (error)
    {
        schedulerFailure = { error };
        schedulerOwnerTerminalState = ['AbortError', 'CancellationError'].includes(error?.name)
            ? 'cancelled'
            : 'failed';
    }
    finally
    {
        releaseLock.markFinalizing();
        for (const finalizer of schedulerFinalizers.reverse())
        {
            try
            {
                await finalizer();
            }
            catch (error)
            {
                finalizationFailures.push(error);
            }
        }
        if (finalizationFailures.length > 0)
        {
            schedulerOwnerTerminalState = 'failed';
            if (schedulerFailure)
            {
                // Preserve the execution failure; cleanup failure is additional evidence, never a pass.
                try
                {
                    schedulerFailure.error.schedulerFinalizationFailures = finalizationFailures;
                }
                catch
                {
                    // A frozen or primitive original failure must not be replaced by an attachment error.
                }
            }
        }
        if (!schedulerFailure && finalizationFailures.length === 0
            && schedulerResult?.status === 'success' && schedulerResult.checkpoint?.correctnessAttempt)
        {
            try
            {
                const byId = new Map(options.tiers.map((tier) => [tier.id, tier]));
                const dependencies = new Set();
                const collect = (tierId) =>
                {
                    for (const dependencyId of tierSchedulerDependencies(byId.get(tierId)))
                    {
                        if (!dependencies.has(dependencyId))
                        {
                            if (!byId.has(dependencyId))
                            {
                                throw new Error(`contract.correctness-dependency-not-declared: ${dependencyId}`);
                            }
                            dependencies.add(dependencyId);
                            collect(dependencyId);
                        }
                    }
                };
                collect('production-correctness');
                const sealed = await finalizeSchedulerCorrectness({
                    checkpointFile: schedulerResult.checkpointPath, owner: releaseLock.owner,
                    readCanonical: readCanonicalSchedulerCheckpoint, commit: commitSchedulerCheckpointCAS,
                    requiredDependencyTierIds: [...dependencies].sort(),
                    loadProvisional: options.correctnessFinalization?.loadProvisional,
                    faultInjector: options.correctnessFinalization?.faultInjector,
                    async postflight(checkpoint, context)
                    {
                        await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree);
                        requireCleanAttemptConsumerAdmission({ consumerId: 'production-correctness', repositoryRoot: root,
                            candidateBinding: { sourceCommit: sourceState.commit,
                                worktreeFingerprint: `sha256:${String(sourceState.worktreeFingerprint).replace(/^sha256:/u, '')}`,
                                schedulerRunId: runId, buildIdentity: context.buildReceiptDigest } });
                        await options.correctnessFinalization?.postflight?.(checkpoint);
                    }
                });
                schedulerResult.checkpoint = sealed.checkpoint;
                schedulerResult.correctnessReceipt = sealed.receipt;
            }
            catch (error)
            {
                schedulerFailure = { error };
                schedulerOwnerTerminalState = 'failed';
            }
        }
        if (schedulerResult?.checkpoint?.correctnessAttempt
            && (schedulerFailure || finalizationFailures.length > 0 || schedulerResult.status !== 'success'))
        {
            try
            {
                const failed = readCanonicalSchedulerCheckpoint(schedulerResult.checkpointPath).checkpoint;
                failed.correctnessAttempt.status = 'rejected';
                if (failed.correctnessTerminalSeal)
                {
                    failed.correctnessTerminalSeal.status = 'rejected';
                }
                appendCheckpointFailure(failed, { tierId: 'production-correctness', exitCode: 1, signal: null,
                    reason: String(schedulerFailure?.error?.message ?? finalizationFailures[0]?.message
                        ?? schedulerResult.failure?.reason ?? 'correctness attempt failed'), changedPaths: [] });
                writeCheckpoint(schedulerResult.checkpointPath, failed, { boundary: true,
                    stage: 'correctness-attempt-rejected', eventType: 'correctness-attempt-rejected',
                    tier: 'production-correctness', step: 'terminal-finalizer' });
                schedulerResult.checkpoint = failed;
                schedulerResult.status = 'failure';
            }
            catch (persistenceError)
            {
                finalizationFailures.push(persistenceError);
                schedulerOwnerTerminalState = 'failed';
            }
        }
        releaseLock(schedulerOwnerTerminalState);
    }
    if (schedulerFailure)
    {
        throw schedulerFailure.error;
    }
    if (finalizationFailures.length > 0)
    {
        throw new AggregateError(finalizationFailures, 'scheduler finalization failed');
    }
    return schedulerResult;
}
