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
    ['finalizer', { issue: 2656, producerId: 'release-finalizer-semantic-outcome' }],
    ['immutable-build', { issue: 2654, producerId: 'immutable-build-semantic-outcome' }],
    ['release-projection', { issue: 2655, producerId: 'release-projection-semantic-outcome' }]
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
        || inventory.migrationState !== 'pending-semantic-candidate-authorities'
        || inventory.qualificationEligible !== false
        || !Array.isArray(inventory.consumers)
        || inventory.consumers.length !== expectedAuthorities.size)
    {
        throw new Error('semantic outcome consumer inventory is not fail-closed');
    }
    for (const consumer of inventory.consumers)
    {
        const authority = expectedAuthorities.get(consumer.id);
        sortedUnique(consumer.entrypoints, `${consumer.id}.entrypoints`);
        sortedUnique(consumer.outputSchemas, `${consumer.id}.outputSchemas`);
        if (!authority
            || consumer.candidateAuthorityIssue !== authority.issue
            || consumer.candidateProducerId !== authority.producerId
            || consumer.candidateSchemaAuthority !== 'issue:#2020'
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
        'schema',
        'verificationReceiptDigest',
        'verificationReceiptPath'
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys.sort())
        || reference.authorityIssue !== consumer.candidateAuthorityIssue
        || reference.producerId !== consumer.candidateProducerId
        || typeof reference.schema !== 'string' || !reference.schema
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
    const consumer = inventory.consumers.find((entry) => entry.id === consumerId);
    if (!consumer)
    {
        throw new Error(`unknown semantic outcome consumer: ${consumerId}`);
    }
    const attemptVerdict = cleanFirstAttemptVerdict({
        ...attemptEvidence,
        expectedIdentity: {
            sourceCommit: expectedIdentity?.sourceCommit,
            worktreeFingerprint: expectedIdentity?.worktreeFingerprint,
            schedulerRunId: expectedIdentity?.schedulerRunId,
            producerId: expectedIdentity?.producerId
        }
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
        expectedIdentity ?? {}
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
    const outcome = candidate.verification.outcome;
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
            schema: candidateReference.schema,
            path: candidateReference.path,
            contentDigest: candidateReference.contentDigest,
            verificationReceiptPath: candidateReference.verificationReceiptPath,
            verificationReceiptDigest: candidateReference.verificationReceiptDigest
        })
    });
}
