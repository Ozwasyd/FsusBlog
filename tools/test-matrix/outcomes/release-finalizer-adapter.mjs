const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { buildReleaseFinalizerPlan } = await import(new URL('../release-final-evidence-contract.mjs', import.meta.url));

import { candidate, exactIds, inputAuthorityReasons, mapNativeAttemptOutcome, nativeSourceError, reason, verifyAdapterCandidate } from './adapter-support.mjs';

export const releaseFinalizerOutcomeProducerId = 'release-finalizer-semantic-outcome';

export function adaptReleaseFinalizerSemanticOutcome({ identity, inputAuthorityRefs, attemptEligibility, plan, evidence, verifyInputs })
{
    const requiredInputIds = exactIds(plan?.inputIds, 'finalizer input IDs');
    const requiredOutputIds = exactIds(plan?.outputIds, 'finalizer output IDs');
    const consumedInputIds = exactIds(evidence?.consumedIds ?? [], 'consumed input IDs');
    const verifiedInputIds = exactIds(evidence?.verifiedIds ?? [], 'verified input IDs');
    const failedInputIds = exactIds(evidence?.failedIds ?? [], 'failed input IDs');
    const blockedInputIds = exactIds(evidence?.blockedIds ?? [], 'blocked input IDs');
    const producedOutputIds = exactIds(evidence?.producedOutputIds ?? [], 'produced output IDs');
    const reasons = inputAuthorityReasons({
        producerId: releaseFinalizerOutcomeProducerId, identity, inputAuthorityRefs,
        attemptEligibility, plan, evidence, verifyInputs
    });
    reasons.push(...(evidence?.nativeFailures ?? []));
    if (evidence?.consumedInputReceipts !== undefined)
    {
        // The current #2020 finalizer profile has ID sets and output digests,
        // but no consumed receipt digest field. Keep native source observations
        // unqualified until that original profile can retain these semantics.
        reasons.push(reason('contract.missing-evidence', releaseFinalizerOutcomeProducerId,
            { evidenceId: 'canonical-consumed-receipt-digest-profile' }));
    }
    for (const id of requiredInputIds.filter((id) => !consumedInputIds.includes(id)))
    {
        reasons.push(reason('contract.missing-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: id }));
    }
    for (const id of consumedInputIds.filter((id) => !requiredInputIds.includes(id)))
    {
        reasons.push(reason('contract.ambiguous-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: id }));
    }
    for (const id of [...failedInputIds, ...blockedInputIds])
    {
        reasons.push(reason('product.state-mismatch', releaseFinalizerOutcomeProducerId, { semanticId: id }));
    }
    const terminalIds = [...verifiedInputIds, ...failedInputIds, ...blockedInputIds];
    const terminal = new Set(terminalIds);
    for (const id of requiredInputIds.filter((id) => !terminal.has(id)))
    {
        reasons.push(reason('contract.missing-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: `${id}:terminal` }));
    }
    for (const id of terminal)
    {
        if (!requiredInputIds.includes(id) || !consumedInputIds.includes(id)
            || terminalIds.filter((actual) => actual === id).length > 1)
        {
            reasons.push(reason('contract.ambiguous-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: `${id}:terminal` }));
        }
    }
    for (const id of requiredOutputIds.filter((id) => !producedOutputIds.includes(id)))
    {
        reasons.push(reason('contract.missing-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: id }));
    }
    for (const id of producedOutputIds.filter((id) => !requiredOutputIds.includes(id)))
    {
        reasons.push(reason('contract.ambiguous-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: id }));
    }
    const outputDigests = evidence?.outputDigests ?? {};
    for (const id of Object.keys(outputDigests).filter((id) => !producedOutputIds.includes(id)))
    {
        reasons.push(reason('contract.ambiguous-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: `${id}:digest` }));
    }
    for (const id of producedOutputIds)
    {
        if (!/^sha256:[0-9a-f]{64}$/u.test(String(outputDigests[id] ?? '')))
        {
            reasons.push(reason('product.state-mismatch', releaseFinalizerOutcomeProducerId, { semanticId: id }));
        }
    }
    if (attemptEligibility?.attemptNumber !== 1 || attemptEligibility?.firstFailure !== false
        || attemptEligibility?.cleanFirstAttempt !== true || attemptEligibility?.qualificationEligible !== true)
    {
        reasons.push(reason('contract.missing-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: 'clean-first-attempt' }));
    }
    return candidate({ producerId: releaseFinalizerOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs',
        identity, inputAuthorityRefs, attemptEligibility,
        membership: { blockedInputIds, consumedInputIds, failedInputIds, outputDigests,
            producedOutputIds, requiredInputIds, requiredOutputIds, verifiedInputIds }, reasons });
}


export function verifyReleaseFinalizerSemanticOutcomeCandidate(value, expectations)
{
    return verifyAdapterCandidate(value, expectations, {
        producerId: releaseFinalizerOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs',
        authorityIssue: 2656
    });
}


/** Required IDs come from the existing canonical finalizer owner, never observed outputs. */
export function mapCanonicalReleaseFinalizerOutcomePlan(matrix)
{
    const authority = buildReleaseFinalizerPlan(matrix);
    if (authority.errors.length > 0)
    {
        throw new Error(`canonical finalizer outcome plan refused: ${authority.errors.join('; ')}`);
    }
    return { inputIds: [...authority.inputTierIds], outputIds: [authority.outputReceiptSchema],
        canonicalPlanDigest: digestCanonical(authority) };
}


export function mapReleaseFinalizerNativeAttemptOutcome(options)
{
    return mapNativeAttemptOutcome(options, releaseFinalizerOutcomeProducerId);
}


/**
 * Consume #2061's existing verifyReleaseFinalVerifiedAuthorityBinding API.
 * The supplied verifier must be that original owner capability, with its
 * independent verificationOptions. No final output or scheduler CAS is made.
 */
export async function mapVerifiedReleaseFinalizerConsumedInputs({
    matrix, binding, verificationOptions, verifyBindings, expectedIdentity
})
{
    try
    {
        if (typeof verifyBindings !== 'function' || !expectedIdentity)
        {
            throw new Error('finalizer mapping requires the original independent binding verifier and identity');
        }
        const verified = await verifyBindings(structuredClone(binding), verificationOptions);
        if (verified?.schema !== 'fsusblog.release-final-test-evidence-binding.v2'
            || verified.status !== 'verified-bindings-unpublished'
            || verified.qualificationEligible !== false || verified.reasonCodes?.length !== 0
            || verified.publicationRequired !== 'canonical-scheduler-CAS'
            || digestCanonical(verified) !== digestCanonical(binding))
        {
            throw new Error('original finalizer binding verifier did not return its unpublished source contract');
        }
        for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId'])
        {
            if (verified.context[field] !== expectedIdentity[field])
            {
                throw Object.assign(new Error('finalizer native source identity mismatch'),
                    { reasonCode: 'PLAN_IDENTITY_MISMATCH' });
            }
        }
        const plan = mapCanonicalReleaseFinalizerOutcomePlan(matrix);
        const dependencies = verificationOptions.testPlan.requiredEvidenceDependencies.dependencies;
        const consumedIds = new Set();
        const consumedInputReceipts = [];
        const inputAuthorityRefs = [];
        for (const authority of verified.authorities)
        {
            const matches = dependencies.filter((entry) => entry.authorityId === authority.authorityId);
            if (matches.length !== 1 || authority.producerId !== matches[0].canonicalOwner
                || authority.outputBindingKey !== matches[0].outputBindingKey)
            {
                throw Object.assign(new Error('finalizer authority association differs from the verified plan'),
                    { reasonCode: 'OUTPUT_BINDING_MISMATCH' });
            }
            const reference = authority.verifiedBinding.receipt;
            if (!reference?.schema || !reference.ref || !/^sha256:[0-9a-f]{64}$/u.test(reference.contentDigest))
            {
                throw new Error('original finalizer binding lacks a verified consumed producer receipt');
            }
            inputAuthorityRefs.push({ kind: reference.schema, path: reference.ref, digest: reference.contentDigest });
            for (const id of matches[0].producerTierIds)
            {
                if (!plan.inputIds.includes(id))
                {
                    throw Object.assign(new Error('verified authority refers to a noncanonical input tier'),
                        { reasonCode: 'UNDECLARED_AUTHORITY' });
                }
                consumedIds.add(id);
                consumedInputReceipts.push({ id, authorityId: authority.authorityId,
                    producerId: authority.producerId, schema: reference.schema,
                    contentDigest: reference.contentDigest });
            }
        }
        const consumed = [...consumedIds].sort();
        return {
            plan,
            inputAuthorityRefs,
            evidence: { consumedIds: consumed, verifiedIds: [...consumed], failedIds: [], blockedIds: [],
                consumedInputReceipts, producedOutputIds: [], outputDigests: {} },
            nativeObservation: { bindingDigest: verified.contentDigest,
                status: verified.status, qualificationEligible: false,
                publicationRequired: verified.publicationRequired }
        };
    }
    catch (error)
    {
        throw nativeSourceError(releaseFinalizerOutcomeProducerId, 'verified-finalizer-inputs', error);
    }
}
