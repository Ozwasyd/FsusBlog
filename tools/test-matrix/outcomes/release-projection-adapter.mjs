import { candidate, exactIds, reason } from './adapter-support.mjs';

export const releaseProjectionOutcomeProducerId = 'release-projection-semantic-outcome';

export function adaptReleaseProjectionSemanticOutcome({ identity, inputAuthorityRefs, attemptEligibility, plan, evidence })
{
    const requiredProjectionIds = exactIds(plan?.projectionIds, 'projection plan IDs');
    const producedProjectionIds = exactIds(evidence?.producedIds ?? [], 'produced projection IDs');
    const verifiedProjectionIds = exactIds(evidence?.verifiedIds ?? [], 'verified projection IDs');
    const failedProjectionIds = exactIds(evidence?.failedIds ?? [], 'failed projection IDs');
    const blockedProjectionIds = exactIds(evidence?.blockedIds ?? [], 'blocked projection IDs');
    const reasons = [];
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
    if (attemptEligibility?.cleanFirstAttempt !== true || attemptEligibility?.qualificationEligible !== true)
    {
        reasons.push(reason('contract.missing-evidence', releaseProjectionOutcomeProducerId, { evidenceId: 'clean-first-attempt' }));
    }
    return candidate({ producerId: releaseProjectionOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs',
        identity, inputAuthorityRefs, attemptEligibility,
        membership: { blockedProjectionIds, failedProjectionIds, producedProjectionIds,
            requiredProjectionIds, semanticDigests, verifiedProjectionIds }, reasons });
}
