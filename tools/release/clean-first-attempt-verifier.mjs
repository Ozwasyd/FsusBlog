import {
    AttemptContractError,
    validateAggregateAttemptReceipt
} from '../test/attempt-provenance.mjs';

export const cleanFirstAttemptVerdictSchema = 'fsusblog.clean-first-attempt-verdict.v1';

function context(receipt)
{
    return {
        producerId: receipt?.producerId ?? null,
        schedulerRunId: receipt?.schedulerRunId ?? null,
        sourceCommit: receipt?.sourceCommit ?? null
    };
}

function reason(code, message, receipt, details = {})
{
    return Object.freeze({
        code,
        message,
        ...context(receipt),
        ...details
    });
}

function mismatch(receipt, field, expected, actual)
{
    return reason(
        'attempt.consumer-identity-mismatch',
        `${receipt?.producerId ?? 'unknown producer'}/${receipt?.schedulerRunId ?? 'unknown run'} ${field} expected ${expected}, got ${actual}`,
        receipt,
        { field, expected, actual }
    );
}

export class CleanFirstAttemptAdmissionError extends Error
{
    constructor(verdict)
    {
        super(verdict.reasons.map((item) => `${item.code}: ${item.message}`).join('; '));
        this.name = 'CleanFirstAttemptAdmissionError';
        this.verdict = verdict;
        this.reasons = verdict.reasons;
    }
}

export function cleanFirstAttemptVerdict({
    aggregateReceipt,
    loadAttempt,
    verifyAuthority,
    verifyArtifact,
    expectedIdentity = {}
})
{
    let aggregate;
    try
    {
        if (typeof verifyArtifact !== 'function')
        {
            throw new AttemptContractError(
                'attempt.artifact-verifier-missing',
                'clean-first-attempt admission requires an artifact verifier'
            );
        }
        aggregate = validateAggregateAttemptReceipt(aggregateReceipt, {
            loadAttempt,
            verifyAuthority,
            verifyArtifact
        });
    }
    catch (error)
    {
        const item = error instanceof AttemptContractError
            ? reason(error.reasonCode, error.message, aggregateReceipt, error.details)
            : reason('attempt.aggregate-invalid', error.message, aggregateReceipt);
        return Object.freeze({
            schema: cleanFirstAttemptVerdictSchema,
            eligible: false,
            reasons: Object.freeze([item]),
            aggregate: null,
            attempt: null
        });
    }

    for (const [field, expected] of Object.entries(expectedIdentity))
    {
        if (expected !== undefined && aggregate[field] !== expected)
        {
            return Object.freeze({
                schema: cleanFirstAttemptVerdictSchema,
                eligible: false,
                reasons: Object.freeze([mismatch(aggregate, field, expected, aggregate[field])]),
                aggregate,
                attempt: aggregate.attempts[0] ?? null
            });
        }
    }

    const attempt = aggregate.attempts[0];
    const isClean = aggregate.attempts.length === 1
        && attempt?.attemptNumber === 1
        && attempt.firstFailure === false
        && attempt.status === 'clean-success'
        && aggregate.firstAttemptStatus === 'clean-success'
        && aggregate.finalAttemptStatus === 'clean-success'
        && aggregate.finalClassification === 'clean-success'
        && aggregate.cleanFirstAttempt === true
        && aggregate.qualificationEligible === true
        && aggregate.policy.classification === 'correctness';
    if (!isClean)
    {
        return Object.freeze({
            schema: cleanFirstAttemptVerdictSchema,
            eligible: false,
            reasons: Object.freeze([reason(
                'attempt.not-clean-first',
                `${aggregate.producerId}/${aggregate.schedulerRunId} attempt ${attempt?.attemptNumber ?? 'missing'} is ${attempt?.status ?? 'missing'}; classification=${aggregate.finalClassification}, cleanFirstAttempt=${aggregate.cleanFirstAttempt}, qualificationEligible=${aggregate.qualificationEligible}`,
                aggregate,
                {
                    attemptNumber: attempt?.attemptNumber ?? null,
                    attemptStatus: attempt?.status ?? null,
                    finalClassification: aggregate.finalClassification,
                    cleanFirstAttempt: aggregate.cleanFirstAttempt,
                    qualificationEligible: aggregate.qualificationEligible
                }
            )]),
            aggregate,
            attempt
        });
    }

    return Object.freeze({
        schema: cleanFirstAttemptVerdictSchema,
        eligible: true,
        reasons: Object.freeze([]),
        aggregate,
        attempt
    });
}

export function requireCleanFirstAttempt(options)
{
    const verdict = cleanFirstAttemptVerdict(options);
    if (!verdict.eligible)
    {
        throw new CleanFirstAttemptAdmissionError(verdict);
    }
    return verdict;
}
