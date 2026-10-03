import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {runDag} = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const {EVIDENCE_TERMINAL_HANDOFF_PREFIX, beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication} = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const {governanceContentDigest} = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const d = (value) => `sha256:${value.repeat(64)}`;

// Original scheduler SOURCE seam: these injected operations exercise parent-held
// observation isolation only, not native producer execution or qualification.
function heldCompletionFixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-held-completion-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'source.txt'), 'original-input');
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: d('b') };
    const output = '.tmp/held/output.json';
    const tier = { id: 'held-producer', command: 'fixture held producer',
        executionDependsOn: [], requiresEvidenceFrom: [], artifacts: [output, '.tmp/held/**'],
        evidence: [], resourceClass: 'cpu', maxParallel: 1, cpuUnits: 1,
        memoryGiB: 0.1, cacheInputs: ['source.txt'], executionKey: 'test/held-producer',
        executionVariant: 'ordinary', coverage: ['ordinary-unit'] };
    const options = { root, tiers: [tier], runId: 'held-completion',
        runsRoot: path.join(root, 'runs'), sourceState,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
        executeTier: async () =>
        {
            fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
            fs.writeFileSync(path.join(root, output), '{"original":true}\n');
            return { code: 0, signal: null };
        } };
    return { root, output, options };
}

test('parent held completion accepts unchanged SOURCE observations without publishing a capability', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    let observed;
    options.onTierComplete = (_tier, result) => { observed = structuredClone(result); };
    const result = await runDag(options);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.checkpoint.tiers['held-producer'].outputs, observed.outputs);
    assert.equal(Object.hasOwn(result.checkpoint, 'heldRun'), false);
    assert.equal(Object.hasOwn(result.checkpoint.tiers['held-producer'], 'parentCompletionFailure'), false);
});

for (const [name, mutate] of [
    ['nested output entry', (_tier, result) => { result.outputs['.tmp/held/**'][0][1] = d('f'); }],
    ['complete output replacement', (_tier, result) => { result.outputs = {}; result.outputFingerprint = d('f'); }],
    ['producer command', (tier) => { tier.command = 'replacement producer'; }],
    ['producer identity', (tier) => { tier.id = 'unknown-producer'; }],
    ['input fingerprint', (_tier, result) => { result.inputFingerprint = d('f'); }],
    ['dependency fingerprint', (_tier, result) => { result.dependencyFingerprint = d('f'); }]
])
{
    test(`parent held completion rejects callback drift in ${name} through original failure routing`, async (t) =>
    {
        const { options } = heldCompletionFixture(t);
        let original;
        options.onTierComplete = (tier, result) =>
        {
            original = structuredClone(result);
            mutate(tier, result);
        };
        const result = await runDag(options);
        const failed = result.checkpoint.tiers['held-producer'];
        assert.equal(result.status, 'failure');
        assert.equal(failed.status, 'failure');
        assert.match(failed.parentCompletionFailure, /original parent-held outputs/u);
        assert.deepEqual(failed.outputs, original.outputs);
        assert.equal(failed.exitCode, 0); // actual injected child exit is not rewritten
        assert.equal(failed.signal, null);
        assert.deepEqual(result.checkpoint.completedTiers, []);
    });
}

test('parent held completion rejects actual output drift after observation even without result mutation', async (t) =>
{
    const { root, output, options } = heldCompletionFixture(t);
    options.onTierComplete = () => fs.writeFileSync(path.join(root, output), '{"replaced":true}\n');
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.match(result.failure.reason, /output bytes changed after parent observation/u);
    assert.equal(result.checkpoint.tiers['held-producer'].exitCode, 0);
});

test('parent held completion does not recapture a callback-replaced parent input fingerprint', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    options.afterTierSettled = (_tier, settled) =>
    {
        settled.inputFingerprint = d('f');
    };
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.match(result.failure.reason, /original parent-held outputs/u);
    assert.equal(result.checkpoint.tiers['held-producer'].exitCode, 0);
});

