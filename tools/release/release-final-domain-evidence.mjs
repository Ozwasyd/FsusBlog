import path from 'node:path';
import process from 'node:process';

import { readEvidenceDocument } from '../test-matrix/content-addressed-evidence-store.mjs';
import {
    collectReleaseFinalDomainProjectionReceipts,
    releaseFinalDomainProjectionTierIds
} from '../test-matrix/release-domain-evidence.mjs';
import {
    loadCanonicalReleaseFinalEvidenceInputs
} from '../test-matrix/release-final-evidence-contract.mjs';
import {
    validatePostRuntimeReceipt,
    verifyBehaviorEvidencePostRuntime
} from '../test-matrix/behavior-evidence-post-runtime.mjs';
import * as schedulerAuthority from '../test-matrix/scheduler.mjs';
import { authorityDigest } from '../test-matrix/post-runtime-producer-registry.mjs';
import { validateCurrentRunEvidenceContext } from '../test/evidence-location-contract.mjs';
import {
    assertPreRuntimeQualified
} from '../test-matrix/behavior-evidence-pre-runtime.mjs';
import {
    createRequiredEvidenceCatalogBinding,
    loadCanonicalRequiredEvidenceCatalog
} from '../test-matrix/required-evidence-catalog.mjs';
import {
    validateFinalReport
} from '../docs/behavior-document-consistency-final.mjs';

import { requirePublicPreviewReleaseEvidence } from './public-preview-release-evidence.mjs';
import {
    locateReleaseReliabilityQualifiedReceipt
} from './release-reliability-qualified-receipt.mjs';
import {
    assertReleaseFinalBehaviorIdentity,
    createReleaseFinalTestEvidenceBinding,
    validateBrowserContractReceipt
} from './test-evidence-receipts.mjs';

export function assertReleaseFinalPostRuntimeCandidate({
    postRuntimeReceipt: post, currentRunContext, browserContractReceipt, buildReceipt
})
{
    const context = validateCurrentRunEvidenceContext(currentRunContext);
    const expected = {
        commit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        candidateIdentityDigest: authorityDigest(context.candidateIdentity),
        buildIdentityDigest: authorityDigest(context.buildIdentity)
    };
    for (const [key, value] of Object.entries(expected))
    {
        if (post.executionIdentity?.[key] !== value)
        {
            throw new Error(`post-runtime execution identity mismatch: ${key}`);
        }
    }
    const errors = validateBrowserContractReceipt(browserContractReceipt, {
        expectedCommit: context.sourceCommit,
        expectedFingerprint: context.worktreeFingerprint,
        expectedBuildReceiptDigest: buildReceipt.contentDigest,
        requireSuccess: true
    });
    if (browserContractReceipt.runIdentity?.runId !== context.schedulerRunId)
    {
        errors.push('post-runtime browser contract run identity mismatch');
    }
    if (errors.length > 0) throw new Error(errors.join('; '));
}

export function verifyReleaseFinalPostRuntimeAuthority({
    directEvidence, currentRunContext, repositoryRoot,
    environment = process.env
})
{
    const context = validateCurrentRunEvidenceContext(currentRunContext);
    const input = directEvidence.behaviorPostRuntime;
    const post = validatePostRuntimeReceipt(input.receipt, { repositoryRoot });
    const schedulerVerificationContext = schedulerAuthority.readSchedulerVerificationContext({
        root: repositoryRoot,
        runsRoot: path.join(repositoryRoot, '.tmp/test-runs'),
        file: environment.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT,
        expectedContentDigest: environment.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST,
        expectedCandidateIdentityDigest: environment.FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST,
        expectedRunId: context.schedulerRunId,
        expectedSourceState: {
            commit: context.sourceCommit,
            worktreeFingerprint: context.worktreeFingerprint.replace(/^sha256:/u, '')
        }
    });
    const verified = verifyBehaviorEvidencePostRuntime({
        receipt: input.file,
        preRuntimeReceipt: directEvidence.behaviorPreRuntime.file,
        catalog: 'config/contracts/behavior-contracts.json',
        registry: 'config/testing/post-runtime-producer-registry.json',
        observationReceipts: post.observationRefs.map((reference) => reference.ref),
        acceptedClaimsReceipts: post.acceptedClaimRefs.map((reference) => reference.ref),
        executionContext: post.executionContext.ref,
        schedulerEvidence: post.schedulerEvidence.ref,
        verificationMode: 'completed-tier',
        schedulerVerificationContext,
        repositoryRoot
    });
    if (verified.contentDigest !== post.contentDigest)
    {
        throw new Error('post-runtime replay differs from located receipt');
    }
    assertReleaseFinalPostRuntimeCandidate({
        postRuntimeReceipt: verified, currentRunContext: context,
        browserContractReceipt: directEvidence.browserContract.receipt,
        buildReceipt: directEvidence.productionBuild.receipt
    });
    return verified;
}

