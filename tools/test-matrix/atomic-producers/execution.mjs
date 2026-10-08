import fs from 'node:fs';
import path from 'node:path';

import { runProducerAttempts } from '../../test/attempt-runner.mjs';
import { digestCanonical, sealContentDigest, validateExternalAuthorityReferences } from '../../test/attempt-provenance.mjs';
import { buildSettledPhaseJoinEvidence, executeWeightedStepDag, StepDagExecutionError } from '../../test/bundles/bundle-steps.mjs';

import { verifyCompiledAtomicProducerDag } from './compiler.mjs';
import { isAtomicExecutable, resolveAtomicReplayPlan } from './contract.mjs';

export class AtomicProducerExecutionError extends Error
{
    constructor(vector, cause)
    {
        super('atomic producer DAG reached a non-success terminal state', { cause });
        this.name = 'AtomicProducerExecutionError';
        this.terminalVector = vector;
    }
}

function attemptOutcome(result)
{
    const receipt = result.attempts[0];
    if (result.attempts.length !== 1 || receipt.attemptNumber !== 1 || receipt.maxAttempts !== 1
        || receipt.retryPolicyId !== 'correctness-first-attempt')
    {
        throw new Error('atomic correctness execution did not produce exact-one zero-retry attempt');
    }
    const terminalState = result.aggregate.cleanFirstAttempt === true ? 'success'
        : receipt.failureKind === 'runner-timeout' ? 'timed-out'
            : receipt.failureKind === 'runner-cancelled' ? 'cancelled'
                : 'failed';
    return {
        terminalState,
        reasonCode: terminalState === 'success' ? 'clean-first-attempt' : receipt.failureKind,
        primaryFailureRefs: terminalState === 'success' ? [] : [receipt.producerId],
        evidenceRef: path.join(result.producerRoot, 'aggregate.json'),
        contentDigest: result.aggregate.contentDigest,
        startedAtMs: Date.parse(receipt.startedAt),
        finishedAtMs: Date.parse(receipt.finishedAt),
        durationMs: receipt.durationMs,
        logFile: path.join(result.producerRoot, 'attempt-1', 'stderr.log')
    };
}

function terminalVector(compiled, scheduler, attempts, context)
{
    const receipts = compiled.steps.map((step) =>
    {
        const terminal = scheduler.terminalReceipts[step.id];
        if (!terminal)
        {
            throw new Error(`missing scheduler terminal receipt: ${step.id}`);
        }
        const result = attempts.get(step.id);
        const receipt = result?.attempts[0];
        const blockedBy = terminal.terminalState === 'blocked'
            ? step.dependsOn.filter((id) => scheduler.states[id] !== 'success') : [];
        return sealContentDigest({
            schema: 'fsusblog.atomic-producer-terminal-receipt.v1',
            producerId: step.id,
            kind: step.kind,
            logicalParentId: step.logicalParentId,
            compiledDagDigest: compiled.contentDigest,
            schedulerRunId: context.schedulerRunId,
            sourceCommit: context.sourceCommit,
            worktreeFingerprint: context.worktreeFingerprint,
            terminalState: terminal.terminalState,
            reasonCode: terminal.reasonCode,
            primaryFailureRefs: terminal.primaryFailureRefs,
            blockedBy,
            attemptRef: result ? {
                path: path.join(result.producerRoot, 'attempt-1', 'receipt.json'),
                contentDigest: receipt.contentDigest
            } : null,
            aggregateAttemptRef: result ? {
                path: path.join(result.producerRoot, 'aggregate.json'),
                contentDigest: result.aggregate.contentDigest
            } : null,
            artifactRefs: receipt ? receipt.artifactPaths.map((relative) => ({
                path: path.join(result.producerRoot, 'attempt-1', relative),
                contentDigest: `sha256:${receipt.artifactDigests[relative]}`
            })) : [],
            evidenceRefs: terminal.evidenceRef === null ? [] : [{
                path: terminal.evidenceRef,
                contentDigest: terminal.contentDigest
            }],
            schedulerReceiptDigest: digestCanonical(terminal)
        });
    });
    return sealContentDigest({
        schema: 'fsusblog.atomic-producer-terminal-vector.v1',
        compiledDagDigest: compiled.contentDigest,
        matrixDigest: compiled.matrixDigest,
        schedulerRunId: context.schedulerRunId,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        qualificationEligible: false,
        status: receipts.every((receipt) => receipt.terminalState === 'success') ? 'success' : 'failed',
        receipts
    });
}

/**
 * Execute only declared children through the existing weighted DAG and runner.
 * Upstream reference verification remains with the external authority owners.
 * The returned vector is execution evidence, never release qualification.
 */
