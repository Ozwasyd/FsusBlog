import crypto from 'node:crypto';

import { validateCurrentRunEvidenceContext } from '../test/evidence-location-contract.mjs';
import { assertPreRuntimeQualified } from '../test-matrix/behavior-evidence-pre-runtime.mjs';
import { validatePostRuntimeReceipt } from '../test-matrix/behavior-evidence-post-runtime.mjs';
import { authorityDigest } from '../test-matrix/post-runtime-producer-registry.mjs';
import { validateRequiredEvidenceCatalogBinding } from '../test-matrix/required-evidence-catalog.mjs';
import { validateFinalReport } from '../docs/behavior-document-consistency-final.mjs';
import { validateReleaseFinalTestEvidenceBinding } from './test-evidence-receipts.mjs';

export const releaseFinalTerminalAcceptanceSchema =
    'fsusblog.release-final-terminal-acceptance.v1';
export const releaseFinalBindingPath =
    '.tmp/release-evidence/release-final-test-evidence-binding.json';

const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort()
            .map((key) => [key, stable(value[key])]))
        : value;

function contentDigest(value)
{
    const unsigned = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'contentDigest')
    );
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(stable(unsigned))).digest('hex')}`;
}

function serializedFileDigest(value)
{
    return `sha256:${crypto.createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`).digest('hex')}`;
}

function same(left, right)
{
    return JSON.stringify(left) === JSON.stringify(right);
}

function inputReference(receipt, key)
{
    return {
        schema: receipt.schema,
        path: receipt.path,
        fileDigest: receipt.fileDigest,
        contentDigest: receipt.contentDigest,
        key
    };
}

