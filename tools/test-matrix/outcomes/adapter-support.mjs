const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
import { externalCandidateVerification, sealProducerSemanticOutcomeCandidate, validateProducerSemanticOutcomeCandidate } from './outcome-contract.mjs';

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
    return sealProducerSemanticOutcomeCandidate(structuredClone({
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
    }));
}


/**
 * The host must obtain expected digests and bindings from the canonical input
 * owners. The adapter never derives held expectations from its observation.
 */
export function inputAuthorityReasons({
    producerId, identity, inputAuthorityRefs, attemptEligibility, plan, evidence, verifyInputs
})
{
    const missing = () => [reason('contract.missing-evidence', producerId, {
        evidenceId: 'verified-held-inputs'
    })];
    if (typeof verifyInputs !== 'function')
    {
        return missing();
    }
    let held;
    try
    {
        held = verifyInputs({ producerId, inputAuthorityRefs: structuredClone(inputAuthorityRefs) });
        const fields = ['attemptEligibility', 'evidenceDigest', 'identity',
            'inputAuthorityRefs', 'planDigest', 'verified'];
        if (!held || typeof held !== 'object' || held.verified !== true
            || JSON.stringify(Object.keys(held).sort()) !== JSON.stringify(fields)
            || !/^sha256:[0-9a-f]{64}$/u.test(String(held.planDigest))
            || !/^sha256:[0-9a-f]{64}$/u.test(String(held.evidenceDigest))
            || !held.identity || !held.attemptEligibility || !Array.isArray(held.inputAuthorityRefs))
        {
            return missing();
        }
        const reasons = [];
        if (JSON.stringify(Object.keys(held.identity).sort()) !== JSON.stringify(Object.keys(identity).sort()))
        {
            return missing();
        }
        for (const field of Object.keys(identity))
        {
            if (identity[field] !== held.identity[field])
            {
                reasons.push(reason('contract.identity', producerId, { identityField: field }));
            }
        }
        for (const [field, actual, expected] of [
            ['planDigest', digestCanonical(plan), held.planDigest],
            ['evidenceDigest', digestCanonical(evidence), held.evidenceDigest],
            ['inputAuthorityRefs', digestCanonical(inputAuthorityRefs), digestCanonical(held.inputAuthorityRefs)],
            ['attemptEligibility', digestCanonical(attemptEligibility), digestCanonical(held.attemptEligibility)]
        ])
        {
            if (actual !== expected)
            {
                reasons.push(reason('contract.identity', producerId, { identityField: field }));
            }
        }
        return reasons;
    }
    catch
    {
        return missing();
    }
}


/** Verify a candidate against independently supplied host expectations. */
export function verifyAdapterCandidate(value, {
    expectedCandidateDigest, expectedIdentity, verificationReceiptDigest
}, { producerId, producerAuthorityId, authorityIssue })
{
    if (!expectedIdentity || !/^sha256:[0-9a-f]{64}$/u.test(String(expectedCandidateDigest))
        || !/^sha256:[0-9a-f]{64}$/u.test(String(verificationReceiptDigest)))
    {
        throw new Error('adapter candidate requires independent identity and digest expectations');
    }
    const snapshot = structuredClone(value);
    validateProducerSemanticOutcomeCandidate(snapshot, {
        expectedProducerId: producerId,
        expectedAuthorityId: producerAuthorityId
    });
    if (snapshot.contentDigest !== expectedCandidateDigest
        || JSON.stringify(Object.keys(expectedIdentity).sort())
            !== JSON.stringify(Object.keys(snapshot.identity).sort()))
    {
        throw new Error('adapter candidate does not match independent digest or identity expectations');
    }
    return {
        ...externalCandidateVerification(snapshot, { expectedIdentity, authorityIssue, verificationReceiptDigest }),
        attemptEligibility: snapshot.attemptEligibility
    };
}
