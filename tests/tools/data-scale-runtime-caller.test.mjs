import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const { createProductionBuildReceipt } = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));

function seal(value)
{
    return { ...value, contentDigest: productionDiskDemandDigest(value) };
}

function rawHash(value)
{
    return createHash('sha256').update(value).digest('hex');
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
    const write = (relative, value) =>
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
        return { status: 'complete', path: relative,
            fileDigest: `sha256:${rawHash(value)}` };
    };
    const buildRoot = path.join(root, '.tmp/build', `${runId}-acceptance`);
    const assembly = path.join(buildRoot, 'server/FsusBlog.Server.dll');
    write(path.relative(root, assembly), 'controlled unit assembly bytes; no native qualification');
    const artifactRoot = path.join(root, '.tmp/ci-production-build', runId);
    write(path.relative(root, path.join(artifactRoot, 'payload/backend-runtime/FsusBlog.Server.dll')),
        fs.readFileSync(assembly));
    write('unit-source.txt', 'controlled source input');
    const buildReceipt = createProductionBuildReceipt({ root, artifactRoot, sourceState,
        producer: { workflow: 'Local production', runId, runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: Object.fromEntries(['node', 'npm', 'dotnet', 'vite', 'vitest', 'playwright', 'emsdk'].map((key) => [key, 'unit-double'])),
        domains: [{ name: 'backend-runtime', path: 'payload/backend-runtime' }], inputPaths: ['unit-source.txt'] });
    const imageReference = `unit@sha256:${'c'.repeat(64)}`;
    const imageDigest = `sha256:${'c'.repeat(64)}`;
    const fixtureConfig = write(`.tmp/env/${namespace}.env`, 'controlled unit configuration');
    const schemaFile = write('src/backend/Infrastructure/SchemaMigration/SchemaModelInspector.cs', 'controlled unit schema source');
    const seed = write('tools/data-scale/seed.sh', 'controlled unit seed source');
    const auditRetentionPolicy = write('src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs', 'controlled unit policy source');
    const projected = (binding) => ({ path: binding.path, fileDigest: binding.fileDigest });
    const topology = seal({ schema: 'fsusblog.release-reliability-runtime-topology.v1', status: 'complete',
        runId, namespace, root: `.tmp/fixtures/${namespace}`, config: projected(fixtureConfig),
        schemaFile: projected(schemaFile), seed: projected(seed), auditRetentionPolicy: projected(auditRetentionPolicy),
        runtime: { imageDigest, sourceState }, postgres: { imageId: `sha256:${'d'.repeat(64)}` },
        redis: { imageId: `sha256:${'e'.repeat(64)}` } });
    const topologyBinding = write(`.tmp/release-reliability/${runId}/fixture-authority.json`, JSON.stringify(topology));
    write('config/testing/test-execution-service-catalog.json', JSON.stringify({ services: {
        postgres: { imageReference: `unit-postgres@sha256:${'d'.repeat(64)}` },
        redis: { imageReference: `unit-redis@sha256:${'e'.repeat(64)}` } } }));
    const identity = seal({ schema: 'fsusblog.release-reliability-run-identity.v1', status: 'complete', runId,
        invocationId: 'unit-invocation', sourceState: { ...sourceState, worktreeFingerprint: `sha256:${sourceState.worktreeFingerprint}` },
        build: { status: 'complete', path: `.tmp/ci-production-build/${runId}/receipt.json`,
            fileDigest: `sha256:${rawHash(fs.readFileSync(path.join(artifactRoot, 'receipt.json')))}`,
            contentDigest: buildReceipt.contentDigest, imageDigest,
            image: { reference: imageReference, imageDigest, revision: sourceState.commit },
            sourceState, producerRunId: runId },
        fixture: { status: 'complete', root: topology.root, namespace,
            config: fixtureConfig, schema: schemaFile, seed, auditRetentionPolicy,
            topology: { ...topologyBinding, content: { schema: topology.schema, contentDigest: topology.contentDigest,
                postgres: topology.postgres, redis: topology.redis,
                auditRetentionPolicy: topology.auditRetentionPolicy, runtime: topology.runtime } } } });
    const identityFile = path.join(root, '.tmp/release-reliability/unit-invocation/identity.json');
    write(path.relative(root, identityFile), JSON.stringify(identity));
    const environment = { FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
        FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: identity.invocationId,
        FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'unit-attempt' };
    const events = [];
    const cleanupCapability = Object.freeze({ assertRetained: () => 'controlled-parent-cleanup' });
    const runtimeAdmission = { unitCapability: () => 'only-parent-held',
        retainCleanupCustody(plan)
        {
            events.push('retain-cleanup');
            assert.equal(plan.invocationId, identity.invocationId);
            return cleanupCapability;
        } };
    let cleanupStatus = 'complete';
    let provisionFailure = false;
    const parent = {
        root, runsRoot, admission, admissionReference, runtimeAdmission,
        environment: { ...environment, FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot, FSUSBLOG_BACKEND_SERVER_DLL: assembly,
            FSUSBLOG_TEST_FIXTURE_CONFIG: fixtureConfig.path, FSUSBLOG_RELEASE_RUNTIME_IMAGE: imageReference },
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
            if (provisionFailure)
            {
                throw new Error('unit owner provision failure after preparation');
            }
            const receipt = seal({ schema: 'fsusblog.data-scale-runtime.v2', status: 'complete',
                parentSchedulerRunId: request.runId, invocationId: request.invocationId, attemptId: plan.attemptId,
                sourceCommit: plan.sourceCommit, dataScaleRunId: plan.dataScaleRunId });
            const receiptPath = `.tmp/release-reliability/${request.invocationId}/data-scale-owner/${plan.dataScaleRunId}.runtime.json`;
            fs.writeFileSync(path.join(root, receiptPath), JSON.stringify(receipt));
            return { plan, planPath, receipt, receiptPath };
        },
        async teardown({ plan, runtimeAdmission: capability, retainedCleanupCustody })
        {
            assert.equal(capability, runtimeAdmission);
            assert.ok(retainedCleanupCustody === null || retainedCleanupCustody === undefined
                || retainedCleanupCustody === cleanupCapability);
            events.push('teardown');
            const receipt = seal({ schema: 'fsusblog.data-scale-teardown.v2', status: cleanupStatus,
                parentSchedulerRunId: plan.parentSchedulerRunId, invocationId: plan.invocationId, attemptId: plan.attemptId,
                sourceCommit: plan.sourceCommit, dataScaleRunId: plan.dataScaleRunId, runtimePlanDigest: plan.contentDigest });
            const receiptPath = `.tmp/release-reliability/${plan.invocationId}/data-scale-owner/${plan.dataScaleRunId}.teardown.json`;
            fs.writeFileSync(path.join(root, receiptPath), JSON.stringify(receipt));
            return { receipt, receiptPath };
        }
    };
    return { root, parent, ownerFile, admissionFile: published.file, identityFile, artifactRoot, assembly,
        identity, environment, events,
        setCleanupStatus: (value) =>
        {
            cleanupStatus = value;
        }, setProvisionFailure: () =>
        {
            provisionFailure = true;
        },
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
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
});

