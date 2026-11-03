import { canonicalize, digestValue, isDigest } from './browser-contract-receipt-contract.mjs';
import { validateCorrectnessProvisionalReceipt } from './correctness-provisional-receipt.mjs';
import { createCorrectnessTerminalAuthority } from './correctness-scheduler-authority.mjs';

export const correctnessTerminalReceiptSchema = 'fsusblog.browserless-correctness-receipt.v2';

function equal(actual, expected, field)
{
    if (expected === undefined || JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expected)))
    {
        throw new Error(`correctness terminal receipt ${field} mismatch`);
    }
}

/** Pure construction only. The scheduler owns persistence and the finalized reverse-reference commit. */
export function createCorrectnessTerminalReceipt({
    provisional, context, snapshots, aggregateTerminalReceipt, finalizedAt
})
{
    validateCorrectnessProvisionalReceipt(provisional, context);
    const authority = createCorrectnessTerminalAuthority(snapshots);
    for (const field of ['runId', 'targetTierId', 'targetAttemptId', 'sourceState', 'buildReceiptDigest', 'dependencyClosureDigest'])
    {
        equal(authority[field], provisional[field], field);
    }
    if (authority.terminalCheckpointRevision <= provisional.createdFromCheckpointRevision)
    {
        throw new Error('correctness terminal receipt checkpoint must follow provisional revision');
    }
    const aggregate = aggregateTerminalReceipt;
    equal(aggregate?.schema, 'fsusblog.scheduler.terminal-receipt.v1', 'aggregate schema');
    equal(aggregate.terminalState, 'success', 'aggregateTerminalState');
    for (const field of ['runId', 'targetTierId', 'targetAttemptId', 'sourceState', 'buildReceiptDigest', 'dependencyClosureDigest'])
    {
        equal(aggregate[field], authority[field], `aggregate.${field}`);
    }
    equal(aggregate.terminalCheckpointRef, authority.terminalCheckpointRef, 'aggregate.terminalCheckpointRef');
    equal(aggregate.contentDigest, digestValue(aggregate), 'aggregate content digest');
    if (!isDigest(aggregate.contentDigest))
    {
        throw new Error('correctness terminal receipt aggregate digest is invalid');
    }
    if (typeof finalizedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(finalizedAt)
        || !Number.isFinite(Date.parse(finalizedAt)) || new Date(finalizedAt).toISOString() !== finalizedAt)
    {
        throw new Error('correctness terminal receipt finalizedAt requires an explicit UTC timestamp');
    }
    const receipt = {
        schema: correctnessTerminalReceiptSchema,
        status: 'success',
        qualificationEligible: true,
        producerAuthority: 'scheduler-terminal-finalizer',
        runId: authority.runId,
        targetTierId: authority.targetTierId,
        targetAttemptId: authority.targetAttemptId,
        sourceState: structuredClone(authority.sourceState),
        buildReceiptDigest: authority.buildReceiptDigest,
        provisionalReceiptRef: provisional.contentDigest,
        provisionalReceiptDigest: provisional.contentDigest,
        dependencyClosureDigest: authority.dependencyClosureDigest,
        terminalCheckpointRef: authority.terminalCheckpointRef,
        terminalCheckpointRevision: authority.terminalCheckpointRevision,
        terminalCheckpointDigest: authority.terminalCheckpointDigest,
        aggregateTerminalReceiptRef: aggregate.contentDigest,
        aggregateTerminalReceiptDigest: aggregate.contentDigest,
        aggregateTerminalState: 'success',
        finalizedAt,
        contentDigest: null
    };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

/** The immutable terminal parent avoids a circular digest; its finalized child explicitly names this final. */
export function verifyCorrectnessTerminalReceipt({ receipt, finalizedCheckpoint, ...inputs })
{
    const expected = createCorrectnessTerminalReceipt({ ...inputs, finalizedAt: receipt?.finalizedAt });
    equal(receipt, expected, 'sealed document');
    const checkpoint = finalizedCheckpoint;
    equal(checkpoint?.schema, 'fsusblog.test-matrix.checkpoint.v1', 'finalized checkpoint schema');
    equal(checkpoint.contentDigest, digestValue(checkpoint), 'finalized checkpoint content digest');
    equal(checkpoint.runId, receipt.runId, 'finalized checkpoint runId');
    equal(checkpoint.sourceState, receipt.sourceState, 'finalized checkpoint sourceState');
    equal(checkpoint.authoritative, true, 'finalized checkpoint authority');
    if (!['running', 'finalizing', 'success'].includes(checkpoint.status))
    {
        throw new Error('correctness terminal receipt finalized checkpoint run state is not eligible');
    }
    equal(checkpoint.revision, receipt.terminalCheckpointRevision + 1, 'finalized checkpoint revision');
    const tier = checkpoint.tiers?.[receipt.targetTierId];
    equal(tier?.status, 'success', 'finalized aggregate status');
    for (const field of ['targetAttemptId', 'buildReceiptDigest', 'dependencyClosureDigest'])
    {
        equal(tier[field], receipt[field], `finalized aggregate ${field}`);
    }
    equal(checkpoint.correctnessTerminalSeal, {
        status: 'finalized',
        runId: receipt.runId,
        targetTierId: receipt.targetTierId,
        targetAttemptId: receipt.targetAttemptId,
        terminalParentRef: receipt.terminalCheckpointRef,
        finalReceiptRef: receipt.contentDigest,
        finalReceiptDigest: receipt.contentDigest
    }, 'finalized checkpoint reverse ref');
    return { status: 'verified', receiptDigest: receipt.contentDigest,
        finalizedCheckpointDigest: checkpoint.contentDigest };
}
