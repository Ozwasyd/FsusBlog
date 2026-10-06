import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertPreparedNugetCurrent, behaviorDocNugetClosure, inventoryNugetOfflineFeed, inventoryPreparedNuget,
    nugetPreparationClosure, nugetPreparationCommand, nugetPreparationDeclaration,
    nugetPreparationPurpose, observeNugetInputFile, observeNugetPreparationToolchain, readPreparedNuget,
    requireNugetResourceChannel, seedPreparedNuget
} from '../../tools/test/behavior-doc-nuget-preparation.mjs';
import { finalizeRunOwnedDirectoriesAfterPhysical, prepareRunOwnedDirectories } from '../../tools/test/execution-envelope-directories.mjs';
import { bindBehaviorDocNugetPreparationDiskDemand, bindMatrixNugetDiskDemand, readProductionDiskDemandCatalog } from '../../tools/test-matrix/production-disk-demand.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuget-control-'));
    fs.chmodSync(root, 0o700);
    t.after(() =>
    {
        if (!fs.existsSync(root)) return;
        const writable = (directory) =>
        {
            fs.chmodSync(directory, 0o700);
            for (const name of fs.readdirSync(directory))
            {
                const child = path.join(directory, name);
                if (fs.lstatSync(child).isDirectory()) writable(child);
            }
        };
        writable(root);
        fs.rmSync(root, { recursive: true });
    });
    return root;
}
function seal(directory)
{
    for (const name of fs.readdirSync(directory))
    {
        const file = path.join(directory, name);
        if (fs.lstatSync(file).isDirectory()) seal(file);
        else fs.chmodSync(file, 0o400);
    }
    fs.chmodSync(directory, 0o500);
}
function emptyZip()
{
    // A standard one-file ZIP containing empty a.txt, with its local and central records.
    const name = Buffer.from('a.txt');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(name.length, 28);
    const footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(1, 8); footer.writeUInt16LE(1, 10);
    footer.writeUInt32LE(central.length + name.length, 12); footer.writeUInt32LE(local.length + name.length, 16);
    return Buffer.concat([local, name, central, name, footer]);
}
const onePackage = { packages: [{ path: 'example/1.0.0', contentHash: Buffer.alloc(64).toString('base64') }] };
function feed(t)
{
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'example.1.0.0.nupkg'), emptyZip());
    seal(root);
    return root;
}

test('matrix has a closed declaration and a distinct absolute offline restore command', () =>
{
    assert.deepEqual(nugetPreparationDeclaration('matrix-governance').consumers, ['matrix-governance', 'validate-matrix']);
    assert.equal(nugetPreparationPurpose('validate-matrix'), 'matrix-governance');
    assert.equal(nugetPreparationPurpose('behavior-doc-static-admission'), 'behavior-doc');
    assert.throws(() => nugetPreparationPurpose('build-static'), /not declared/u);
    assert.throws(() => nugetPreparationDeclaration('custom'), /not declared/u);
    assert.throws(() => nugetPreparationCommand({ purpose: 'matrix-governance' }), /absolute SDK/u);
    assert.deepEqual(nugetPreparationCommand({ purpose: 'matrix-governance', toolchain: { executable: '/fixture/dotnet' },
        packagesRoot: '/fixture/packages', artifactsRoot: '/fixture/artifacts', feedRoot: '/fixture/feed', configFile: '/fixture/NuGet.Config' }),
    ['/fixture/dotnet', 'restore', 'tools/contracts/MatrixNugetRestore.slnx', '--locked-mode', '--packages', '/fixture/packages',
        '--artifacts-path', '/fixture/artifacts', '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel',
        '--source', '/fixture/feed', '--configfile', '/fixture/NuGet.Config']);
});

test('actual current matrix closure binds extractor injection and all reachable locked packages', () =>
{
    const matrix = nugetPreparationClosure(repositoryRoot, 'matrix-governance');
    for (const required of ['Directory.Build.props', 'Directory.Packages.props', 'src/shared/packages.lock.json',
        'tools/testing/FsusBlog.ContentFieldContractExtractor/Program.cs', 'tools/testing/FsusBlog.ContentFieldContractExtractor/Inject.targets',
        'tools/contracts/MatrixNugetRestore.slnx', 'ops/docker/FsusBlog.Server.Dockerfile'])
        assert.ok(matrix.sourceClosureDigests.some((entry) => entry.path === required), required);
    const donor = new Map(behaviorDocNugetClosure(repositoryRoot).packages.map((entry) => [entry.path, entry.contentHash]));
    for (const entry of matrix.packages) assert.equal(donor.get(entry.path), entry.contentHash);
    assert.ok(matrix.packages.length > 0);
});

