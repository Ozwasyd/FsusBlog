import fs from 'node:fs';
import path from 'node:path';

import { projectionContentDigest } from './evidence-projection.mjs';
import {
    releaseFinalDomainProjectionTierIds,
    releasePolicyIdentity,
    safeRelativePath,
    sha256File,
    sortedUnique,
    validateCatalogAgainstLedger,
    validateDispositionLedger
} from './release-domain-ledger.mjs';

export function validateReleaseDomainProjectionReceipt({
    receipt,
    catalog,
    ledger,
    sourceState,
    runId,
    namespace,
    policyIdentity
})
{
    const entries = validateCatalogAgainstLedger(catalog, ledger);
    const expectedSource = {
        commit: String(sourceState?.commit ?? ''),
        worktreeFingerprint: String(sourceState?.worktreeFingerprint ?? '')
            .replace(/^sha256:/u, '')
    };
    if (receipt?.schema !== 'fsusblog.evidence-projection-receipt.v1'
        || receipt.contentDigest !== projectionContentDigest(receipt)
        || receipt.status !== 'success'
        || receipt.executionMode !== 'projection')
    {
        throw new Error(
            `${catalog.tierId} projection receipt schema, status, mode, or digest is invalid`
        );
    }
    if (receipt.tierId !== catalog.tierId
        || receipt.executionOwner !== catalog.executionOwner
        || receipt.projectFrom !== catalog.projectFrom
        || JSON.stringify(receipt.sourceState) !== JSON.stringify(expectedSource)
        || receipt.runId !== runId
        || receipt.namespace !== namespace
        || receipt.policyIdentity !== policyIdentity
        || !/^sha256:[a-f0-9]{64}$/u.test(String(receipt.buildIdentity ?? '')))
    {
        throw new Error(
            `${catalog.tierId} projection receipt producer or source/run/build/policy identity mismatch`
        );
    }
    const expectedAssertions = entries.map((entry) => ({
        id: entry.requiredTestId,
        outcome: 'Passed',
        sourceTestIds: entry.sourceTestIds,
        coverageIds: catalog.requiredCoverageIds,
        artifactIds: entry.requiredArtifactIds
    })).sort((left, right) => left.id.localeCompare(right.id));
    const expectedArtifacts = catalog.requiredArtifactDeclarations;
    if (JSON.stringify(receipt.testIds) !== JSON.stringify(catalog.requiredTestIds)
        || JSON.stringify(receipt.coverageIds) !== JSON.stringify(catalog.requiredCoverageIds)
        || JSON.stringify(receipt.assertions) !== JSON.stringify(expectedAssertions)
        || receipt.assertions?.some((assertion) => assertion?.outcome !== 'Passed'))
    {
        throw new Error(
            `${catalog.tierId} projection receipt required IDs or outcomes do not exactly match`
        );
    }
    const artifactDeclarations = receipt.artifacts?.map(({ id, path: artifactPath }) => ({
        id,
        path: artifactPath
    })) ?? [];
    const buildIdentityArtifacts = Array.isArray(receipt.artifacts)
        ? receipt.artifacts.filter((artifact) =>
            artifact?.id === catalog.buildIdentityArtifactId)
        : [];
    if (!Array.isArray(receipt.artifacts)
        || JSON.stringify(artifactDeclarations) !== JSON.stringify(expectedArtifacts)
        || receipt.artifacts.some((artifact) =>
            !/^sha256:[a-f0-9]{64}$/u.test(String(artifact?.digest ?? ''))))
    {
        throw new Error(
            `${catalog.tierId} projection receipt artifact declarations or digests do not exactly match`
        );
    }
    if (buildIdentityArtifacts.length !== 1
        || buildIdentityArtifacts[0].digest !== receipt.buildIdentity)
    {
        throw new Error(
            `${catalog.tierId} projection receipt build identity does not match its declared artifact`
        );
    }
    if (receipt.producer?.schema !== 'fsusblog.evidence-producer-receipt.v1'
        || receipt.producer.producerId !== catalog.projectFrom
        || !safeRelativePath(receipt.producer.receipt, `${catalog.tierId}.producer.receipt`)
        || !/^sha256:[a-f0-9]{64}$/u.test(
            String(receipt.producer.receiptContentDigest ?? '')
        )
        || !safeRelativePath(
            receipt.producer.assertionReport?.path,
            `${catalog.tierId}.producer.assertionReport.path`
        )
        || !/^sha256:[a-f0-9]{64}$/u.test(
            String(receipt.producer.assertionReport?.digest ?? '')
        ))
    {
        throw new Error(`${catalog.tierId} projection receipt producer binding is invalid`);
    }
    const expectedBoundary = {
        childProcessCount: 0,
        dotnetTestLaunchCount: 0,
        vitestLaunchCount: 0,
        playwrightLaunchCount: 0,
        runtimeProbeLaunchCount: 0
    };
    if (JSON.stringify(receipt.executionBoundary) !== JSON.stringify(expectedBoundary))
    {
        throw new Error(
            `${catalog.tierId} projection receipt execution boundary is not zero-spawn`
        );
    }
    return receipt;
}

function visitProjectionReceipts(directory, files)
{
    if (!fs.existsSync(directory))
    {
        return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            visitProjectionReceipts(candidate, files);
        }
        else if (entry.isFile() && entry.name.endsWith('.json'))
        {
            files.push(candidate);
        }
    }
}

