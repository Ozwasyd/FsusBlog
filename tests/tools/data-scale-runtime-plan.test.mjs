import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    DATA_SCALE_EXCLUSIVE_RESOURCES,
    DATA_SCALE_RUNTIME_SCHEMA,
    computeSha256,
    createDataScaleRuntimePlan,
    createDataScaleRuntimeReceipt,
    isForbiddenContainerName,
    validateDataScaleBackendConnection,
    validateDataScaleRuntimePlan
} from '../../tools/data-scale/runtime-plan.mjs';

import { verifyDataScaleOwnerReceipt } from '../../tools/test/verify-release-reliability-lifecycle-action.mjs';

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

test('data-scale runtime receipt satisfies verifyDataScaleOwnerReceipt contract', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-receipt-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const runId = 'run-receipt-03';
    const seedReceiptRelative = `.tmp/scale/${runId}/data/seed-receipt.json`;
    const seedReceiptAbsolute = path.join(temp, seedReceiptRelative);
    fs.mkdirSync(path.dirname(seedReceiptAbsolute), { recursive: true });

    const seedReceiptData = {
        schema: 'fsusblog.data-scale-seed-receipt.v1',
        dataScaleRunId: runId,
        namespace: 'scale-ns-03',
        tier: 'scale-m',
        generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(seedReceiptAbsolute, `${JSON.stringify(seedReceiptData, null, 2)}\n`);
    const seedReceiptBytesDigest = computeSha256(fs.readFileSync(seedReceiptAbsolute));

    const sourceCommit = 'b4690b70ce2871fd8c4197b4a1f8e18d5d3bc11d';
    const worktreeFingerprint = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const buildReceiptDigest = 'sha256:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const imageDigest = 'sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const envManifestDigest = 'sha256:3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const receipt = createDataScaleRuntimeReceipt({
        dataScaleRunId: runId,
        parentSchedulerRunId: 'sched-03',
        sourceCommit,
        worktreeFingerprint,
        buildReceiptDigest,
        imageDigest,
        namespace: 'scale-ns-03',
        postgres: {
            containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            database: 'fsusblog_data_scale',
            imageDigest: 'sha256:4123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            volumeId: `fsusblog-data-scale-pg-vol-${runId}`
        },
        redis: {
            containerId: '5123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            imageDigest: 'sha256:6123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            volumeId: `fsusblog-data-scale-redis-vol-${runId}`
        },
        backend: {
            baseUrl: 'http://127.0.0.1:18888',
            executableOrImageDigest: imageDigest,
            pidOrContainerId: '7123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            startTicks: '1234567890'
        },
        aotRoot: `.tmp/scale/${runId}/aot`,
        searchRoot: `.tmp/scale/${runId}/search`,
        hotReadRoot: `.tmp/scale/${runId}/hotread`,
        dataRoot: `.tmp/scale/${runId}/data`,
        envManifestDigest,
        seedReceiptPath: seedReceiptRelative,
        seedReceiptDigest: seedReceiptBytesDigest,
        createdAt: new Date().toISOString()
    });

    assert.equal(receipt.schema, DATA_SCALE_RUNTIME_SCHEMA);
    assert.ok(receipt.contentDigest.startsWith('sha256:'));

    const receiptRelative = `.tmp/scale/${runId}/data/runtime-receipt.json`;
    const receiptAbsolute = path.join(temp, receiptRelative);
    fs.writeFileSync(receiptAbsolute, `${JSON.stringify(receipt, null, 2)}\n`);

    const identity = {
        sourceState: {
            commit: sourceCommit,
            worktreeFingerprint
        },
        build: {
            contentDigest: buildReceiptDigest,
            imageDigest
        }
    };

    const verified = verifyDataScaleOwnerReceipt({
        repositoryRoot: temp,
        ownerReceipt: 'data-scale-runtime',
        receiptPath: receiptRelative,
        identity,
        runId: 'sched-03'
    });

    assert.equal(verified.document.dataScaleRunId, runId);
    assert.equal(verified.document.schema, DATA_SCALE_RUNTIME_SCHEMA);
});

test('data-scale runtime receipt rejects tampered fields', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-tamper-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const runId = 'run-tamper-04';
    const seedReceiptRelative = `.tmp/scale/${runId}/data/seed-receipt.json`;
    const seedReceiptAbsolute = path.join(temp, seedReceiptRelative);
    fs.mkdirSync(path.dirname(seedReceiptAbsolute), { recursive: true });
    fs.writeFileSync(seedReceiptAbsolute, '{"seed": "ok"}\n');
    const seedReceiptBytesDigest = computeSha256(fs.readFileSync(seedReceiptAbsolute));

    const receipt = createDataScaleRuntimeReceipt({
        dataScaleRunId: runId,
        parentSchedulerRunId: 'sched-04',
        sourceCommit: 'b4690b70ce2871fd8c4197b4a1f8e18d5d3bc11d',
        worktreeFingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        buildReceiptDigest: 'sha256:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        imageDigest: 'sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        namespace: 'scale-ns-04',
        postgres: {
            containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            database: 'fsusblog_data_scale',
            imageDigest: 'sha256:4123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            volumeId: `fsusblog-data-scale-pg-vol-${runId}`
        },
        redis: {
            containerId: '5123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            imageDigest: 'sha256:6123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            volumeId: `fsusblog-data-scale-redis-vol-${runId}`
        },
        backend: {
            baseUrl: 'http://127.0.0.1:18888',
            executableOrImageDigest: 'sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            pidOrContainerId: '7123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            startTicks: '1234567890'
        },
        aotRoot: `.tmp/scale/${runId}/aot`,
        searchRoot: `.tmp/scale/${runId}/search`,
        hotReadRoot: `.tmp/scale/${runId}/hotread`,
        dataRoot: `.tmp/scale/${runId}/data`,
        envManifestDigest: 'sha256:3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        seedReceiptPath: seedReceiptRelative,
        seedReceiptDigest: seedReceiptBytesDigest,
        createdAt: new Date().toISOString()
    });

    // Tamper with parent scheduler runId
    receipt.parentSchedulerRunId = 'tampered-scheduler-id';

    const receiptRelative = `.tmp/scale/${runId}/data/runtime-receipt.json`;
    const receiptAbsolute = path.join(temp, receiptRelative);
    fs.writeFileSync(receiptAbsolute, `${JSON.stringify(receipt, null, 2)}\n`);

    const identity = {
        sourceState: {
            commit: 'b4690b70ce2871fd8c4197b4a1f8e18d5d3bc11d',
            worktreeFingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        },
        build: {
            contentDigest: 'sha256:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            imageDigest: 'sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        }
    };

    assert.throws(() =>
    {
        verifyDataScaleOwnerReceipt({
            repositoryRoot: temp,
            ownerReceipt: 'data-scale-runtime',
            receiptPath: receiptRelative,
            identity,
            runId: 'sched-04'
        });
    }, /identity mismatch/);
});