test('finite archive input rejects extra archives, writable inputs, symlinks and hardlinks', (t) =>
{
    const root = feed(t);
    const before = inventoryNugetOfflineFeed(root, onePackage);
    assert.ok(before.expandedAllocatedBytes > before.allocatedBytes);
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(path.join(root, 'foreign.1.0.0.nupkg'), emptyZip(), { mode: 0o400 });
    fs.chmodSync(root, 0o500);
    assert.throws(() => inventoryNugetOfflineFeed(root, onePackage), /roster/u);
    fs.chmodSync(root, 0o700); fs.unlinkSync(path.join(root, 'foreign.1.0.0.nupkg'));
    fs.chmodSync(root, 0o500);
    const archive = path.join(root, 'example.1.0.0.nupkg');
    fs.chmodSync(archive, 0o600);
    assert.throws(() => inventoryNugetOfflineFeed(root, onePackage), /sealed/u);
    fs.chmodSync(archive, 0o400);
    const outside = fixture(t); fs.linkSync(archive, path.join(outside, 'linked.nupkg'));
    assert.throws(() => inventoryNugetOfflineFeed(root, onePackage), /non-linked/u);
    fs.unlinkSync(path.join(outside, 'linked.nupkg'));
    fs.chmodSync(root, 0o700); fs.renameSync(archive, path.join(outside, 'donor.nupkg')); fs.symlinkSync(path.join(outside, 'donor.nupkg'), archive);
    fs.chmodSync(root, 0o500);
    assert.throws(() => inventoryNugetOfflineFeed(root, onePackage), /symlinks/u);
});

test('archive byte drift changes the finite input and malformed ZIP has no resource bound', (t) =>
{
    const root = feed(t), archive = path.join(root, 'example.1.0.0.nupkg');
    const before = inventoryNugetOfflineFeed(root, onePackage);
    const changed = emptyZip(); changed[10] = 1;
    fs.chmodSync(archive, 0o600); fs.writeFileSync(archive, changed); fs.chmodSync(archive, 0o400);
    assert.notEqual(inventoryNugetOfflineFeed(root, onePackage).treeDigest, before.treeDigest);
    fs.chmodSync(archive, 0o600); fs.writeFileSync(archive, Buffer.alloc(25)); fs.chmodSync(archive, 0o400);
    assert.throws(() => inventoryNugetOfflineFeed(root, onePackage), /ZIP/u);
});

test('same-byte file replacement changes descriptor custody identity', (t) =>
{
    const root = fixture(t), file = path.join(root, 'descriptor.json');
    fs.writeFileSync(file, '{}', { mode: 0o400 });
    const before = observeNugetInputFile(file);
    fs.renameSync(file, path.join(root, 'old.json')); fs.writeFileSync(file, '{}', { mode: 0o400 });
    const after = observeNugetInputFile(file);
    assert.equal(before.sha256, after.sha256);
    assert.notDeepEqual(before, after);
});

test('foreign producer or purpose cannot acquire ingress or start native preparation', async (t) =>
{
    await assert.rejects(readPreparedNuget({ producerId: 'foreign' }), /not declared/u);
    const root = fixture(t), file = path.join(root, 'foreign.json');
    fs.writeFileSync(file, JSON.stringify({ purpose: 'behavior-doc' }), { mode: 0o400 });
    await assert.rejects(readPreparedNuget({ repositoryRoot, producerId: 'matrix-governance', runId: 'fixture', file }), /foreign declaration/u);
    const original = process.env.FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL;
    delete process.env.FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL;
    try { await assert.rejects(requireNugetResourceChannel({ root: repositoryRoot, runId: 'fixture', sourceState: {} }), /original resource-owner/u); }
    finally { if (original !== undefined) process.env.FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL = original; }
});

test('seed drift rejects before copy and failed copy preserves removable task-owned residue', (t) =>
{
    const source = fixture(t), destination = fixture(t);
    fs.mkdirSync(path.join(source, 'example')); fs.writeFileSync(path.join(source, 'example/a'), 'a'); fs.writeFileSync(path.join(source, 'example/b'), 'b');
    seal(source);
    const prepared = inventoryPreparedNuget(source);
    assert.throws(() => seedPreparedNuget({ ...prepared, treeDigest: '0'.repeat(64) }, destination), /drifted/u);
    assert.deepEqual(fs.readdirSync(destination), []);
    const write = fs.writeFileSync;
    let copied = 0;
    fs.writeFileSync = (file, ...args) =>
    {
        if (String(file).startsWith(destination + path.sep) && ++copied === 2) throw new Error('controlled-copy-failure');
        return write(file, ...args);
    };
    try { assert.throws(() => seedPreparedNuget(prepared, destination), /controlled-copy-failure/u); }
    finally { fs.writeFileSync = write; }
    assert.equal(inventoryPreparedNuget(source).treeDigest, prepared.treeDigest);
    fs.rmSync(destination, { recursive: true });
    assert.equal(fs.existsSync(destination), false);
});

