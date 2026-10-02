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

function retainedByteFixture(t)
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
    const actual = captureMigrationRetainedInputs(value);
    const receipt = createProductionBuildReceipt({
        root: value.root, artifactRoot,
        sourceState: { commit: actual.sourceIdentity.sourceCommit, worktreeFingerprint: actual.sourceIdentity.worktreeFingerprint },
        producer: { workflow: 'Byte fixture only', runId: 'fixture', runAttempt: 1, job: 'fixture-not-build' },
        toolchain: { node: 'fixture', npm: 'fixture', dotnet: 'fixture', vite: 'fixture', vitest: 'fixture', playwright: 'fixture', emsdk: 'fixture' },
        inputPaths: ['Directory.Build.props'], domains: [{ name: 'migration-runtime', path: 'payload/migration-runtime' }],
        build: { command: 'tools/test/lanes/production-build-artifacts.sh' }
    });
    return { ...value, artifactRoot, receipt };
}

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