test('parent held refusal preserves original active sibling termination and full settle before return', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    const originalExecute = options.executeTier;
    options.tiers[0].parallelizable = true;
    options.tiers.push({ ...options.tiers[0], id: 'held-sibling',
        command: 'fixture held sibling', executionKey: 'test/held-sibling', artifacts: [] });
    options.maxParallel = 2;
    options.systemResources.cpuCount = 4;
    let siblingEntered;
    const entered = new Promise((resolve) => { siblingEntered = resolve; });
    let releaseSibling;
    const released = new Promise((resolve) => { releaseSibling = resolve; });
    let siblingSettled = false;
    let siblingTerminated = false;
    options.executeTier = async (tier) =>
    {
        if (tier.id === 'held-sibling')
        {
            siblingEntered();
            await released;
            siblingSettled = true;
            return { code: 0, signal: null };
        }
        await entered;
        return originalExecute();
    };
    options.onTierComplete = (tier, result) =>
    {
        if (tier.id === 'held-producer') result.outputs = {};
    };
    options.abortTier = (tier) =>
    {
        if (tier.id === 'held-sibling')
        {
            siblingTerminated = true;
            releaseSibling();
        }
    };
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.equal(siblingTerminated, true);
    assert.equal(siblingSettled, true);
    assert.equal(result.checkpoint.tiers['held-sibling'].status, 'cancelled');
    assert.equal(result.checkpoint.tiers['held-sibling'].exitCode, 0);
});

test('settled hook cannot launder a real failed SOURCE operation into parent-held success', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    const originalExecute = options.executeTier;
    const actualError = new Error('original child failure', { cause: new Error('original child cause') });
    options.executeTier = async () =>
    {
        await originalExecute(); // fresh, complete required outputs do exist
        return { code: 7, signal: 'SIGTERM', error: actualError };
    };
    options.afterTierSettled = (_tier, settled) =>
    {
        assert.notEqual(settled.executionResult.error, actualError);
        settled.executionResult.code = 0;
        settled.executionResult.signal = null;
        settled.executionResult.error = null;
    };
    const result = await runDag(options);
    const failed = result.checkpoint.tiers['held-producer'];
    assert.equal(result.status, 'failure');
    assert.equal(failed.status, 'failure');
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.signal, 'SIGTERM');
    assert.equal(failed.reason, 'original child failure');
    assert.match(failed.parentCompletionFailure, /settled terminal or log observations changed/u);
    assert.equal(actualError.message, 'original child failure');
    assert.deepEqual(result.checkpoint.completedTiers, []);
});

for (const [name, mutate] of [
    ['exit code', (settled) => { settled.executionResult.code = 9; }],
    ['signal', (settled) => { settled.executionResult.signal = 'SIGKILL'; }],
    ['timeout phase', (settled) => { settled.executionResult.timeoutPhase = 'termination'; }],
    ['injected physical terminal', (settled) => { settled.executionResult.physicalExecutionTermination = { marker: { original: false } }; }],
    ['log completion', (settled) => { settled.executionResult.logComplete = false; }],
    ['log truncation', (settled) => { settled.executionResult.logTruncationReason = 'replacement'; }],
    ['stdout byte evidence', (settled) => { settled.logEvidence.streams.stdoutBytes += 1; }],
    ['log raw path', (settled) => { settled.logFile = 'replacement.log'; }]
])
{
    test(`settled hook cannot replace original SOURCE ${name}`, async (t) =>
    {
        const { options } = heldCompletionFixture(t);
        const originalExecute = options.executeTier;
        options.executeTier = async () =>
        {
            await originalExecute();
            // The existing injected executor normalizer supplies code/signal/error
            // only. Optional native terminal fields must not be invented by hooks.
            return { code: 0, signal: null };
        };
        options.afterTierSettled = (_tier, settled) => mutate(settled);
        const result = await runDag(options);
        const failed = result.checkpoint.tiers['held-producer'];
        assert.equal(result.status, 'failure');
        assert.equal(failed.exitCode, 0);
        assert.equal(failed.signal, null);
        assert.equal(failed.timeoutPhase, null);
        assert.equal(failed.physicalExecutionTermination, null);
        assert.match(failed.parentCompletionFailure, /settled terminal or log observations changed/u);
        assert.deepEqual(result.checkpoint.completedTiers, []);
    });
}

