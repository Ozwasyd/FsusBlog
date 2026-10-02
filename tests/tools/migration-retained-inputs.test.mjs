import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureMigrationRetainedInputs, readProductionRetainedMigrationTool, validateMigrationRetainedInputs } from '../../tools/ci/migration-retained-inputs.mjs';
import { collectProductionInputTree, createProductionBuildReceipt, verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';

function fixture(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-retained-inputs-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'source');
    const sdkRoot = path.join(directory, 'sdk');
    fs.mkdirSync(root);
    fs.mkdirSync(sdkRoot);
    const files = {
        'Directory.Build.props': '<Project />\n',
        'Directory.Packages.props': '<Project />\n',
        'src/migration/FsusBlog.Migration.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../shared/FsusBlog.Shared.csproj" /></ItemGroup></Project>\n',
        'src/migration/Program.cs': 'internal class Program {}\n',
        'src/shared/FsusBlog.Shared.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
        'src/shared/Contract.cs': 'public record Contract(int Value);\n',
        'tools/build-with-data-env.sh': '#!/bin/bash\nexec "$@"\n',
        'tools/test/lanes/production-build-artifacts.sh': '#!/bin/bash\n',
        'tools/ci/migration-retained-inputs.mjs': 'export const owner = true;\n',
        'tools/ci/production-build-artifacts.mjs': 'export const owner = true;\n'
    };
    for (const [file, bytes] of Object.entries(files))
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), bytes);
    }
    // These are byte fixtures, not executable SDKs or evidence of a dotnet build.
    fs.writeFileSync(path.join(sdkRoot, 'dotnet'), 'host fixture', { mode: 0o755 });
    fs.mkdirSync(path.join(sdkRoot, 'sdk'));
    fs.writeFileSync(path.join(sdkRoot, 'sdk/compiler.dll'), 'compiler fixture');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']])
    {
        const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    const originalPath = process.env.PATH;
    process.env.PATH = sdkRoot;
    t.after(() => { process.env.PATH = originalPath; });
    return { root, sdkRoot };
}

test('original input measurement includes transitive Shared source and every SDK byte', t =>
{
    const value = fixture(t);
    const first = captureMigrationRetainedInputs(value);
    const second = captureMigrationRetainedInputs(value);
    assert.deepEqual(first, second);
    assert.ok(first.sourceDigests.some(entry => entry.path === 'src/shared/Contract.cs'));
    assert.deepEqual(first.sdkFiles.map(entry => entry.path), ['dotnet', 'sdk/compiler.dll']);
    const identity = validateMigrationRetainedInputs(first, second);
    assert.match(identity.SourceRevision, /^[a-f0-9]{40}$/u);
    for (const key of ['WorktreeDigest', 'ToolchainDigest', 'ConfigurationDigest'])
    {
        assert.match(identity[key], /^[a-f0-9]{64}$/u);
    }
});

for (const [name, file] of [['Migration source', 'src/migration/Program.cs'], ['Shared source', 'src/shared/Contract.cs'],
    ['original configuration', 'Directory.Build.props'], ['original producer', 'tools/ci/production-build-artifacts.mjs']])
{
    test(`${name} drift refuses retained inputs`, t =>
    {
        const value = fixture(t);
        const before = captureMigrationRetainedInputs(value);
        fs.appendFileSync(path.join(value.root, file), '\nchanged\n');
        assert.throws(() => validateMigrationRetainedInputs(before, captureMigrationRetainedInputs(value)), /changed/u);
    });
}

test('unchanged SDK version labels cannot hide actual compiler byte drift', t =>
{
    const value = fixture(t);
    const before = captureMigrationRetainedInputs(value);
    fs.writeFileSync(path.join(value.sdkRoot, 'sdk/compiler.dll'), 'different compiler');
    assert.throws(() => validateMigrationRetainedInputs(before, captureMigrationRetainedInputs(value)), /changed/u);
});

