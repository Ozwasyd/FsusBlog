import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { RunEvidenceObjectStore } from './content-addressed-evidence-store.mjs';
import { schedulerRunLockActivity, schedulerRunOwnerIsComplete, verifySchedulerRunOwner } from './scheduler-run-owner.mjs';

const { digestValue } = await import(new URL('../release/browser-contract-receipt-contract.mjs', import.meta.url));
const { validateCorrectnessProvisionalReceipt } = await import(new URL('../release/correctness-provisional-receipt.mjs', import.meta.url));
const { createCorrectnessTerminalReceipt, verifyCorrectnessTerminalReceipt } = await import(new URL('../release/correctness-terminal-receipt.mjs', import.meta.url));
const { CorrectnessTerminalSealJournal } = await import(new URL('../release/correctness-terminal-seal-journal.mjs', import.meta.url));

function loadPacket(file)
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('correctness provisional packet must be an attempt-owned regular file');
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertActiveSealOwner(checkpointFile, checkpoint, owner)
{
    const activity = schedulerRunLockActivity({ runsRoot: path.dirname(path.dirname(checkpointFile)),
        runId: checkpoint.runId, targetTierId: checkpoint.targetTierId,
        candidateIdentityDigest: checkpoint.schedulerCandidateIdentityDigest });
    if (activity.status !== 'active' || activity.owner?.ownerToken !== owner?.ownerToken
        || checkpoint.schedulerRunOwnerToken !== owner?.ownerToken)
    {
        throw new Error('contract.correctness-seal-owner-not-active');
    }
}

function validateCurrentProvisional(initial, packet, requiredDependencyTierIds)
{
    if (Object.keys(packet).sort().join(',') !== 'context,provisional')
    {
        throw new Error('correctness provisional packet requires only context and provisional');
    }
    const { context, provisional } = packet;
    validateCorrectnessProvisionalReceipt(provisional, context);
    if (context.runId !== initial.runId || context.targetAttemptId !== initial.correctnessAttempt.targetAttemptId
        || context.createdFromCheckpointRevision !== initial.correctnessAttempt.createdFromCheckpointRevision
        || !isDeepStrictEqual(context.sourceState, initial.sourceState)
        || !isDeepStrictEqual(context.requiredDependencyTierIds, [...requiredDependencyTierIds].sort())
        || initial.releaseCandidateIdentity?.immutableBuildReceiptDigest !== context.buildReceiptDigest)
    {
        throw new Error('contract.correctness-provisional-binding-mismatch: run/source/attempt/build/closure');
    }
    for (const dependencyId of requiredDependencyTierIds)
    {
        const reference = initial.currentRunEvidenceReferences?.references
            ?.find((entry) => entry.consumerId === dependencyId);
        const supplied = context.dependencyTerminalReceipts.find((entry) => entry.reference.targetTierId === dependencyId);
        if (initial.tiers?.[dependencyId]?.status !== 'success'
            || initial.currentRunEvidenceReferences?.attemptId !== context.dependencyAttemptIds[dependencyId]
            || reference?.contentDigest !== supplied?.reference.digest)
        {
            throw new Error(`contract.correctness-dependency-not-terminal: ${dependencyId}`);
        }
    }
    return { context, provisional };
}

async function recoverCurrentSeal({ checkpointFile, canonical, owner, readCanonical, requiredDependencyTierIds, postflight })
{
    const checkpoint = canonical.checkpoint;
    const seal = checkpoint.correctnessTerminalSeal;
    if (checkpoint.correctnessAttempt.status !== 'finalized' || seal?.status !== 'finalized'
        || seal.targetAttemptId !== checkpoint.correctnessAttempt.targetAttemptId
        || !checkpoint.correctnessSealPacketRef || !checkpoint.correctnessFinalReceiptObjectRef)
    {
        throw new Error('contract.correctness-existing-seal-incomplete');
    }
    const store = new RunEvidenceObjectStore({ root: path.join(path.dirname(checkpointFile), 'evidence-store'),
        runId: checkpoint.runId, sourceState: checkpoint.sourceState });
    const journal = new CorrectnessTerminalSealJournal({ store, targetAttemptId: checkpoint.correctnessAttempt.targetAttemptId });
    const state = journal.state();
    if (!state || !['prepared', 'finalized'].includes(state.record.status)
        || state.record.packetRef !== checkpoint.correctnessSealPacketRef)
    {
        throw new Error('contract.correctness-existing-seal-not-current-or-rejected');
    }
    const packet = journal.readPacket(checkpoint.correctnessSealPacketRef);
    const { context } = validateCurrentProvisional(checkpoint,
        { context: packet.inputs.context, provisional: packet.inputs.provisional }, requiredDependencyTierIds);
    verifyCorrectnessTerminalReceipt({ ...packet.inputs, receipt: packet.receipt, finalizedCheckpoint: checkpoint });
    if (!isDeepStrictEqual(store.readObject(checkpoint.correctnessFinalReceiptObjectRef).value, packet.receipt))
    {
        throw new Error('contract.correctness-existing-seal-object-drift');
    }
    const currentChild = () =>
    {
        const current = readCanonical(checkpointFile);
        if (current?.checkpointDigest !== canonical.checkpointDigest
            || !isDeepStrictEqual(current.checkpoint, checkpoint))
        {
            throw new Error('contract.correctness-existing-seal-canonical-drift');
        }
        assertActiveSealOwner(checkpointFile, current.checkpoint, owner);
        return current.checkpoint;
    };
    await postflight(checkpoint, context);
    currentChild();
    const recovered = await journal.recover({ packetRef: checkpoint.correctnessSealPacketRef,
        readFinalizedCheckpoint(binding)
        {
            if (binding.runId !== checkpoint.runId || binding.targetAttemptId !== checkpoint.correctnessAttempt.targetAttemptId
                || binding.terminalParentRef !== seal.terminalParentRef || binding.finalReceiptDigest !== seal.finalReceiptDigest)
            {
                throw new Error('contract.correctness-existing-seal-recovery-binding-drift');
            }
            return currentChild();
        } });
    currentChild();
    return { ...recovered, checkpoint };
}

