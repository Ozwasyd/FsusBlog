import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { commitSchedulerCheckpointCAS, readCanonicalSchedulerCheckpoint, readCanonicalSchedulerResourceGrant,
    runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { acquireSchedulerRunLock, schedulerCandidateIdentityDigest } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-grant-generation-'));
    const runId = 'grant-run';
    const runsRoot = path.join(root, 'runs');
    const checkpointFile = path.join(runsRoot, runId, 'checkpoint.json');
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'controlled-source' };
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({ runId, targetTierId: 'nested',
        namespace: 'test-matrix', sourceState });
    const owner = acquireSchedulerRunLock({ runsRoot, runId, targetTierId: 'nested', candidateIdentityDigest });
    owner.markRunning();
    t.after(() =>
    {
        if (fs.existsSync(path.join(runsRoot, '.locks', `${runId}.lock`)))
        {
            owner.finalize('failed');
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    // Controlled source contract using a real active owner and immutable store; no nested conformance is claimed.
    const document = { schema: 'fsusblog.test-matrix.resource-grants.v1', runId, sourceState,
        schedulerOwnerToken: owner.owner.ownerToken, generation: 1, schedulerCheckpointRevision: 1,
        resourceBudget: { cpuUnits: 6, memoryGiB: 12 }, residentReservation: { cpuUnits: 0, memoryGiB: 0 },
        grants: { nested: { cpuUnits: 2, memoryGiB: 4 } }, generatedAt: new Date().toISOString() };
    writeCanonicalSchedulerFixture(checkpointFile, { runId, targetTierId: 'nested', sourceState,
        schedulerCandidateIdentityDigest: candidateIdentityDigest, schedulerRunOwnerToken: owner.owner.ownerToken,
        authoritative: false, tiers: {}, resourceUtilization: { resourceGrants: document } });
    const projection = path.join(path.dirname(checkpointFile), 'resource-grants.json');
    fs.writeFileSync(projection, JSON.stringify(document));
    const options = { checkpointFile, runId, tierId: 'nested', ownerToken: owner.owner.ownerToken };
    return { root, options, owner, document, projection };
}

test('canonical grant reader binds active owner and exact generation without granting qualification', (t) =>
{
    const current = fixture(t);
    const read = readCanonicalSchedulerResourceGrant(current.options);
    assert.equal(read.generation, 1);
    assert.deepEqual(read.grant, { cpuUnits: 2, memoryGiB: 4 });
    assert.equal(read.qualificationEligible, false);
    for (const changed of [{ runId: 'other' }, { ownerToken: 'other' }, { tierId: 'other' },
        { minimumGeneration: 2 }, { expectedGeneration: 2 }])
    {
        assert.throws(() => readCanonicalSchedulerResourceGrant({ ...current.options, ...changed }),
            /identity-mismatch|generation-mismatch|tier-or-envelope-invalid/u);
    }
});

test('old, corrupt and wrong-run grant projections fail instead of retaining historical capacity', (t) =>
{
    const current = fixture(t);
    for (const document of ['{broken', JSON.stringify({ ...current.document, generation: 0 }),
        JSON.stringify({ ...current.document, runId: 'other' }),
        JSON.stringify({ ...current.document, grants: { nested: { cpuUnits: 6, memoryGiB: 12 } } })])
    {
        fs.writeFileSync(current.projection, document);
        assert.throws(() => readCanonicalSchedulerResourceGrant(current.options));
    }
});

test('canonical generation changes survive CAS and reject stale readers and inactive owner', (t) =>
{
    const current = fixture(t);
    const canonical = readCanonicalSchedulerCheckpoint(current.options.checkpointFile);
    const committed = commitSchedulerCheckpointCAS({ checkpointFile: current.options.checkpointFile,
        expectedRevision: canonical.checkpoint.revision, expectedDigest: canonical.checkpointDigest,
        owner: current.owner.owner, update(checkpoint)
        {
            checkpoint.resourceUtilization.resourceGrants.generation = 2;
            checkpoint.resourceUtilization.resourceGrants.schedulerCheckpointRevision = checkpoint.revision + 1;
            checkpoint.resourceUtilization.resourceGrants.grants.nested = { cpuUnits: 6, memoryGiB: 12 };
        } });
    assert.throws(() => readCanonicalSchedulerResourceGrant(current.options), /projection-drift/u);
    fs.writeFileSync(current.projection, JSON.stringify(committed.checkpoint.resourceUtilization.resourceGrants));
    assert.equal(readCanonicalSchedulerResourceGrant({ ...current.options, minimumGeneration: 2 }).generation, 2);
    assert.throws(() => readCanonicalSchedulerResourceGrant({ ...current.options, expectedGeneration: 1 }), /generation-mismatch/u);
    current.owner.markFinalizing();
    assert.equal(current.owner.finalize('complete'), true);
    assert.throws(() => readCanonicalSchedulerResourceGrant(current.options), /owner-inactive/u);
});

test('existing scheduler writer journals monotonic grant generations while controlled execution remains unqualified', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-real-grant-writer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = await runDag({ root, runsRoot: path.join(root, 'runs'), runId: 'writer-run',
        targetTierId: 'writer', sourceState: { commit: 'b'.repeat(40), worktreeFingerprint: 'controlled' },
        snapshotWorktree: async () => ({ fingerprint: 'controlled', entries: new Map() }), dynamicPriority: false,
        systemResources: { cpuCount: 2, availableMemoryGiB: 8, load1: 0 }, currentFreeMemoryGiB: () => 8,
        executeTier: async () => ({ code: 0, signal: null }),
        tiers: [{ id: 'writer', command: 'echo writer', cacheInputs: [], executionDependsOn: [], services: [],
            parallelizable: true, exclusiveResources: [], resourceClass: 'cpu', cpuUnits: 1, memoryGiB: 1 }] });
    assert.equal(result.checkpoint.authoritative, false);
    const final = result.checkpoint.resourceUtilization.resourceGrants;
    assert.ok(final.generation >= 2);
    assert.ok(final.schedulerCheckpointRevision <= result.checkpoint.revision);
    const journal = fs.readFileSync(path.join(result.runDirectory, 'evidence-store', 'journals', 'writer-run.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
    const updates = journal.filter((event) => event.eventType === 'resource-grants-updated');
    assert.ok(updates.length >= 2);
    const store = new RunEvidenceObjectStore({ root: path.join(result.runDirectory, 'evidence-store'),
        runId: result.runId, sourceState: result.checkpoint.sourceState, readOnly: true });
    const generations = updates.flatMap((event) => store.readObject(event.payloadDigest).value.operations
        .filter((operation) => operation.kind === 'set' && operation.path.join('.') === 'resourceUtilization.resourceGrants.generation')
        .map((operation) => operation.value));
    assert.deepEqual(generations, generations.map((_value, index) => index + 2));
    assert.equal(generations.at(-1), final.generation);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.runDirectory, 'resource-grants.json'), 'utf8')), final);
});
