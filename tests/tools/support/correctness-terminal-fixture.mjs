const { digestValue } = await import(new URL('../../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url));
const { createCorrectnessProvisionalReceipt } = await import(new URL('../../../tools/release/correctness-provisional-receipt.mjs', import.meta.url));
const { createCorrectnessTerminalReceipt } = await import(new URL('../../../tools/release/correctness-terminal-receipt.mjs', import.meta.url));

export function seal(value)
{
    value.contentDigest = digestValue(value);
    return value;
}

export function fixture({ targetAttemptId = 'aggregate-attempt-a' } = {})
{
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const buildReceiptDigest = `sha256:${'c'.repeat(64)}`;
    const dependency = seal({ schema: 'controlled.owner-terminal.v1', status: 'success',
        runId: 'correctness-run', targetTierId: 'unit', targetAttemptId: 'unit-attempt-a', sourceState, buildReceiptDigest });
    const context = {
        runId: 'correctness-run', targetTierId: 'production-correctness', targetAttemptId,
        sourceState, buildReceiptDigest, createdFromCheckpointRevision: 3, aggregateStatus: 'running',
        requiredDependencyTierIds: ['unit'], dependencyAttemptIds: { unit: 'unit-attempt-a' },
        dependencyReceiptSchemas: { unit: dependency.schema },
        dependencyTerminalReceipts: [{ reference: { ref: dependency.contentDigest, digest: dependency.contentDigest,
            runId: dependency.runId, targetTierId: dependency.targetTierId, targetAttemptId: dependency.targetAttemptId }, receipt: dependency }],
        executedTierIds: ['production-correctness', 'unit'], jobSummaryRefs: [], physicalExecutionRefs: []
    };
    const provisional = createCorrectnessProvisionalReceipt(context);
    const tier = { status: 'success', targetAttemptId: context.targetAttemptId, buildReceiptDigest,
        dependencyClosureDigest: provisional.dependencyClosureDigest, commandExitCode: 0,
        outcomeValidated: true, checkpointCASCommitted: true, postflightStatus: 'success' };
    const checkpoint = seal({ schema: 'fsusblog.test-matrix.checkpoint.v1', runId: context.runId, sourceState,
        authoritative: true, status: 'running', revision: 4, tiers: { 'production-correctness': tier } });
    const before = { ref: checkpoint.contentDigest, checkpoint };
    const snapshots = { before, after: structuredClone(before), expected: {
        runId: context.runId, targetTierId: context.targetTierId, targetAttemptId: context.targetAttemptId,
        sourceState, buildReceiptDigest, dependencyClosureDigest: provisional.dependencyClosureDigest,
        checkpointRevision: checkpoint.revision, checkpointDigest: checkpoint.contentDigest
    } };
    const aggregateTerminalReceipt = seal({ schema: 'fsusblog.scheduler.terminal-receipt.v1', terminalState: 'success',
        runId: context.runId, targetTierId: context.targetTierId, targetAttemptId: context.targetAttemptId,
        sourceState, buildReceiptDigest, dependencyClosureDigest: provisional.dependencyClosureDigest,
        terminalCheckpointRef: checkpoint.contentDigest });
    const inputs = { context, provisional, snapshots, aggregateTerminalReceipt, finalizedAt: '2026-10-08T00:00:00.000Z' };
    const receipt = createCorrectnessTerminalReceipt(inputs);
    const finalizedCheckpoint = seal({ ...structuredClone(checkpoint), revision: 5, correctnessTerminalSeal: {
        status: 'finalized', runId: context.runId, targetTierId: context.targetTierId, targetAttemptId: context.targetAttemptId,
        terminalParentRef: checkpoint.contentDigest, finalReceiptRef: receipt.contentDigest, finalReceiptDigest: receipt.contentDigest
    } });
    return { ...inputs, receipt, finalizedCheckpoint };
}
