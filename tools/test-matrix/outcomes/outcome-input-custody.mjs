
import fs from 'node:fs';
import path from 'node:path';

import { validateProducerSemanticOutcomeCandidate } from './outcome-contract.mjs';

const { locateCurrentRunEvidence, verifyCurrentRunEvidenceBinding } = await import(new URL('../../test/current-run-evidence-locator.mjs', import.meta.url));
const { resolveEvidenceReferencePayload } = await import(new URL('../../test/current-run-evidence-publication.mjs', import.meta.url));
const { cleanFirstAttemptVerdict, fileBackedCleanAttemptEvidence } = await import(new URL('../../release/clean-first-attempt-verifier.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`outcome input custody: ${message}`);
    }
}
const same = (left, right) => digestCanonical(left) === digestCanonical(right);
const key = (reference) => JSON.stringify([reference.kind, reference.path]);

function bounded(file, maxBytes)
{
    require(fs.statSync(file).size <= maxBytes, 'held JSON exceeds host budget');
}

function payloadDigest(payload, mode, reference)
{
    if (mode === 'file-bytes')
    {
        return reference.payload.digest;
    }
    if (mode === 'canonical-json')
    {
        return digestCanonical(payload);
    }
    const field = mode === 'content-digest' ? 'contentDigest' : mode === 'plan-digest' ? 'planDigest' : null;
    require(field, 'unknown independently declared digest mode');
    const unsigned = { ...payload };
    delete unsigned[field];
    require(payload[field] === digestCanonical(unsigned), 'held payload content seal mismatch');
    return payload[field];
}

/**
 * Reopen an exact host-pinned input roster through the original locator and
 * publication owners, then bind the original file-backed aggregate/attempt.
 * The external verifyAuthority callback remains the original execution owner's
 * responsibility. This bridge verifies custody, not domain semantics or runtime
 * execution, and never issues a producer verification/fingerprint/qualification.
 * Held labels require an explicit host-pinned physical payload mapping; there is
 * no path search, newest-file fallback, invented receipt or automatic rebinding.
 */
