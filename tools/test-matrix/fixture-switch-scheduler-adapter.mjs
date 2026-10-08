import { isDeepStrictEqual } from 'node:util';

const { digest, seal } = await import(new URL('../test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));

function requireExact(actual, expected, label)
{
    if (!isDeepStrictEqual(actual, expected))
    {
        throw new Error(`fixture switch scheduler ${label} differs from the requested current reference`);
    }
}

/** Read-only consumer of canonical scheduler objects; expected identities are mandatory, never selected from history. */
export async function readFixtureSwitchSchedulerObservation({ checkpointFile, expected, requireTerminal = false })
{
    const { readCanonicalSchedulerCheckpoint } = await import(new URL('./scheduler.mjs', import.meta.url));
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
    const before = readCanonicalSchedulerCheckpoint(checkpointFile, { repairProjection: false });
    const checkpoint = before.checkpoint;
    requireExact(before.checkpointDigest, expected.checkpointDigest, 'checkpoint');
    requireExact(before.lastSequence, expected.lastSequence, 'sequence');
    requireExact(checkpoint.runId, expected.runId, 'run');
    requireExact(checkpoint.sourceState, expected.sourceState, 'source');
    requireExact(checkpoint.releaseCandidateIdentity?.immutableBuildReceiptDigest, expected.buildReceiptDigest, 'build');
    requireExact(checkpoint.correctnessAttempt?.targetAttemptId, expected.targetAttemptId, 'attempt');
    let terminal = null;
    if (requireTerminal)
    {
        const { readCurrentSchedulerCorrectness } = await import(new URL('./scheduler-correctness-finalizer.mjs', import.meta.url));
        terminal = readCurrentSchedulerCorrectness({ checkpointFile, readCanonical: readCanonicalSchedulerCheckpoint });
        requireExact(terminal.finalizedCheckpoint, checkpoint, 'terminal child');
    }
    const after = readCanonicalSchedulerCheckpoint(checkpointFile, { repairProjection: false });
    requireExact(after.checkpointDigest, before.checkpointDigest, 'readback checkpoint');
    requireExact(after.lastSequence, before.lastSequence, 'readback sequence');
    requireExact(after.checkpoint, checkpoint, 'readback state');
    return seal({ schema: 'fsusblog.fixture-switch-scheduler-observation.v1',
        binding: structuredClone(expected), revision: checkpoint.revision,
        compactStateRef: before.compactStateRef, compactDigest: before.compactDigest,
        checkpoint: structuredClone(checkpoint), terminal: structuredClone(terminal),
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
    requireExact(evidence.context.source.commit, observation.binding.sourceState.commit, 'sequence source');
    // The switch contract uses a prefixed digest; canonical scheduler source identity uses the raw hex fingerprint.
    requireExact(evidence.context.source.worktreeFingerprint,
        `sha256:${observation.binding.sourceState.worktreeFingerprint}`, 'sequence worktree');
    requireExact(evidence.context.buildDigest, observation.binding.buildReceiptDigest, 'sequence build');
    return seal({ schema: 'fsusblog.fixture-switch-scheduler-source-binding.v1',
        schedulerObservationDigest: contentDigest, switchEvidenceDigest: evidence.contentDigest,
        binding: structuredClone(observation.binding), qualificationEligible: false,
        gaps: [...observation.gaps] });
}