export async function executeCompiledAtomicProducerDag(compiled, options)
{
    const verified = verifyCompiledAtomicProducerDag(compiled, options.matrix, options.authorities);
    const { capacity, context, producerContexts, finalizerOperations } = options;
    if (!context || Object.keys(context).sort().join(',')
        !== ['evidenceRoot', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'].sort().join(',')
        || !/^[a-z][a-z0-9-]*$/u.test(context.schedulerRunId))
    {
        throw new Error('atomic execution requires a closed current-run context');
    }
    const currentCapacity = typeof capacity === 'function' ? capacity() : capacity;
    if (currentCapacity?.signal !== undefined && currentCapacity.signal !== null)
    {
        throw new Error('global-interrupt finalizer capability is unavailable in the shared weighted scheduler');
    }
    if (verified.steps.some((step) => step.executionClass === 'runtime') && !currentCapacity?.stateConflictPolicy)
    {
        throw new Error('runtime execution requires the canonical state conflict policy');
    }
    const preflight = new Map();
    for (const step of verified.steps)
    {
        if (!isAtomicExecutable(step))
        {
            if (step.alwaysRunFinalizer === true
                && (typeof finalizerOperations?.[step.operationRef.id]?.execute !== 'function'
                    || finalizerOperations[step.operationRef.id].contentDigest !== step.operationRef.contentDigest))
            {
                throw new Error(`missing finalizer capability: ${step.operationRef.id}`);
            }
            continue;
        }
        const supplied = producerContexts?.[step.id];
        if (!supplied || typeof supplied.verifyAuthority !== 'function')
        {
            throw new Error(`missing externally verified producer context: ${step.id}`);
        }
        const references = validateExternalAuthorityReferences(supplied.authorityReferences, supplied.verifyAuthority, {
            sourceCommit: context.sourceCommit,
            worktreeFingerprint: context.worktreeFingerprint,
            schedulerRunId: context.schedulerRunId,
            producerId: step.id
        });
        if (references.find((reference) => reference.kind === 'replay-plan').artifactDigest !== step.replayPlanRef.contentDigest)
        {
            throw new Error(`replay plan reference differs from compiled DAG: ${step.id}`);
        }
        const replay = resolveAtomicReplayPlan(options.authorities.replayPlans, step.replayPlanRef).plan;
        if (replay.source.commit !== context.sourceCommit || replay.source.worktreeFingerprint !== context.worktreeFingerprint
            || replay.run.id !== context.schedulerRunId || replay.command.environmentDigest !== digestCanonical(supplied.env))
        {
            throw new Error(`canonical replay source/run/environment differs from execution: ${step.id}`);
        }
        preflight.set(step.id, {
            evidenceRoot: context.evidenceRoot,
            schedulerRunId: context.schedulerRunId,
            sourceCommit: context.sourceCommit,
            worktreeFingerprint: context.worktreeFingerprint,
            cwd: supplied.cwd,
            env: supplied.env,
            timeoutMs: supplied.timeoutMs,
            signal: supplied.signal,
            authorityReferences: references,
            verifyAuthority: supplied.verifyAuthority,
            expectedTestIds: replay.testEnumerationOrder,
            producerId: step.id,
            retryPolicyId: step.attemptPolicyId,
            command: step.command
        });
    }
    const attempts = new Map();
    const results = new Map();
    const directory = path.join(context.evidenceRoot, context.schedulerRunId, 'atomic-dag', verified.contentDigest.slice(7));
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    const writeEvidence = (id, evidence) =>
    {
        const file = path.join(directory, `${id}.json`);
        fs.writeFileSync(file, `${JSON.stringify(evidence, null, 4)}\n`, { flag: 'wx', mode: 0o444 });
        return file;
    };
    let scheduler;
    let failure = null;
    try
    {
        scheduler = await executeWeightedStepDag(verified.steps, capacity, async (step) =>
        {
            let result;
            if (isAtomicExecutable(step))
            {
                const attempt = await runProducerAttempts(preflight.get(step.id));
                attempts.set(step.id, attempt);
                result = attemptOutcome(attempt);
            }
            else if (step.alwaysRunFinalizer === true)
            {
                // The installed owner performs cleanup/inventory only. No command
                // or attempt runner is exposed through this operation contract.
                await finalizerOperations[step.operationRef.id].execute(Object.freeze({
                    operationRef: step.operationRef,
                    dependencyOutcomes: Object.freeze({ ...step.dependencyOutcomes })
                }));
                const evidence = sealContentDigest({
                    producerId: step.id,
                    operationRef: step.operationRef,
                    dependencyOutcomes: step.dependencyOutcomes,
                    terminalState: 'success',
                    reasonCode: 'finalizer-completed'
                });
                result = { ...evidence, evidenceRef: writeEvidence(step.id, evidence) };
            }
            else
            {
                const join = buildSettledPhaseJoinEvidence({
                    stepId: step.id,
                    dependencyIds: Object.keys(step.dependencyOutcomes),
                    dependencyOutcomes: step.dependencyOutcomes,
                    dependencyResults: results,
                    evidenceRef: path.join(directory, `${step.id}.json`)
                });
                writeEvidence(step.id, join.evidence);
                result = { ...join.evidence, evidence: join.evidence };
            }
            results.set(step.id, result);
            return result;
        });
    }
    catch (error)
    {
        if (!(error instanceof StepDagExecutionError))
        {
            // The shared scheduler has no complete terminal vector for this
            // failure. Preserve its refusal rather than inventing receipts.
            throw error;
        }
        scheduler = error;
        failure = error;
    }
    const vector = terminalVector(verified, scheduler, attempts, context);
    fs.writeFileSync(path.join(directory, 'terminal-vector.json'), `${JSON.stringify(vector, null, 4)}\n`, { flag: 'wx', mode: 0o444 });
    if (failure)
    {
        throw new AtomicProducerExecutionError(vector, failure);
    }
    return vector;
}

export function verifyAtomicTerminalVector(vector, expected)
{
    const { contentDigest, ...body } = vector;
    if (digestCanonical(body) !== contentDigest || digestCanonical(vector) !== digestCanonical(expected))
    {
        throw new Error('atomic terminal vector content or expected identity mismatch');
    }
    return true;
}