test('missing SDK file, extra SDK file and symbolic replacement are not the retained tree', t =>
{
    const value = fixture(t);
    const before = captureMigrationRetainedInputs(value);
    fs.unlinkSync(path.join(value.sdkRoot, 'sdk/compiler.dll'));
    assert.throws(() => validateMigrationRetainedInputs(before, captureMigrationRetainedInputs(value)), /changed/u);
    fs.writeFileSync(path.join(value.sdkRoot, 'sdk/compiler.dll'), 'compiler fixture');
    fs.writeFileSync(path.join(value.sdkRoot, 'unregistered.dll'), 'extra');
    assert.throws(() => validateMigrationRetainedInputs(before, captureMigrationRetainedInputs(value)), /changed/u);
    fs.unlinkSync(path.join(value.sdkRoot, 'unregistered.dll'));
    fs.symlinkSync('../dotnet', path.join(value.sdkRoot, 'sdk/alias'));
    assert.throws(() => captureMigrationRetainedInputs(value), /symlink/u);
});

test('supplied SDK directory cannot substitute the PATH-selected build host', t =>
{
    const value = fixture(t);
    process.env.PATH = '/usr/bin:/bin';
    assert.throws(() => captureMigrationRetainedInputs(value), /actual PATH-selected/u);
});

test('caller identity, unknown snapshot fields and schema substitution are refused', t =>
{
    const value = fixture(t);
    const actual = captureMigrationRetainedInputs(value);
    for (const modified of [{ ...actual, approved: true }, { ...actual, schema: 'caller-approved' },
        { ...actual, sourceIdentity: { ...actual.sourceIdentity, sourceCommit: 'a'.repeat(40) } }])
    {
        assert.throws(() => validateMigrationRetainedInputs(modified, actual), /changed/u);
    }
});

test('empty and symlink SDK roots are refused by the original inventory owner', t =>
{
    const value = fixture(t);
    const empty = path.join(value.root, 'empty');
    fs.mkdirSync(empty);
    assert.throws(() => collectProductionInputTree(empty), /empty/u);
    const alias = path.join(value.root, 'sdk-alias');
    fs.symlinkSync(value.sdkRoot, alias);
    assert.throws(() => collectProductionInputTree(alias), /canonical/u);
});

function retainedByteFixture(t, { backendPath = null, backendFiles = [
    'FsusBlog.Server.dll', 'FsusBlog.Shared.dll', 'FsusBlog.Server.runtimeconfig.json', 'FsusBlog.Server.deps.json'] } = {})
{
    const value = fixture(t);
    const artifactRoot = path.join(path.dirname(value.root), 'production-artifacts');
    fs.mkdirSync(path.join(artifactRoot, 'payload/migration-runtime'), { recursive: true });
    const inputOwner = new URL('../../tools/ci/migration-retained-inputs.mjs', import.meta.url);
    const invoke = operation =>
    {
        const result = spawnSync(process.execPath, [inputOwner.pathname, operation, value.root, artifactRoot, value.sdkRoot],
            { encoding: 'utf8', env: process.env });
        assert.equal(result.status, 0, result.stderr);
    };
    invoke('begin');
    const beforeBytes = fs.readFileSync(path.join(artifactRoot, 'migration-inputs-before.json'));
    // Deliberately not a PE, build or runtime fixture. This tests byte retention only.
    fs.writeFileSync(path.join(artifactRoot, 'payload/migration-runtime/FsusBlog.Migration.dll'), 'assembly byte fixture');
    invoke('finish');
    assert.deepEqual(fs.readFileSync(path.join(artifactRoot, 'payload/migration-runtime/migration-inputs-before.json')), beforeBytes);
    assert.equal(fs.existsSync(path.join(artifactRoot, 'migration-inputs-before.json')), false);
    const domains = [{ name: 'migration-runtime', path: 'payload/migration-runtime' }];
    if (backendPath)
    {
        fs.mkdirSync(path.join(artifactRoot, backendPath), { recursive: true });
        for (const name of backendFiles)
            fs.writeFileSync(path.join(artifactRoot, backendPath, name), `original byte fixture: ${name}`);
        domains.push({ name: 'backend-runtime', path: backendPath });
    }
    const actual = captureMigrationRetainedInputs(value);
    const receipt = createProductionBuildReceipt({
        root: value.root, artifactRoot,
        sourceState: { commit: actual.sourceIdentity.sourceCommit, worktreeFingerprint: actual.sourceIdentity.worktreeFingerprint },
        producer: { workflow: 'Byte fixture only', runId: 'fixture', runAttempt: 1, job: 'fixture-not-build' },
        toolchain: { node: 'fixture', npm: 'fixture', dotnet: 'fixture', vite: 'fixture', vitest: 'fixture', playwright: 'fixture', emsdk: 'fixture' },
        inputPaths: ['Directory.Build.props'], domains,
        build: { command: 'tools/test/lanes/production-build-artifacts.sh' }
    });
    return { ...value, artifactRoot, receipt };
}

