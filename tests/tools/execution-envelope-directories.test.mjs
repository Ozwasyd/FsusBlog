import assert from 'node:assert/strict';
import { createHash } from "node:crypto";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {finalizeRunOwnedDirectories, prepareRunOwnedDirectories} = await import(new URL('../../tools/test/execution-envelope-directories.mjs', import.meta.url));
const { finalizeRunOwnedDirectoriesAfterPhysical } = await import(new URL('../../tools/test/execution-envelope-directories.mjs', import.meta.url));
const { inventoryNugetOfflineFeed, inventoryPreparedNuget, seedPreparedNuget, validatePreparedNugetPackages } = await import(new URL('../../tools/test/behavior-doc-nuget-preparation.mjs', import.meta.url));
const { bindBehaviorDocNugetPreparationDiskDemand, bindBehaviorDocNugetDiskDemand, defaultProductionDiskRoots, readProductionDiskDemandCatalog } = await import(new URL('../../tools/test-matrix/production-disk-demand.mjs', import.meta.url));
const { runProtectedBehaviorDocAdmission } = await import(new URL('../../tools/test-matrix/protected-behavior-doc-admission.mjs', import.meta.url));
const { behaviorDocNugetClosure, matrixNativeNugetClosure, nugetPreparationCommand, nugetPreparationEnvironment, observeMatrixNativeNugetToolInputs, readPreparedMatrixNativeNuget } = await import(new URL('../../tools/test/behavior-doc-nuget-preparation.mjs', import.meta.url));
const { createMinimalCorrectnessEnvironment } = await import(new URL('../../tools/test/execution-envelope-environment.mjs', import.meta.url));
const { loadExecutionEnvelopePolicy } = await import(new URL('../../tools/test-matrix/execution-envelope-policy.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('matrix native closure binds the actual extractor/backend and complete current project locks', (context) =>
{
    const closure = matrixNativeNugetClosure(repositoryRoot);
    assert.deepEqual(closure.projects, [
        'src/backend/FsusBlog.Server.csproj',
        'tools/testing/FsusBlog.ContentFieldContractExtractor/FsusBlog.ContentFieldContractExtractor.csproj'
    ]);
    assert.equal(closure.purpose, 'matrix-native');
    assert.notDeepEqual(closure, behaviorDocNugetClosure(repositoryRoot));
    assert.ok(closure.packages.length > 0);
    for (const project of closure.sourceClosureDigests.filter((entry) => entry.path.endsWith('.csproj')))
    {
        assert.ok(closure.sourceClosureDigests.some((entry) => entry.path === path.posix.join(path.posix.dirname(project.path), 'packages.lock.json')));
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-nuget-closure-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const entry of closure.sourceClosureDigests)
    {
        const destination = path.join(root, entry.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, entry.path), destination);
    }
    assert.deepEqual(matrixNativeNugetClosure(root), closure);
    const lock = path.join(root, 'src/backend/packages.lock.json');
    const bytes = fs.readFileSync(lock);
    fs.rmSync(lock);
    assert.throws(() => matrixNativeNugetClosure(root), /every referenced project lock/u);
    fs.writeFileSync(lock, bytes);
    const source = path.join(root, closure.projects[0]);
    fs.appendFileSync(source, '\n<!-- controlled source mutation -->\n');
    assert.notDeepEqual(matrixNativeNugetClosure(root), closure);
    const solution = path.join(root, 'FsusBlog.MatrixNativeRestore.slnx');
    fs.appendFileSync(solution, '<!-- controlled foreign solution -->\n');
    assert.throws(() => matrixNativeNugetClosure(root), /actual project owners/u);
});