export function validateReleaseFinalTerminalAcceptance(receipt, {
    binding,
    preRuntimeReceipt,
    postRuntimeReceipt,
    consistencyFinalReport,
    currentRunContext,
    canonicalInputs
} = {})
{
    const errors = [];
    let context;
    try
    {
        context = validateCurrentRunEvidenceContext(currentRunContext);
        assertPreRuntimeQualified(preRuntimeReceipt);
        validatePostRuntimeReceipt(postRuntimeReceipt);
        validateFinalReport(consistencyFinalReport);
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
        return errors;
    }
    errors.push(...validateReleaseFinalTestEvidenceBinding(binding));
    errors.push(...validateRequiredEvidenceCatalogBinding(
        binding?.requiredEvidenceCatalog
    ));
    if (receipt?.schema !== releaseFinalTerminalAcceptanceSchema)
    {
        errors.push('release-final terminal acceptance schema mismatch');
    }
    if (receipt?.contentDigest !== contentDigest(receipt ?? {}))
    {
        errors.push('release-final terminal acceptance contentDigest mismatch');
    }
    if (receipt?.status !== 'ok'
        || !same(receipt?.warnings, [])
        || !same(receipt?.failureReasons, []))
    {
        errors.push('release-final terminal acceptance must be ok with warnings=0');
    }
    if (context.sourceCommit !== binding?.sourceState?.commit
        || context.worktreeFingerprint.replace(/^sha256:/u, '')
            !== binding?.sourceState?.worktreeFingerprint.replace(/^sha256:/u, '')
        || receipt?.sourceIdentity?.commit !== context.sourceCommit
        || receipt?.sourceIdentity?.worktreeFingerprint
            !== context.worktreeFingerprint)
    {
        errors.push('release-final terminal source/worktree identity mismatch');
    }
    if (receipt?.runIdentity?.schedulerRunId !== context.schedulerRunId
        || receipt?.runIdentity?.attemptId !== context.attemptId
        || postRuntimeReceipt?.runIdentity !== context.schedulerRunId
        || postRuntimeReceipt?.executionIdentity?.attemptId !== context.attemptId)
    {
        errors.push('release-final terminal run/attempt identity mismatch');
    }
    const requiredAuthorities = binding?.requiredEvidenceCatalog?.authorityIds ?? [];
    if (!same(receipt?.dag?.requiresEvidenceFrom, canonicalInputs)
        || !same(requiredAuthorities, canonicalInputs)
        || receipt?.dag?.requiredAuthorityCatalogDigest
            !== binding?.requiredEvidenceCatalog?.contentDigest
        || receipt?.dag?.authoritySetDigest !== authorityDigest(canonicalInputs))
    {
        errors.push('release-final terminal DAG authority binding mismatch');
    }
    const expectedInputs = {
        preRuntime: inputReference(binding.receipts.behaviorPreRuntime,
            'behavior-evidence-pre-runtime'),
        postRuntime: inputReference(binding.receipts.behaviorPostRuntime,
            'behavior-evidence-post-runtime'),
        consistencyFinal: inputReference(binding.receipts.behaviorConsistencyFinal,
            'behavior-document-consistency-final'),
        finalizer: {
            schema: binding.schema,
            path: releaseFinalBindingPath,
            fileDigest: serializedFileDigest(binding),
            contentDigest: binding.contentDigest,
            key: 'release-final'
        }
    };
    if (!same(receipt?.inputs, expectedInputs)
        || consistencyFinalReport?.receiptDigests?.preRuntime
            !== preRuntimeReceipt.contentDigest
        || consistencyFinalReport?.receiptDigests?.postRuntime
            !== postRuntimeReceipt.contentDigest)
    {
        errors.push('release-final terminal input binding mismatch');
    }
    if (receipt?.spawnCounts?.runtimeCandidateBeforePreRuntime !== 0
        || receipt?.spawnCounts?.releaseFinalBeforePostRuntime !== 0
        || preRuntimeReceipt.runtimeCandidateSpawnCountBeforeReceipt !== 0
        || postRuntimeReceipt.releaseFinalSpawnCountBeforeReceipt !== 0
        || consistencyFinalReport?.spawnBeforeReceipt?.runtimeCandidate !== 0
        || consistencyFinalReport?.spawnBeforeReceipt?.releaseFinal !== 0)
    {
        errors.push('release-final terminal spawn counts must all be zero');
    }
    const mutationEntries = Object.values(preRuntimeReceipt.mutationStatus ?? {});
    const mutationFailures = mutationEntries.flatMap((entry) => entry.failures ?? []);
    const expectedMutation = {
        receiptDigest: preRuntimeReceipt.contentDigest,
        evidenceDigest: preRuntimeReceipt.mutationEvidenceDigest,
        resultDigest: authorityDigest(preRuntimeReceipt.mutationStatus ?? {}),
        behaviorCount: mutationEntries.length,
        qualifiedCount: mutationEntries.filter((entry) =>
            entry.qualified === true).length,
        failureCount: mutationFailures.length,
        status: mutationEntries.every((entry) => entry.qualified === true)
            && mutationFailures.length === 0 ? 'ok' : 'failed'
    };
    if (!same(receipt?.mutationResults, expectedMutation)
        || expectedMutation.status !== 'ok')
    {
        errors.push('release-final terminal mutation result is not qualified');
    }
    const scan = consistencyFinalReport?.zeroLegacyScan;
    const expectedScanner = {
        reportDigest: consistencyFinalReport.contentDigest,
        resultDigest: authorityDigest(scan),
        scannedFileCount: scan?.scannedFileCount,
        findingCount: scan?.findings?.length,
        dagStronglyConnectedComponentCount:
            consistencyFinalReport?.dagAudit?.stronglyConnectedComponents?.length,
        duplicateAuthorityCount:
            consistencyFinalReport?.dagAudit?.authorityDuplicates?.length,
        status: scan?.findings?.length === 0
            && consistencyFinalReport?.dagAudit?.stronglyConnectedComponents?.length === 0
            && consistencyFinalReport?.dagAudit?.authorityDuplicates?.length === 0
            ? 'ok' : 'failed'
    };
    if (!same(receipt?.scannerResults, expectedScanner)
        || expectedScanner.status !== 'ok')
    {
        errors.push('release-final terminal scanner result is not qualified');
    }
    const expectedIdentities = {
        catalogDigest: preRuntimeReceipt.catalogDigest,
        claimDigest: preRuntimeReceipt.staticClaimVerificationDigest,
        candidateIdentity: structuredClone(postRuntimeReceipt.candidateIdentity),
        candidateIdentityDigest: authorityDigest(postRuntimeReceipt.candidateIdentity),
        executionIdentity: structuredClone(postRuntimeReceipt.executionIdentity),
        contextCandidateIdentity: structuredClone(context.candidateIdentity),
        contextCandidateIdentityDigest: authorityDigest(context.candidateIdentity),
        contextBuildIdentity: structuredClone(context.buildIdentity),
        contextBuildIdentityDigest: authorityDigest(context.buildIdentity),
        finalizerBindingDigest: binding.contentDigest
    };
    if (!same(receipt?.identities, expectedIdentities)
        || postRuntimeReceipt.executionIdentity?.candidateIdentityDigest
            !== authorityDigest(context.candidateIdentity)
        || postRuntimeReceipt.executionIdentity?.buildIdentityDigest
            !== authorityDigest(context.buildIdentity)
        || postRuntimeReceipt.catalogDigest !== preRuntimeReceipt.catalogDigest
        || postRuntimeReceipt.staticClaimVerificationDigest
            !== `sha256:${preRuntimeReceipt.staticClaimVerificationDigest.replace(/^sha256:/u, '')}`)
    {
        errors.push('release-final terminal candidate/build/catalog/claim identity mismatch');
    }
    return [...new Set(errors)];
}

