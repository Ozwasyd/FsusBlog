import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { startDataScaleRuntimeCaller, delegateDataScaleRuntimeOperation, readDataScaleBaselineContainerControls } = await import(new URL('../../tools/test/data-scale-runtime-caller.mjs', import.meta.url));
const { currentProcessIdentity } = await import(new URL('../../tools/test/process-identity.mjs', import.meta.url));
const { productionDiskDemandDigest } = await import(new URL('../../tools/test-matrix/production-disk-demand.mjs', import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));
const { createSchedulerRunOwner, createSchedulerTierAdmission, schedulerCandidateIdentityDigest, writeSchedulerTierAdmission } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));

function seal(value)
{
    return { ...value, contentDigest: productionDiskDemandDigest(value) };
}

// The scheduler lock, immutable admission, evidence journal, process identity
// and RPC sockets are real. Owner callbacks are unit doubles, not native Docker
// or runtime qualification evidence.
function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-data-scale-caller-unit-'));
    const runsRoot = path.join(root, 'runs');
    const runId = 'unit-data-scale';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const targetTierId = 'fixture';
    const namespace = 'unit-data-scale';
    const candidateDigest = schedulerCandidateIdentityDigest({ runId, targetTierId, namespace, sourceState });
    const owner = createSchedulerRunOwner({ runId, targetTierId, candidateIdentityDigest: candidateDigest,
        ownerToken: 'unit-owner-token', identity: currentProcessIdentity(), state: 'running' });
    const ownerFile = path.join(runsRoot, '.locks', `${runId}.lock`, 'owner.json');
    fs.mkdirSync(path.dirname(ownerFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
    const admission = createSchedulerTierAdmission({ runId, targetTierId, currentTierId: 'release-reliability-fresh',
        namespace, mode: 'fresh', sourceState, schedulerCandidateIdentityDigest: candidateDigest,
        schedulerOwnerToken: owner.ownerToken, schedulerCheckpointRevision: 1, admissionSequence: 1,
        activeTierIds: [], releaseFinalSpawnCountBeforeAdmission: 0 });
    const published = writeSchedulerTierAdmission({ runsRoot, admission });
    const admissionReference = { schema: published.schema, ref: path.relative(root, published.file),
        fileDigest: published.fileDigest, contentDigest: published.contentDigest,
        currentTierId: published.currentTierId, admissionSequence: published.admissionSequence };
    const store = new RunEvidenceObjectStore({ root: path.join(runsRoot, runId, 'evidence-store'), runId, sourceState });
    store.appendJournalEvent({ eventType: 'tier-admitted', tier: admission.currentTierId, step: 'scheduler',
        status: 'running', payload: { operations: [{ kind: 'set', path: ['schedulerAdmissions', admission.currentTierId], value: admissionReference }] } });
    const identity = seal({ schema: 'fsusblog.release-reliability-run-identity.v1', status: 'complete', runId,
        invocationId: 'unit-invocation', sourceState: { ...sourceState, worktreeFingerprint: `sha256:${sourceState.worktreeFingerprint}` } });
    const environment = { FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
        FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: identity.invocationId,
        FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'unit-attempt' };
    const events = [];
    const runtimeAdmission = { unitCapability: () => 'only-parent-held' };
    let cleanupStatus = 'complete';
    let provisionFailure = false;
    const parent = {
        root, runsRoot, admission, admissionReference, runtimeAdmission,
        async provision({ identity: request, environment: requestEnvironment, runtimeAdmission: capability, onPlan })
        {
            assert.equal(capability, runtimeAdmission);
            const plan = seal({ schema: 'fsusblog.data-scale-runtime-plan.v1', parentSchedulerRunId: request.runId,
                dataScaleRunId: `data-scale-${'d'.repeat(20)}`,
                invocationId: request.invocationId, attemptId: requestEnvironment.FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID,
                sourceCommit: request.sourceState.commit, worktreeFingerprint: request.sourceState.worktreeFingerprint });
            const planPath = `.tmp/release-reliability/${request.invocationId}/data-scale-owner/${plan.dataScaleRunId}.plan.json`;
            onPlan({ plan, planPath });
            fs.mkdirSync(path.dirname(path.join(root, planPath)), { recursive: true });
            fs.writeFileSync(path.join(root, planPath), JSON.stringify(plan));
            events.push('provision');
            if (provisionFailure) throw new Error('unit owner provision failure after preparation');
            const receipt = seal({ schema: 'fsusblog.data-scale-runtime.v2', status: 'complete',
                parentSchedulerRunId: request.runId, invocationId: request.invocationId, attemptId: plan.attemptId,
                sourceCommit: plan.sourceCommit, dataScaleRunId: plan.dataScaleRunId });
            const receiptPath = `.tmp/release-reliability/${request.invocationId}/data-scale-owner/${plan.dataScaleRunId}.runtime.json`;
            fs.writeFileSync(path.join(root, receiptPath), JSON.stringify(receipt));
            return { plan, planPath, receipt, receiptPath };
        },
        async teardown({ plan, runtimeAdmission: capability })
        {
            assert.equal(capability, runtimeAdmission);
            events.push('teardown');
            const receipt = seal({ schema: 'fsusblog.data-scale-teardown.v2', status: cleanupStatus,
                parentSchedulerRunId: plan.parentSchedulerRunId, invocationId: plan.invocationId, attemptId: plan.attemptId,
                sourceCommit: plan.sourceCommit, dataScaleRunId: plan.dataScaleRunId, runtimePlanDigest: plan.contentDigest });
            const receiptPath = `.tmp/release-reliability/${plan.invocationId}/data-scale-owner/${plan.dataScaleRunId}.teardown.json`;
            fs.writeFileSync(path.join(root, receiptPath), JSON.stringify(receipt));
            return { receipt, receiptPath };
        }
    };
    return { root, parent, ownerFile, admissionFile: published.file, identity, environment, events,
        setCleanupStatus: (value) => { cleanupStatus = value; }, setProvisionFailure: () => { provisionFailure = true; },
        remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function delegate(unit, server, operation = 'provision', overrides = {})
{
    return delegateDataScaleRuntimeOperation({ operation, repositoryRoot: unit.root, identity: unit.identity,
        environment: { ...unit.environment, ...server.environment }, timeoutMs: 5000, ...overrides });
}

test('DataScale caller performs authenticated real RPC while parent retains capabilities and exact attempt custody', async () =>
{
    const unit = fixture();
    let server;
    try
    {
        server = await startDataScaleRuntimeCaller(unit.parent);
        const journalFile = server.environment.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL;
        const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
        assert.equal(fs.statSync(path.dirname(journalFile)).mode & 0o777, 0o700);
        assert.equal(fs.statSync(journalFile).mode & 0o777, 0o600);
        assert.equal(fs.statSync(journal.socketPath).mode & 0o777, 0o600);
        assert.equal(Object.hasOwn(journal, 'runtimeAdmission'), false);
        const provisioned = await delegate(unit, server);
        assert.equal(journal.admission.sourceState.worktreeFingerprint, 'b'.repeat(64));
        assert.equal(unit.identity.sourceState.worktreeFingerprint, `sha256:${'b'.repeat(64)}`);
        assert.equal(provisioned.planPath, `.tmp/release-reliability/unit-invocation/data-scale-owner/data-scale-${'d'.repeat(20)}.plan.json`);
        assert.equal(Object.hasOwn(provisioned, 'plan'), false);
        assert.deepEqual(await delegate(unit, server), provisioned);
        await assert.rejects(delegate(unit, server, 'provision', { environment: {
            ...unit.environment, ...server.environment, FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'foreign-attempt' } }), /different invocation or attempt/u);
        const result = await delegate(unit, server, 'teardown');
        assert.equal(result.receiptPath, `.tmp/release-reliability/unit-invocation/data-scale-owner/data-scale-${'d'.repeat(20)}.teardown.json`);
        assert.deepEqual(unit.events, ['provision', 'teardown']);
        await server.dispose();
        assert.equal(fs.existsSync(journalFile), false);
    }
    finally { if (server) await server.dispose(); unit.remove(); }
});

test('DataScale caller refuses missing, unsafe, tampered and stale scheduler authority before callbacks', async () =>
{
    const unit = fixture();
    let server;
    try
    {
        await assert.rejects(delegateDataScaleRuntimeOperation({ operation: 'provision', repositoryRoot: unit.root,
            identity: unit.identity, environment: unit.environment }), /journal is required/u);
        server = await startDataScaleRuntimeCaller(unit.parent);
        await assert.rejects(delegate(unit, server, 'arbitrary-shell'), /closed roster/u);
        const file = server.environment.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL;
        const original = fs.readFileSync(file);
        fs.chmodSync(file, 0o644);
        await assert.rejects(delegate(unit, server), /private path/u);
        fs.chmodSync(file, 0o600);
        const journal = JSON.parse(original);
        fs.writeFileSync(file, JSON.stringify({ ...journal, operations: ['provision', 'teardown', 'shell'] }));
        await assert.rejects(delegate(unit, server), /journal binding/u);
        fs.writeFileSync(file, original);
        const admissionBytes = fs.readFileSync(unit.admissionFile);
        fs.appendFileSync(unit.admissionFile, ' ');
        await assert.rejects(delegate(unit, server), /immutable admission bytes/u);
        fs.writeFileSync(unit.admissionFile, admissionBytes);
        const ownerBytes = fs.readFileSync(unit.ownerFile);
        fs.rmSync(unit.ownerFile);
        await assert.rejects(delegate(unit, server), /scheduler admission/u);
        fs.writeFileSync(unit.ownerFile, ownerBytes);
        await assert.rejects(delegate(unit, server, 'provision', { identity: seal({ ...unit.identity,
            contentDigest: undefined, sourceState: { ...unit.identity.sourceState, commit: 'f'.repeat(40) } }) }), /identity mismatch/u);
        await assert.rejects(delegate(unit, server, 'provision', { identity: seal({ ...unit.identity,
            contentDigest: undefined, sourceState: { ...unit.identity.sourceState, worktreeFingerprint: `sha256:${'f'.repeat(64)}` } }) }), /identity mismatch/u);
        assert.deepEqual(unit.events, []);
    }
    finally { if (server) await server.dispose(); unit.remove(); }
});

function rawRequest(socketPath, request)
{
    return new Promise((resolve, reject) =>
    {
        const socket = net.connect(socketPath);
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on('data', (chunk) =>
        {
            buffer += chunk;
            if (!buffer.includes('\n')) return;
            socket.end();
            resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
        });
    });
}

test('DataScale baseline control observation requires the live parent reservation and exact source', async () =>
{
    const unit = fixture();
    let server;
    let held = false;
    const grant = { cpuUnits: 0.444, memoryHighBytes: 256 * 1024 ** 2,
        memoryMaxBytes: 256 * 1024 ** 2, pidsMax: 32 };
    const controls = { runId: unit.parent.admission.runId, namespace: unit.parent.admission.namespace,
        sourceState: structuredClone(unit.parent.admission.sourceState),
        roles: Object.fromEntries(['postgres', 'redis', 'backend'].map((role) => [role, { ...grant }])) };
    unit.parent.baselineContainerControls = () =>
    {
        if (!held) throw new Error('original baseline reservation is no longer held');
        return structuredClone(controls);
    };
    try
    {
        server = await startDataScaleRuntimeCaller(unit.parent);
        const options = { repositoryRoot: unit.root, environment: server.environment, timeoutMs: 5000 };
        await assert.rejects(readDataScaleBaselineContainerControls(options), /no longer held/u);
        held = true;
        assert.deepEqual(await readDataScaleBaselineContainerControls(options), controls);
        controls.sourceState.commit = 'f'.repeat(40);
        await assert.rejects(readDataScaleBaselineContainerControls(options), /original scheduler binding/u);
        controls.sourceState.commit = unit.parent.admission.sourceState.commit;
        controls.roles.redis.pidsMax = 0;
        await assert.rejects(readDataScaleBaselineContainerControls(options), /bounded role/u);
        assert.deepEqual(unit.events, []);
        const journal = JSON.parse(fs.readFileSync(server.environment.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL));
        const token = fs.readFileSync(journal.tokenFile, 'utf8').trim();
        const refused = await rawRequest(journal.socketPath, { schema: journal.schema,
            token, journalDigest: journal.contentDigest, operation: 'baseline-container-controls',
            identity: unit.identity, environment: {} });
        assert.equal(refused.ok, false);
    }
    finally { if (server) await server.dispose(); unit.remove(); }
});

test('DataScale parent socket refuses wrong token and operation roster; failed provision retains real teardown custody', async () =>
{
    const unit = fixture();
    let server;
    try
    {
        unit.setProvisionFailure();
        server = await startDataScaleRuntimeCaller(unit.parent);
        const file = server.environment.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL;
        const journal = JSON.parse(fs.readFileSync(file));
        const response = await rawRequest(journal.socketPath, { schema: journal.schema, journalDigest: journal.contentDigest,
            token: '0'.repeat(64), operation: 'provision', identity: unit.identity, environment: unit.environment });
        assert.equal(response.ok, false);
        const token = fs.readFileSync(journal.tokenFile, 'utf8').trim();
        const forbidden = await rawRequest(journal.socketPath, { schema: journal.schema, journalDigest: journal.contentDigest,
            token, operation: 'shell', identity: unit.identity, environment: unit.environment });
        assert.equal(forbidden.ok, false);
        const environmentRefusal = await rawRequest(journal.socketPath, { schema: journal.schema, journalDigest: journal.contentDigest,
            token, operation: 'provision', identity: unit.identity, environment: { ...unit.environment, FSUSBLOG_COMMAND: 'unreviewed-command' } });
        assert.equal(environmentRefusal.ok, false);
        assert.deepEqual(unit.events, []);
        await assert.rejects(delegate(unit, server), /unit owner provision failure/u);
        unit.setCleanupStatus('blocked');
        await assert.rejects(server.dispose(), /custody is retained/u);
        assert.equal(fs.existsSync(file), true);
        unit.setCleanupStatus('complete');
        await delegate(unit, server, 'teardown');
        assert.deepEqual(unit.events, ['provision', 'teardown', 'teardown']);
        await server.dispose();
        assert.equal(fs.existsSync(file), false);
    }
    finally { if (server) await server.dispose(); unit.remove(); }
});

test('DataScale caller accepts only observed sealed cleanup receipts attached by the failed owner', async () =>
{
    const unit = fixture();
    let server;
    const provision = unit.parent.provision;
    unit.setProvisionFailure();
    unit.parent.provision = async (inputs) =>
    {
        try { return await provision(inputs); }
        catch (error)
        {
            const relative = `.tmp/release-reliability/unit-invocation/data-scale-owner/data-scale-${'d'.repeat(20)}.plan.json`;
            const plan = JSON.parse(fs.readFileSync(path.join(unit.root, relative)));
            const cleanup = await unit.parent.teardown({ plan, runtimeAdmission: inputs.runtimeAdmission });
            Object.defineProperty(error, 'dataScaleCleanup', { value: cleanup });
            throw error;
        }
    };
    try
    {
        server = await startDataScaleRuntimeCaller(unit.parent);
        const file = server.environment.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL;
        await assert.rejects(delegate(unit, server), /unit owner provision failure/u);
        assert.deepEqual(unit.events, ['provision', 'teardown']);
        await delegate(unit, server, 'teardown');
        assert.deepEqual(unit.events, ['provision', 'teardown']);
        await server.dispose();
        assert.equal(fs.existsSync(file), false);
    }
    finally { if (server) await server.dispose(); unit.remove(); }
});
