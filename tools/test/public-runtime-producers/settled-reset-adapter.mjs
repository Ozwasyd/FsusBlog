import path from 'node:path';
import { URL } from 'node:url';

const { digestCanonical, validateAggregateAttemptReceipt, verifyFileDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { consumeResetPostconditionReceipt, resetPostconditionAssertionIds, resetPostconditionReceiptSchema } = await import(new URL('../../test-matrix/reset-postcondition-verifier.mjs', import.meta.url));

export const notificationResetProducerId = 'reset-pre-notification-stream';
export const notificationResetAssertionId = 'pre-notification-stream-ready';

/** The reset is an executable hard prerequisite with a settled incoming edge, not a finalizer/join. */
export function publicRuntimeSettledResetContract()
{
    return Object.freeze({
        producerId: notificationResetProducerId,
        assertionId: notificationResetAssertionId,
        receiptSchema: resetPostconditionReceiptSchema,
        verifierModule: 'tools/test-matrix/reset-postcondition-verifier.mjs',
        verifierExport: 'consumeResetPostconditionReceipt',
        supported: resetPostconditionAssertionIds.has(notificationResetAssertionId)
    });
}

/**
 * Postflight adapter for the canonical executor owner. This does not execute a
 * command, create a receipt, or infer cleanliness from exit zero. The owner must
 * call it after validating the original attempt and before releasing successors.
 */
export function adaptPublicRuntimeSettledReset({ terminal, attemptResult, verifyAuthority, producerStep, reset, runIdentity, root })
{
    const contract = publicRuntimeSettledResetContract();
    if (!terminal || typeof terminal.terminalState !== 'string')
    {
        throw new Error('public runtime reset needs a canonical terminal outcome');
    }
    if (terminal.terminalState !== 'success')
    {
        return structuredClone(terminal);
    }
    if (producerStep?.id !== contract.producerId || reset?.producer !== contract.producerId
        || reset?.assertionId !== contract.assertionId || reset?.receiptSchema !== contract.receiptSchema)
    {
        throw new Error('public runtime reset owner/postcondition binding is incomplete');
    }
    if (attemptResult?.attempts?.length !== 1 || attemptResult.attempts[0].producerId !== contract.producerId
        || attemptResult.attempts[0].attemptNumber !== 1 || attemptResult.attempts[0].maxAttempts !== 1
        || attemptResult.attempts[0].retryPolicyId !== 'correctness-first-attempt')
    {
        throw new Error('public runtime reset needs its original exact-one correctness attempt');
    }
    validateAggregateAttemptReceipt(attemptResult.aggregate, {
        verifyAuthority,
        loadAttempt: () => attemptResult.attempts[0],
        verifyArtifact: (relative, digest, receipt) => verifyFileDigest(
            path.join(attemptResult.producerRoot, `attempt-${receipt.attemptNumber}`), relative, digest)
    });
    if (attemptResult.aggregate.cleanFirstAttempt !== true)
    {
        throw new Error('public runtime reset terminal differs from its original failed attempt');
    }
    if (!contract.supported)
    {
        throw new Error('canonical reset verifier has no pre-notification-stream postcondition capability');
    }
    const attempt = attemptResult.attempts[0];
    if (attempt.schedulerRunId !== runIdentity?.runId
        || attempt.sourceCommit !== runIdentity?.sourceState?.commit
        || attempt.worktreeFingerprint !== runIdentity?.sourceState?.worktreeFingerprint
        || !Array.isArray(producerStep.atomicCommand)
        || digestCanonical(attempt.command) !== digestCanonical(producerStep.atomicCommand))
    {
        throw new Error('public runtime reset attempt differs from the canonical run/source/command');
    }
    const observed = consumeResetPostconditionReceipt({ root, producerStep, reset, runIdentity });
    return {
        ...structuredClone(terminal),
        postconditionRef: { path: observed.file, contentDigest: digestCanonical(observed.receipt) }
    };
}