export function assertReleaseFinalBehaviorAuthorityBinding({
    preRuntimeReceipt,
    postRuntimeReceipt,
    releaseCommit
})
{
    const pre = assertPreRuntimeQualified(preRuntimeReceipt);
    const post = validatePostRuntimeReceipt(postRuntimeReceipt);
    if (post.status !== 'ok')
    {
        throw new Error(
            `post-runtime behavior evidence is not qualified: ${post.failureReasons.join('; ')}`
        );
    }
    assertReleaseFinalBehaviorIdentity({ preRuntimeReceipt: pre, postRuntimeReceipt: post, releaseCommit });
    return { preRuntimeReceipt: pre, postRuntimeReceipt: post };
}

export function createReleaseFinalDomainEvidence({
    directEvidence,
    currentRunContext,
    locatorEvidence,
    manifest,
    repositoryRoot,
    sha256Hex
})
{
    const preRuntimeFile = directEvidence.behaviorPreRuntime.file;
    const preRuntimeReceipt = directEvidence.behaviorPreRuntime.receipt;
    const postRuntimeFile = directEvidence.behaviorPostRuntime.file;
    const postRuntimeReceipt = verifyReleaseFinalPostRuntimeAuthority({
        directEvidence, currentRunContext, repositoryRoot
    });
    const behaviorEvidence = assertReleaseFinalBehaviorAuthorityBinding({
        preRuntimeReceipt,
        postRuntimeReceipt,
        releaseCommit: manifest.commitSha
    });
    const consistencyFinalFile = directEvidence.behaviorConsistency.file;
    const consistencyFinalReport = directEvidence.behaviorConsistency.receipt;
    validateFinalReport(consistencyFinalReport);
    if (consistencyFinalReport.status !== 'ok'
        || consistencyFinalReport.sourceIdentity?.commit !== manifest.commitSha
        || consistencyFinalReport.receiptDigests?.postRuntime !== postRuntimeReceipt.contentDigest)
    {
        throw new Error('behavior/document final consistency report identity or qualification mismatch');
    }

    const correctness = directEvidence.browserlessCorrectness;

    const browserContract = directEvidence.browserContract;

    const publicPreview = requirePublicPreviewReleaseEvidence({
        commitSha: manifest.commitSha,
        browserContractReceipt: browserContract.receipt,
        evidence: directEvidence.publicPreview,
        sha256Hex
    });

    const build = directEvidence.productionBuild;
    const canonicalInputs = loadCanonicalReleaseFinalEvidenceInputs().inputs;
    const requiredEvidenceCatalog = loadCanonicalRequiredEvidenceCatalog();
    const requiredEvidenceCatalogBinding =
        createRequiredEvidenceCatalogBinding(requiredEvidenceCatalog);
    const releaseDomainLedger = readEvidenceDocument(path.join(
        repositoryRoot,
        'config/testing/release-domain-assertion-dispositions.json'
    ));
    const releaseDomainTierIdSet = new Set(
        releaseDomainLedger.entries.map((entry) => entry.tierId)
    );
    const releaseDomainTierIds = canonicalInputs
        .filter((tierId) => releaseDomainTierIdSet.has(tierId));
    if (JSON.stringify(releaseDomainTierIds)
        !== JSON.stringify(releaseFinalDomainProjectionTierIds))
    {
        throw new Error(
            'canonical release-final inputs and release-domain projection contract disagree'
        );
    }
    const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim();
    if (!runId || !namespace)
    {
        throw new Error(
            'release-final projection consumption requires FSUSBLOG_TEST_RUN_ID and FSUSBLOG_TEST_NAMESPACE'
        );
    }
    const releaseDomainProjectionReceipts =
        collectReleaseFinalDomainProjectionReceipts({
            repositoryRoot,
            expectedTierIds: releaseFinalDomainProjectionTierIds,
            sourceState: build.receipt.sourceState,
            runId,
            namespace
        });
    const releaseReliabilityQualifiedReceipt =
        locateReleaseReliabilityQualifiedReceipt({
            repositoryRoot,
            expectedCommit: manifest.commitSha,
            expectedWorktreeFingerprint:
                build.receipt.sourceState?.worktreeFingerprint,
            expectedBuildReceiptContentDigest: build.receipt.contentDigest,
            expectedImageDigest: manifest.imageDigest
        });

    return {
        binding: createReleaseFinalTestEvidenceBinding({
            commitSha: manifest.commitSha,
            buildReceipt: build.receipt,
            buildReceiptPath: path.relative(repositoryRoot, build.file),
            correctnessReceipt: correctness.receipt,
            correctnessReceiptPath: correctness.file,
            browserContractReceipt: browserContract.receipt,
            browserContractReceiptPath: browserContract.file,
            preRuntimeReceipt: behaviorEvidence.preRuntimeReceipt,
            preRuntimeReceiptPath: preRuntimeFile,
            postRuntimeReceipt: behaviorEvidence.postRuntimeReceipt,
            postRuntimeReceiptPath: postRuntimeFile,
            consistencyFinalReport,
            consistencyFinalReportPath: consistencyFinalFile,
            releaseDomainProjectionReceipts,
            releaseReliabilityQualifiedReceipt,
            requiredEvidenceCatalogBinding,
            locatorEvidence
        }),
        publicPreview
    };
}
