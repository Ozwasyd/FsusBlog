import path from 'node:path';
import process from 'node:process';

const {readEvidenceDocument} = await import(new URL('../test-matrix/content-addressed-evidence-store.mjs', import.meta.url));
const {collectReleaseFinalDomainProjectionReceipts, releaseFinalDomainProjectionTierIds} = await import(new URL('../test-matrix/release-domain-evidence.mjs', import.meta.url));
const {loadCanonicalReleaseFinalEvidenceInputs} = await import(new URL('../test-matrix/release-final-evidence-contract.mjs', import.meta.url));
const {validatePostRuntimeReceipt} = await import(new URL('../test-matrix/behavior-evidence-post-runtime.mjs', import.meta.url));
const {validateFinalReport} = await import(new URL('../docs/behavior-document-consistency-final.mjs', import.meta.url));
import { requirePublicPreviewReleaseEvidence } from './public-preview-release-evidence.mjs';
import {
    locateReleaseReliabilityQualifiedReceipt
} from './release-reliability-qualified-receipt.mjs';
import { createReleaseFinalTestEvidenceBinding } from './test-evidence-receipts.mjs';

export function createReleaseFinalDomainEvidence({
    directEvidence,
    locatorEvidence,
    manifest,
    repositoryRoot,
    sha256Hex
})
{
    const postRuntimeFile = directEvidence.behaviorPostRuntime.file;
    const postRuntimeReceipt = directEvidence.behaviorPostRuntime.receipt;
    validatePostRuntimeReceipt(postRuntimeReceipt);
    if (postRuntimeReceipt.status !== 'ok')
    {
        throw new Error(`post-runtime behavior evidence is not qualified: ${postRuntimeReceipt.failureReasons.join('; ')}`);
    }
    if (postRuntimeReceipt.sourceIdentity?.commit !== manifest.commitSha)
    {
        throw new Error('post-runtime behavior evidence source commit mismatch');
    }
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
    if (postRuntimeReceipt.candidateIdentity?.browserContractDigest
        !== browserContract.receipt.contentDigest)
    {
        throw new Error('post-runtime behavior evidence browser candidate mismatch');
    }

    const publicPreview = requirePublicPreviewReleaseEvidence({
        commitSha: manifest.commitSha,
        browserContractReceipt: browserContract.receipt,
        evidence: directEvidence.publicPreview,
        sha256Hex
    });

    const build = directEvidence.productionBuild;
    if (postRuntimeReceipt.candidateIdentity?.buildReceiptDigest
        !== build.receipt.contentDigest)
    {
        throw new Error('post-runtime behavior evidence build candidate mismatch');
    }
    const canonicalInputs = loadCanonicalReleaseFinalEvidenceInputs().inputs;
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
            postRuntimeReceipt,
            postRuntimeReceiptPath: postRuntimeFile,
            consistencyFinalReport,
            consistencyFinalReportPath: consistencyFinalFile,
            releaseDomainProjectionReceipts,
            releaseReliabilityQualifiedReceipt,
            locatorEvidence
        }),
        publicPreview
    };
}