test('offline preparation binds MSBuild reuse and background network settings', () =>
{
    const injected = nugetPreparationEnvironment({
        directories: { environment: { HOME: '/owned/home', TMPDIR: '/owned/tmp' } },
        packagesRoot: '/owned/packages', runId: 'run-1',
        source: { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
    });
    const result = createMinimalCorrectnessEnvironment({
        parentEnvironment: { PATH: '/usr/bin', MSBUILDDISABLENODEREUSE: '0', DOTNET_CLI_TELEMETRY_OPTOUT: '0',
            DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'false', UNRELATED: 'forbidden' },
        producerAllowlist: ['PATH'], injectedEnvironment: injected, policy: loadExecutionEnvelopePolicy()
    });
    assert.equal(result.childEnvironment.MSBUILDDISABLENODEREUSE, '1');
    assert.equal(result.childEnvironment.DOTNET_CLI_TELEMETRY_OPTOUT, '1');
    assert.equal(result.childEnvironment.DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE, 'true');
    assert.equal(result.childEnvironment.NUGET_PACKAGES, '/owned/packages');
    assert.equal(result.childEnvironment.UNRELATED, undefined);
    assert.ok(result.observation.variables.some((entry) => entry.name === 'MSBUILDDISABLENODEREUSE'));
    assert.ok(result.observation.variables.some((entry) => entry.name === 'DOTNET_CLI_TELEMETRY_OPTOUT'));
    assert.ok(result.observation.variables.some((entry) => entry.name === 'DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE'));
});

test('matrix preparation command uses the separate original restore solution and exact ordered offline arguments', () =>
{
    const inputs = { packagesRoot: '/owned/packages', artifactsRoot: '/owned/artifacts', feedRoot: '/sealed/feed', configFile: '/owned/NuGet.Config' };
    assert.deepEqual(nugetPreparationCommand({ ...inputs, purpose: 'matrix-native' }), [
        'dotnet', 'restore', 'FsusBlog.MatrixNativeRestore.slnx', '--locked-mode', '--packages', '/owned/packages',
        '--artifacts-path', '/owned/artifacts', '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel',
        '--source', '/sealed/feed', '--configfile', '/owned/NuGet.Config'
    ]);
    assert.equal(nugetPreparationCommand(inputs)[2], 'tools/contracts/BehaviorDocRestore.slnx');
    assert.throws(() => nugetPreparationCommand({ ...inputs, purpose: 'foreign' }), /Unknown/u);
});

test('matrix ingress refuses missing and current-source BehaviorDoc descriptors before receipt/native launch', async (context) =>
{
    await assert.rejects(readPreparedMatrixNativeNuget({ repositoryRoot, runId: 'matrix-run' }), /explicit offline/u);
    const parent = path.join(repositoryRoot, '.tmp/behavior-doc-nuget-preparation');
    fs.mkdirSync(parent, { recursive: true });
    const attempt = fs.mkdtempSync(path.join(parent, 'transfer-controls-'));
    context.after(() => fs.rmSync(attempt, { recursive: true, force: true }));
    const file = path.join(attempt, 'descriptor.json');
    const { sealSourceIdentity } = await import(new URL('../../tools/fact-extractors/identity.mjs', import.meta.url));
    fs.writeFileSync(file, JSON.stringify({ source: sealSourceIdentity(repositoryRoot), closure: behaviorDocNugetClosure(repositoryRoot),
        root: path.join(attempt, 'packages'), artifactsRoot: path.join(attempt, 'artifacts'),
        feedRoot: path.join(attempt, 'feed'), configFile: path.join(attempt, 'NuGet.Config') }));
    await assert.rejects(readPreparedMatrixNativeNuget({ repositoryRoot, runId: 'matrix-run', file }), /source or locked graph/u);
});

test('matrix tool binding detects compiler mutation, foreign SDK and aliased SDK files without executing tools', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-sdk-controls-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sdk = '10.0.302';
    const runtime = '10.0.10';
    const files = ['dotnet', `sdk/${sdk}/Roslyn/bincore/csc.dll`, `sdk/${sdk}/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll`,
        `shared/Microsoft.NETCore.App/${runtime}/System.Private.CoreLib.dll`,
        `shared/Microsoft.AspNetCore.App/${runtime}/Microsoft.AspNetCore.dll`];
    for (const file of files)
    {
        const destination = path.join(root, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'controlled inert tool bytes', { mode: 0o700 });
    }
    const previous = Object.fromEntries(['PATH', 'DOTNET_ROOT', 'FSUSBLOG_CONTENT_FIELD_DOTNET'].map((name) => [name, process.env[name]]));
    context.after(() =>
    {
        for (const [name, value] of Object.entries(previous))
        {
            if (value === undefined)
            {
                delete process.env[name];
            }
            else
            {
                process.env[name] = value;
            }
        }
    });
    process.env.PATH = root;
    process.env.DOTNET_ROOT = root;
    process.env.FSUSBLOG_CONTENT_FIELD_DOTNET = path.join(root, 'dotnet');
    const before = observeMatrixNativeNugetToolInputs(repositoryRoot);
    const compiler = path.join(root, files[1]);
    fs.appendFileSync(compiler, 'mutation');
    assert.notEqual(observeMatrixNativeNugetToolInputs(repositoryRoot).treeDigest, before.treeDigest);
    fs.mkdirSync(path.join(root, 'sdk/foreign'));
    assert.throws(() => observeMatrixNativeNugetToolInputs(repositoryRoot), /single pinned/u);
    fs.rmSync(path.join(root, 'sdk/foreign'), { recursive: true });
    fs.symlinkSync(compiler, path.join(root, 'alias'));
    assert.throws(() => observeMatrixNativeNugetToolInputs(repositoryRoot), /physical alias/u);
});
test('HOME, TMP, npm, NuGet, and tool caches are unique run-attempt owned roots', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directories-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const prepared = prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run-1',
        producerId: 'producer-1',
        attemptId: 'attempt-1',
        outputs: ['outputs/result']
    });
    const values = Object.values(prepared.environment);
    assert.equal(prepared.environment.HOME, prepared.environment.USERPROFILE);
    assert.equal(prepared.environment.TMP, prepared.environment.TEMP);
    assert.equal(prepared.environment.TMP, prepared.environment.TMPDIR);
    assert.equal(new Set(values).size, 6);
    assert.ok(values.every((directory) => directory.startsWith(prepared.fragment.ownedRoot)));
    assert.ok(values.every((directory) => (fs.statSync(directory).mode & 0o777) === 0o700));
    fs.writeFileSync(path.join(prepared.environment.HOME, 'fixture'), 'value');
    fs.writeFileSync(path.join(root, 'outputs/result/output.json'), 'output');
    const fragment = finalizeRunOwnedDirectories(prepared);
    assert.equal(fragment.cleanup.status, 'complete');
    assert.equal(fragment.cleanup.removedOwnedRoot, true);
    assert.equal(fragment.postInventory.some((entry) => entry.path === 'home/fixture'), true);
    assert.deepEqual(
        fragment.externalWriteObservation.preAllowedRootInventory[0].entries,
        []
    );
    assert.equal(
        fragment.externalWriteObservation.postAllowedRootInventory[0].entries
            .some((entry) => entry.path === 'output.json'),
        true
    );
});

