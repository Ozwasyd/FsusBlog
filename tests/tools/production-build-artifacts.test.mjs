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
    productionBuildConsumerMaterializationVerificationSchema,
    productionBuildReceiptSchema,
    registerProductionBuildConsumer,
    releaseProductionBuildConsumer,
    verifyProductionBuildConsumerMaterialization,
    verifyProductionBuildReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This contract test imports the repository owner that it directly exercises.
} from '../../tools/ci/production-build-artifacts.mjs';

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
};
const producer = { workflow: 'Quality Gate', runId: '42', runAttempt: 2, job: 'production-build-artifacts' };
const toolchain = {
    node: 'v24.1.0', npm: '11.0.0', dotnet: '10.0.1', vite: '7.0.0', vitest: '4.0.0', playwright: '1.58.0', emsdk: '4.0.0'
};

function verifyMigrationBuildDependency(source)
{
    const serverBuild = 'dotnet build "$ROOT_DIR/src/backend/FsusBlog.Server.csproj"';
    const migrationBuild = 'dotnet build "$ROOT_DIR/src/migration/FsusBlog.Migration.csproj"';
    const testBuild = 'dotnet build "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"';
    const requiredInputs = [
        '--input src/migration/FsusBlog.Migration.csproj',
        '--input src/migration/packages.lock.json'
    ];
    const occurrences = marker => source.split(marker).length - 1;

    assert.equal(occurrences(serverBuild), 1, 'lane must keep one explicit Server build');
    assert.equal(occurrences(migrationBuild), 1, 'lane must keep one explicit Migration build');
    assert.equal(occurrences(testBuild), 1, 'lane must keep one explicit backend tests build');

    const serverIndex = source.indexOf(serverBuild);
    const migrationIndex = source.indexOf(migrationBuild);
    const testIndex = source.indexOf(testBuild);
    assert.ok(serverIndex < migrationIndex, 'Migration must build after its Shared dependency is produced by the Server build');
    assert.ok(migrationIndex < testIndex, 'Migration must build before the no-dependencies test consumer');

    const serverCommand = source.slice(serverIndex, migrationIndex);
    assert.match(
        serverCommand,
        /-p:FsusBlogCommitSha="\$\{FSUSBLOG_TEST_SOURCE_COMMIT:\?production build source commit is required\}"/u,
        'Server assembly metadata must exact-bind the production build source commit'
    );

    const migrationCommand = source.slice(migrationIndex, testIndex);
    assert.match(
        migrationCommand,
        /-c Release --no-restore --no-dependencies --no-incremental -warnaserror/u,
        'Migration must use the explicit Release no-dependencies build contract'
    );
    const testCommand = source.slice(testIndex, source.indexOf('\nfi', testIndex));
    assert.match(
        testCommand,
        /-c Release --no-restore --no-dependencies --no-incremental -warnaserror/u,
        'the backend test consumer must remain no-dependencies and fail closed on missing outputs'
    );
    for (const input of requiredInputs)
    {
        assert.equal(occurrences(input), 1, `receipt must exact-bind ${input}`);
    }
}

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

function consumerMaterializationFixture(t)
{
    const value = fixture(t);
    create(value);
    const runId = 'consumer-run';
    const consumerId = 'current-schema';
    const destinationRoot = path.join(value.root, 'consumer-materialization');
    const mappings = [{ name: 'backend-runtime', destination: 'backend' }];
    const lease = registerProductionBuildConsumer({
        artifactRoot: value.artifactRoot,
        runId,
        consumerId
    });
    const materialized = materializeProductionBuildDomains({
        artifactRoot: value.artifactRoot,
        destinationRoot,
        mappings,
        verification: {
            expectedSourceState: sourceState,
            expectedProducer: { runId: producer.runId }
        }
    });
    const materializationEvidence = {
        ...materialized.evidence,
        materialized: materialized.copied,
        consumerLease: lease
    };
    const evidenceFile = path.join(value.root, 'consumer-materialization-evidence.json');
    fs.writeFileSync(evidenceFile, `${JSON.stringify(materializationEvidence, null, 2)}\n`);
    return {
        ...value,
        runId,
        consumerId,
        destinationRoot,
        mappings,
        lease,
        evidenceFile,
        materializationEvidence,
        requiredCandidateFiles: [{
            domain: 'backend-runtime',
            artifact: 'FsusBlog.Server.dll',
            candidate: 'backend/FsusBlog.Server.dll'
        }]
    };
}

