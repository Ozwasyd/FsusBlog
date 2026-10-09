import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const { digest, requireDigest, seal } = await import(new URL('../test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));

function requireExact(actual, expected, label)
{
    if (!isDeepStrictEqual(actual, expected))
    {
        throw new Error(`fixture switch scheduler ${label} differs from the requested current reference`);
    }
}

/** Read-only consumer of canonical scheduler objects; expected identities are mandatory, never selected from history. */
export async function readFixtureSwitchSchedulerObservation({ checkpointFile, expected: expectedInput, requireTerminal = false,
    committedEvidence: committedInput = null })
{
    const expected = structuredClone(expectedInput);
    const committedEvidence = structuredClone(committedInput);
    const resolvedCheckpointFile = path.resolve(checkpointFile);
    const { readCanonicalSchedulerCheckpoint, schedulerCommittedEvidenceReadbackVersion, verifyCommittedSchedulerEvidence } =
        await import(new URL('./scheduler.mjs', import.meta.url));
    if (typeof readCanonicalSchedulerCheckpoint !== 'function')
    {
        throw new Error('fixture switch requires the canonical scheduler checkpoint read capability');
    }
    if (!expected || !Number.isSafeInteger(expected.lastSequence) || expected.lastSequence <= 0
        || !expected.checkpointDigest || !expected.targetAttemptId || !expected.sourceState
        || !expected.runId || !expected.buildReceiptDigest)
    {
        throw new Error('fixture switch requires explicit sequence/checkpoint/run/source/build/attempt references');
    }
    const before = readCanonicalSchedulerCheckpoint(resolvedCheckpointFile);
    const checkpoint = before.checkpoint;
    requireExact(before.checkpointDigest, expected.checkpointDigest, 'checkpoint');
    requireExact(before.lastSequence, expected.lastSequence, 'sequence');
    requireExact(checkpoint.runId, expected.runId, 'run');
    requireExact(checkpoint.sourceState, expected.sourceState, 'source');
    requireExact(checkpoint.releaseCandidateIdentity?.immutableBuildReceiptDigest, expected.buildReceiptDigest, 'build');
    requireExact(checkpoint.correctnessAttempt?.targetAttemptId, expected.targetAttemptId, 'attempt');
    let committedReadback = null;
    if (committedEvidence !== null)
    {
        if (schedulerCommittedEvidenceReadbackVersion !== 1 || typeof verifyCommittedSchedulerEvidence !== 'function')
        {
            throw new Error('fixture switch requires the version 1 committed scheduler evidence read capability');
        }
        // The caller supplies the independently expected post-commit revision and registered wrapper contract.
        // Its evidence attempt is preserved separately from the aggregate target attempt above.
        committedReadback = verifyCommittedSchedulerEvidence({ ...committedEvidence, checkpointFile: resolvedCheckpointFile });
    }
    let terminal = null;
    if (requireTerminal)
    {
        const { readCurrentSchedulerCorrectness } = await import(new URL('./scheduler-correctness-finalizer.mjs', import.meta.url));
        terminal = readCurrentSchedulerCorrectness({ checkpointFile: resolvedCheckpointFile, readCanonical: readCanonicalSchedulerCheckpoint });
        requireExact(terminal.finalizedCheckpoint, checkpoint, 'terminal child');
    }
    const after = readCanonicalSchedulerCheckpoint(resolvedCheckpointFile);
    requireExact(after.checkpointDigest, before.checkpointDigest, 'readback checkpoint');
    requireExact(after.lastSequence, before.lastSequence, 'readback sequence');
    requireExact(after.checkpoint, checkpoint, 'readback state');
    const fingerprint = expected.sourceState.worktreeFingerprint;
    const switchFingerprint = /^[a-f0-9]{64}$/u.test(fingerprint) ? `sha256:${fingerprint}` : fingerprint;
    requireDigest(switchFingerprint, 'canonical scheduler source fingerprint');
    return seal({ schema: 'fsusblog.fixture-switch-scheduler-observation.v1',
        binding: structuredClone(expected), revision: checkpoint.revision,
        switchSource: { commit: expected.sourceState.commit, worktreeFingerprint: switchFingerprint },
        compactStateRef: before.compactStateRef, compactDigest: before.compactDigest,
        checkpoint: structuredClone(checkpoint), terminal: structuredClone(terminal),
        committedReadback: structuredClone(committedReadback),
        qualificationEligible: false,
        gaps: ['compiled switch admission/cleanup/empty observation authority', 'native same-runtime recovery qualification'] });
}

/** Recompute source-stage sequence materials and bind their source to the exact scheduler snapshot; phase admission remains upstream-owned. */
export async function bindFixtureSwitchSchedulerSourceEvidence({ observation, evidence, inputs })
{
    const { verifyFixtureSwitchEvidence } = await import(new URL('./fixture-switch-evidence.mjs', import.meta.url));
    const { contentDigest, ...body } = observation;
    requireExact(digest(body), contentDigest, 'observation digest');
    if (observation.qualificationEligible !== false)
    {
        throw new Error('fixture switch scheduler observation cannot qualify runtime acceptance');
    }
    verifyFixtureSwitchEvidence(evidence, inputs);
    requireExact(evidence.context.runId, observation.binding.runId, 'sequence run');
    requireExact(evidence.context.source, observation.switchSource, 'sequence source');
    requireExact(evidence.context.buildDigest, observation.binding.buildReceiptDigest, 'sequence build');
    return seal({ schema: 'fsusblog.fixture-switch-scheduler-source-binding.v1',
        schedulerObservationDigest: contentDigest, switchEvidenceDigest: evidence.contentDigest,
        binding: structuredClone(observation.binding), qualificationEligible: false,
        gaps: [...observation.gaps] });
}