test('symlink escape and output paths outside the worktree fail closed', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-escape-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-outside-'));
    context.after(() =>
    {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, '.tmp/test-execution-envelope'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.tmp/test-execution-envelope/run-owned'));
    assert.throws(() => prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run',
        producerId: 'producer',
        attemptId: 'attempt'
    }), /resolves outside its repository/u);
    fs.rmSync(path.join(root, '.tmp/test-execution-envelope/run-owned'));
    assert.throws(() => prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run',
        producerId: 'producer',
        attemptId: 'attempt',
        outputs: ['../outside']
    }), /escapes the worktree/u);
});

test('cleanup never removes sibling retained evidence or user files', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-cleanup-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const retained = path.join(root, '.tmp/test-execution-envelope/retained.json');
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    fs.writeFileSync(retained, 'retained');
    const prepared = prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run',
        producerId: 'producer',
        attemptId: 'attempt'
    });
    finalizeRunOwnedDirectories(prepared);
    assert.equal(fs.readFileSync(retained, 'utf8'), 'retained');
});


function fixture(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-nuget-ingress-'));
    context.after(() =>
    {
        const makeRemovable = (directory) =>
        {
            fs.chmodSync(directory, 0o700);
            for (const name of fs.readdirSync(directory))
            {
                const file = path.join(directory, name);
                if (fs.lstatSync(file).isDirectory())
                {
                    makeRemovable(file);
                }
            }
        };
        makeRemovable(root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const seed = path.join(root, 'seed');
    fs.mkdirSync(path.join(seed, 'example/1.0.0'), { recursive: true });
    const archive = Buffer.from('finite package fixture, not an SDK or NuGet restore receipt');
    const contentHash = createHash('sha512').update(archive).digest('base64');
    for (const [name, bytes] of Object.entries({
        'example.1.0.0.nupkg': archive,
        'example.1.0.0.nupkg.sha512': contentHash,
        '.nupkg.metadata': JSON.stringify({ version: 2, contentHash }),
        'lib.dll': 'source-bound fixture'
    }))
    {
        fs.writeFileSync(path.join(seed, 'example/1.0.0', name), bytes, { mode: 0o444 });
    }
    for (const directory of [path.join(seed, 'example/1.0.0'), path.join(seed, 'example'), seed])
    {
        fs.chmodSync(directory, 0o555);
    }
    return { root, seed, closure: { packages: [{ path: 'example/1.0.0', contentHash }] } };
}

test('finite locked seed copies exact bytes and enters preInventory before execution', (context) =>
{
    const { root, seed, closure } = fixture(context);
    const input = inventoryPreparedNuget(seed);
    validatePreparedNugetPackages(input, closure);
    const prepared = prepareRunOwnedDirectories({
        repositoryRoot: root, cwd: root, runId: 'run', producerId: 'behavior-doc-static-admission',
        attemptId: 'attempt', preparedNuget: input
    });
    assert.notEqual(prepared.environment.NUGET_PACKAGES, seed);
    assert.equal(fs.statSync(prepared.environment.NUGET_PACKAGES).mode & 0o777, 0o700);
    assert.ok(prepared.fragment.preInventory.some((entry) => entry.path === 'nuget-packages/example/1.0.0/lib.dll'));
    assert.equal(fs.readFileSync(path.join(prepared.environment.NUGET_PACKAGES, 'example/1.0.0/lib.dll'), 'utf8'),
        'source-bound fixture');
    assert.equal(inventoryPreparedNuget(seed).treeDigest, input.treeDigest);
    assert.equal(finalizeRunOwnedDirectories(prepared).cleanup.removedOwnedRoot, true);
    assert.equal(fs.existsSync(seed), true);
});

test('missing and empty dependency payloads fail closed', (context) =>
{
    const { root, seed, closure } = fixture(context);
    assert.throws(() => inventoryPreparedNuget(path.join(root, 'missing')), /ENOENT/u);
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty, { mode: 0o555 });
    assert.throws(() => inventoryPreparedNuget(empty), /empty cache/u);
    assert.throws(() => validatePreparedNugetPackages(inventoryPreparedNuget(seed),
        { packages: [...closure.packages, { path: 'missing/1.0.0', contentHash: closure.packages[0].contentHash }] }),
    /roster/u);
});

test('signed package content hash and raw archive hash remain distinct completed-restore bindings', (context) =>
{
    const { seed, closure } = fixture(context);
    const archive = path.join(seed, 'example/1.0.0/example.1.0.0.nupkg');
    const metadata = path.join(seed, 'example/1.0.0/.nupkg.metadata');
    // Shape-only fixture: no signature validation or NuGet restore qualification is claimed.
    const signedContentHash = createHash('sha512').update('unsigned package content').digest('base64');
    const locked = { packages: [{ ...closure.packages[0], contentHash: signedContentHash }] };
    fs.chmodSync(metadata, 0o644);
    fs.writeFileSync(metadata, JSON.stringify({ version: 2, contentHash: signedContentHash }));
    fs.chmodSync(metadata, 0o444);
    const feed = { entries: [{ path: 'example.1.0.0.nupkg',
        sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex') }] };
    assert.doesNotThrow(() => validatePreparedNugetPackages(inventoryPreparedNuget(seed), locked, feed));
    assert.throws(() => validatePreparedNugetPackages(inventoryPreparedNuget(seed), closure, feed), /package content/u);
    assert.throws(() => validatePreparedNugetPackages(inventoryPreparedNuget(seed), locked,
        { entries: [{ ...feed.entries[0], sha256: '0'.repeat(64) }] }), /raw archive/u);
});

test('wrong package bytes and extra top-level payload are refused', (context) =>
{
    const { seed, closure } = fixture(context);
    const archive = path.join(seed, 'example/1.0.0/example.1.0.0.nupkg');
    fs.chmodSync(archive, 0o644);
    fs.writeFileSync(archive, 'wrong package');
    fs.chmodSync(archive, 0o444);
    assert.throws(() => validatePreparedNugetPackages(inventoryPreparedNuget(seed), closure), /package content/u);
    fs.chmodSync(seed, 0o755);
    fs.writeFileSync(path.join(seed, 'extra'), 'not in locked graph', { mode: 0o444 });
    fs.chmodSync(seed, 0o555);
    assert.throws(() => validatePreparedNugetPackages(inventoryPreparedNuget(seed), closure), /roster/u);
});

test('writable, symbolic-linked and hard-linked dependency inputs are refused', (context) =>
{
    const { root, seed } = fixture(context);
    const file = path.join(seed, 'example/1.0.0/lib.dll');
    fs.chmodSync(file, 0o644);
    assert.throws(() => inventoryPreparedNuget(seed), /sealed read-only/u);
    fs.chmodSync(file, 0o444);
    fs.linkSync(file, path.join(root, 'hard-link'));
    assert.throws(() => inventoryPreparedNuget(seed), /non-linked/u);
    fs.unlinkSync(path.join(root, 'hard-link'));
    fs.symlinkSync(seed, path.join(root, 'alias'));
    assert.throws(() => inventoryPreparedNuget(path.join(root, 'alias')), /canonical/u);
});

test('seed drift and an occupied destination fail before copy', (context) =>
{
    const { root, seed } = fixture(context);
    const input = inventoryPreparedNuget(seed);
    const destination = path.join(root, 'cache');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'old'), 'old attempt');
    assert.throws(() => seedPreparedNuget(input, destination), /fresh canonical/u);
    fs.unlinkSync(path.join(destination, 'old'));
    const file = path.join(seed, 'example/1.0.0/lib.dll');
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, 'changed');
    fs.chmodSync(file, 0o444);
    assert.throws(() => seedPreparedNuget(input, destination), /drifted/u);
    assert.deepEqual(fs.readdirSync(destination), []);
});

test('preseed failure cleans only the new attempt and preserves first failure', (context) =>
{
    const { root, seed } = fixture(context);
    const input = inventoryPreparedNuget(seed);
    const authority = path.join(root, '.tmp/test-execution-envelope/run-owned');
    fs.mkdirSync(authority, { recursive: true });
    fs.writeFileSync(path.join(authority, 'retained'), 'evidence');
    assert.throws(() => prepareRunOwnedDirectories({
        repositoryRoot: root, cwd: root, runId: 'run', producerId: 'behavior-doc-static-admission',
        attemptId: 'attempt', preparedNuget: { ...input, treeDigest: '0'.repeat(64) }
    }), /drifted/u);
    const attempts = path.join(authority, 'run/behavior-doc-static-admission');
    assert.deepEqual(fs.readdirSync(attempts), []);
    assert.equal(fs.readFileSync(path.join(authority, 'retained'), 'utf8'), 'evidence');
    assert.equal(fs.existsSync(seed), true);
});

for (const reason of [Object.freeze(new Error('interrupted copy')), 0, false, null])
{
    test('interrupted preseed retains an immutable or primitive first reason during cleanup refusal', (context) =>
    {
        const { root, seed } = fixture(context);
        const input = inventoryPreparedNuget(seed);
        const destination = path.join(root, 'interrupted-copy');
        fs.mkdirSync(destination);
        context.mock.method(fs, 'writeFileSync', (file) =>
        {
            if (String(file).startsWith(destination + path.sep))
            {
                throw reason;
            }
            throw new Error('unexpected write outside task destination');
        });
        const chmod = fs.chmodSync;
        context.mock.method(fs, 'chmodSync', (file, mode) =>
        {
            if (String(file).startsWith(destination + path.sep))
            {
                throw new Error('cleanup refusal');
            }
            return chmod(file, mode);
        });
        let failed = false;
        try
        {
            seedPreparedNuget(input, destination);
        }
        catch (error)
        {
            failed = true;
            assert.equal(error, reason);
        }
        assert.equal(failed, true);
        assert.equal(fs.existsSync(seed), true);
        context.mock.restoreAll();
    });
}

test('offline ingress cannot be assigned to another producer', (context) =>
{
    const { root, seed } = fixture(context);
    assert.throws(() => prepareRunOwnedDirectories({
        repositoryRoot: root, cwd: root, runId: 'run', producerId: 'other',
        attemptId: 'attempt', preparedNuget: inventoryPreparedNuget(seed)
    }), /limited to the declared/u);
});

test('Fresh demand adds actual allocated peak/recovery on run-owned filesystem without reducing safety', () =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    const original = readProductionDiskDemandCatalog(root);
    const preparation = { allocatedBytes: 12288, treeDigest: 'a'.repeat(64), bindingDigest: 'b'.repeat(64) };
    const bound = bindBehaviorDocNugetDiskDemand(original, preparation);
    const old = original.producers.find((value) => value.producerId === 'behavior-doc-static-admission').demands;
    const actual = bound.producers.find((value) => value.producerId === 'behavior-doc-static-admission').demands;
    const before = old.find((value) => value.rootId === 'os-temp');
    const after = actual.find((value) => value.rootId === 'behavior-doc-run-owned');
    assert.equal(bound.safetyBytes, original.safetyBytes);
    assert.equal(after.uncertaintyBytes, before.uncertaintyBytes);
    assert.equal(after.peakAdditionalBytes, before.peakAdditionalBytes + preparation.allocatedBytes);
    assert.equal(after.rollbackOrRecoveryBytes, before.rollbackOrRecoveryBytes + preparation.allocatedBytes);
    assert.deepEqual(actual.filter((value) => value !== after), old.filter((value) => value !== before));
    assert.equal(defaultProductionDiskRoots(root, { includeDockerStorage: false }).behaviorDocRunOwnedRoot,
        path.join(root, '.tmp/test-execution-envelope/run-owned'));
    assert.throws(() => bindBehaviorDocNugetDiskDemand(original, { ...preparation, allocatedBytes: Infinity }), /bounded/u);
});

test('protected admission refuses output escape before SDK or physical launch', async () =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    let launches = 0;
    await assert.rejects(runProtectedBehaviorDocAdmission({
        repositoryRoot: root, runId: 'run', outputFile: path.join(root, '.tmp/escape/receipt.json'),
        spawn: () =>
        {
            launches++;
            throw new Error('must not launch');
        }
    }), /precise original output owner/u);
    assert.equal(launches, 0);
});

