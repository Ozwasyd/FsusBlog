import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';

import { readEvidenceDocument } from '../test-matrix/content-addressed-evidence-store.mjs';
import {
    collectReleaseFinalDomainProjectionReceipts,
    releaseFinalDomainProjectionTierIds
} from '../test-matrix/release-domain-evidence.mjs';
import {
    loadCanonicalReleaseFinalEvidenceInputs
} from '../test-matrix/release-final-evidence-contract.mjs';
import {
    validatePostRuntimeReceipt
} from '../test-matrix/behavior-evidence-post-runtime.mjs';

import { requirePublicPreviewReleaseEvidence } from './public-preview-release-evidence.mjs';
import {
    locateReleaseReliabilityQualifiedReceipt
} from './release-reliability-qualified-receipt.mjs';
import { createReleaseFinalTestEvidenceBinding } from './test-evidence-receipts.mjs';

export function createReleaseFinalDomainEvidence({
    manifest,
    repositoryRoot,
    findReceiptFile,
    sha256Hex
})
{
    const postRuntimeFile = path.resolve(
        repositoryRoot,
        process.env.FSUSBLOG_BEHAVIOR_POST_RUNTIME_RECEIPT
            ?? '.tmp/behavior-evidence-post-runtime/receipt.json'
    );
    if (!fs.existsSync(postRuntimeFile) || !fs.statSync(postRuntimeFile).isFile())
    {
        throw new Error('post-runtime behavior evidence receipt is required at its exact configured path');
    }
    const postRuntimeReceipt = readEvidenceDocument(postRuntimeFile);
    validatePostRuntimeReceipt(postRuntimeReceipt);
    if (postRuntimeReceipt.status !== 'ok')
    {
        throw new Error(`post-runtime behavior evidence is not qualified: ${postRuntimeReceipt.failureReasons.join('; ')}`);
    }
    if (postRuntimeReceipt.sourceIdentity?.commit !== manifest.commitSha)
    {
        throw new Error('post-runtime behavior evidence source commit mismatch');
    }

    const correctness = findReceiptFile(
        'fsusblog.browserless-correctness-receipt.v1',
        [
            process.env.FSUSBLOG_CORRECTNESS_RECEIPT,
            '.tmp/release-evidence/browserless-correctness-receipt.json'
        ],
        manifest.commitSha
    );
    if (!correctness)
    {
        throw new Error('browserless correctness receipt is required');
    }

    const browserContract = findReceiptFile(
        'fsusblog.browser-contract-receipt.v2',
        [
            process.env.FSUSBLOG_BROWSER_CONTRACT_RECEIPT,
            '.tmp/browser-contract/receipt.json'
        ],
        manifest.commitSha,
        { requireExactOne: true }
    );
    if (!browserContract)
    {
        throw new Error(
            'Browser Contract receipt is required; release-final fails closed without it'
        );
    }
    if (postRuntimeReceipt.candidateIdentity?.browserContractDigest
        !== browserContract.receipt.contentDigest)
    {
        throw new Error('post-runtime behavior evidence browser candidate mismatch');
    }

    const publicPreview = requirePublicPreviewReleaseEvidence({
        commitSha: manifest.commitSha,
        browserContractReceipt: browserContract.receipt,
        findReceiptFile,
        sha256Hex
    });

    const build = findReceiptFile(
        'fsusblog.ci-production-build-receipt.v1',
        [
            process.env.FSUSBLOG_PRODUCTION_BUILD_RECEIPT,
            correctness.receipt.build?.receipt,
            browserContract.receipt.buildBinding?.receipt,
            '.tmp/ci-production-build/receipt.json'
        ],
        manifest.commitSha
    );
    if (!build)
    {
        throw new Error('immutable #1078 production build receipt is required');
    }
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
            releaseDomainProjectionReceipts,
            releaseReliabilityQualifiedReceipt
        }),
        publicPreview
    };
}
