import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanFirstAttemptVerdict } from './clean-first-attempt-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryFile = path.join(
    root,
    'config/testing/semantic-outcome-clean-attempt-consumers.json'
);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const expectedAuthorities = new Map([
    ['finalizer', { issue: 2656, producerId: 'release-finalizer-semantic-outcome',
        authorityId: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs' }],
    ['immutable-build', { issue: 2654, producerId: 'immutable-build-semantic-outcome',
        authorityId: 'tools/test-matrix/outcomes/immutable-build-adapter.mjs' }],
    ['release-projection', { issue: 2655, producerId: 'release-projection-semantic-outcome',
        authorityId: 'tools/test-matrix/outcomes/release-projection-adapter.mjs' }]
]);
const candidateIdentityFields = Object.freeze([
    'buildIdentity',
    'executionEnvelopeDigest',
    'producerId',
    'replayPlanDigest',
    'schedulerRunId',
    'sourceCommit',
    'temporalContextDigest',
    'toolchainDigest',
    'worktreeFingerprint'
]);

function sortedUnique(values, label)
{
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value))
    {
        throw new Error(`${label} must be a string array`);
    }
    const normalized = [...new Set(values)].sort();
    if (JSON.stringify(values) !== JSON.stringify(normalized))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
}

export function readSemanticOutcomeConsumerInventory(file = inventoryFile)
{
    return validateSemanticOutcomeConsumerInventory(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function validateSemanticOutcomeConsumerInventory(inventory)
{
    if (inventory?.schema !== 'fsusblog.semantic-outcome-clean-attempt-consumer-inventory.v1'
        || inventory.unifiedAttemptVerifier
            !== 'tools/release/clean-first-attempt-verifier.mjs#cleanFirstAttemptVerdict'
        || inventory.candidateVerificationMode !== 'external-owner-only'
        || inventory.migrationState !== 'migrated'
        || inventory.qualificationEligible !== true
        || !Array.isArray(inventory.consumers)
        || inventory.consumers.length !== expectedAuthorities.size)
    {
        throw new Error('semantic outcome consumer inventory is not migrated to canonical authorities');
    }
    const consumerIds = new Set();
    for (const consumer of inventory.consumers)
    {
        if (consumerIds.has(consumer?.id))
        {
            throw new Error('semantic outcome consumer inventory contains a duplicate owner');
        }
        consumerIds.add(consumer?.id);
        const authority = expectedAuthorities.get(consumer.id);
        sortedUnique(consumer.entrypoints, `${consumer.id}.entrypoints`);
        sortedUnique(consumer.outputSchemas, `${consumer.id}.outputSchemas`);
        if (!authority
            || consumer.candidateAuthorityIssue !== authority.issue
            || consumer.candidateProducerId !== authority.producerId
            || consumer.candidateProducerAuthorityId !== authority.authorityId
            || consumer.candidateSchema !== 'fsusblog.producer-semantic-outcome-candidate.v1'
            || consumer.candidateSchemaAuthority
                !== 'config/schemas/producer-semantic-outcome-candidate.schema.json'
            || consumer.attemptSchema !== 'fsusblog.test-attempt-receipt.v1'
            || consumer.aggregateSchema !== 'fsusblog.test-attempt-aggregate-receipt.v1'
            || !Array.isArray(consumer.rawEvidenceAccess)
            || consumer.rawEvidenceAccess.length !== 0
            || consumer.producerInvocation !== null
            || consumer.entrypoints.some((entrypoint) => !fs.existsSync(path.join(root, entrypoint))))
        {
            throw new Error(`${consumer.id} semantic outcome authority binding is invalid`);
        }
    }
    return inventory;
}

function referenceError(message, reference = null)
{
    return Object.freeze({
        code: 'candidate.external-authority-unverified',
        message,
        producerId: reference?.producerId ?? null,
        candidatePath: reference?.path ?? null
    });
}

function validateCandidateReference(reference, consumer)
{
    const keys = Object.keys(reference ?? {}).sort();
    const expectedKeys = [
        'authorityIssue',
        'contentDigest',
        'path',
        'producerId',
        'producerAuthorityId',
        'schema',
        'verificationReceiptDigest',
        'verificationReceiptPath'
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys.sort())
        || reference.authorityIssue !== consumer.candidateAuthorityIssue
        || reference.producerId !== consumer.candidateProducerId
        || reference.producerAuthorityId !== consumer.candidateProducerAuthorityId
        || reference.schema !== consumer.candidateSchema
        || typeof reference.path !== 'string' || !reference.path
        || typeof reference.verificationReceiptPath !== 'string'
        || !reference.verificationReceiptPath
        || !digestPattern.test(String(reference.contentDigest ?? ''))
        || !digestPattern.test(String(reference.verificationReceiptDigest ?? '')))
    {
        throw new Error(`${consumer.id} candidate reference is incomplete or crosses its authority`);
    }
    return reference;
}

function identityMismatch(reference, field, expected, actual)
{
    return Object.freeze({
        code: 'candidate.identity-mismatch',
        message: `${reference.producerId} ${field} expected ${expected}, got ${actual}`,
        producerId: reference.producerId,
        candidatePath: reference.path,
        field,
        expected,
        actual
    });
}

function validateExpectedIdentity(identity)
{
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
        || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(candidateIdentityFields))
    {
        throw new Error(`candidate expected identity must exactly contain ${candidateIdentityFields.join(', ')}`);
    }
    for (const field of [
        'buildIdentity',
        'executionEnvelopeDigest',
        'replayPlanDigest',
        'temporalContextDigest',
        'toolchainDigest',
        'worktreeFingerprint'
    ])
    {
        if (!digestPattern.test(String(identity[field] ?? '')))
        {
            throw new Error(`candidate expected identity ${field} must be SHA-256`);
        }
    }
    if (!/^[0-9a-f]{40}$/u.test(String(identity.sourceCommit ?? ''))
        || typeof identity.schedulerRunId !== 'string' || !identity.schedulerRunId
        || typeof identity.producerId !== 'string' || !identity.producerId)
    {
        throw new Error('candidate expected source/run/producer identity is invalid');
    }
    return identity;
}

