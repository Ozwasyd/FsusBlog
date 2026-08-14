import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    collectProductionBuildArtifactStore,
    createProductionBuildReceipt,
    materializeProductionBuildDomains,
    productionBuildReceiptSchema,
    registerProductionBuildConsumer,
    releaseProductionBuildMaterialization,
    releaseProductionBuildConsumer,
    verifyProductionBuildReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This lane directly tests its production-build owner module.
} from '../../tools/ci/production-build-artifacts.mjs';

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
};
const producer = { workflow: 'Quality Gate', runId: '42', runAttempt: 2, job: 'production-build-artifacts' };
const toolchain = {
    node: 'v24.1.0', npm: '11.0.0', dotnet: '10.0.1', vite: '7.0.0', vitest: '4.0.0', playwright: '1.58.0', emsdk: '4.0.0'
};

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ci-build-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const artifactRoot = path.join(root, 'artifact');
    fs.mkdirSync(path.join(artifactRoot, 'payload/backend'), { recursive: true });
    fs.mkdirSync(path.join(artifactRoot, 'payload/frontend'), { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'payload/backend/FsusBlog.Server.dll'), 'server');
    fs.writeFileSync(path.join(artifactRoot, 'payload/frontend/index.html'), '<main>ok</main>');
    fs.writeFileSync(path.join(root, 'global.json'), '{"sdk":{"version":"10.0.100"}}\n');
    return { root, artifactRoot };
}

function create(value)
{
    return createProductionBuildReceipt({
        ...value,
        sourceState,
        producer,
        toolchain,
        inputPaths: ['global.json'],
        domains: [
            { name: 'backend-runtime', path: 'payload/backend' },
            { name: 'frontend-dist', path: 'payload/frontend' }
        ],
        build: { profile: 'production-release-fresh', command: './tools/test.sh ci-tier production-build-artifacts' }
    });
}

test('receipt binds source, toolchain, producer, input and every immutable artifact digest', t =>
{
    const value = fixture(t);
    const receipt = create(value);
    assert.equal(receipt.schema, productionBuildReceiptSchema);
    assert.deepEqual(receipt.sourceState, sourceState);
    assert.deepEqual(receipt.producer, producer);
    assert.equal(receipt.inputDigests.length, 1);
    assert.equal(receipt.artifacts.length, 2);
    assert.ok(receipt.artifacts.every(entry => /^sha256:[a-f0-9]{64}$/u.test(entry.sha256)));
    assert.match(receipt.contentDigest, /^sha256:[a-f0-9]{64}$/u);

    const verified = verifyProductionBuildReceipt({
        artifactRoot: value.artifactRoot,
        expectedSourceState: sourceState,
        expectedProducer: { runId: '42', runAttempt: 2 },
        expectedToolchain: { node: 'v24.1.0' },
        expectedInputRoot: value.root
    });
    assert.equal(verified.evidence.status, 'success');
    assert.equal(verified.evidence.artifactBytes, Buffer.byteLength('server') + Buffer.byteLength('<main>ok</main>'));
});

test('receipt verification treats prefixed and unprefixed worktree fingerprints as the same SHA-256', t =>
{
    const value = fixture(t);
    create(value);
    const verified = verifyProductionBuildReceipt({
        artifactRoot: value.artifactRoot,
        expectedSourceState: {
            ...sourceState,
            worktreeFingerprint: `sha256:${sourceState.worktreeFingerprint}`
        }
    });
    assert.equal(verified.evidence.status, 'success');
});

test('receipt verification preserves the filesystem order for mixed-case artifact paths', t =>
{
    const value = fixture(t);
    fs.writeFileSync(path.join(value.artifactRoot, 'payload/backend/alpha.dll'), 'alpha');
    fs.writeFileSync(path.join(value.artifactRoot, 'payload/backend/Zeta.dll'), 'zeta');
    create(value);

    const verified = verifyProductionBuildReceipt({ artifactRoot: value.artifactRoot });
    assert.equal(verified.evidence.status, 'success');
    assert.equal(verified.evidence.artifactCount, 4);
});

test('verification restores the read-only seal after a transfer strips file modes', t =>
{
    const value = fixture(t);
    create(value);
    const artifact = path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll');
    fs.chmodSync(artifact, 0o644);
    fs.chmodSync(path.join(value.artifactRoot, 'receipt.json'), 0o644);
    const verified = verifyProductionBuildReceipt({ artifactRoot: value.artifactRoot });
    assert.equal(verified.evidence.restoredSealFiles, 2);
    assert.equal(fs.statSync(artifact).mode & 0o222, 0);
});

