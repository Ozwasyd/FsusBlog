import fs from 'node:fs';
import path from 'node:path';

import {
    projectionContentDigest,
    sealProjectionDocument
} from './evidence-projection.mjs';
import {
    evidenceSelectorDigest,
    normalizeSourceArtifact,
    releaseDomainReportSchema,
    sortedUnique,
    validateCatalogAgainstLedger,
    validateDispositionLedger
} from './release-domain-ledger.mjs';
import { validateNativeAssertionEvidence } from './release-domain-native-evidence.mjs';

export function createAssertionReport({
    producerId,
    sourceState,
    runId,
    namespace,
    buildIdentity,
    policyIdentity,
    assertions,
    sourceArtifacts,
    status,
    generatedAt = new Date().toISOString()
})
{
    return sealProjectionDocument({
        schema: releaseDomainReportSchema,
        status,
        producerId,
        sourceState,
        runId,
        namespace,
        buildIdentity,
        policyIdentity,
        assertions: [...assertions]
            .sort((left, right) => left.id.localeCompare(right.id)),
        sourceArtifacts: [...sourceArtifacts]
            .sort((left, right) => left.path.localeCompare(right.path)),
        generatedAt
    });
}

export function validateAssertionReport({
    report,
    producerId,
    entries,
    sourceState,
    runId,
    namespace,
    buildIdentity,
    policyIdentity,
    repositoryRoot
})
{
    if (report?.schema !== releaseDomainReportSchema
        || report.contentDigest !== projectionContentDigest(report))
    {
        throw new Error('assertion report schema or digest is invalid');
    }
    if (report.status !== 'success')
    {
        throw new Error(`assertion report status must be success, got ${report.status}`);
    }
    if (report.producerId !== producerId
        || report.runId !== runId
        || report.namespace !== namespace
        || JSON.stringify(report.sourceState) !== JSON.stringify(sourceState)
        || report.buildIdentity !== buildIdentity
        || report.policyIdentity !== policyIdentity)
    {
        throw new Error('assertion report identity mismatch');
    }
    const expected = entries.map((entry) => entry.requiredTestId).sort();
    const actual = report.assertions?.map((assertion) => assertion.id) ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected))
    {
        throw new Error('assertion report IDs do not exactly match disposition ledger');
    }
    if (!Array.isArray(report.sourceArtifacts) || report.sourceArtifacts.length === 0)
    {
        throw new Error('assertion report sourceArtifacts must be a non-empty array');
    }
    const normalizedArtifacts = report.sourceArtifacts.map((artifact, index) =>
        normalizeSourceArtifact(
            repositoryRoot,
            artifact,
            `assertion report sourceArtifacts[${index}]`
        ));
    const artifactPaths = normalizedArtifacts.map((artifact) => artifact.path);
    if (new Set(artifactPaths).size !== artifactPaths.length
        || JSON.stringify(artifactPaths)
            !== JSON.stringify([...artifactPaths].sort()))
    {
        throw new Error('assertion report sourceArtifacts must be sorted and unique');
    }
    const referencedPaths = new Set();
    for (const assertion of report.assertions)
    {
        const entry = entries.find(
            (candidate) => candidate.requiredTestId === assertion.id
        );
        if (assertion.outcome !== 'Passed' || assertion.executed !== true)
        {
            throw new Error(`assertion ${assertion.id} was not successfully executed`);
        }
        if (JSON.stringify(assertion.sourceTestIds)
            !== JSON.stringify(entry.sourceTestIds))
        {
            throw new Error(`assertion ${assertion.id} source test IDs mismatch`);
        }
        if (assertion.producerEvidenceDigest
            !== evidenceSelectorDigest(entry.producerEvidence))
        {
            throw new Error(
                `assertion ${assertion.id} producer evidence identity mismatch`
            );
        }
        const paths = sortedUnique(
            assertion.sourceArtifactPaths,
            `${assertion.id}.sourceArtifactPaths`
        );
        if (paths.some((relative) => !artifactPaths.includes(relative)))
        {
            throw new Error(
                `assertion ${assertion.id} references an undeclared native source artifact`
            );
        }
        paths.forEach((relative) => referencedPaths.add(relative));
        if (repositoryRoot)
        {
            validateNativeAssertionEvidence({
                repositoryRoot,
                entry,
                sourceArtifactPaths: paths,
                sourceState,
                runId,
                namespace,
                policyIdentity
            });
        }
    }
    if (JSON.stringify([...referencedPaths].sort()) !== JSON.stringify(artifactPaths))
    {
        throw new Error('assertion report contains unreferenced native source artifacts');
    }
    return report.assertions;
}

