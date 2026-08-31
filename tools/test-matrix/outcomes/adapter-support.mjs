import { digestCanonical } from '../../test/attempt-provenance.mjs';

import { sealProducerSemanticOutcomeCandidate } from './outcome-contract.mjs';

export function exactIds(values, label)
{
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value))
    {
        throw new Error(`${label} must be a string array`);
    }
    const normalized = [...new Set(values)].sort();
    if (normalized.length !== values.length)
    {
        throw new Error(`${label} contains duplicate IDs`);
    }
    return normalized;
}

export function reason(kind, producerId, identity, details = {})
{
    return { kind, producerId, identity: { producerId, ...identity }, ...details };
}

export function candidate({
    producerId,
    producerAuthorityId,
    identity,
    inputAuthorityRefs,
    attemptEligibility,
    membership,
    reasons
})
{
    return sealProducerSemanticOutcomeCandidate({
        producerId,
        producerAuthorityId,
        identity,
        inputAuthorityRefs,
        attemptEligibility,
        outcome: {
            status: reasons.length === 0 ? 'success' : 'failed',
            requiredMembershipVerified: reasons.length === 0,
            reasons,
            membership,
            semanticPayloadDigest: digestCanonical(membership)
        }
    });
}