test('missing offline preparation refuses admission before launch or reading old receipt', async (context) =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    const admissionRoot = path.join(root, '.tmp/behavior-doc-static-admission');
    fs.mkdirSync(admissionRoot, { recursive: true });
    const ownedOutput = fs.mkdtempSync(path.join(admissionRoot, 'unit-old-receipt-'));
    context.after(() => fs.rmSync(ownedOutput, { recursive: true, force: true }));
    const receipt = path.join(ownedOutput, 'receipt.json');
    fs.writeFileSync(receipt, 'old invalid receipt must not be parsed', { flag: 'wx' });
    let launches = 0;
    await assert.rejects(runProtectedBehaviorDocAdmission({
        repositoryRoot: root, runId: 'run', outputFile: receipt,
        preparationFile: '', spawn: () =>
        {
            launches++;
            throw new Error('must not launch');
        }
    }), /explicit offline/u);
    assert.equal(launches, 0);
    assert.equal(fs.readFileSync(receipt, 'utf8'), 'old invalid receipt must not be parsed');
});

function offlineFeedFixture(context)
{
    const { root } = fixture(context);
    const feed = path.join(root, 'flat-feed');
    fs.mkdirSync(feed);
    // Minimal ZIP resource fixture, not an SDK/NuGet extraction receipt.
    const name = Buffer.from('lib.dll');
    const payload = Buffer.from('locked source bytes');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50);
    footer.writeUInt16LE(1, 8);
    footer.writeUInt16LE(1, 10);
    footer.writeUInt32LE(central.length + name.length, 12);
    footer.writeUInt32LE(local.length + name.length + payload.length, 16);
    const archive = Buffer.concat([local, name, payload, central, name, footer]);
    const file = path.join(feed, 'example.1.0.0.nupkg');
    fs.writeFileSync(file, archive, { mode: 0o444 });
    fs.chmodSync(feed, 0o555);
    return { root, feed, archive, file,
        closure: { packages: [{ path: 'example/1.0.0', contentHash: createHash('sha512').update(archive).digest('base64') }] } };
}