export function createReleaseFinalTerminalAcceptance(options)
{
    const {
        binding,
        preRuntimeReceipt,
        postRuntimeReceipt,
        consistencyFinalReport,
        currentRunContext,
        canonicalInputs
    } = options;
    const context = validateCurrentRunEvidenceContext(currentRunContext);
    const mutationEntries = Object.values(preRuntimeReceipt.mutationStatus ?? {});
    const mutationFailures = mutationEntries.flatMap((entry) => entry.failures ?? []);
    const scan = consistencyFinalReport.zeroLegacyScan;
    const receipt = {
        schema: releaseFinalTerminalAcceptanceSchema,
        sourceIdentity: {
            commit: context.sourceCommit,
            worktreeFingerprint: context.worktreeFingerprint
        },
        runIdentity: {
            schedulerRunId: context.schedulerRunId,
            attemptId: context.attemptId
        },
        dag: {
            finalizerTierId: 'release-final',
            requiresEvidenceFrom: [...canonicalInputs],
            requiredAuthorityCatalogDigest:
                binding.requiredEvidenceCatalog.contentDigest,
            authoritySetDigest: authorityDigest(canonicalInputs)
        },
        inputs: {
            preRuntime: inputReference(binding.receipts.behaviorPreRuntime,
                'behavior-evidence-pre-runtime'),
            postRuntime: inputReference(binding.receipts.behaviorPostRuntime,
                'behavior-evidence-post-runtime'),
            consistencyFinal: inputReference(binding.receipts.behaviorConsistencyFinal,
                'behavior-document-consistency-final'),
            finalizer: {
                schema: binding.schema,
                path: releaseFinalBindingPath,
                fileDigest: serializedFileDigest(binding),
                contentDigest: binding.contentDigest,
                key: 'release-final'
            }
        },
        identities: {
            catalogDigest: preRuntimeReceipt.catalogDigest,
            claimDigest: preRuntimeReceipt.staticClaimVerificationDigest,
            candidateIdentity: structuredClone(postRuntimeReceipt.candidateIdentity),
            candidateIdentityDigest: authorityDigest(postRuntimeReceipt.candidateIdentity),
            executionIdentity: structuredClone(postRuntimeReceipt.executionIdentity),
            contextCandidateIdentity: structuredClone(context.candidateIdentity),
            contextCandidateIdentityDigest: authorityDigest(context.candidateIdentity),
            contextBuildIdentity: structuredClone(context.buildIdentity),
            contextBuildIdentityDigest: authorityDigest(context.buildIdentity),
            finalizerBindingDigest: binding.contentDigest
        },
        spawnCounts: {
            runtimeCandidateBeforePreRuntime:
                preRuntimeReceipt.runtimeCandidateSpawnCountBeforeReceipt,
            releaseFinalBeforePostRuntime:
                postRuntimeReceipt.releaseFinalSpawnCountBeforeReceipt
        },
        scannerResults: {
            reportDigest: consistencyFinalReport.contentDigest,
            resultDigest: authorityDigest(scan),
            scannedFileCount: scan.scannedFileCount,
            findingCount: scan.findings.length,
            dagStronglyConnectedComponentCount:
                consistencyFinalReport.dagAudit.stronglyConnectedComponents.length,
            duplicateAuthorityCount:
                consistencyFinalReport.dagAudit.authorityDuplicates.length,
            status: 'ok'
        },
        mutationResults: {
            receiptDigest: preRuntimeReceipt.contentDigest,
            evidenceDigest: preRuntimeReceipt.mutationEvidenceDigest,
            resultDigest: authorityDigest(preRuntimeReceipt.mutationStatus ?? {}),
            behaviorCount: mutationEntries.length,
            qualifiedCount: mutationEntries.filter((entry) =>
                entry.qualified === true).length,
            failureCount: mutationFailures.length,
            status: 'ok'
        },
        warnings: [],
        status: 'ok',
        failureReasons: [],
        contentDigest: null
    };
    receipt.contentDigest = contentDigest(receipt);
    const errors = validateReleaseFinalTerminalAcceptance(receipt, options);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    return receipt;
}