test('settled hook Error message and cause are compared as actual fields, not Error empty JSON', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    const originalExecute = options.executeTier;
    const error = new Error('original error', { cause: new Error('original cause') });
    error.code = 'original-code';
    options.executeTier = async () =>
    {
        await originalExecute();
        return { code: 3, signal: null, error };
    };
    options.afterTierSettled = (_tier, settled) =>
    {
        assert.equal(settled.executionResult.error.code, 'original-code');
        settled.executionResult.error.message = 'replacement error';
    };
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.equal(result.failure.exitCode, 3);
    assert.equal(result.failure.reason, 'original error');
    assert.equal(error.message, 'original error');
    assert.equal(error.cause.message, 'original cause');
    assert.match(result.checkpoint.tiers['held-producer'].parentCompletionFailure,
        /settled terminal or log observations changed/u);
});

test('settled hook changing only non-enumerable Error cause cannot replace original first cause', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    const originalExecute = options.executeTier;
    const error = new Error('original error', { cause: new Error('original cause') });
    options.executeTier = async () =>
    {
        await originalExecute();
        return { code: 3, signal: null, error };
    };
    options.afterTierSettled = (_tier, settled) =>
    {
        settled.executionResult.error.cause.message = 'replacement cause';
    };
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.equal(result.failure.reason, 'original error');
    assert.equal(error.cause.message, 'original cause');
    assert.match(result.checkpoint.tiers['held-producer'].parentCompletionFailure,
        /settled terminal or log observations changed/u);
});

test('settled fork failure follows original settle without exposing clone diagnostic source', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    const originalExecute = options.executeTier;
    const error = new Error('original failure');
    error.diagnostic = () => 'do not publish callback source';
    options.executeTier = async () =>
    {
        await originalExecute();
        return { code: 5, signal: null, error };
    };
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.equal(result.failure.exitCode, 5);
    assert.equal(result.failure.reason, 'original failure');
    assert.equal(result.checkpoint.tiers['held-producer'].parentCompletionFailure,
        'scheduler original settled observation cannot be independently retained');
});

test('settled hook may add non-authority diagnostics without mutating original observations', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    options.afterTierSettled = (_tier, settled) =>
    {
        settled.diagnosticNote = 'SOURCE-only note';
        settled.executionResult.diagnosticNote = 'not an execution grant';
    };
    const result = await runDag(options);
    assert.equal(result.status, 'success');
    assert.equal(result.checkpoint.tiers['held-producer'].exitCode, 0);
    assert.equal(Object.hasOwn(result.checkpoint.tiers['held-producer'], 'parentCompletionFailure'), false);
});

test('settled hook actual file changes are rejected against pre-hook parent output bytes', async (t) =>
{
    const { root, output, options } = heldCompletionFixture(t);
    options.afterTierSettled = () => fs.writeFileSync(path.join(root, output), '{"replaced":true}\n');
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.match(result.failure.reason, /output bytes changed after parent observation/u);
    assert.equal(result.checkpoint.tiers['held-producer'].exitCode, 0);
});

test('settled hook throw is a parent failure without forging the successful child exit', async (t) =>
{
    const { options } = heldCompletionFixture(t);
    options.afterTierSettled = () => { throw new Error('parent hook failure'); };
    const result = await runDag(options);
    assert.equal(result.status, 'failure');
    assert.equal(result.failure.reason, 'parent hook failure');
    assert.equal(result.failure.exitCode, 0);
    assert.equal(result.checkpoint.tiers['held-producer'].parentCompletionFailure, 'parent hook failure');
});

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