test('offline feed inventories only exact locked archives and bounded expanded allocation', (context) =>
{
    const { feed, closure } = offlineFeedFixture(context);
    const bound = inventoryNugetOfflineFeed(feed, closure);
    assert.equal(bound.entries.length, 1);
    assert.ok(Number.isSafeInteger(bound.expandedAllocatedBytes));
    assert.ok(bound.expandedAllocatedBytes > bound.allocatedBytes);
    assert.throws(() => inventoryNugetOfflineFeed(feed, { packages: [] }), /roster/u);
    assert.throws(() => inventoryNugetOfflineFeed(feed, { packages: [{ ...closure.packages[0], contentHash: 'foreign' }] }), /lock/u);
    const signedContentHash = createHash('sha512').update('unsigned package content').digest('base64');
    const signedInput = inventoryNugetOfflineFeed(feed,
        { packages: [{ ...closure.packages[0], contentHash: signedContentHash }] });
    assert.notEqual(signedInput.archives[0].archiveSha512, signedInput.archives[0].contentHash);
    assert.equal(signedInput.archives[0].archiveSha512,
        createHash('sha512').update(fs.readFileSync(path.join(feed, 'example.1.0.0.nupkg'))).digest('base64'));
});

test('offline feed refuses expanded cache payload, extras and altered or unsupported archives', (context) =>
{
    const { feed, closure, archive, file } = offlineFeedFixture(context);
    fs.chmodSync(feed, 0o755);
    fs.writeFileSync(path.join(feed, 'lib.dll'), 'malicious cached assembly', { mode: 0o444 });
    fs.chmodSync(feed, 0o555);
    assert.throws(() => inventoryNugetOfflineFeed(feed, closure), /roster/u);
    fs.chmodSync(feed, 0o755);
    fs.unlinkSync(path.join(feed, 'lib.dll'));
    fs.chmodSync(feed, 0o555);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, Buffer.from('corrupt'));
    fs.chmodSync(file, 0o444);
    assert.throws(() => inventoryNugetOfflineFeed(feed, closure), /ZIP/u);
    const unsupported = Buffer.from(archive);
    unsupported.writeUInt16LE(0xffff, unsupported.length - 12);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, unsupported);
    fs.chmodSync(file, 0o444);
    const matchingHash = { packages: [{ ...closure.packages[0], contentHash: createHash('sha512').update(unsupported).digest('base64') }] };
    assert.throws(() => inventoryNugetOfflineFeed(feed, matchingHash), /single-volume|ZIP64/u);
});

