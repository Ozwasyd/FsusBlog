import { canonicalize, digestValue, isDigest, sourceStateErrors } from './browser-contract-receipt-contract.mjs';

export function correctnessAggregateAuthorityLevel(status)
{
    if (status === undefined || status === null || ['pending', 'admitted', 'running', 'finalizing'].includes(status))
    {
        return 'provisional';
    }
    if (status === 'success')
    {
        return 'terminal-success';
    }
    throw new Error(`production-correctness aggregate cannot seal evidence from status ${status}`);
}

function equal(actual, expected, field)
{
    if (expected === undefined || JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expected)))
    {
        throw new Error(`correctness terminal authority ${field} mismatch`);
    }
}

/** Validate a canonical-owner supplied snapshot; mutable checkpoint projections cannot supply this proof. */
export function validateCorrectnessTerminalSnapshot(snapshot, expected)
{
    if (!snapshot?.checkpoint || !expected || expected.targetTierId !== 'production-correctness'
        || typeof expected.runId !== 'string' || !expected.runId
        || typeof expected.targetAttemptId !== 'string' || !expected.targetAttemptId
        || !Number.isSafeInteger(expected.checkpointRevision) || expected.checkpointRevision < 1
        || !isDigest(expected.checkpointDigest) || !isDigest(expected.dependencyClosureDigest)
        || !isDigest(expected.buildReceiptDigest))
    {
        throw new Error('correctness terminal authority requires explicit canonical checkpoint and attempt binding');
    }
    const checkpoint = snapshot.checkpoint;
    equal(checkpoint.schema, 'fsusblog.test-matrix.checkpoint.v1', 'checkpoint schema');
    if (sourceStateErrors(expected.sourceState, 'sourceState').length > 0)
    {
        throw new Error('correctness terminal authority sourceState is invalid');
    }
    equal(snapshot.ref, expected.checkpointDigest, 'checkpoint ref');
    equal(checkpoint.contentDigest, expected.checkpointDigest, 'checkpoint digest');
    equal(checkpoint.contentDigest, digestValue(checkpoint), 'checkpoint content digest');
    equal(checkpoint.revision, expected.checkpointRevision, 'checkpoint revision');
    equal(checkpoint.runId, expected.runId, 'runId');
    equal(checkpoint.sourceState, expected.sourceState, 'sourceState');
    equal(checkpoint.authoritative, true, 'canonical authority');
    if (!['running', 'finalizing', 'success'].includes(checkpoint.status))
    {
        throw new Error('correctness terminal authority checkpoint run state is not eligible');
    }
    const tier = checkpoint.tiers?.[expected.targetTierId];
    if (correctnessAggregateAuthorityLevel(tier?.status) !== 'terminal-success')
    {
        throw new Error('correctness terminal authority requires aggregate terminal success');
    }
    for (const field of ['targetAttemptId', 'buildReceiptDigest', 'dependencyClosureDigest'])
    {
        equal(tier[field], expected[field], field);
    }
    equal(tier.commandExitCode, 0, 'commandExitCode');
    equal(tier.outcomeValidated, true, 'outcomeValidated');
    equal(tier.checkpointCASCommitted, true, 'checkpointCASCommitted');
    equal(tier.postflightStatus, 'success', 'postflightStatus');
    return snapshot;
}

/** Both owner reads must bind the same terminal commit; drift cannot be repaired by another attempt. */
export function createCorrectnessTerminalAuthority({ before, after, expected })
{
    validateCorrectnessTerminalSnapshot(before, expected);
    validateCorrectnessTerminalSnapshot(after, expected);
    equal(before, after, 'checkpoint read/commit drift');
    return {
        kind: 'scheduler-terminal-finalizer',
        status: 'success',
        authorityLevel: 'final',
        runId: expected.runId,
        targetTierId: expected.targetTierId,
        targetAttemptId: expected.targetAttemptId,
        sourceState: structuredClone(expected.sourceState),
        buildReceiptDigest: expected.buildReceiptDigest,
        dependencyClosureDigest: expected.dependencyClosureDigest,
        terminalCheckpointRef: before.ref,
        terminalCheckpointRevision: expected.checkpointRevision,
        terminalCheckpointDigest: expected.checkpointDigest
    };
}