function verifyConsumerMaterialization(value, overrides = {})
{
    return verifyProductionBuildConsumerMaterialization({
        artifactRoot: value.artifactRoot,
        evidenceFile: value.evidenceFile,
        destinationRoot: value.destinationRoot,
        runId: value.runId,
        consumerId: value.consumerId,
        mappings: value.mappings,
        requiredCandidateFiles: value.requiredCandidateFiles,
        verification: {
            expectedSourceState: sourceState,
            expectedProducer: { runId: producer.runId }
        },
        ...overrides
    });
}

test('lane builds and binds Migration before the no-dependencies backend test consumer', () =>
{
    const lane = fs.readFileSync(new URL('../../tools/test/lanes/production-build-artifacts.sh', import.meta.url), 'utf8');
    assert.doesNotThrow(() => verifyMigrationBuildDependency(lane));
});

test('lane dependency contract rejects missing, reordered, implicit and unbound Migration builds', () =>
{
    const lane = fs.readFileSync(new URL('../../tools/test/lanes/production-build-artifacts.sh', import.meta.url), 'utf8');
    const migrationCommand = / {4}"\$ROOT_DIR\/tools\/test\/run-with-dotnet-release-build-lock\.sh" \\\n {8}"\$ROOT_DIR\/tools\/build-with-data-env\.sh" dotnet build "\$ROOT_DIR\/src\/migration\/FsusBlog\.Migration\.csproj" \\\n {8}-c Release --no-restore --no-dependencies --no-incremental -warnaserror -v minimal \/p:NuGetAudit=false\n/u;
    const match = lane.match(migrationCommand);
    assert.ok(match, 'test fixture must locate the exact Migration build command');
    const withoutMigration = lane.replace(migrationCommand, '');
    assert.throws(() => verifyMigrationBuildDependency(withoutMigration), /one explicit Migration build/u);

    const reordered = withoutMigration.replace(
        /(-c Release --no-restore --no-dependencies --no-incremental -warnaserror -v minimal \/p:NuGetAudit=false\n)(fi\n)/u,
        `$1${match[0]}$2`
    );
    assert.throws(() => verifyMigrationBuildDependency(reordered), /before the no-dependencies test consumer/u);

    const implicitTestBuild = lane.replace(
        /("\$ROOT_DIR\/tests\/backend\/FsusBlog\.Server\.Tests\.csproj" \\\n {8}-c Release --no-restore )--no-dependencies /u,
        '$1'
    );
    assert.throws(() => verifyMigrationBuildDependency(implicitTestBuild), /test consumer must remain no-dependencies/u);

    const unboundServerAssembly = lane.replace(
        / \\\n+ {8}-p:FsusBlogCommitSha="\$\{FSUSBLOG_TEST_SOURCE_COMMIT:\?production build source commit is required\}"/u,
        ''
    );
    assert.throws(
        () => verifyMigrationBuildDependency(unboundServerAssembly),
        /assembly metadata must exact-bind/u
    );

    for (const input of ['--input src/migration/FsusBlog.Migration.csproj', '--input src/migration/packages.lock.json'])
    {
        assert.throws(
            () => verifyMigrationBuildDependency(lane.replace(`${input}\n`, '')),
            /receipt must exact-bind/u
        );
    }
});

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

test('consumer verifier exact-binds receipt, active lease, read-only mapping and required candidate', t =>
{
    const value = consumerMaterializationFixture(t);
    const verified = verifyConsumerMaterialization(value);

    assert.equal(verified.evidence.schema, productionBuildConsumerMaterializationVerificationSchema);
    assert.equal(verified.evidence.status, 'success');
    assert.equal(verified.evidence.receiptContentDigest, verified.receipt.contentDigest);
    assert.deepEqual(verified.evidence.mappings, value.mappings);
    assert.equal(verified.lease.status, 'active');
    assert.equal(verified.candidates.length, 1);
    assert.equal(verified.candidates[0].receiptPath, 'payload/backend/FsusBlog.Server.dll');
    assert.equal(
        verified.candidates[0].physicalPath,
        fs.realpathSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll'))
    );
});

test('consumer verifier re-runs immutable receipt verification without repairing its seal', t =>
{
    const value = consumerMaterializationFixture(t);
    const artifact = path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll');
    fs.chmodSync(artifact, 0o644);

    assert.throws(() => verifyConsumerMaterialization(value), /artifact read-only seal is missing/u);
    assert.notEqual(fs.statSync(artifact).mode & 0o222, 0);
});

