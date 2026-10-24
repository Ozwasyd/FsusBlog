import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
    DATA_SCALE_EXCLUSIVE_RESOURCES,
    DATA_SCALE_RUNTIME_SCHEMA,
    computeSha256,
    createDataScaleRuntimePlan,
    createDataScaleRuntimeReceipt,
    validateDataScaleRuntimePlan
} = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));

const {
    DATA_SCALE_RUNTIME_SCHEMA: OWNER_RUNTIME_SCHEMA,
    createDataScaleRuntimePlan: createOwnerPlan,
    createDataScaleRuntimeReceipt: createOwnerReceipt
} = await import(new URL('../../tools/test/data-scale-runtime-owner.mjs', import.meta.url));
const { digestValue, sealDocument } = await import(new URL('../../tools/test/release-reliability-receipt.mjs', import.meta.url));
const { verifyDataScaleOwnerReceipt } = await import(new URL('../../tools/test/verify-release-reliability-lifecycle-action.mjs', import.meta.url));

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

test('data-scale runtime plan generates run-bound identifiers and ownership labels', () =>
{
    const runId = 'run-plan-test-01';
    const parentRunId = 'sched-01';
    const plan = createDataScaleRuntimePlan({
        dataScaleRunId: runId,
        parentSchedulerRunId: parentRunId,
        namespace: 'scale-ns-01',
        tier: 'scale-m',
        repositoryRoot: root
    });

    assert.equal(plan.runtimeRequirement, 'dedicated-scenario');
    assert.equal(plan.dataScaleRunId, runId);
    assert.equal(plan.parentSchedulerRunId, parentRunId);
    assert.ok(plan.postgres.containerName.includes(runId));
    assert.ok(plan.redis.containerName.includes(runId));
    assert.ok(plan.postgres.volumeName.includes(runId));
    assert.ok(plan.redis.volumeName.includes(runId));

    assert.equal(plan.ownershipLabels['fsusblog.owner'], 'data-scale');
    assert.equal(plan.ownershipLabels['fsusblog.dataScaleRunId'], runId);
    assert.equal(plan.ownershipLabels['fsusblog.parentSchedulerRunId'], parentRunId);

    assert.deepEqual(plan.exclusiveResources, [...DATA_SCALE_EXCLUSIVE_RESOURCES]);
    assert.ok(validateDataScaleRuntimePlan(plan, root));
});

test('data-scale runtime plan requires all 4 dedicated roots to be distinct and under .tmp/', () =>
{
    const runId = 'run-plan-roots-02';
    const plan = createDataScaleRuntimePlan({
        dataScaleRunId: runId,
        parentSchedulerRunId: 'sched-02',
        namespace: 'scale-ns-02',
        repositoryRoot: root
    });

    const roots = [plan.roots.aotRoot, plan.roots.searchRoot, plan.roots.hotReadRoot, plan.roots.dataRoot];
    assert.equal(new Set(roots).size, 4, 'all 4 roots must be distinct');
    for (const r of roots)
    {
        assert.ok(r.startsWith('.tmp/'), `root ${r} must be under .tmp/`);
        assert.ok(r.includes(runId), `root ${r} must contain dataScaleRunId`);
    }
});