export function validateDomainReceiptAgainstReport({
    catalog,
    ledger,
    producerReceipt,
    assertionReport,
    sourceState,
    runId,
    namespace,
    buildIdentity,
    policyIdentity,
    repositoryRoot
})
{
    const domainEntries = validateCatalogAgainstLedger(catalog, ledger);
    const producerEntries = validateDispositionLedger(ledger)
        .filter((entry) => entry.canonicalProducer === catalog.projectFrom);
    validateAssertionReport({
        report: assertionReport,
        producerId: catalog.projectFrom,
        entries: producerEntries,
        sourceState,
        runId,
        namespace,
        buildIdentity,
        policyIdentity,
        repositoryRoot
    });
    const reportAssertions = new Map(
        assertionReport.assertions.map((assertion) => [assertion.id, assertion])
    );
    const expected = domainEntries.map((entry) =>
    {
        const assertion = reportAssertions.get(entry.requiredTestId);
        return {
            id: entry.requiredTestId,
            outcome: assertion.outcome,
            sourceTestIds: assertion.sourceTestIds,
            coverageIds: catalog.requiredCoverageIds,
            artifactIds: entry.requiredArtifactIds
        };
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (JSON.stringify(producerReceipt.assertions) !== JSON.stringify(expected))
    {
        throw new Error(
            `${catalog.tierId} producer receipt assertions do not exactly match executed assertion report`
        );
    }
    return expected;
}

export function validateReleaseDomainMatrix(root, matrix)
{
    const errors = [];
    const ledgerPath =
        path.join(root, 'config/testing/release-domain-assertion-dispositions.json');
    try
    {
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        const entries = validateDispositionLedger(ledger);
        const tierIds =
            [...new Set(entries.map((entry) => entry.tierId))].sort();
        for (const tierId of tierIds)
        {
            const tier = matrix.tiers.find((candidate) => candidate.id === tierId);
            const catalogPath =
                path.join(root, `tests/fixtures/evidence-projection/${tierId}.json`);
            if (!tier) throw new Error(`${tierId} is missing from matrix`);
            const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
            const domainEntries = validateCatalogAgainstLedger(catalog, ledger);
            for (const field of [
                'requiredTestIds',
                'requiredCoverageIds',
                'requiredArtifactDeclarations'
            ])
            {
                if (JSON.stringify(tier[field]) !== JSON.stringify(catalog[field]))
                {
                    throw new Error(
                        `${tierId}.${field} does not exactly match projection catalog`
                    );
                }
            }
            const outputReceiptPaths = [...new Set(
                domainEntries.map((entry) => entry.outputReceiptPath)
            )];
            if (outputReceiptPaths.length !== 1
                || JSON.stringify(tier.artifacts)
                    !== JSON.stringify(outputReceiptPaths)
                || !String(tier.command ?? '')
                    .includes(`--output ${outputReceiptPaths[0]} `))
            {
                throw new Error(
                    `${tierId} logical output receipt does not exactly match the disposition ledger`
                );
            }
            if (tier.executionOwner !== catalog.executionOwner
                || tier.projectFrom !== catalog.projectFrom)
            {
                throw new Error(
                    `${tierId} producer identity does not exactly match the projection catalog`
                );
            }
            if (tier.projectionCatalog
                !== path.relative(root, catalogPath).replaceAll(path.sep, '/'))
            {
                throw new Error(
                    `${tierId}.projectionCatalog does not name its domain catalog`
                );
            }
        }
        const ledgerTierIds = entries.map((entry) => entry.tierId);
        if (ledgerTierIds.some((tierId) => !tierIds.includes(tierId)))
        {
            throw new Error('disposition ledger has an unknown logical tier');
        }
    }
    catch (error)
    {
        errors.push(
            `release-domain-projection: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    return errors;
}
