import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {runDag} = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const {EVIDENCE_TERMINAL_HANDOFF_PREFIX, beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication} = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const {governanceContentDigest} = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const {attachCurrentRunEvidenceReferenceToCheckpoint} = await import(new URL('../../tools/test/current-run-evidence-checkpoint.mjs', import.meta.url));
const {RunEvidenceObjectStore} = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));
const d = (value) => `sha256:${value.repeat(64)}`;

test('scheduler recordSettled consumes the producer terminal handoff into its current-attempt checkpoint', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-evidence-scheduler-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true });
    const runId = 'evidence-scheduler-run';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: d('b') };
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId,
        attemptId: 'attempt-1', sourceCommit: sourceState.commit,
        worktreeFingerprint: sourceState.worktreeFingerprint,
        candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run']
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const contextPath = 'artifacts/current-run/context.json';
    fs.writeFileSync(path.join(root, contextPath), `${JSON.stringify(context)}\n`);
    const entry = {
        consumerId: 'consumer', authorityId: 'authority', producerId: 'producer',
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], publicationMode: 'hooked',
        producerSource: 'producer.mjs', producerCallsite: 'caller.mjs',
        producerBindingClass: 'cli',
        producerExecutable: 'node caller.mjs', producerCommand: 'node --import hook caller.mjs',
        outputBindingKey: 'FSUSBLOG_TEST_EVIDENCE_PATH',
        handoffBindingKey: 'FSUSBLOG_TEST_EVIDENCE_HANDOFF_PATH',
        payloadBindingKey: 'FSUSBLOG_TEST_EVIDENCE_PAYLOAD_PATH', checkpointCommand: 'checkpoint'
    };
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] };
    fs.writeFileSync(path.join(root, 'config/testing/evidence-locator-registry.json'),
        `${JSON.stringify({ ...registryBody, contentDigest: governanceContentDigest(registryBody) })}\n`);
    const outputPath = 'artifacts/current-run/reference.json';
    const payloadPath = 'artifacts/current-run/payload.json';
    const result = await runDag({
        tiers: [{
            id: 'producer-tier', command: 'fixture producer', executionDependsOn: [],
            requiresEvidenceFrom: [], artifacts: [], evidence: [], resourceClass: 'cpu',
            maxParallel: 1, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [],
            executionKey: 'test/producer-tier', executionVariant: 'ordinary', coverage: ['ordinary-unit']
        }],
        root,
        runsRoot: path.join(root, 'runs'),
        runId,
        sourceState,
        env: { FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextPath },
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
        executeTier: async (_tier, execution) =>
        {
            const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId,
                context, outputPath, payloadPath, producerId: entry.producerId, repositoryRoot: root });
            fs.writeFileSync(path.join(root, payloadPath), `${JSON.stringify({ schema: 'payload.v1', ok: true })}\n`);
            const finalized = finalizeCurrentRunEvidencePublication({ authorityId: entry.authorityId,
                context, outputPath, payloadPath, payloadSchema: 'payload.v1', producerId: entry.producerId,
                repositoryRoot: root, sessionId: session.sessionId, terminalStatus: 'success' });
            execution.writeOutput(`${EVIDENCE_TERMINAL_HANDOFF_PREFIX}${JSON.stringify(finalized.handoff)}\n`);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    const checkpoint = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.currentRunEvidenceReferences.references.length, 1);
    assert.equal(checkpoint.currentRunEvidenceReferences.references[0].authorityId, entry.authorityId);
    assert.equal(checkpoint.currentRunEvidenceReferences.references[0].inputDigest,
        JSON.parse(fs.readFileSync(path.join(root, `${outputPath}.handoff.json`), 'utf8')).inputDigest);
});

