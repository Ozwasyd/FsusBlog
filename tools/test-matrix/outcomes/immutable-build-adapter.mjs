import { candidate, exactIds, reason } from './adapter-support.mjs';

export const immutableBuildOutcomeProducerId = 'immutable-build-semantic-outcome';

export function adaptImmutableBuildSemanticOutcome({
    identity,
    inputAuthorityRefs,
    attemptEligibility,
    plan,
    evidence
})
{
    const plannedArtifactIds = exactIds(plan?.artifactIds, 'build plan artifactIds');
    const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
    const actualArtifactIds = artifacts.map((artifact) => artifact?.id);
    const uniqueActual = [...new Set(actualArtifactIds)].sort();
    const reasons = [];
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
    if (attemptEligibility?.cleanFirstAttempt !== true || attemptEligibility?.qualificationEligible !== true)
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
