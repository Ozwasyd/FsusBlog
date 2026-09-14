import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {runDag} = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const {EVIDENCE_TERMINAL_HANDOFF_PREFIX, beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication} = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const {governanceContentDigest} = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
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