test('unknown physical terminal retains directories; never-started attempt is recoverable', (t) =>
{
    const root = fixture(t);
    const prepared = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId: 'fixture', producerId: 'validate-matrix', attemptId: 'unknown' });
    assert.throws(() => finalizeRunOwnedDirectoriesAfterPhysical(prepared, { physicalStarted: true, physicalExecution: { postObservation: 'unverifiable' } }), /retained/u);
    assert.equal(fs.existsSync(prepared.fragment.ownedRoot), true);
    assert.equal(prepared.fragment.cleanup.removedOwnedRoot, false);
    finalizeRunOwnedDirectoriesAfterPhysical(prepared, { physicalStarted: false, physicalExecution: null });
    assert.equal(fs.existsSync(prepared.fragment.ownedRoot), false);
});

test('finite demand preserves original safety, recovery and uncertainty without bundle impersonation', () =>
{
    const catalog = readProductionDiskDemandCatalog(repositoryRoot);
    const preparation = { purpose: 'matrix-governance', producerId: 'validate-matrix', allocatedBytes: 8192,
        feedAllocatedBytes: 4096, bindingDigest: 'a'.repeat(64) };
    const matrix = bindMatrixNugetDiskDemand(catalog, preparation, 'validate-matrix');
    assert.equal(matrix.safetyBytes, catalog.safetyBytes);
    const declared = matrix.producers.find((producer) => producer.producerId === 'validate-matrix');
    assert.ok(declared.demands.every((demand) => demand.uncertaintyBytes > 0 && demand.rollbackOrRecoveryBytes > 0));
    assert.deepEqual(catalog.producers, matrix.producers.filter((producer) => producer.producerId !== 'validate-matrix'));
    assert.throws(() => bindMatrixNugetDiskDemand(catalog, preparation, 'build-static'), /exact admitted/u);
    const transfer = bindBehaviorDocNugetPreparationDiskDemand(catalog,
        { allocatedBytes: 4096, expandedAllocatedBytes: 8192, treeDigest: 'b'.repeat(64) }, 'matrix-governance');
    assert.equal(transfer.safetyBytes, catalog.safetyBytes);
    assert.ok(transfer.producers.some((producer) => producer.producerId === 'matrix-nuget-preparation'));
    assert.equal(createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
        createHash('sha256').update(JSON.stringify(readProductionDiskDemandCatalog(repositoryRoot))).digest('hex'));
});


