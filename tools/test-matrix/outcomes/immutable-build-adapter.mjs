const { verifyProductionBuildReceipt, productionBuildVerificationSchema } = await import(new URL('../../ci/production-build-artifacts.mjs', import.meta.url));

import { candidate, exactIds, inputAuthorityReasons, mapNativeAttemptOutcome, nativeSourceError, reason, verifyAdapterCandidate } from './adapter-support.mjs';

export const immutableBuildOutcomeProducerId = 'immutable-build-semantic-outcome';

export function adaptImmutableBuildSemanticOutcome({
    identity,
    inputAuthorityRefs,
    attemptEligibility,
    plan,
    evidence,
    verifyInputs
})
{
    const plannedArtifactIds = exactIds(plan?.artifactIds, 'build plan artifactIds');
    const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
    const actualArtifactIds = artifacts.map((artifact) => artifact?.id);
    const uniqueActual = [...new Set(actualArtifactIds)].sort();
    const reasons = inputAuthorityReasons({
        producerId: immutableBuildOutcomeProducerId, identity, inputAuthorityRefs,
        attemptEligibility, plan, evidence, verifyInputs
    });
    reasons.push(...(evidence?.nativeFailures ?? []));
    for (const id of plannedArtifactIds.filter((id) => !uniqueActual.includes(id)))
    {
        reasons.push(reason('contract.missing-evidence', immutableBuildOutcomeProducerId, { evidenceId: id }));
    }
    for (const id of uniqueActual.filter((id) => !plannedArtifactIds.includes(id)))
    {
        reasons.push(reason('contract.ambiguous-evidence', immutableBuildOutcomeProducerId, { evidenceId: id }));
    }
    for (const id of uniqueActual.filter((id) => actualArtifactIds.filter((actual) => actual === id).length > 1))
    {
        reasons.push(reason('contract.ambiguous-evidence', immutableBuildOutcomeProducerId, { evidenceId: id }));
    }
    const artifactSemanticDigests = {};
    const verifiedArtifactIds = [];
    for (const artifact of artifacts.filter((item) => plannedArtifactIds.includes(item?.id)))
    {
        const digests = [artifact.contentDigest, artifact.manifestDigest, artifact.provenanceDigest]
            .concat(artifact.imageDigest ? [artifact.imageDigest] : []);
        if (artifact.verified !== true || digests.some((value) => !/^sha256:[0-9a-f]{64}$/u.test(String(value))))
        {
            reasons.push(reason('product.state-mismatch', immutableBuildOutcomeProducerId, { semanticId: artifact.id }));
        }
        else
        {
            verifiedArtifactIds.push(artifact.id);
            artifactSemanticDigests[artifact.id] = Object.fromEntries([
                ['contentDigest', artifact.contentDigest],
                ['imageDigest', artifact.imageDigest ?? null],
                ['manifestDigest', artifact.manifestDigest],
                ['provenanceDigest', artifact.provenanceDigest]
            ]);
        }
    }
    const assertions = Array.isArray(evidence?.verificationAssertions)
        ? evidence.verificationAssertions : [];
    const requiredAssertionIds = exactIds(
        plan?.verificationAssertionIds,
        'build plan verificationAssertionIds'
    );
    const assertionIds = assertions.map((item) => item?.id);
    for (const id of requiredAssertionIds.filter((id) => !assertionIds.includes(id)))
    {
        reasons.push(reason('contract.missing-evidence', immutableBuildOutcomeProducerId, {
            evidenceId: `assertion:${id}`
        }));
    }
    for (const id of assertionIds.filter((id) => !requiredAssertionIds.includes(id)))
    {
        reasons.push(reason('contract.ambiguous-evidence', immutableBuildOutcomeProducerId, {
            evidenceId: `assertion:${id}`
        }));
    }
    for (const id of requiredAssertionIds.filter((id) => assertionIds.filter((actual) => actual === id).length > 1))
    {
        reasons.push(reason('contract.ambiguous-evidence', immutableBuildOutcomeProducerId, {
            evidenceId: `assertion:${id}`
        }));
    }
    for (const assertion of assertions.filter((item) => item?.status !== 'passed'))
    {
        reasons.push(reason('product.assertion', immutableBuildOutcomeProducerId, { assertionId: assertion.id }));
    }
    if (attemptEligibility?.attemptNumber !== 1 || attemptEligibility?.firstFailure !== false
        || attemptEligibility?.cleanFirstAttempt !== true || attemptEligibility?.qualificationEligible !== true)
    {
        reasons.push(reason('contract.missing-evidence', immutableBuildOutcomeProducerId, { evidenceId: 'clean-first-attempt' }));
    }
    const membership = {
        actualArtifactIds: uniqueActual,
        artifactSemanticDigests,
        plannedArtifactIds,
        verificationAssertionIds: assertionIds.sort(),
        verifiedArtifactIds: [...verifiedArtifactIds].sort()
    };
    return candidate({ producerId: immutableBuildOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/immutable-build-adapter.mjs',
        identity, inputAuthorityRefs, attemptEligibility, membership, reasons });
}


