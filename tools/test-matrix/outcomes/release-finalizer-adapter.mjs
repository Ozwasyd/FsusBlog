import { candidate, exactIds, reason } from './adapter-support.mjs';

export const releaseFinalizerOutcomeProducerId = 'release-finalizer-semantic-outcome';

export function adaptReleaseFinalizerSemanticOutcome({ identity, inputAuthorityRefs, attemptEligibility, plan, evidence })
{
    const requiredInputIds = exactIds(plan?.inputIds, 'finalizer input IDs');
    const requiredOutputIds = exactIds(plan?.outputIds, 'finalizer output IDs');
    const consumedInputIds = exactIds(evidence?.consumedIds ?? [], 'consumed input IDs');
    const verifiedInputIds = exactIds(evidence?.verifiedIds ?? [], 'verified input IDs');
    const failedInputIds = exactIds(evidence?.failedIds ?? [], 'failed input IDs');
    const blockedInputIds = exactIds(evidence?.blockedIds ?? [], 'blocked input IDs');
    const producedOutputIds = exactIds(evidence?.producedOutputIds ?? [], 'produced output IDs');
    const reasons = [];
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
    if (attemptEligibility?.cleanFirstAttempt !== true || attemptEligibility?.qualificationEligible !== true)
    {
        reasons.push(reason('contract.missing-evidence', releaseFinalizerOutcomeProducerId, { evidenceId: 'clean-first-attempt' }));
    }
    return candidate({ producerId: releaseFinalizerOutcomeProducerId,
        producerAuthorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs',
        identity, inputAuthorityRefs, attemptEligibility,
        membership: { blockedInputIds, consumedInputIds, failedInputIds, outputDigests,
            producedOutputIds, requiredInputIds, requiredOutputIds, verifiedInputIds }, reasons });
}
