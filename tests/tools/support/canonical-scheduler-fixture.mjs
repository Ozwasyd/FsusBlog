import fs from 'node:fs';
import path from 'node:path';

const { RunEvidenceObjectStore } = await import(new URL('../../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url));
const { schedulerReleaseCandidateRequiredFields } = await import(new URL('../../../tools/test-matrix/scheduler.mjs', import.meta.url));

/** A complete field roster with a controlled verifier, not a candidate admission or runtime receipt. */
export function controlledSchedulerCandidate(sourceState, buildReceiptDigest = `sha256:${'c'.repeat(64)}`)
{
    const value = Object.fromEntries(schedulerReleaseCandidateRequiredFields.map((field) => [field, null]));
    Object.assign(value, { schema: 'controlled.candidate.v1', identityVersion: 1,
        sourceCommit: sourceState.commit, worktreeFingerprint: sourceState.worktreeFingerprint,
        repositorySubmoduleOrAliasDigests: { ui: 'stable' }, immutableBuildReceiptDigest: buildReceiptDigest });
    delete value.candidateIdentityDigest;
    value.candidateIdentityDigest = digestValue(value);
    return value;
}

/** Controlled canonical source fixture; publication itself is not physical scheduler qualification. */
export function writeCanonicalSchedulerFixture(file, document)
{
    const checkpoint = JSON.parse(JSON.stringify({ schema: 'fsusblog.test-matrix.checkpoint.v1',
        status: 'running', revision: 1, ...document }));
    checkpoint.contentDigest = digestValue(checkpoint);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const store = new RunEvidenceObjectStore({ root: path.join(path.dirname(file), 'evidence-store'),
        runId: checkpoint.runId, sourceState: checkpoint.sourceState });
    const event = store.appendJournalEvent({ eventType: 'scheduler-state-updated', status: checkpoint.status,
        payload: { operations: [{ kind: 'set', path: [], value: checkpoint }] } });
    store.writeCompactCheckpoint({ stage: 'controlled-checkpoint', state: checkpoint, lastSequence: event.sequence });
    // Deliberately incomplete derived projection: callers must load canonical objects instead of this JSON.
    fs.writeFileSync(file, JSON.stringify(checkpoint) + '\n');
    return { checkpoint, store };
}