test('DataScale caller consumes the original sealed production Server domain without an acceptance rebuild', async () =>
{
    const unit = fixture();
    let server;
    try
    {
        unit.parent.environment.FSUSBLOG_PRODUCTION_BUILD_ROOT = unit.artifactRoot;
        unit.parent.environment.FSUSBLOG_BACKEND_SERVER_DLL = path.join(unit.artifactRoot,
            'payload/backend-runtime/FsusBlog.Server.dll');
        fs.rmSync(path.dirname(unit.assembly), { recursive: true });
        server = await startDataScaleRuntimeCaller(unit.parent);
        await delegate(unit, server);
        await delegate(unit, server, 'teardown');
        assert.deepEqual(unit.events, ['provision', 'teardown']);
    }
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
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
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
});

test('DataScale parent refuses artifact environment overrides and self-sealed identities before owner callbacks', async () =>
{
    const unit = fixture();
    let server;
    try
    {
        server = await startDataScaleRuntimeCaller(unit.parent);
        const journal = JSON.parse(fs.readFileSync(server.environment.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL));
        const token = fs.readFileSync(journal.tokenFile, 'utf8').trim();
        const { contentDigest: originalDigest, ...original } = unit.identity;
        void originalDigest;
        const foreignInvocation = seal({ ...original, invocationId: 'foreign-invocation' });
        await assert.rejects(delegate(unit, server, 'provision', {
            identity: foreignInvocation, environment: { ...unit.environment, ...server.environment,
                FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: foreignInvocation.invocationId }
        }), /different invocation or attempt/u);
        await assert.rejects(delegate(unit, server, 'provision', { environment: {
            ...unit.environment, ...server.environment, FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'foreign-first-attempt'
        } }), /different invocation or attempt/u);
        for (const key of ['FSUSBLOG_PRODUCTION_BUILD_ROOT', 'FSUSBLOG_BACKEND_SERVER_DLL',
            'FSUSBLOG_TEST_FIXTURE_CONFIG', 'FSUSBLOG_RELEASE_RUNTIME_IMAGE'])
        {
            const environment = { ...unit.environment, [key]: 'foreign-child-artifact' };
            await assert.rejects(delegate(unit, server, 'provision', { environment: { ...environment, ...server.environment } }), /unapproved environment key/u);
            const result = await rawRequest(journal.socketPath, { schema: journal.schema, token,
                journalDigest: journal.contentDigest, operation: 'provision', identity: unit.identity, environment });
            assert.equal(result.ok, false);
            assert.match(result.error, /unapproved environment key/u);
        }
        const { contentDigest, ...unsigned } = unit.identity;
        void contentDigest;
        const forged = seal({ ...unsigned, build: { ...unsigned.build, contentDigest: `sha256:${'f'.repeat(64)}` } });
        await assert.rejects(delegate(unit, server, 'provision', { identity: forged }), /original invocation artifact/u);
        fs.writeFileSync(unit.identityFile, JSON.stringify(forged));
        await assert.rejects(delegate(unit, server, 'provision', { identity: forged }), /producer output/u);
        assert.deepEqual(unit.events, []);
    }
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
});