export function verifyImmutableBuildSemanticOutcomeCandidate(value, expectations)
{
    return verifyAdapterCandidate(value, expectations, {
        producerId: immutableBuildOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/immutable-build-adapter.mjs',
        authorityIssue: 2654
    });
}


/** Map real verified receipt bytes; host authority and attempt admission remain required. */
function readMapVerifiedProductionBuildOutcomeInputs({ plan, verification, artifactBindings })
{
    for (const field of ['artifactRoot', 'expectedInputRoot', 'expectedReceiptDigest',
        'expectedSourceState', 'expectedProducer', 'expectedToolchain'])
    {
        if (!verification?.[field])
        {
            throw new Error(`production build outcome bridge requires independent ${field}`);
        }
    }
    exactIds(artifactBindings?.map((binding) => binding.id), 'production artifact binding IDs');
    const { receipt, evidence: verified } = verifyProductionBuildReceipt({
        ...verification, repairReadOnlySeal: false
    });
    for (const field of ['workflow', 'runId', 'runAttempt', 'job'])
    {
        if (verification.expectedProducer[field] !== receipt.producer[field])
        {
            throw new Error(`production build outcome bridge requires exact producer ${field}`);
        }
    }
    if (JSON.stringify(Object.keys(verification.expectedToolchain).sort())
        !== JSON.stringify(Object.keys(receipt.toolchain).sort()))
    {
        throw new Error('production build outcome bridge requires the complete held toolchain');
    }
    const records = new Map(receipt.artifacts.map((record) => [record.path, record]));
    const artifacts = artifactBindings.map((binding) =>
    {
        const record = (field) =>
        {
            const value = records.get(binding[field]);
            if (!value)
            {
                throw new Error(`${binding.id} ${field} is not in the verified build receipt`);
            }
            return value.sha256;
        };
        if (binding.imageDigest !== undefined && binding.imageDigest !== null)
        {
            throw new Error('image outcome requires the original image-verification owner capability');
        }
        return { id: binding.id, contentDigest: record('contentPath'),
            manifestDigest: record('manifestPath'), provenanceDigest: record('provenancePath'),
            imageDigest: null, verified: true };
    });
    return {
        plan: structuredClone(plan),
        evidence: {
            artifacts,
            verificationAssertions: [{ id: productionBuildVerificationSchema,
                status: verified.status === 'success' ? 'passed' : 'failed' }],
            nativeReceiptDigest: receipt.contentDigest
        }
    };
}


/** Original native source verification failures remain canonical, with text diagnostic only. */
export function mapVerifiedProductionBuildOutcomeInputs(options)
{
    try
    {
        return readMapVerifiedProductionBuildOutcomeInputs(options);
    }
    catch (error)
    {
        throw nativeSourceError(immutableBuildOutcomeProducerId, 'native-source-verification', error);
    }
}


export function mapImmutableBuildNativeAttemptOutcome(options)
{
    return mapNativeAttemptOutcome(options, immutableBuildOutcomeProducerId);
}