test('offline preparation capacity retains original uncertainty and reserves archive plus expanded staging', (context) =>
{
    const { feed, closure } = offlineFeedFixture(context);
    const bound = inventoryNugetOfflineFeed(feed, closure);
    const original = readProductionDiskDemandCatalog(path.resolve(import.meta.dirname, '../..'));
    const next = bindBehaviorDocNugetPreparationDiskDemand(original, bound);
    assert.equal(next.safetyBytes, original.safetyBytes);
    assert.deepEqual(next.producers.slice(0, original.producers.length), original.producers);
    const added = next.producers.at(-1);
    assert.equal(added.producerId, 'behavior-doc-nuget-preparation');
    assert.equal(new Set(added.demands.map((demand) => demand.rootId)).size, added.demands.length);
    const artifact = added.demands.find((demand) => demand.rootId === 'behavior-doc-nuget-preparation');
    const originalArtifacts = original.producers.find((value) => value.producerId === 'behavior-doc-static-admission')
        .demands.filter((demand) => demand.rootId !== 'os-temp');
    assert.equal(artifact.peakAdditionalBytes, bound.allocatedBytes + bound.expandedAllocatedBytes
        + originalArtifacts.reduce((sum, demand) => sum + demand.peakAdditionalBytes, 0));
    assert.equal(artifact.uncertaintyBytes, originalArtifacts.reduce((sum, demand) => sum + demand.uncertaintyBytes, 0));
});