function checkpointAttachmentFixture(t, producerNames = ['first', 'second'])
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-evidence-checkpoint-cas-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true });
    const runId = 'checkpoint-cas-run';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: d('b') };
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId,
        attemptId: 'attempt-1', sourceCommit: sourceState.commit,
        worktreeFingerprint: sourceState.worktreeFingerprint,
        candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run']
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const contextPath = 'artifacts/current-run/context.json';
    fs.writeFileSync(path.join(root, contextPath), `${JSON.stringify(context)}\n`);
    const entries = producerNames.map((name) => ({
        consumerId: `consumer-${name}`, authorityId: `authority-${name}`, producerId: `producer-${name}`,
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], publicationMode: 'hooked',
        producerSource: `producer-${name}.mjs`, producerCallsite: `caller-${name}.mjs`,
        producerBindingClass: 'cli', producerExecutable: `node caller-${name}.mjs`,
        producerCommand: `node --import hook caller-${name}.mjs`,
        outputBindingKey: `FSUSBLOG_${name.toUpperCase()}_EVIDENCE_PATH`,
        handoffBindingKey: `FSUSBLOG_${name.toUpperCase()}_HANDOFF_PATH`,
        payloadBindingKey: `FSUSBLOG_${name.toUpperCase()}_PAYLOAD_PATH`,
        checkpointCommand: `node tools/test/attach-current-run-evidence-checkpoint.mjs --consumer consumer-${name}`
    }));
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries };
    const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
    fs.writeFileSync(path.join(root, 'config/testing/evidence-locator-registry.json'), `${JSON.stringify(registry)}\n`);
    const handoffs = entries.map((entry, index) =>
    {
        const outputPath = `artifacts/current-run/reference-${index}.json`;
        const payloadPath = `artifacts/current-run/payload-${index}.json`;
        const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId,
            context, outputPath, payloadPath, producerId: entry.producerId, repositoryRoot: root });
        fs.writeFileSync(path.join(root, payloadPath), `${JSON.stringify({ schema: 'payload.v1', value: index })}\n`);
        return finalizeCurrentRunEvidencePublication({ authorityId: entry.authorityId,
            context, outputPath, payloadPath, payloadSchema: 'payload.v1', producerId: entry.producerId,
            repositoryRoot: root, sessionId: session.sessionId, terminalStatus: 'success' }).handoff;
    });
    const checkpointPath = path.join(root, 'runs', runId, 'checkpoint.json');
    const options = {
        tiers: [{ id: 'producer-tier', command: 'fixture producer', executionDependsOn: [],
            requiresEvidenceFrom: [], artifacts: [], evidence: [], resourceClass: 'cpu',
            maxParallel: 1, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [],
            executionKey: 'test/producer-tier', executionVariant: 'ordinary', coverage: ['ordinary-unit'] }],
        root, runsRoot: path.join(root, 'runs'), runId, sourceState,
        env: { FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextPath },
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} })
    };
    const attach = (index, expectedRevision) => attachCurrentRunEvidenceReferenceToCheckpoint({
        checkpointPath, context, entry: entries[index], handoff: handoffs[index], registry,
        repositoryRoot: root, expectedRevision
    });
    return { options, checkpointPath, handoffs, entries, attach, context, registry };
}