test('actual SDK compiler, MSBuild, runtime and hostfxr bytes are bound across awaits', async (t) =>
{
    const root = fixture(t), sdk = fixture(t);
    fs.mkdirSync(path.join(root, 'ops/docker'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'ARG DOTNET_SDK_VERSION=10.0.302\nARG DOTNET_RUNTIME_VERSION=10.0.6\n');
    const files = ['dotnet', 'sdk/10.0.302/MSBuild.dll', 'sdk/10.0.302/Roslyn/bincore/csc.dll',
        'host/fxr/10.0.6/libhostfxr.so', 'shared/Microsoft.NETCore.App/10.0.6/libcoreclr.so',
        'shared/Microsoft.NETCore.App/10.0.6/System.Private.CoreLib.dll', 'shared/Microsoft.AspNetCore.App/10.0.6/fixture.dll',
        'packs/Microsoft.NETCore.App.Ref/10.0.6/ref/net10.0/System.Runtime.dll'];
    for (const relative of files)
    {
        const file = path.join(sdk, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, relative);
    }
    const configured = process.env.FSUSBLOG_CONTENT_FIELD_DOTNET;
    process.env.FSUSBLOG_CONTENT_FIELD_DOTNET = path.join(sdk, 'dotnet');
    try
    {
        for (const relative of files)
        {
            const before = observeNugetPreparationToolchain(root, 'matrix-governance');
            await Promise.resolve();
            fs.appendFileSync(path.join(sdk, relative), '-changed');
            const after = observeNugetPreparationToolchain(root, 'matrix-governance');
            assert.notDeepEqual(after, before, relative);
        }
        for (const relative of ['packs/Microsoft.NETCore.App.Ref/10.0.11/ref/net10.0/System.Runtime.dll',
            'host/fxr/10.0.11/libhostfxr.so', 'shared/Microsoft.NETCore.App/10.0.11/libcoreclr.so'])
        {
            const before = observeNugetPreparationToolchain(root, 'matrix-governance');
            await Promise.resolve();
            fs.mkdirSync(path.dirname(path.join(sdk, relative)), { recursive: true });
            fs.writeFileSync(path.join(sdk, relative), 'foreign installation');
            const after = observeNugetPreparationToolchain(root, 'matrix-governance');
            assert.notDeepEqual(after, before, relative);
            assert.ok(after.files.some((entry) => entry.path === relative));
        }
        const rosterBefore = observeNugetPreparationToolchain(root, 'matrix-governance');
        fs.mkdirSync(path.join(sdk, 'sdk/10.0.999'));
        assert.notDeepEqual(observeNugetPreparationToolchain(root, 'matrix-governance'), rosterBefore);
        process.env.FSUSBLOG_CONTENT_FIELD_DOTNET = 'dotnet';
        assert.throws(() => observeNugetPreparationToolchain(root, 'matrix-governance'), /absolute SDK/u);
    }
    finally
    {
        if (configured === undefined) delete process.env.FSUSBLOG_CONTENT_FIELD_DOTNET;
        else process.env.FSUSBLOG_CONTENT_FIELD_DOTNET = configured;
    }
});

test('shared source, build props, injection and locks change the declared closure after awaits', async (t) =>
{
    const root = fixture(t);
    const files = {
        'src/backend/FsusBlog.Server.csproj': '<Project><ProjectReference Include="../shared/Shared.csproj"/></Project>',
        'src/shared/Shared.csproj': '<Project/>',
        'src/shared/Model.cs': 'class Model {}',
        'Directory.Build.props': '<Project/>',
        'Directory.Packages.props': '<Project/>',
        'tools/testing/FsusBlog.ContentFieldContractExtractor/FsusBlog.ContentFieldContractExtractor.csproj': '<Project/>',
        'tools/testing/FsusBlog.ContentFieldContractExtractor/Inject.targets': '<Project/>',
        'tools/contracts/MatrixNugetRestore.slnx': fs.readFileSync(path.join(repositoryRoot, 'tools/contracts/MatrixNugetRestore.slnx'), 'utf8'),
        'tools/docs/prepare-behavior-doc-nuget.mjs': '// fixture',
        'tools/test/behavior-doc-nuget-preparation.mjs': '// fixture',
        'ops/docker/FsusBlog.Server.Dockerfile': '# fixture',
        'src/shared/packages.lock.json': JSON.stringify({ dependencies: { net10: { Example: { type: 'Direct', resolved: '1.0.0', contentHash: Buffer.alloc(64).toString('base64') } } } })
    };
    for (const [relative, bytes] of Object.entries(files))
    {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), bytes);
    }
    for (const relative of ['src/shared/Model.cs', 'Directory.Build.props', 'Directory.Packages.props',
        'tools/testing/FsusBlog.ContentFieldContractExtractor/Inject.targets', 'src/shared/packages.lock.json'])
    {
        const before = nugetPreparationClosure(root, 'matrix-governance');
        await Promise.resolve();
        fs.appendFileSync(path.join(root, relative), '\n');
        assert.notDeepEqual(nugetPreparationClosure(root, 'matrix-governance'), before, relative);
    }
});


test('actual consumer publisher refuses same-byte descriptor replacement during its authority await', async (t) =>
{
    const root = fixture(t), descriptor = path.join(root, 'descriptor.json');
    fs.writeFileSync(descriptor, '{}', { mode: 0o400 });
    const preparedNuget = { inputPaths: [descriptor], inputIdentities: [observeNugetInputFile(descriptor)] };
    const source = fs.readFileSync(path.join(repositoryRoot, 'tools/test/run-deterministic-command.mjs'), 'utf8');
    const start = source.indexOf('async function publishConsumerProjection(');
    const end = source.indexOf('\nfunction git(', start);
    assert.ok(start >= 0 && end > start);
    const publications = [];
    // Execute the actual method body against a recording filesystem. No native receipt is admitted.
    const recordingFs = { mkdirSync() {}, realpathSync: (file) => file,
        writeFileSync: (file) => publications.push({ file }), renameSync: (from, to) => publications.push({ from, to }) };
    const publisher = new Function('path', 'fs', 'repoRoot', 'sanitizeSegment', 'validateRunBoundProjection',
        'buildRunBoundConsumerEvidence', 'validateRunBoundConsumerEvidence', 'assertPreparedNugetCurrent',
        source.slice(start, end) + '\nreturn publishConsumerProjection;')(
        path, recordingFs, repositoryRoot, (value, fallback) => value || fallback,
        async () =>
        {
            await Promise.resolve();
            fs.renameSync(descriptor, path.join(root, 'prior.json'));
            fs.writeFileSync(descriptor, '{}', { mode: 0o400 });
            return {};
        }, () => ({}), () => {}, assertPreparedNugetCurrent);
    await assert.rejects(publisher({ result: { receiptFile: 'control-only', projectionFile: 'control-only' },
        directory: '.tmp/control-only', cwd: repositoryRoot, runId: 'control-only', key: 'control-only',
        consumerId: 'validate-matrix', executionEnvelopeBinding: {}, preparedNuget }), /drifted at execution boundary/u);
    assert.deepEqual(publications, []);
});