test('unverifiable physical terminal preserves the owned directory and explicit recovery obligation', (context) =>
{
    // State-only unit fixture: no child process or physical acceptance is simulated.
    for (const evidence of [null, { postObservation: 'unverifiable' }, { postObservation: 'nonempty' }])
    {
        const { root } = fixture(context);
        const owned = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
            runId: 'run', producerId: 'behavior-doc-static-admission', attemptId: 'retained' });
        const sentinel = path.join(owned.environment.TMPDIR, 'active-resource-canary');
        fs.writeFileSync(sentinel, 'must remain');
        assert.throws(() => finalizeRunOwnedDirectoriesAfterPhysical(owned, {
            physicalStarted: true, physicalExecution: evidence
        }), (error) =>
        {
            assert.equal(error.physicalExecution, evidence);
            assert.equal(error.recoveryObligation.ownedRoot, owned.fragment.ownedRoot);
            return /retained/u.test(error.message);
        });
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain');
        assert.equal(owned.fragment.cleanup.removedOwnedRoot, false);
    }
});

test('verified zero-member terminal and before-spawn failure remove only their current owned directory', (context) =>
{
    for (const state of [{ physicalStarted: false, physicalExecution: null },
        { physicalStarted: true, physicalExecution: { postObservation: 'zero-members' } }])
    {
        const { root } = fixture(context);
        const owned = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
            runId: 'run', producerId: 'behavior-doc-static-admission', attemptId: 'terminal' });
        const retained = path.join(root, 'outside-current-attempt');
        fs.writeFileSync(retained, 'retained');
        const terminal = finalizeRunOwnedDirectoriesAfterPhysical(owned, state);
        assert.equal(terminal.cleanup.removedOwnedRoot, true);
        assert.equal(fs.existsSync(owned.fragment.ownedRoot), false);
        assert.equal(fs.readFileSync(retained, 'utf8'), 'retained');
    }
});