/** Called by runDag after command settlement and every registered scheduler cleanup, while its owner is finalizing. */
export async function finalizeSchedulerCorrectness({ checkpointFile, owner, readCanonical, commit,
    requiredDependencyTierIds, loadProvisional = loadPacket, postflight, faultInjector = () =>
    {} })
{
    let canonical = readCanonical(checkpointFile);
    const initial = canonical?.checkpoint;
    const attempt = initial?.correctnessAttempt;
    const tier = initial?.tiers?.['production-correctness'];
    if (!attempt || initial.status !== 'success' || initial.authoritative !== true || initial.candidateIdentityValidated !== true
        || tier?.status !== 'success' || tier.commandExitCode !== 0 || tier.outcomeValidated !== true
        || !['running', 'finalized'].includes(attempt.status)
        || tier.targetAttemptId !== attempt.targetAttemptId || initial.schedulerRunOwnerToken !== owner?.ownerToken)
    {
        throw new Error('contract.correctness-terminal-ineligible: current canonical command/attempt/authority');
    }
    assertActiveSealOwner(checkpointFile, initial, owner);
    // An explicit current reverse child may finish a prepared journal or retry its existing final.
    // No new parent/CAS, producer invocation, clock selection, or historical attempt scan is allowed.
    if (attempt.status === 'finalized' || initial.correctnessTerminalSeal || initial.correctnessSealPacketRef
        || initial.correctnessFinalReceiptObjectRef)
    {
        return recoverCurrentSeal({ checkpointFile, canonical, owner, readCanonical, requiredDependencyTierIds, postflight });
    }
    const packet = await loadProvisional(attempt.provisionalPacketFile, { checkpoint: structuredClone(initial) });
    const { context, provisional } = validateCurrentProvisional(initial, packet, requiredDependencyTierIds);
    await postflight(initial, context);
    canonical = commit({ checkpointFile, expectedRevision: canonical.checkpoint.revision,
        expectedDigest: canonical.checkpointDigest, owner, update(checkpoint)
        {
            const aggregate = checkpoint.tiers['production-correctness'];
            aggregate.buildReceiptDigest = context.buildReceiptDigest;
            aggregate.dependencyClosureDigest = provisional.dependencyClosureDigest;
            aggregate.checkpointCASCommitted = true;
            aggregate.postflightStatus = 'success';
        } });
    faultInjector('terminal-committed');
    const before = { ref: canonical.checkpointDigest, checkpoint: canonical.checkpoint };
    const afterCommit = readCanonical(checkpointFile);
    const snapshots = { before, after: { ref: afterCommit.checkpointDigest, checkpoint: afterCommit.checkpoint },
        expected: { runId: initial.runId, targetTierId: 'production-correctness', targetAttemptId: attempt.targetAttemptId,
            sourceState: initial.sourceState, buildReceiptDigest: context.buildReceiptDigest,
            dependencyClosureDigest: provisional.dependencyClosureDigest,
            checkpointRevision: before.checkpoint.revision, checkpointDigest: before.ref } };
    const aggregateTerminalReceipt = {
        schema: 'fsusblog.scheduler.terminal-receipt.v1', terminalState: 'success',
        runId: initial.runId, targetTierId: 'production-correctness', targetAttemptId: attempt.targetAttemptId,
        sourceState: initial.sourceState, buildReceiptDigest: context.buildReceiptDigest,
        dependencyClosureDigest: provisional.dependencyClosureDigest,
        terminalCheckpointRef: before.ref, commandExitCode: tier.commandExitCode,
        outcomeValidated: tier.outcomeValidated, contentDigest: null
    };
    aggregateTerminalReceipt.contentDigest = digestValue(aggregateTerminalReceipt);
    const inputs = { context, provisional, snapshots, aggregateTerminalReceipt, finalizedAt: new Date().toISOString() };
    const receipt = createCorrectnessTerminalReceipt(inputs);
    const store = new RunEvidenceObjectStore({ root: path.join(path.dirname(checkpointFile), 'evidence-store'),
        runId: initial.runId, sourceState: initial.sourceState });
    const journal = new CorrectnessTerminalSealJournal({ store, targetAttemptId: attempt.targetAttemptId });
    const prepared = journal.prepare(inputs);
    try
    {
        faultInjector('prepared');
        const finalObject = store.publishObject(receipt);
        faultInjector('final-object-written');
        await postflight(readCanonical(checkpointFile).checkpoint, context);
        const child = commit({ checkpointFile, expectedRevision: before.checkpoint.revision,
            expectedDigest: before.ref, owner, update(checkpoint)
            {
                checkpoint.correctnessSealPacketRef = prepared.packetRef;
                checkpoint.correctnessFinalReceiptObjectRef = finalObject.digest;
                checkpoint.correctnessAttempt.status = 'finalized';
                checkpoint.correctnessTerminalSeal = { status: 'finalized', runId: initial.runId,
                    targetTierId: 'production-correctness', targetAttemptId: attempt.targetAttemptId,
                    terminalParentRef: before.ref, finalReceiptRef: receipt.contentDigest,
                    finalReceiptDigest: receipt.contentDigest };
            } });
        faultInjector('reverse-committed');
        const finalized = journal.finalize({ packetRef: prepared.packetRef, finalizedCheckpoint: child.checkpoint });
        return { ...finalized, checkpoint: child.checkpoint };
    }
    catch (error)
    {
        try
        {
            if (journal.state()?.record.status === 'prepared')
            {
                journal.reject({ packetRef: prepared.packetRef, reasonCode: 'terminal-seal-commit-failed' });
            }
        }
        catch (rejectionError)
        {
            if (error instanceof Error && !Object.isFrozen(error))
            {
                error.correctnessSealRejectionError = rejectionError;
            }
        }
        throw error;
    }
}