function ownerFixture(context)
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-receipt-'));
    context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const digest = (value) => `sha256:${value.repeat(64)}`;
    const identity = {
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: digest('b') },
        build: { contentDigest: digest('c'), imageDigest: digest('d') },
        fixture: { namespace: 'current-fixture' }
    };
    const plan = createOwnerPlan({
        repositoryRoot: temp,
        runId: 'scheduler-current',
        invocationId: 'invocation-current',
        attemptId: 'attempt-current',
        sourceCommit: identity.sourceState.commit,
        worktreeFingerprint: identity.sourceState.worktreeFingerprint,
        buildReceiptDigest: identity.build.contentDigest,
        imageDigest: identity.build.imageDigest,
        postgresImageDigest: digest('e'),
        redisImageDigest: digest('f')
    });
    const seedReceiptPath = `${plan.roots.dataRoot}/seed.json`;
    const seedFile = path.join(temp, seedReceiptPath);
    fs.mkdirSync(path.dirname(seedFile), { recursive: true });
    fs.writeFileSync(seedFile, '{"seed":"bound"}\n');
    const clientName = `FsusBlogDataScale-${plan.dataScaleRunId}`;
    const receipt = createOwnerReceipt({
        repositoryRoot: temp,
        plan,
        postgres: {
            containerId: '1'.repeat(64), database: 'fsusblog',
            imageDigest: plan.postgresImageDigest, volumeId: plan.resources.postgresVolumeName
        },
        redis: {
            containerId: '2'.repeat(64), imageDigest: plan.redisImageDigest,
            volumeId: plan.resources.redisVolumeName
        },
        backend: {
            baseUrl: 'http://127.0.0.1:18888', executableOrImageDigest: plan.imageDigest,
            pidOrContainerId: '3'.repeat(64), startTicks: '1234567890'
        },
        network: { id: '4'.repeat(64), name: plan.resources.networkName },
        permissionHelper: { name: plan.resources.permissionHelperContainerName, postExists: false },
        connections: {
            postgres: {
                applicationName: clientName, backendAddress: '172.24.0.4', database: 'fsusblog',
                matchingClientCount: 2, foreignClientCount: 0
            },
            redis: {
                clientName, backendAddress: '172.24.0.4', matchingClientCount: 2, foreignClientCount: 0
            }
        },
        seedReceiptPath,
        seedReceiptDigest: computeSha256(fs.readFileSync(seedFile)),
        seedSummary: {
            status: 'ok', tier: 'scale-m', namespace: plan.namespace,
            declared: { articles: 10000, comments: 100000 },
            expected: { articles: 10000, comments: 100000 },
            observed: { articles: 10000, comments: 100000 }
        },
        envManifestDigest: digest('5'),
        fixtureIdentityDigest: digestValue(identity.fixture),
        lifecycle: { start: 'complete', reset: 'complete', readiness: 'complete', postcondition: 'pending' },
        createdAt: '2026-10-08T00:00:00.000Z'
    });
    const receiptPath = `${plan.roots.dataRoot}/runtime.json`;
    const write = (document) => fs.writeFileSync(path.join(temp, receiptPath), JSON.stringify(document));
    const verify = () => verifyDataScaleOwnerReceipt({
        repositoryRoot: temp, ownerReceipt: 'data-scale-runtime', receiptPath, identity,
        runId: plan.parentSchedulerRunId, invocationId: plan.invocationId, attemptId: plan.attemptId
    });
    write(receipt);
    return { plan, receipt, write, verify };
}

test('data-scale runtime receipt satisfies verifyDataScaleOwnerReceipt contract', (context) =>
{
    const fixture = ownerFixture(context);
    const verified = fixture.verify();
    assert.equal(verified.document.schema, OWNER_RUNTIME_SCHEMA);
    assert.equal(verified.document.dataScaleRunId, fixture.plan.dataScaleRunId);
    assert.equal(verified.document.invocationId, fixture.plan.invocationId);
    assert.equal(verified.document.attemptId, fixture.plan.attemptId);
    assert.equal(verified.contentDigest, fixture.receipt.contentDigest);
});

test('data-scale runtime receipt rejects tampered fields', (context) =>
{
    const fixture = ownerFixture(context);
    for (const field of ['parentSchedulerRunId', 'invocationId', 'attemptId', 'sourceCommit'])
    {
        const tampered = { ...fixture.receipt, [field]: 'stale-identity' };
        for (const document of [tampered, sealDocument(tampered)])
        {
            fixture.write(document);
            assert.throws(fixture.verify, /identity mismatch/u, field);
        }
    }
});

test('legacy lane receipts cannot substitute for the current invocation owner', (context) =>
{
    const fixture = ownerFixture(context);
    const legacy = createDataScaleRuntimeReceipt(fixture.receipt);
    assert.equal(legacy.schema, DATA_SCALE_RUNTIME_SCHEMA);
    fixture.write(legacy);
    assert.throws(fixture.verify, /top-level fields mismatch/u);
});