test('coordination verification rejects a writable seal without repairing it', t =>
{
    const value = fixture(t);
    create(value);
    const artifact = path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll');
    const receipt = path.join(value.artifactRoot, 'receipt.json');
    fs.chmodSync(artifact, 0o644);
    fs.chmodSync(receipt, 0o644);
    assert.throws(() => verifyProductionBuildReceipt({
        artifactRoot: value.artifactRoot,
        repairReadOnlySeal: false
    }), /read-only seal is missing/u);
    assert.notEqual(fs.statSync(artifact).mode & 0o222, 0);
    assert.notEqual(fs.statSync(receipt).mode & 0o222, 0);
});

test('consumer rejects checkout input drift even when the receipt and payload are unchanged', t =>
{
    const value = fixture(t);
    create(value);
    fs.writeFileSync(path.join(value.root, 'global.json'), '{"sdk":{"version":"99.0.0"}}\n');

    assert.throws(() => verifyProductionBuildReceipt({
        artifactRoot: value.artifactRoot,
        expectedSourceState: sourceState,
        expectedToolchain: toolchain,
        expectedInputRoot: value.root
    }), error =>
    {
        assert.match(error.message, /input digest mismatch: global\.json/u);
        assert.equal(error.evidence.status, 'failure');
        return true;
    });
});

test('wrong commit, wrong run and toolchain drift fail closed', t =>
{
    const value = fixture(t);
    create(value);
    assert.throws(() => verifyProductionBuildReceipt({
        artifactRoot: value.artifactRoot,
        expectedSourceState: { ...sourceState, commit: 'c'.repeat(40) },
        expectedProducer: { workflow: 'Other Workflow', runId: 'stale', runAttempt: 3 },
        expectedToolchain: { node: 'v99.0.0' }
    }), error =>
    {
        assert.match(error.message, /commit SHA mismatch/u);
        assert.match(error.message, /producer workflow mismatch/u);
        assert.match(error.message, /producer runId mismatch/u);
        assert.match(error.message, /producer runAttempt mismatch/u);
        assert.match(error.message, /toolchain node mismatch/u);
        assert.equal(error.evidence.status, 'failure');
        return true;
    });
});

test('missing, damaged and unreceipted artifacts are all rejected', t =>
{
    const value = fixture(t);
    create(value);
    fs.chmodSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll'), 0o644);
    fs.appendFileSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll'), '-tampered');
    fs.rmSync(path.join(value.artifactRoot, 'payload/frontend/index.html'));
    fs.writeFileSync(path.join(value.artifactRoot, 'payload/backend/unreceipted.dll'), 'extra');
    fs.writeFileSync(path.join(value.artifactRoot, 'root-extra.txt'), 'extra');
    assert.throws(() => verifyProductionBuildReceipt({ artifactRoot: value.artifactRoot }), error =>
    {
        assert.match(error.message, /artifact size mismatch/u);
        assert.match(error.message, /artifact digest mismatch/u);
        assert.match(error.message, /artifact is missing/u);
        assert.match(error.message, /unreceipted files/u);
        assert.match(error.message, /artifact root contains files not covered/u);
        return true;
    });
});

test('path escape and symlink payloads are rejected before a receipt is emitted', t =>
{
    const value = fixture(t);
    assert.throws(() => createProductionBuildReceipt({
        root: value.root,
        artifactRoot: value.artifactRoot,
        sourceState,
        producer,
        toolchain,
        inputPaths: ['global.json'],
        domains: [{ name: 'escape', path: '../outside' }]
    }), /unsafe|escapes/u);
    fs.symlinkSync(path.join(value.root, 'global.json'), path.join(value.artifactRoot, 'payload/backend/link'));
    assert.throws(() => create(value), /symlink/u);
});