function attachInAnotherProcess(fixture, index, expectedRevision)
{
    const moduleUrl = new URL('../../tools/test/current-run-evidence-checkpoint.mjs', import.meta.url).href;
    const input = {
        checkpointPath: fixture.checkpointPath, context: fixture.context,
        entry: fixture.entries[index], handoff: fixture.handoffs[index], registry: fixture.registry,
        repositoryRoot: fixture.options.root, expectedRevision
    };
    const script = `
        import fs from 'node:fs';
        const { attachCurrentRunEvidenceReferenceToCheckpoint } = await import(${JSON.stringify(moduleUrl)});
        const input = JSON.parse(fs.readFileSync(0, 'utf8'));
        try {
            const checkpoint = await attachCurrentRunEvidenceReferenceToCheckpoint(input);
            process.stdout.write(JSON.stringify({ ok: true, checkpoint }));
        } catch (error) {
            process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
        }
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000
    }));
}

function attachmentStore(fixture)
{
    return new RunEvidenceObjectStore({ root: path.join(path.dirname(fixture.checkpointPath), 'evidence-store'),
        runId: fixture.options.runId, sourceState: fixture.options.sourceState });
}

function assertLastReferenceAppend(fixture, expectedAuthority)
{
    const store = attachmentStore(fixture);
    const event = store.readJournal().at(-1);
    assert.equal(event.eventType, 'current-run-evidence-attached');
    const payload = store.readObject(event.payloadDigest).value;
    const operation = payload.operations.find((value) => JSON.stringify(value.path)
        === JSON.stringify(['currentRunEvidenceReferences', 'references']));
    assert.equal(operation.kind, 'append');
    assert.deepEqual(operation.values.map((reference) => reference.authorityId), [expectedAuthority]);
}

test('locked scheduler ingests both verified producer handoffs without a child checkpoint writer', async (t) =>
{
    const fixture = checkpointAttachmentFixture(t);
    const result = await runDag({ ...fixture.options, executeTier: async (_tier, execution) =>
    {
        // A standalone writer cannot enter its parent's run ownership. The
        // legitimate producer path still hands both refs to recordSettled.
        const before = fs.readFileSync(fixture.checkpointPath);
        await assert.rejects(fixture.attach(0), /already active|owner-unverifiable/u);
        assert.deepEqual(fs.readFileSync(fixture.checkpointPath), before);
        for (const handoff of fixture.handoffs)
        {
            execution.writeOutput(`${EVIDENCE_TERMINAL_HANDOFF_PREFIX}${JSON.stringify(handoff)}\n`);
        }
        return { code: 0, signal: null };
    } });
    assert.equal(result.status, 'success');
    const checkpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8'));
    assert.deepEqual(checkpoint.currentRunEvidenceReferences.references.map((entry) => entry.authorityId),
        fixture.entries.map((entry) => entry.authorityId));
});

test('standalone checkpoint attachments append through the original journal and reject stale revisions', async (t) =>
{
    const fixture = checkpointAttachmentFixture(t);
    const run = await runDag({ ...fixture.options, executeTier: async () => ({ code: 0, signal: null }) });
    assert.equal(run.status, 'success');
    const original = JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8'));
    assert.deepEqual(original.currentRunEvidenceReferences.references, []);
    const first = await fixture.attach(0, original.revision);
    assert.equal(first.revision, original.revision + 1);
    const firstBytes = fs.readFileSync(fixture.checkpointPath);
    await assert.rejects(fixture.attach(1, original.revision), /does not match expected revision/u);
    assert.deepEqual(fs.readFileSync(fixture.checkpointPath), firstBytes);
    const second = await fixture.attach(1, first.revision);
    assert.equal(second.revision, first.revision + 1);
    assert.deepEqual(second.currentRunEvidenceReferences.references.map((entry) => entry.authorityId),
        fixture.entries.map((entry) => entry.authorityId));
    const finalBytes = fs.readFileSync(fixture.checkpointPath);
    await assert.rejects(fixture.attach(0, second.revision), /already contains this authority/u);
    assert.deepEqual(fs.readFileSync(fixture.checkpointPath), finalBytes);
    assert.ok(fs.existsSync(path.join(path.dirname(fixture.checkpointPath), 'evidence-store', 'checkpoints',
        `${fixture.options.runId}.json`)));
});

test('simultaneous valid checkpoint writers cannot both consume one expected revision', async (t) =>
{
    const fixture = checkpointAttachmentFixture(t);
    const run = await runDag({ ...fixture.options, executeTier: async () => ({ code: 0, signal: null }) });
    assert.equal(run.status, 'success');
    const revision = JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8')).revision;
    const results = await Promise.allSettled([fixture.attach(0, revision), fixture.attach(1, revision)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.match(rejected.reason.message, /does not match expected revision|already active|owner-unverifiable/u);
    const checkpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8'));
    assert.equal(checkpoint.revision, revision + 1);
    assert.equal(checkpoint.currentRunEvidenceReferences.references.length, 1);
});

test('writer A then process B then writer A binds each journal patch to the freshly locked baseline', async (t) =>
{
    const fixture = checkpointAttachmentFixture(t, ['first', 'second', 'third']);
    const run = await runDag({ ...fixture.options, executeTier: async () => ({ code: 0, signal: null }) });
    assert.equal(run.status, 'success');
    const first = await fixture.attach(0, run.checkpoint.revision);
    const other = attachInAnotherProcess(fixture, 1, first.revision);
    assert.equal(other.ok, true);
    assert.deepEqual(other.checkpoint.currentRunEvidenceReferences.references.map((entry) => entry.authorityId),
        fixture.entries.slice(0, 2).map((entry) => entry.authorityId));
    const last = await fixture.attach(2, other.checkpoint.revision);
    assert.deepEqual(last.currentRunEvidenceReferences.references.map((entry) => entry.authorityId),
        fixture.entries.map((entry) => entry.authorityId));
    // Compact publication alone would hide a stale cached patch. Verify the
    // actual durable payload contains only C, not the previously committed B.
    assertLastReferenceAppend(fixture, fixture.entries[2].authorityId);
});

test('a fresh process recovers the durable attachment after compact publication fails without duplicating prior refs', async (t) =>
{
    const fixture = checkpointAttachmentFixture(t, ['first', 'second', 'third', 'z-last']);
    const run = await runDag({ ...fixture.options, executeTier: async () => ({ code: 0, signal: null }) });
    assert.equal(run.status, 'success');
    const first = await fixture.attach(0, run.checkpoint.revision);
    const other = attachInAnotherProcess(fixture, 1, first.revision);
    assert.equal(other.ok, true);
    const before = fs.readFileSync(fixture.checkpointPath);
    const store = attachmentStore(fixture);
    const compactBefore = fs.readFileSync(path.join(store.checkpointsDirectory, `${fixture.options.runId}.json`));
    const journalSequence = store.readJournal().at(-1).sequence;
    const originalCompactWriter = RunEvidenceObjectStore.prototype.writeCompactCheckpoint;
    const failure = new Error('fixture compact publication interrupted after durable attachment');
    t.mock.method(RunEvidenceObjectStore.prototype, 'writeCompactCheckpoint', function (options)
    {
        if (this.runId === fixture.options.runId && options.stage === 'current-run-evidence-attached')
        {
            throw failure;
        }
        return originalCompactWriter.call(this, options);
    });
    await assert.rejects(fixture.attach(2, other.checkpoint.revision), (error) => error === failure);
    t.mock.restoreAll();
    assert.deepEqual(fs.readFileSync(fixture.checkpointPath), before);
    assert.deepEqual(fs.readFileSync(path.join(store.checkpointsDirectory, `${fixture.options.runId}.json`)), compactBefore);
    assert.equal(store.readJournal().at(-1).sequence, journalSequence + 1);
    assertLastReferenceAppend(fixture, fixture.entries[2].authorityId);
    // Exercise the real original readCheckpoint/CAS entry in a new process,
    // not a test-only reducer. The durable C advances its recovered revision.
    const stale = attachInAnotherProcess(fixture, 3, other.checkpoint.revision);
    assert.equal(stale.ok, false);
    assert.match(stale.message, /does not match expected revision/u);
    assert.deepEqual(fs.readFileSync(fixture.checkpointPath), before);
    // The standalone CLI/helper's default also observes the original recovered
    // revision, rather than being permanently stuck on stale compatibility JSON.
    const resumed = attachInAnotherProcess(fixture, 3);
    assert.equal(resumed.ok, true);
    const references = resumed.checkpoint.currentRunEvidenceReferences;
    assert.deepEqual(references.references.map((entry) => entry.authorityId),
        fixture.entries.map((entry) => entry.authorityId));
    assert.equal(references.contentDigest, governanceContentDigest(references));
    assert.equal(resumed.checkpoint.revision, other.checkpoint.revision + 2);
});

test('a compatibility revision not backed by the original journal cannot replace the locked baseline', async (t) =>
{
    const fixture = checkpointAttachmentFixture(t);
    const run = await runDag({ ...fixture.options, executeTier: async () => ({ code: 0, signal: null }) });
    assert.equal(run.status, 'success');
    const first = await fixture.attach(0, run.checkpoint.revision);
    const advanced = { ...first, revision: first.revision + 1 };
    fs.writeFileSync(fixture.checkpointPath, `${JSON.stringify(advanced)}\n`);
    const before = fs.readFileSync(fixture.checkpointPath);
    const store = attachmentStore(fixture);
    const events = store.readJournal();
    await assert.rejects(fixture.attach(1, advanced.revision), /journal baseline does not match the locked revision/u);
    assert.deepEqual(fs.readFileSync(fixture.checkpointPath), before);
    assert.deepEqual(store.readJournal(), events);
});

test('scheduler resume drops old-attempt refs and rejects an old handoff on the new attempt', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-evidence-scheduler-resume-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true });
    const runId = 'evidence-scheduler-resume';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: d('b') };
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId,
        attemptId: 'attempt-1', sourceCommit: sourceState.commit,
        worktreeFingerprint: sourceState.worktreeFingerprint,
        candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run']
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const contextPath = 'artifacts/current-run/context.json';
    fs.writeFileSync(path.join(root, contextPath), `${JSON.stringify(context)}\n`);
    const entry = {
        consumerId: 'consumer', authorityId: 'authority', producerId: 'producer',
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], publicationMode: 'hooked',
        producerSource: 'producer.mjs', producerCallsite: 'caller.mjs',
        producerBindingClass: 'cli',
        producerExecutable: 'node caller.mjs', producerCommand: 'node --import hook caller.mjs',
        outputBindingKey: 'FSUSBLOG_TEST_EVIDENCE_PATH',
        handoffBindingKey: 'FSUSBLOG_TEST_EVIDENCE_HANDOFF_PATH',
        payloadBindingKey: 'FSUSBLOG_TEST_EVIDENCE_PAYLOAD_PATH', checkpointCommand: 'checkpoint'
    };
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] };
    fs.writeFileSync(path.join(root, 'config/testing/evidence-locator-registry.json'),
        `${JSON.stringify({ ...registryBody, contentDigest: governanceContentDigest(registryBody) })}\n`);
    const outputPath = 'artifacts/current-run/reference.json';
    const payloadPath = 'artifacts/current-run/payload.json';
    const first = await runDag({
        tiers: [{
            id: 'producer-tier', command: 'fixture producer', executionDependsOn: [],
            requiresEvidenceFrom: [], artifacts: [], evidence: [], resourceClass: 'cpu',
            maxParallel: 1, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [],
            executionKey: 'test/producer-tier', executionVariant: 'ordinary', coverage: ['ordinary-unit']
        }],
        root,
        runsRoot: path.join(root, 'runs'),
        runId,
        sourceState,
        env: { FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextPath },
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
        executeTier: async (_tier, execution) =>
        {
            const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId,
                context, outputPath, payloadPath, producerId: entry.producerId, repositoryRoot: root });
            fs.writeFileSync(path.join(root, payloadPath), `${JSON.stringify({ schema: 'payload.v1', ok: true })}\n`);
            const finalized = finalizeCurrentRunEvidencePublication({ authorityId: entry.authorityId,
                context, outputPath, payloadPath, payloadSchema: 'payload.v1', producerId: entry.producerId,
                repositoryRoot: root, sessionId: session.sessionId, terminalStatus: 'success' });
            execution.writeOutput(`${EVIDENCE_TERMINAL_HANDOFF_PREFIX}${JSON.stringify(finalized.handoff)}\n`);
            return { code: 0, signal: null };
        }
    });
    assert.equal(first.status, 'success');
    const nextBody = { ...contextBody, attemptId: 'attempt-2' };
    const nextContext = { ...nextBody, contentDigest: governanceContentDigest(nextBody) };
    fs.writeFileSync(path.join(root, contextPath), `${JSON.stringify(nextContext)}\n`);
    const resumed = await runDag({
        tiers: [{
            id: 'producer-tier', command: 'fixture producer', executionDependsOn: [],
            requiresEvidenceFrom: [], artifacts: [], evidence: [], resourceClass: 'cpu',
            maxParallel: 1, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [],
            executionKey: 'test/producer-tier', executionVariant: 'ordinary', coverage: ['ordinary-unit']
        }],
        root,
        runsRoot: path.join(root, 'runs'),
        runId,
        sourceState,
        resume: true,
        env: { FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextPath },
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
        executeTier: async () => ({ code: 0, signal: null })
    });
    assert.equal(resumed.status, 'success');
    const checkpoint = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.currentRunEvidenceReferences.attemptId, 'attempt-2');
    assert.equal(checkpoint.currentRunEvidenceReferences.references.length, 0);
});