/** Consumers must bind the current canonical child and completed owner, never an orphan final file. */
export function readCurrentSchedulerCorrectness({ checkpointFile, readCanonical })
{
    const canonical = readCanonical(checkpointFile);
    const checkpoint = canonical?.checkpoint;
    if (checkpoint?.status !== 'success' || checkpoint.authoritative !== true
        || checkpoint.correctnessTerminalSeal?.status !== 'finalized'
        || checkpoint.correctnessTerminalSeal.targetAttemptId !== checkpoint.correctnessAttempt?.targetAttemptId
        || !checkpoint.correctnessSealPacketRef || !checkpoint.correctnessFinalReceiptObjectRef)
    {
        throw new Error('contract.correctness-current-seal-unqualified');
    }
    const runDirectory = path.dirname(checkpointFile);
    const ownerFile = path.join(path.dirname(runDirectory), '.locks', '.terminal', checkpoint.runId,
        `${checkpoint.schedulerRunOwnerToken}.json`);
    const owner = loadPacket(ownerFile);
    const verification = verifySchedulerRunOwner(owner, { runId: checkpoint.runId,
        candidateIdentityDigest: checkpoint.schedulerCandidateIdentityDigest, targetTierId: checkpoint.targetTierId });
    if (!schedulerRunOwnerIsComplete(owner) || verification.status !== 'inactive' || owner.state !== 'complete')
    {
        throw new Error('contract.correctness-scheduler-owner-not-complete');
    }
    const store = new RunEvidenceObjectStore({ root: path.join(runDirectory, 'evidence-store'),
        runId: checkpoint.runId, sourceState: checkpoint.sourceState, readOnly: true });
    const journal = new CorrectnessTerminalSealJournal({ store, targetAttemptId: checkpoint.correctnessAttempt.targetAttemptId });
    const finalized = journal.resolve({ packetRef: checkpoint.correctnessSealPacketRef });
    if (!isDeepStrictEqual(finalized.finalizedCheckpoint, checkpoint)
        || finalized.receipt.contentDigest !== checkpoint.correctnessTerminalSeal.finalReceiptDigest
        || store.readObject(checkpoint.correctnessFinalReceiptObjectRef).value.contentDigest !== finalized.receipt.contentDigest)
    {
        throw new Error('contract.correctness-current-seal-readback-drift');
    }
    return finalized;
}
