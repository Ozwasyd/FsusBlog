const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { projectionContentDigest } = await import(new URL('../evidence-projection.mjs', import.meta.url));
const { normalizeSourceArtifact, readJsonArtifact, validateCatalogAgainstLedger } = await import(new URL('../release-domain-ledger.mjs', import.meta.url));
const { validateReleaseDomainProjectionReceipt } = await import(new URL('../release-domain-projection-receipt.mjs', import.meta.url));
const { validateDomainReceiptAgainstReport } = await import(new URL('../release-domain-report.mjs', import.meta.url));

import { candidate, exactIds, inputAuthorityReasons, mapNativeAttemptOutcome, nativeSourceError, reason, verifyAdapterCandidate } from './adapter-support.mjs';

export const releaseProjectionOutcomeProducerId = 'release-projection-semantic-outcome';

export function adaptReleaseProjectionSemanticOutcome({ identity, inputAuthorityRefs, attemptEligibility, plan, evidence, verifyInputs })
{
    const requiredProjectionIds = exactIds(plan?.projectionIds, 'projection plan IDs');
    const producedProjectionIds = exactIds(evidence?.producedIds ?? [], 'produced projection IDs');
    const verifiedProjectionIds = exactIds(evidence?.verifiedIds ?? [], 'verified projection IDs');
    const failedProjectionIds = exactIds(evidence?.failedIds ?? [], 'failed projection IDs');
    const blockedProjectionIds = exactIds(evidence?.blockedIds ?? [], 'blocked projection IDs');
    const reasons = inputAuthorityReasons({
        producerId: releaseProjectionOutcomeProducerId, identity, inputAuthorityRefs,
        attemptEligibility, plan, evidence, verifyInputs
    });
    reasons.push(...(evidence?.nativeFailures ?? []));
    const terminalIds = [...verifiedProjectionIds, ...failedProjectionIds, ...blockedProjectionIds];
    const terminal = new Set(terminalIds);
    for (const id of requiredProjectionIds.filter((id) => !producedProjectionIds.includes(id)))
    {
        reasons.push(reason('contract.missing-evidence', releaseProjectionOutcomeProducerId, { evidenceId: id }));
    }
    for (const id of producedProjectionIds.filter((id) => !requiredProjectionIds.includes(id)))
    {
        reasons.push(reason('contract.ambiguous-evidence', releaseProjectionOutcomeProducerId, { evidenceId: id }));
    }
    for (const id of requiredProjectionIds.filter((id) => !terminal.has(id)))
    {
        reasons.push(reason('contract.missing-evidence', releaseProjectionOutcomeProducerId, { evidenceId: `${id}:terminal` }));
    }
    for (const id of terminal)
    {
        if (!requiredProjectionIds.includes(id) || !producedProjectionIds.includes(id)
            || terminalIds.filter((actual) => actual === id).length > 1)
        {
            reasons.push(reason('contract.ambiguous-evidence', releaseProjectionOutcomeProducerId, { evidenceId: `${id}:terminal` }));
        }
    }
    for (const id of [...failedProjectionIds, ...blockedProjectionIds])
    {
        reasons.push(reason('product.state-mismatch', releaseProjectionOutcomeProducerId, { semanticId: id }));
    }
    const semanticDigests = evidence?.semanticDigests ?? {};
    for (const id of Object.keys(semanticDigests).filter((id) => !verifiedProjectionIds.includes(id)))
    {
        reasons.push(reason('contract.ambiguous-evidence', releaseProjectionOutcomeProducerId, { evidenceId: `${id}:digest` }));
    }
    for (const id of verifiedProjectionIds)
    {
        if (!/^sha256:[0-9a-f]{64}$/u.test(String(semanticDigests[id] ?? '')))
        {
            reasons.push(reason('product.state-mismatch', releaseProjectionOutcomeProducerId, { semanticId: id }));
        }
    }
    if (attemptEligibility?.attemptNumber !== 1 || attemptEligibility?.firstFailure !== false
        || attemptEligibility?.cleanFirstAttempt !== true || attemptEligibility?.qualificationEligible !== true)
    {
        reasons.push(reason('contract.missing-evidence', releaseProjectionOutcomeProducerId, { evidenceId: 'clean-first-attempt' }));
    }
    return candidate({ producerId: releaseProjectionOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs',
        identity, inputAuthorityRefs, attemptEligibility,
        membership: { blockedProjectionIds, failedProjectionIds, producedProjectionIds,
            requiredProjectionIds, semanticDigests, verifiedProjectionIds }, reasons });
}