test('consumer verifier rejects stale runs and missing or inactive leases', t =>
{
    const stale = consumerMaterializationFixture(t);
    assert.throws(
        () => verifyConsumerMaterialization(stale, { runId: 'stale-run' }),
        /consumer lease is missing/u
    );

    const missing = consumerMaterializationFixture(t);
    fs.rmSync(`${missing.artifactRoot}.state/consumers/${missing.runId}--${missing.consumerId}.json`);
    assert.throws(() => verifyConsumerMaterialization(missing), /consumer lease is missing/u);

    const inactive = consumerMaterializationFixture(t);
    releaseProductionBuildConsumer({
        artifactRoot: inactive.artifactRoot,
        runId: inactive.runId,
        consumerId: inactive.consumerId,
        reason: 'cancelled'
    });
    assert.throws(() => verifyConsumerMaterialization(inactive), /consumer lease is inactive/u);

    const linked = consumerMaterializationFixture(t);
    const leaseFile = `${linked.artifactRoot}.state/consumers/${linked.runId}--${linked.consumerId}.json`;
    const leaseTarget = path.join(linked.root, 'copied-consumer-lease.json');
    fs.copyFileSync(leaseFile, leaseTarget);
    fs.rmSync(leaseFile);
    fs.symlinkSync(leaseTarget, leaseFile);
    assert.throws(() => verifyConsumerMaterialization(linked), /regular non-symlink/u);
});

test('consumer verifier rejects non-canonical and tampered materialization evidence', t =>
{
    const linked = consumerMaterializationFixture(t);
    const linkedEvidence = path.join(linked.root, 'linked-evidence.json');
    fs.symlinkSync(linked.evidenceFile, linkedEvidence);
    assert.throws(
        () => verifyConsumerMaterialization(linked, { evidenceFile: linkedEvidence }),
        /regular non-symlink/u
    );

    for (const [mutate, expected] of [
        [evidence =>
        {
            evidence.schema = 'fake';
        }, /schema\/status/u],
        [evidence =>
        {
            evidence.status = 'failure';
        }, /schema\/status/u],
        [evidence =>
        {
            evidence.receiptContentDigest = `sha256:${'0'.repeat(64)}`;
        }, /digest binding/u],
        [evidence =>
        {
            evidence.sourceState.commit = 'c'.repeat(40);
        }, /source binding/u],
        [evidence =>
        {
            evidence.consumerLease.runId = 'stale-run';
        }, /evidence lease binding/u],
        [evidence =>
        {
            evidence.materialization.domains[0].bytes += 1;
        }, /mapping evidence is not exact/u]
    ])
    {
        const value = consumerMaterializationFixture(t);
        const evidence = structuredClone(value.materializationEvidence);
        mutate(evidence);
        fs.writeFileSync(value.evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
        assert.throws(() => verifyConsumerMaterialization(value), expected);
    }
});

test('consumer verifier rejects retargeted domains and non-exact candidate bindings', t =>
{
    const retargeted = consumerMaterializationFixture(t);
    const domainTarget = path.join(retargeted.destinationRoot, 'backend');
    fs.unlinkSync(domainTarget);
    fs.symlinkSync(path.join(retargeted.artifactRoot, 'payload/frontend'), domainTarget, 'junction');
    assert.throws(() => verifyConsumerMaterialization(retargeted), /destination target mismatch/u);

    const lexical = consumerMaterializationFixture(t);
    assert.throws(() => verifyConsumerMaterialization(lexical, {
        requiredCandidateFiles: [{
            domain: 'backend-runtime',
            artifact: 'FsusBlog.Server.dll',
            candidate: 'backend/../backend/FsusBlog.Server.dll'
        }]
    }), /path is not canonical/u);

    const unreceipted = consumerMaterializationFixture(t);
    assert.throws(() => verifyConsumerMaterialization(unreceipted, {
        requiredCandidateFiles: [{
            domain: 'backend-runtime',
            artifact: 'Other.Server.dll',
            candidate: 'backend/Other.Server.dll'
        }]
    }), /not an exact receipt artifact/u);

    const wrongMapping = consumerMaterializationFixture(t);
    assert.throws(() => verifyConsumerMaterialization(wrongMapping, {
        requiredCandidateFiles: [{
            domain: 'backend-runtime',
            artifact: 'FsusBlog.Server.dll',
            candidate: 'other/FsusBlog.Server.dll'
        }]
    }), /lexical mapping is not exact/u);
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