export function collectReleaseFinalDomainProjectionReceipts({
    repositoryRoot,
    expectedTierIds,
    sourceState,
    runId,
    namespace,
    ledgerPath = 'config/testing/release-domain-assertion-dispositions.json',
    catalogDirectory = 'tests/fixtures/evidence-projection',
    projectionDirectory = '.tmp/release-evidence/projections'
})
{
    const root = path.resolve(repositoryRoot);
    sortedUnique(expectedTierIds, 'release-final projection tier IDs');
    if (JSON.stringify(expectedTierIds)
        !== JSON.stringify(releaseFinalDomainProjectionTierIds))
    {
        throw new Error(
            'release-final projection tier IDs do not exactly match the canonical release-domain set'
        );
    }
    const absoluteLedger = path.resolve(root, ledgerPath);
    const ledger = JSON.parse(fs.readFileSync(absoluteLedger, 'utf8'));
    const ledgerEntries = validateDispositionLedger(ledger);
    const ledgerTierIds = new Set(ledgerEntries.map((entry) => entry.tierId));
    if (expectedTierIds.some((tierId) => !ledgerTierIds.has(tierId)))
    {
        throw new Error('release-final projection inputs include a non-release-domain tier');
    }
    const policyIdentity = releasePolicyIdentity(absoluteLedger);
    const files = [];
    visitProjectionReceipts(path.resolve(root, projectionDirectory), files);
    const documents = files.flatMap((file) =>
    {
        try
        {
            const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
            return receipt?.schema === 'fsusblog.evidence-projection-receipt.v1'
                ? [{ file, receipt }]
                : [];
        }
        catch
        {
            return [];
        }
    });
    return expectedTierIds.map((tierId) =>
    {
        const entries = ledgerEntries.filter((entry) => entry.tierId === tierId);
        const outputPaths =
            [...new Set(entries.map((entry) => entry.outputReceiptPath))];
        const matches = documents.filter(({ receipt }) => receipt.tierId === tierId);
        if (outputPaths.length !== 1 || matches.length !== 1)
        {
            throw new Error(
                `${tierId} requires exactly one projection receipt, found ${matches.length}`
            );
        }
        const relativePath =
            path.relative(root, matches[0].file).replaceAll(path.sep, '/');
        if (relativePath !== outputPaths[0])
        {
            throw new Error(
                `${tierId} projection receipt is not at its disposition-ledger output path`
            );
        }
        const catalog = JSON.parse(fs.readFileSync(
            path.resolve(root, catalogDirectory, `${tierId}.json`),
            'utf8'
        ));
        const receipt = validateReleaseDomainProjectionReceipt({
            receipt: matches[0].receipt,
            catalog,
            ledger,
            sourceState,
            runId,
            namespace,
            policyIdentity
        });
        return {
            tierId,
            path: relativePath,
            fileDigest: sha256File(matches[0].file),
            contentDigest: receipt.contentDigest,
            buildIdentity: receipt.buildIdentity,
            policyIdentity: receipt.policyIdentity
        };
    });
}


export const requiredEvidenceVerifier = Object.freeze({
    version: 1,
    successStatuses: Object.freeze(['success']),
    describe: async (receipt) => (await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url))).describeOwnerReceipt(receipt, {
        identity: { namespace: 'namespace', runId: 'runId', sourceCommit: 'sourceState.commit',
            worktreeFingerprint: 'sourceState.worktreeFingerprint', buildIdentity: 'buildIdentity', policyIdentity: 'policyIdentity' },
        status: 'status', contentDigest: 'contentDigest'
    }),
    async verify({ receipt, entry, context, domainInputs, repositoryRoot })
    {
        const { verifiedOwnerResult } = await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url));
        const { readOwnerEvidenceReference, readOwnerEvidenceFile } = await import(new URL('../release/required-evidence-owner-input.mjs', import.meta.url));
        const { projectEvidence } = await import('./evidence-projection.mjs');
        const { validateDomainReceiptAgainstReport } = await import('./release-domain-report.mjs');
        const catalog = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
            'tests/fixtures/evidence-projection', `${entry.authorityId}.json`), 'utf8'));
        const ledger = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
            'config/testing/release-domain-assertion-dispositions.json'), 'utf8'));
        validateReleaseDomainProjectionReceipt({ receipt, catalog, ledger,
            sourceState: { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint },
            runId: context.schedulerRunId, namespace: receipt.namespace,
            policyIdentity: releasePolicyIdentity(path.join(repositoryRoot,
                'config/testing/release-domain-assertion-dispositions.json')) });
        for (const artifact of receipt.artifacts)
        {
            readOwnerEvidenceFile({ path: artifact.path, digest: artifact.digest }, { repositoryRoot, context });
        }
        const producer = readOwnerEvidenceReference(domainInputs?.producer, { repositoryRoot, context });
        if (domainInputs.producer.path !== receipt.producer.receipt
            || producer.receipt.contentDigest !== receipt.producer.receiptContentDigest)
        {
            throw new Error('projection explicit original producer reference mismatch');
        }
        const report = readOwnerEvidenceReference(receipt.producer.assertionReport, { repositoryRoot, context });
        const inputs = { catalog, producerReceipt: producer.receipt,
            producerReceiptPath: domainInputs.producer.path,
            sourceState: { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint },
            runId: context.schedulerRunId, namespace: receipt.namespace, buildIdentity: receipt.buildIdentity,
            policyIdentity: receipt.policyIdentity, repositoryRoot };
        validateDomainReceiptAgainstReport({ ...inputs, ledger, assertionReport: report.receipt });
        const replay = projectEvidence({ ...inputs, generatedAt: receipt.generatedAt });
        if (replay.contentDigest !== receipt.contentDigest)
        {
            throw new Error('original producer projection replay mismatch');
        }
        return verifiedOwnerResult({ schema: receipt.schema, contentDigest: receipt.contentDigest,
            producerDigest: producer.digest, assertionReportDigest: report.digest });
    }
});