test('sealed domains are read-only and receipt identity changes with source, toolchain or build input', t =>
{
    const value = fixture(t);
    const receipt = create(value);
    assert.equal(receipt.seal.mode, 'read-only-files');
    assert.equal(receipt.seal.atomicReceipt, true);
    assert.equal(receipt.digestTable.authority, 'receipt.artifacts');
    assert.equal(receipt.digestTable.traversalCount, 1);
    assert.equal(fs.statSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll')).mode & 0o222, 0);
    assert.throws(() => create(value), /receipt is already sealed/u);

    for (const drift of [
        { expectedSourceState: { ...sourceState, commit: 'c'.repeat(40) } },
        { expectedToolchain: { node: 'v99' } }
    ])
    {
        assert.throws(() => verifyProductionBuildReceipt({ artifactRoot: value.artifactRoot, ...drift }), /mismatch/u);
    }
    fs.chmodSync(path.join(value.root, 'global.json'), 0o644);
    fs.writeFileSync(path.join(value.root, 'global.json'), '{"sdk":{"version":"99.0.0"}}\n');
    assert.throws(() => verifyProductionBuildReceipt({
        artifactRoot: value.artifactRoot,
        expectedInputRoot: value.root
    }), /input digest mismatch/u);
});

test('read-only consumers reference one sealed tree while writable consumers use CoW and cannot pollute it', t =>
{
    const value = fixture(t);
    create(value);
    const original = fs.readFileSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll'));
    const destinationRoot = path.join(value.root, 'consumer');
    const result = materializeProductionBuildDomains({
        artifactRoot: value.artifactRoot,
        destinationRoot,
        mappings: [
            { name: 'backend-runtime', destination: '.runtime/backend' },
            { name: 'frontend-dist', destination: '.runtime/frontend' },
            { name: 'frontend-dist', destination: '.runtime/wwwroot' }
        ],
        verification: { expectedSourceState: sourceState, expectedProducer: { runId: '42' } }
    });
    assert.equal(result.evidence.digestTraversalCount, 1);
    assert.equal(result.evidence.referencedBytes, Buffer.byteLength('server') + (2 * Buffer.byteLength('<main>ok</main>')));
    assert.equal(result.evidence.copiedBytes, 0);
    assert.equal(result.evidence.materialization.domains.every(item => item.method === 'reference'), true);
    assert.equal(
        fs.realpathSync(path.join(destinationRoot, '.runtime/frontend')),
        fs.realpathSync(path.join(destinationRoot, '.runtime/wwwroot'))
    );

    const writable = materializeProductionBuildDomains({
        artifactRoot: value.artifactRoot,
        destinationRoot: path.join(value.root, 'writable'),
        mappings: [{ name: 'backend-runtime', destination: '.runtime/backend', writable: true }],
        cloneFile: (source, destination) => fs.copyFileSync(source, destination),
        verification: { expectedSourceState: sourceState }
    });
    assert.equal(writable.evidence.materialization.domains[0].method, 'reflink');
    assert.equal(writable.evidence.reflinkedBytes, Buffer.byteLength('server'));
    fs.chmodSync(path.join(value.root, 'writable/.runtime/backend/FsusBlog.Server.dll'), 0o644);
    fs.appendFileSync(path.join(value.root, 'writable/.runtime/backend/FsusBlog.Server.dll'), '-pollution');
    assert.deepEqual(fs.readFileSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll')), original);
});

test('unsupported CoW records an explicit ordinary-copy fallback instead of silently degrading', t =>
{
    const value = fixture(t);
    create(value);
    const result = materializeProductionBuildDomains({
        artifactRoot: value.artifactRoot,
        destinationRoot: path.join(value.root, 'fallback'),
        mappings: [{ name: 'backend-runtime', destination: 'backend', writable: true }],
        cloneFile: () =>
        {
            const error = new Error('fixture has no reflink');
            error.code = 'ENOTSUP';
            throw error;
        }
    });
    assert.equal(result.evidence.materialization.domains[0].method, 'copy-fallback');
    assert.match(result.evidence.materialization.domains[0].fallbackReason, /ENOTSUP/u);
    assert.deepEqual(
        result.evidence.materialization.domains[0].attempts.map(item => item.method),
        ['reflink', 'overlay', 'hardlink-writable-layer', 'copy-fallback']
    );
    assert.equal(result.evidence.copiedBytes, Buffer.byteLength('server'));
});

test('CoW I/O failures fail closed instead of being mislabeled as unsupported-platform fallback', t =>
{
    const value = fixture(t);
    create(value);
    assert.throws(() => materializeProductionBuildDomains({
        artifactRoot: value.artifactRoot,
        destinationRoot: path.join(value.root, 'io-failure'),
        mappings: [{ name: 'backend-runtime', destination: 'backend', writable: true }],
        cloneFile: () =>
        {
            const error = new Error('fixture storage failure');
            error.code = 'EIO';
            throw error;
        }
    }), /fixture storage failure/u);
    assert.equal(fs.existsSync(path.join(value.root, 'io-failure/backend')), false);
});

test('failed materialization releases its active consumer lease for cancel-safe GC', t =>
{
    const value = fixture(t);
    create(value);
    const result = spawnSync(process.execPath, [
        'tools/ci/production-build-artifacts-cli.mjs',
        'materialize',
        '--artifact-root', value.artifactRoot,
        '--destination-root', path.join(value.root, 'failed-consumer'),
        '--map', 'missing-domain=runtime',
        '--consumer-run-id', 'run-failed',
        '--consumer-id', 'fixture'
    ], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.equal(result.status, 1);
    const lease = JSON.parse(fs.readFileSync(
        `${value.artifactRoot}.state/consumers/run-failed--fixture.json`,
        'utf8'
    ));
    assert.equal(lease.status, 'released');
    assert.equal(lease.releaseReason, 'materialization-failed');
});

test('qualified consumer cleanup removes only its exact materialization before releasing the lease', t =>
{
    const value = fixture(t);
    create(value);
    const runId = 'qualified-run';
    const consumerId = 'qualified-namespace';
    const buildRunId = `${runId}-acceptance`;
    const buildRoot = path.join(value.root, '.tmp/build', buildRunId);
    registerProductionBuildConsumer({
        artifactRoot: value.artifactRoot,
        runId,
        consumerId
    });
    fs.mkdirSync(path.join(buildRoot, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(buildRoot, 'frontend/index.html'), 'materialized');

    const result = releaseProductionBuildMaterialization({
        root: value.root,
        artifactRoot: value.artifactRoot,
        runId,
        consumerId,
        buildRunId
    });
    assert.equal(fs.existsSync(buildRoot), false);
    assert.equal(result.lease.status, 'released');
    assert.equal(result.lease.releaseReason, 'completed');

    registerProductionBuildConsumer({
        artifactRoot: value.artifactRoot,
        runId,
        consumerId: 'tamper'
    });
    fs.mkdirSync(buildRoot, { recursive: true });
    fs.writeFileSync(path.join(buildRoot, 'layout.json'), '{}');
    assert.throws(
        () => releaseProductionBuildMaterialization({
            root: value.root,
            artifactRoot: value.artifactRoot,
            runId,
            consumerId: 'tamper',
            buildRunId
        }),
        /managed owner state/u
    );
    assert.equal(fs.existsSync(buildRoot), true);
});

test('active consumer leases protect sealed artifacts across resume and cancel while stale artifacts are collected', t =>
{
    const nowMs = Date.now();
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ci-build-store-'));
    t.after(() => fs.rmSync(storeRoot, { recursive: true, force: true }));
    const activeRoot = path.join(storeRoot, 'active');
    const invalidRoot = path.join(storeRoot, 'invalid');
    const staleRoot = path.join(storeRoot, 'stale');
    fs.mkdirSync(activeRoot);
    fs.mkdirSync(invalidRoot);
    fs.mkdirSync(staleRoot);
    const lifecycleReceipt = JSON.stringify({ schema: productionBuildReceiptSchema, status: 'complete' });
    fs.writeFileSync(path.join(activeRoot, 'receipt.json'), lifecycleReceipt);
    fs.writeFileSync(path.join(invalidRoot, 'receipt.json'), '{}');
    fs.writeFileSync(path.join(staleRoot, 'receipt.json'), lifecycleReceipt);
    assert.throws(
        () => registerProductionBuildConsumer({ artifactRoot: activeRoot, runId: '', consumerId: 'test-runtime' }),
        /requires runId and consumerId/u
    );
    const staleDate = new Date(nowMs - 1_000);
    fs.utimesSync(activeRoot, staleDate, staleDate);
    fs.utimesSync(staleRoot, staleDate, staleDate);
    registerProductionBuildConsumer({ artifactRoot: activeRoot, runId: 'run-1', consumerId: 'test-runtime', nowMs: nowMs - 100 });
    registerProductionBuildConsumer({ artifactRoot: activeRoot, runId: 'run-1', consumerId: 'test-runtime', nowMs });

    const protectedResult = collectProductionBuildArtifactStore({
        storeRoot,
        nowMs,
        staleAfterMs: 500
    });
    assert.deepEqual(protectedResult.removed, ['stale']);
    assert.deepEqual(protectedResult.protected, ['active']);
    assert.equal(fs.existsSync(invalidRoot), true);

    releaseProductionBuildConsumer({ artifactRoot: activeRoot, runId: 'run-1', consumerId: 'test-runtime', reason: 'cancelled' });
    const cancelledResult = collectProductionBuildArtifactStore({
        storeRoot,
        nowMs: nowMs + 1,
        staleAfterMs: 500
    });
    assert.deepEqual(cancelledResult.removed, ['active']);
});