test('DataScale parent freezes original artifact locators before child requests arrive', async () =>
{
    const unit = fixture();
    let server;
    let captured;
    const fixed = { ...unit.parent.environment };
    const provision = unit.parent.provision;
    unit.parent.provision = async (options) =>
    {
        captured = options.environment;
        return provision(options);
    };
    try
    {
        server = await startDataScaleRuntimeCaller(unit.parent);
        for (const key of ['FSUSBLOG_PRODUCTION_BUILD_ROOT', 'FSUSBLOG_BACKEND_SERVER_DLL',
            'FSUSBLOG_TEST_FIXTURE_CONFIG', 'FSUSBLOG_RELEASE_RUNTIME_IMAGE'])
        {
            unit.parent.environment[key] = 'changed-after-parent-start';
        }
        await delegate(unit, server);
        for (const [key, value] of Object.entries(fixed))
        {
            assert.equal(captured[key], value);
        }
        await delegate(unit, server, 'teardown');
    }
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
});

test('DataScale parent re-observes original receipt, fixture and complete candidate bytes before provisioning', async () =>
{
    const unit = fixture();
    let server;
    try
    {
        server = await startDataScaleRuntimeCaller(unit.parent);
        const assemblyBytes = fs.readFileSync(unit.assembly);
        fs.appendFileSync(unit.assembly, 'foreign bytes');
        await assert.rejects(delegate(unit, server), /actual candidate assembly closure/u);
        fs.writeFileSync(unit.assembly, assemblyBytes);
        const extra = path.join(path.dirname(unit.assembly), 'unreceipted.dll');
        fs.writeFileSync(extra, 'foreign closure');
        await assert.rejects(delegate(unit, server), /unreceipted files/u);
        fs.rmSync(extra);
        const config = path.join(unit.root, unit.parent.environment.FSUSBLOG_TEST_FIXTURE_CONFIG);
        const configBytes = fs.readFileSync(config);
        fs.appendFileSync(config, 'changed fixture bytes');
        await assert.rejects(delegate(unit, server), /original fixture artifact/u);
        fs.writeFileSync(config, configBytes);
        const receipt = path.join(unit.artifactRoot, 'receipt.json');
        fs.renameSync(receipt, `${receipt}.retained`);
        await assert.rejects(delegate(unit, server), /ENOENT/u);
        fs.renameSync(`${receipt}.retained`, receipt);
        const source = path.join(unit.root, 'unit-source.txt');
        const sourceBytes = fs.readFileSync(source);
        fs.appendFileSync(source, 'foreign source');
        await assert.rejects(delegate(unit, server), /input digest mismatch/u);
        fs.writeFileSync(source, sourceBytes);
        assert.deepEqual(unit.events, []);
        await delegate(unit, server);
        fs.appendFileSync(unit.identityFile, ' ');
        await assert.rejects(delegate(unit, server), /artifact bytes changed after binding/u);
        // Cleanup keeps its captured original custody even if the original
        // input was subsequently tampered; it must not strand the runtime.
        await delegate(unit, server, 'teardown');
        assert.deepEqual(unit.events, ['provision', 'teardown']);
    }
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
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
            if (!buffer.includes('\n'))
            {
                return;
            }
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
        if (!held)
        {
            throw new Error('original baseline reservation is no longer held');
        }
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
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
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
        const serializedCleanup = await rawRequest(journal.socketPath, { schema: journal.schema, journalDigest: journal.contentDigest,
            token, operation: 'teardown', identity: unit.identity, environment: unit.environment,
            retainedCleanupCustody: { assertRetained: 'serialized-permit' } });
        assert.equal(serializedCleanup.ok, false);
        const environmentRefusal = await rawRequest(journal.socketPath, { schema: journal.schema, journalDigest: journal.contentDigest,
            token, operation: 'provision', identity: unit.identity, environment: { ...unit.environment, FSUSBLOG_COMMAND: 'unreviewed-command' } });
        assert.equal(environmentRefusal.ok, false);
        assert.deepEqual(unit.events, []);
        await assert.rejects(delegate(unit, server), /unit owner provision failure/u);
        unit.setCleanupStatus('blocked');
        await assert.rejects(server.dispose(), /custody is retained/u);
        assert.equal(fs.existsSync(file), true);
        unit.setCleanupStatus('complete');
        await assert.rejects(delegate(unit, server, 'teardown'), /parent-only cleanup/u);
        await assert.rejects(delegate(unit, server), /parent-only cleanup/u);
        assert.deepEqual(unit.events, ['provision', 'retain-cleanup', 'teardown']);
        await server.dispose();
        assert.deepEqual(unit.events, ['provision', 'retain-cleanup', 'teardown', 'retain-cleanup', 'teardown']);
        assert.equal(fs.existsSync(file), false);
    }
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
});

test('DataScale caller accepts only observed sealed cleanup receipts attached by the failed owner', async () =>
{
    const unit = fixture();
    let server;
    const provision = unit.parent.provision;
    unit.setProvisionFailure();
    unit.parent.provision = async (inputs) =>
    {
        try
        {
            return await provision(inputs);
        }
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
    finally
    {
        if (server)
        {
            await server.dispose();
        }
        unit.remove();
    }
});