test('Migration-only byte receipt does not manufacture an original current-target producer domain', t =>
{
    const value = retainedByteFixture(t);
    assert.equal(readProductionRetainedMigrationTool(value).CurrentTargetProducer, null);
});

test('original current-target producer inputs are measured from the same sealed production receipt', t =>
{
    const value = retainedByteFixture(t, { backendPath: 'payload/backend-runtime' });
    const original = readProductionRetainedMigrationTool(value);
    const bound = original.CurrentTargetProducer;
    for (const [pathKey, digestKey, name] of [['AssemblyPath', 'AssemblySha256', 'FsusBlog.Server.dll'],
        ['SharedAssemblyPath', 'SharedAssemblySha256', 'FsusBlog.Shared.dll'],
        ['RuntimeConfigurationPath', 'RuntimeConfigurationSha256', 'FsusBlog.Server.runtimeconfig.json'],
        ['DependenciesPath', 'DependenciesSha256', 'FsusBlog.Server.deps.json']])
    {
        assert.equal(bound[pathKey], path.join(value.artifactRoot, 'payload/backend-runtime', name));
        assert.equal(bound[digestKey], value.receipt.artifacts.find(item => item.path === `payload/backend-runtime/${name}`).sha256.slice(7));
    }
    const executed = invokeCompiledFixture(value);
    assert.equal(executed.status, 0, executed.stderr);
    assert.deepEqual(JSON.parse(executed.stdout), original);
});

test('incomplete or redirected original current-target producer domains are refused', t =>
{
    const missing = retainedByteFixture(t, { backendPath: 'payload/backend-runtime', backendFiles: ['FsusBlog.Server.dll'] });
    assert.throws(() => readProductionRetainedMigrationTool(missing), /producer input missing/u);
    const redirected = retainedByteFixture(t, { backendPath: 'payload/caller-backend' });
    assert.throws(() => readProductionRetainedMigrationTool(redirected), /original read-only backend runtime domain/u);
});

test('modified original current-target input bytes are refused by original receipt verification', t =>
{
    const value = retainedByteFixture(t, { backendPath: 'payload/backend-runtime' });
    const file = path.join(value.artifactRoot, 'payload/backend-runtime/FsusBlog.Server.deps.json');
    fs.chmodSync(file, 0o644);
    fs.appendFileSync(file, 'replacement');
    assert.throws(() => readProductionRetainedMigrationTool(value));
    const executed = invokeCompiledFixture(value);
    assert.notEqual(executed.status, 0);
    assert.equal(executed.stdout, '');
});

// Execute the exact fixed loader source owned by the C# producer. This is a
// lightweight Node control, not compilation or an executing Migration capability.
const producerSource = fs.readFileSync(new URL('../../src/migration/CurrentSchemaOwnedTargetProducer.cs', import.meta.url), 'utf8');
const compiledLoader = producerSource.match(/private const string s_retainedCompiledReaderBootstrap = """\n([\s\S]*?)\n        """;/u)?.[1];
const compiledModuleNames = ['tools/ci/migration-retained-inputs.mjs', 'tools/ci/production-build-artifacts.mjs',
    'tools/fact-extractors/identity.mjs', 'tools/fact-extractors/lib/canonicalize.mjs'];
const compiledFixtureSources = compiledModuleNames.map(name => fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'base64'));
function invokeCompiledFixture(value, sources = compiledFixtureSources, extra = [])
{
    assert.ok(compiledLoader, 'original C# fixed loader must exist');
    return spawnSync('/usr/bin/node', ['--experimental-vm-modules', '--input-type=module', '--eval', compiledLoader, '--',
        value.root, value.artifactRoot, value.sdkRoot, ...sources, ...extra], { env: process.env, encoding: 'utf8' });
}

test('compiled original four-module closure preserves import metadata and matches the original byte reader', t =>
{
    const value = retainedByteFixture(t);
    const observed = invokeCompiledFixture(value);
    assert.equal(observed.status, 0, observed.stderr);
    assert.deepEqual(JSON.parse(observed.stdout), readProductionRetainedMigrationTool(value));
    assert.equal(observed.stdout.trim().split('\n').length, 1);
});