function verifyExternalCandidate(reference, consumer, verifyCandidate, expectedIdentity)
{
    if (typeof verifyCandidate !== 'function')
    {
        return { verified: false, reasons: [referenceError('external candidate verifier is required', reference)] };
    }
    let verification;
    try
    {
        validateCandidateReference(reference, consumer);
        verification = verifyCandidate(reference);
    }
    catch (error)
    {
        return { verified: false, reasons: [referenceError(error.message, reference)] };
    }
    if (!verification || typeof verification !== 'object'
        || verification.verified !== true
        || verification.authorityIssue !== reference.authorityIssue
        || verification.producerId !== reference.producerId
        || verification.producerAuthorityId !== reference.producerAuthorityId
        || verification.candidateSchema !== reference.schema
        || verification.candidateDigest !== reference.contentDigest
        || verification.verificationReceiptDigest !== reference.verificationReceiptDigest)
    {
        return { verified: false, reasons: [referenceError(
            `${reference.producerId} candidate or owner verification digest does not match`,
            reference
        )] };
    }
    for (const [field, expected] of Object.entries(expectedIdentity))
    {
        if (expected !== undefined && verification.identity?.[field] !== expected)
        {
            return {
                verified: false,
                reasons: [identityMismatch(reference, field, expected, verification.identity?.[field])]
            };
        }
    }
    if (!verification.outcome || typeof verification.outcome !== 'object'
        || !Array.isArray(verification.outcome.reasons)
        || typeof verification.outcome.requiredMembershipVerified !== 'boolean')
    {
        return { verified: false, reasons: [referenceError(
            `${reference.producerId} owner verification omitted its canonical semantic outcome`,
            reference
        )] };
    }
    return { verified: true, verification };
}