export function verifyOutcomeInputCustody(encodedCandidate, encodedExpected, {
    maxBytes, repositoryRoot, context, registry, bindings, attemptEvidence, verifyAuthority
})
{
    require(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'explicit host byte budget required');
    for (const encoded of [encodedCandidate, encodedExpected, JSON.stringify(bindings)])
    {
        require(typeof encoded === 'string' && Buffer.byteLength(encoded) <= maxBytes, 'encoded input exceeds host budget');
    }
    const candidate = JSON.parse(encodedCandidate);
    const expected = JSON.parse(encodedExpected);
    require(same(candidate.identity, expected.identity) && candidate.contentDigest === expected.candidateDigest,
        'independent candidate identity/digest mismatch');
    validateProducerSemanticOutcomeCandidate(candidate, { expectedProducerId: expected.identity.producerId,
        expectedAuthorityId: expected.producerAuthorityId });
    require(typeof expected.producerAuthorityId === 'string' && candidate.producerAuthorityId === expected.producerAuthorityId,
        'independent producer authority mismatch');
    require(context.contentDigest === expected.contextDigest && registry.contentDigest === expected.registryDigest
        && digestCanonical(bindings) === expected.bindingsDigest, 'independent locator context/registry/mapping mismatch');
    for (const field of ['schedulerRunId', 'sourceCommit', 'worktreeFingerprint'])
    {
        require(context[field] === candidate.identity[field], `locator ${field} crosses candidate`);
    }
    require(context.buildIdentity.digest === candidate.identity.buildIdentity, 'locator build identity crosses candidate');
    require(Array.isArray(bindings) && bindings.length === candidate.inputAuthorityRefs.length
        && new Set(bindings.map((binding) => key(binding.inputReference))).size === bindings.length,
    'input mapping must be exact and unique');
    const root = fs.realpathSync(repositoryRoot);
    const held = [];
    for (const input of candidate.inputAuthorityRefs)
    {
        require(same(Object.keys(input).sort(), ['digest', 'kind', 'path']), 'input reference fields are not exact');
        const binding = bindings.find((item) => key(item.inputReference) === key(input));
        require(binding && same(binding.inputReference, input), 'candidate input is missing its independent mapping');
        const entry = registry.entries.find((item) => item.consumerId === binding.consumerId);
        require(entry, 'input consumer is not in the original locator registry');
        const locator = { context, registry, registryEntry: entry, repositoryRoot: root };
        const inputPath = binding.reference?.path ?? binding.explicitInputs?.[0];
        require(typeof inputPath === 'string', 'explicit current-run reference required');
        bounded(path.resolve(root, inputPath), maxBytes);
        const located = locateCurrentRunEvidence({ ...locator,
            ...(binding.reference ? { reference: binding.reference } : {}),
            ...(binding.explicitInputs ? { explicitInputs: binding.explicitInputs } : {}) });
        require(located.receipt.payload?.path === binding.payloadPath, 'held payload differs from independent mapping');
        bounded(path.resolve(root, binding.payloadPath), maxBytes);
        const { file, payload } = resolveEvidenceReferencePayload(located.receipt,
            { repositoryRoot: root, ownedRoots: context.ownedRoots });
        require(path.relative(root, file).replaceAll(path.sep, '/') === binding.payloadPath,
            'held payload path is not canonical');
        require(payloadDigest(payload, binding.digestMode, located.receipt) === input.digest,
            'held input digest differs from candidate');
        verifyCurrentRunEvidenceBinding(located.bindingReceipt, locator);
        held.push({ inputReference: input, payloadPath: binding.payloadPath,
            payloadFileDigest: located.receipt.payload.digest, bindingReceipt: located.bindingReceipt });
    }
    require(same(attemptEvidence.aggregateReference, expected.aggregateReference), 'independent aggregate reference mismatch');
    const evidenceRoot = fs.realpathSync(attemptEvidence.evidenceRoot);
    require(evidenceRoot === attemptEvidence.evidenceRoot && context.ownedRoots.some((owned) =>
    {
        const ownedRoot = fs.realpathSync(path.resolve(root, owned));
        return evidenceRoot === ownedRoot || evidenceRoot.startsWith(`${ownedRoot}${path.sep}`);
    }), 'attempt evidence escapes current-run owned roots');
    const loaders = fileBackedCleanAttemptEvidence({ ...attemptEvidence, evidenceRoot });
    const verdict = cleanFirstAttemptVerdict({ ...loaders, verifyAuthority,
        expectedIdentity: Object.fromEntries(['producerId', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint']
            .map((field) => [field, candidate.identity[field]])) });
    require(verdict.aggregate && verdict.attempt
        && (verdict.eligible || verdict.reasons.every((reason) => reason.code === 'attempt.not-clean-first')),
    `original attempt verification failed: ${verdict.reasons.map((reason) => reason.code).join(',')}`);
    for (const field of ['producerId', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint',
        'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
    {
        require(verdict.attempt[field] === candidate.identity[field], `attempt ${field} crosses candidate`);
    }
    const actualEligibility = { aggregateDigest: verdict.aggregate.contentDigest,
        attemptDigest: verdict.attempt.contentDigest, attemptNumber: verdict.attempt.attemptNumber,
        cleanFirstAttempt: verdict.aggregate.cleanFirstAttempt, firstFailure: verdict.attempt.firstFailure,
        qualificationEligible: verdict.aggregate.qualificationEligible };
    require(same(candidate.attemptEligibility, actualEligibility), 'candidate attempt eligibility differs from held attempt');
    // The original authority callback can perform I/O; recheck inputs after it.
    for (const item of held)
    {
        const entry = registry.entries.find((value) => value.consumerId === item.bindingReceipt.consumerId);
        const locator = { context, registry, registryEntry: entry, repositoryRoot: root };
        verifyCurrentRunEvidenceBinding(item.bindingReceipt, locator);
        const located = locateCurrentRunEvidence({ ...locator,
            ...(item.bindingReceipt.input.kind === 'explicit-run-path'
                ? { explicitInputs: [item.bindingReceipt.input.path] }
                : { reference: item.bindingReceipt.input }) });
        resolveEvidenceReferencePayload(located.receipt, { repositoryRoot: root, ownedRoots: context.ownedRoots });
    }
    return Object.freeze({ custodyVerified: true, producerVerificationPending: true, qualificationEligible: false,
        candidateDigest: candidate.contentDigest, contextDigest: context.contentDigest, registryDigest: registry.contentDigest,
        attemptCleanFirst: verdict.eligible, attemptEligibility: actualEligibility, heldInputs: held });
}