test('compiled reader never executes replacement checkout JavaScript', t =>
{
    const value = retainedByteFixture(t);
    for (const name of compiledModuleNames)
    {
        fs.mkdirSync(path.dirname(path.join(value.root, name)), { recursive: true });
        fs.writeFileSync(path.join(value.root, name), "throw new Error('mutable_checkout_executed');\n");
    }
    const observed = invokeCompiledFixture(value);
    assert.notEqual(observed.status, 0);
    assert.doesNotMatch(observed.stderr, /mutable_checkout_executed/u);
    assert.equal(observed.stdout, '');
});

test('compiled reader rejects omitted, extra, malformed and oversized source payloads', t =>
{
    const value = retainedByteFixture(t);
    for (const sources of [compiledFixtureSources.slice(0, 3), [...compiledFixtureSources, compiledFixtureSources[0]],
        ['!', ...compiledFixtureSources.slice(1)], [Buffer.alloc(98304).toString('base64'), ...compiledFixtureSources.slice(1)]])
    {
        const observed = invokeCompiledFixture(value, sources);
        assert.notEqual(observed.status, 0);
        if (observed.status === null) assert.equal(observed.error?.code, 'E2BIG');
        assert.equal(observed.stdout ?? '', '');
    }
});

test('compiled linker rejects filesystem, package, escape and unknown builtin fallbacks', t =>
{
    const value = retainedByteFixture(t);
    for (const dependency of ['file:///tmp/caller.mjs', 'caller-package', '../../../caller.mjs', 'node:module'])
    {
        const entry = `import '${dependency}'; export function readProductionRetainedMigrationTool() { return {}; }`;
        const observed = invokeCompiledFixture(value, [Buffer.from(entry).toString('base64'), ...compiledFixtureSources.slice(1)]);
        assert.notEqual(observed.status, 0);
        assert.match(observed.stderr, /migration_retained_compiled_reader_(?:unknown|unbound)_import/u);
        assert.equal(observed.stdout, '');
    }
});

test('compiled linker rejects dynamic imports and a disconnected original closure', t =>
{
    const value = retainedByteFixture(t);
    for (const entry of ["await import('node:fs'); export function readProductionRetainedMigrationTool() { return {}; }",
        'export function readProductionRetainedMigrationTool() { return {}; }'])
    {
        const observed = invokeCompiledFixture(value, [Buffer.from(entry).toString('base64'), ...compiledFixtureSources.slice(1)]);
        assert.notEqual(observed.status, 0);
        assert.match(observed.stderr, /migration_retained_compiled_reader_(?:dynamic_import|incomplete_closure)/u);
        assert.equal(observed.stdout, '');
    }
});

test('original before and after byte measurements are fully covered by the original production receipt', t =>
{
    const value = retainedByteFixture(t);
    const verified = verifyProductionBuildReceipt({ artifactRoot: value.artifactRoot,
        expectedSourceState: value.receipt.sourceState, expectedInputRoot: value.root, repairReadOnlySeal: false });
    assert.equal(verified.evidence.status, 'success');
    const measured = readProductionRetainedMigrationTool(value);
    assert.equal(measured.Identity.SourceRevision, value.receipt.sourceState.commit);
    assert.match(measured.AssemblySha256, /^[a-f0-9]{64}$/u);
    assert.match(measured.ReceiptSha256, /^[a-f0-9]{64}$/u);
});

test('retained byte reader refuses a lost seal without repairing caller evidence', t =>
{
    const value = retainedByteFixture(t);
    const file = path.join(value.artifactRoot, 'payload/migration-runtime/FsusBlog.Migration.dll');
    fs.chmodSync(file, 0o600);
    assert.throws(() => readProductionRetainedMigrationTool(value), /read-only/u);
    assert.notEqual(fs.statSync(file).mode & 0o222, 0);
});

test('retained byte reader rejects unreceipted sidecars and modified output bytes', t =>
{
    const value = retainedByteFixture(t);
    const stray = path.join(value.artifactRoot, 'unclaimed.json');
    fs.writeFileSync(stray, '{}');
    assert.throws(() => readProductionRetainedMigrationTool(value), /not covered/u);
    fs.unlinkSync(stray);
    const file = path.join(value.artifactRoot, 'payload/migration-runtime/FsusBlog.Migration.dll');
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, 'substitute assembly');
    fs.chmodSync(file, 0o400);
    assert.throws(() => readProductionRetainedMigrationTool(value), /digest mismatch/u);
});