export function admitSemanticOutcomeCleanAttempt({
    consumerId,
    candidateReference,
    verifyCandidate,
    attemptEvidence,
    expectedIdentity,
    rawEvidence = null,
    inventory = readSemanticOutcomeConsumerInventory()
})
{
    validateSemanticOutcomeConsumerInventory(inventory);
    const consumer = inventory.consumers.find((entry) => entry.id === consumerId);
    if (!consumer)
    {
        throw new Error(`unknown semantic outcome consumer: ${consumerId}`);
    }
    try
    {
        validateExpectedIdentity(expectedIdentity);
    }
    catch (error)
    {
        return Object.freeze({
            schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([referenceError(error.message, candidateReference)]),
            attemptVerdict: null
        });
    }
    const attemptVerdict = cleanFirstAttemptVerdict({
        ...attemptEvidence,
        expectedIdentity: {
            sourceCommit: expectedIdentity?.sourceCommit,
            worktreeFingerprint: expectedIdentity?.worktreeFingerprint,
            schedulerRunId: expectedIdentity?.schedulerRunId,
            producerId: expectedIdentity?.producerId
        },
        expectedAttemptIdentity: Object.fromEntries([
            'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'
        ].map((field) => [field, expectedIdentity[field]]))
    });
    if (!attemptVerdict.eligible)
    {
        return Object.freeze({
            schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: attemptVerdict.reasons,
            attemptVerdict
        });
    }
    if (rawEvidence !== null)
    {
        return Object.freeze({
            schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([{
                code: 'candidate.raw-evidence-conflict',
                message: `${consumerId} consumer cannot select raw manifest, path, status, summary, or log evidence over the canonical candidate`
            }]),
            attemptVerdict
        });
    }
    const candidate = verifyExternalCandidate(
        candidateReference,
        consumer,
        verifyCandidate,
        expectedIdentity
    );
    if (!candidate.verified)
    {
        return Object.freeze({
            schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze(candidate.reasons),
            attemptVerdict
        });
    }
    const attemptEligibility = candidate.verification.attemptEligibility;
    const attemptFields = ['aggregateDigest', 'attemptDigest', 'attemptNumber',
        'cleanFirstAttempt', 'firstFailure', 'qualificationEligible'];
    if (!attemptEligibility || typeof attemptEligibility !== 'object'
        || JSON.stringify(Object.keys(attemptEligibility).sort())
            !== JSON.stringify([...attemptFields].sort()))
    {
        return Object.freeze({
            schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([referenceError(
                `${candidateReference.producerId} owner verification omitted its canonical attempt binding`,
                candidateReference
            )]),
            attemptVerdict
        });
    }
    const verifiedAttemptBinding = {
        aggregateDigest: attemptVerdict.aggregate.contentDigest,
        attemptDigest: attemptVerdict.attempt.contentDigest,
        attemptNumber: attemptVerdict.attempt.attemptNumber,
        cleanFirstAttempt: attemptVerdict.aggregate.cleanFirstAttempt,
        firstFailure: attemptVerdict.attempt.firstFailure,
        qualificationEligible: attemptVerdict.aggregate.qualificationEligible
    };
    for (const field of attemptFields)
    {
        if (attemptEligibility[field] !== verifiedAttemptBinding[field])
        {
            return Object.freeze({
                schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
                consumerId,
                eligible: false,
                reasons: Object.freeze([{
                    ...identityMismatch(candidateReference, field,
                        verifiedAttemptBinding[field], attemptEligibility[field]),
                    code: 'candidate.attempt-binding-mismatch'
                }]),
                attemptVerdict
            });
        }
    }
    const outcome = candidate.verification.outcome;
    const outcomeShapeValid = ['blocked', 'cancelled', 'failed', 'success'].includes(outcome.status)
        && (outcome.status === 'success'
            ? outcome.requiredMembershipVerified === true && outcome.reasons.length === 0
            : outcome.requiredMembershipVerified === false && outcome.reasons.length > 0);
    if (!outcomeShapeValid)
    {
        return Object.freeze({
            schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([referenceError(
                `${candidateReference.producerId} canonical outcome status, membership, and reasons are inconsistent`,
                candidateReference
            )]),
            attemptVerdict
        });
    }
    const successful = outcome.status === 'success'
        && outcome.requiredMembershipVerified === true
        && outcome.reasons.length === 0;
    return Object.freeze({
        schema: 'fsusblog.semantic-outcome-clean-attempt-admission.v1',
        consumerId,
        eligible: successful,
        reasons: Object.freeze(successful ? [] : outcome.reasons),
        attemptVerdict,
        candidate: Object.freeze({
            authorityIssue: candidateReference.authorityIssue,
            producerId: candidateReference.producerId,
            producerAuthorityId: candidateReference.producerAuthorityId,
            schema: candidateReference.schema,
            path: candidateReference.path,
            contentDigest: candidateReference.contentDigest,
            verificationReceiptPath: candidateReference.verificationReceiptPath,
            verificationReceiptDigest: candidateReference.verificationReceiptDigest
        })
    });
}