export function verifyReleaseProjectionSemanticOutcomeCandidate(value, expectations)
{
    return verifyAdapterCandidate(value, expectations, {
        producerId: releaseProjectionOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs',
        authorityIssue: 2655
    });
}


/** Read exact canonical native refs without generating a projection or invoking a producer. */
function readMapVerifiedReleaseDomainProjectionOutcomeInputs({
    catalog, ledger, repositoryRoot, sourceState, runId, namespace, buildIdentity, policyIdentity
})
{
    if (!repositoryRoot || !sourceState || !runId || !namespace || !buildIdentity || !policyIdentity)
    {
        throw new Error('projection outcome bridge requires independent native identity and root');
    }
    const entries = validateCatalogAgainstLedger(catalog, ledger);
    normalizeSourceArtifact(repositoryRoot, { path: catalog.dispositionLedger, digest: policyIdentity }, 'projection policy');
    if (digestCanonical(readJsonArtifact(repositoryRoot, catalog.dispositionLedger)) !== digestCanonical(ledger))
    {
        throw new Error('projection outcome bridge held ledger differs from native policy bytes');
    }
    const receiptPaths = [...new Set(entries.map((entry) => entry.outputReceiptPath))];
    if (receiptPaths.length !== 1)
    {
        throw new Error('projection outcome bridge requires exactly one canonical receipt path');
    }
    const receipt = readJsonArtifact(repositoryRoot, receiptPaths[0]);
    validateReleaseDomainProjectionReceipt({ receipt, catalog, ledger, sourceState, runId, namespace, policyIdentity });
    if (receipt.buildIdentity !== buildIdentity)
    {
        throw new Error('projection outcome bridge native build identity mismatch');
    }
    const producerReceipt = readJsonArtifact(repositoryRoot, receipt.producer.receipt);
    if (producerReceipt.schema !== receipt.producer.schema
        || producerReceipt.contentDigest !== projectionContentDigest(producerReceipt)
        || producerReceipt.contentDigest !== receipt.producer.receiptContentDigest
        || producerReceipt.producerId !== catalog.projectFrom
        || producerReceipt.logicalTierId !== catalog.tierId
        || producerReceipt.status !== 'success'
        || JSON.stringify(producerReceipt.sourceState) !== JSON.stringify(receipt.sourceState)
        || producerReceipt.runId !== runId || producerReceipt.namespace !== namespace
        || producerReceipt.buildIdentity !== buildIdentity || producerReceipt.policyIdentity !== policyIdentity
        || digestCanonical(producerReceipt.artifacts) !== digestCanonical(receipt.artifacts)
        || digestCanonical(producerReceipt.assertionReport) !== digestCanonical(receipt.producer.assertionReport))
    {
        throw new Error('projection outcome bridge native producer receipt binding mismatch');
    }
    normalizeSourceArtifact(repositoryRoot, producerReceipt.assertionReport, 'producer assertion report');
    const assertionReport = readJsonArtifact(repositoryRoot, producerReceipt.assertionReport.path);
    validateDomainReceiptAgainstReport({ catalog, ledger, producerReceipt, assertionReport,
        sourceState: receipt.sourceState, runId, namespace, buildIdentity, policyIdentity, repositoryRoot });
    receipt.artifacts.forEach((artifact) => normalizeSourceArtifact(repositoryRoot, artifact, artifact.id));
    const semantic = {
        schema: receipt.schema,
        testIds: receipt.testIds,
        coverageIds: receipt.coverageIds,
        assertions: receipt.assertions,
        artifacts: receipt.artifacts.map(({ id, digest }) => ({ id, digest }))
    };
    return {
        plan: { projectionIds: [catalog.tierId], catalogDigest: digestCanonical(catalog),
            ledgerDigest: digestCanonical(ledger) },
        evidence: { producedIds: [catalog.tierId], verifiedIds: [catalog.tierId], failedIds: [], blockedIds: [],
            semanticDigests: { [catalog.tierId]: digestCanonical(semantic) },
            nativeReceiptDigest: receipt.contentDigest, nativeProducerDigest: producerReceipt.contentDigest }
    };
}


/** Original native source verification failures remain canonical, with text diagnostic only. */
export function mapVerifiedReleaseDomainProjectionOutcomeInputs(options)
{
    try
    {
        return readMapVerifiedReleaseDomainProjectionOutcomeInputs(options);
    }
    catch (error)
    {
        throw nativeSourceError(releaseProjectionOutcomeProducerId, 'native-source-verification', error);
    }
}


export function mapReleaseProjectionNativeAttemptOutcome(options)
{
    return mapNativeAttemptOutcome(options, releaseProjectionOutcomeProducerId);
}
