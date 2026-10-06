import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    migrationAssemblyPendingPaths,
    prepareMigrationAssemblyPending,
    publishMigrationAssemblyPending,
    verifyCurrentMigrationAssembly,
    verifyMigrationAssemblyPending
} from '../../tools/db/generate-migration-assembly-receipt.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checker = join(repoRoot, 'tools/db/check-migration-assembly-boundary.mjs');
const fixturePaths = [
    'FsusBlog.slnx',
    'src/backend/FsusBlog.Server.csproj',
    'src/migration',
    'src/shared',
    'tests/migration',
    'artifacts/schema-migration/migration-assembly-receipt.json',
    'artifacts/schema-migration/migration-assembly-binding.json'
];

function fixture(t)
{
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-migration-boundary-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const path of fixturePaths)
    {
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repoRoot, path), destination, { recursive: true });
    }
    return root;
}

function mutate(root, path, transform)
{
    const fullPath = join(root, path);
    const source = readFileSync(fullPath, 'utf8');
    writeFileSync(fullPath, transform(source));
}

function check(root)
{
    return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' });
}

// These are source controls with explicit command/build/service adapters. No DLL,
// native result or actual MySQL qualification is manufactured by this fixture.
function pendingFixture(t)
{
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-migration-pending-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sources = ['src/migration/Fixture.cs', 'tests/migration/Fixture.cs'];
    for (const file of sources)
    {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), 'internal sealed class Fixture {}\n');
    }
    const git = (...args) =>
    {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    writeFileSync(join(root, '.gitignore'), '.tmp/\n');
    git('init', '--quiet');
    git('add', 'src', 'tests', '.gitignore');
    git('-c', 'user.name=Source Control', '-c', 'user.email=source-control@example.invalid',
        'commit', '--quiet', '-m', 'source fixture');
    const digest = value => createHash('sha256').update(value).digest('hex');
    const sourceBytes = file => fs.lstatSync(join(root, file)).isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(join(root, file))) : readFileSync(join(root, file));
    const observeSource = async () => ({ commit: git('rev-parse', 'HEAD'),
        worktreeFingerprint: digest(Buffer.concat(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
            .split('\0').filter(Boolean).sort().flatMap(file => [Buffer.from(`${file}\0`), sourceBytes(file)]))) });
    const context = { root, producer: 'backend-unit', runId: 'source-control', namespace: 'component', attemptId: null,
        sourceState: { commit: git('rev-parse', 'HEAD'),
            worktreeFingerprint: digest(Buffer.concat(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
                .split('\0').filter(Boolean).sort().flatMap(file => [Buffer.from(`${file}\0`), sourceBytes(file)]))) } };
    const owner = { ownerIdentity: { pid: process.pid }, createdAt: 'source-control', runRoot: join(root, '.tmp/build/source-control') };
    const admission = { contentDigest: `sha256:${digest('explicit service adapter')}`, executionEnvironment: {} };
    const commands = [
        'dotnet build src/migration/FsusBlog.Migration.csproj -c Release --no-restore',
        'dotnet test tests/migration/FsusBlog.Migration.Tests.csproj -c Release --no-restore'
    ];
    const adapters = {
        observeSource,
        requireBuild: async () => owner,
        readAdmission: async () => admission,
        execute: async (_root, inputDigest, _env, directory) => commands.map((command, index) =>
        {
            writeFileSync(join(directory, `${index}.stdout`), `controlled ${index}\n`, { mode: 0o600, flag: 'wx' });
            writeFileSync(join(directory, `${index}.stderr`), '', { mode: 0o600, flag: 'wx' });
            return { command, status: 'passed', exitCode: 0, inputDigest, summary: `controlled ${index}` };
        })
    };
    const paths = migrationAssemblyPendingPaths(context);
    return { root, context, adapters, paths,
        read: () => JSON.parse(readFileSync(paths.file, 'utf8')) };
}

test('Migration assembly pending binds real source and log bytes without touching tracked output', async t =>
{
    const fixture = pendingFixture(t);
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    assert.equal(fs.existsSync(join(fixture.root, 'artifacts')), false);
    assert.equal(fs.statSync(fixture.paths.file).mode & 0o777, 0o600);
    verifyMigrationAssemblyPending(fixture.context, fixture.read());
    writeFileSync(join(fixture.paths.directory, '1.stdout'), 'tampered output\n');
    assert.throws(() => verifyMigrationAssemblyPending(fixture.context, fixture.read()), /pending owner, bytes/u);
});

test('Migration assembly pending refuses command failure, filtered commands and source drift', async t =>
{
    for (const mutation of ['failure', 'filter', 'source'])
    {
        const fixture = pendingFixture(t);
        const execute = fixture.adapters.execute;
        fixture.adapters.execute = async (...args) =>
        {
            const results = await execute(...args);
            if (mutation === 'failure')
            {
                results[1].status = 'failed';
                results[1].exitCode = 1;
            }
            else if (mutation === 'filter')
            {
                results[1].command += ' --filter Selected';
            }
            else
            {
                writeFileSync(join(fixture.root, 'tests/migration/Fixture.cs'), 'source drift\n');
            }
            return results;
        };
        await assert.rejects(prepareMigrationAssemblyPending(fixture.context, fixture.adapters), /verification failed|source drifted/u);
        assert.equal(fs.existsSync(fixture.paths.file), false);
        assert.equal(fs.existsSync(join(fixture.root, 'artifacts')), false);
    }
});

test('Migration assembly pending rejects extra keys, paths, foreign producer and retry attempt', t =>
{
    const { context } = pendingFixture(t);
    for (const changed of [
        { ...context, outputFile: '/tmp/escape.json' },
        { ...context, runId: '../foreign' },
        { ...context, producer: 'foreign' },
        { ...context, producer: 'backend-tests', attemptId: 'attempt-0002' }
    ])
    {
        assert.throws(() => migrationAssemblyPendingPaths(changed), /closed current-run/u);
    }
});

test('Migration assembly pending refuses symlink parents and unregistered pending members', async t =>
{
    const fixture = pendingFixture(t);
    fs.symlinkSync('/tmp', join(fixture.root, '.tmp'));
    await assert.rejects(prepareMigrationAssemblyPending(fixture.context, fixture.adapters), /task-owned parent|source drifted/u);
    fs.unlinkSync(join(fixture.root, '.tmp'));
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    writeFileSync(join(fixture.paths.directory, 'permit.json'), '{"success":true}\n');
    assert.throws(() => verifyMigrationAssemblyPending(fixture.context, fixture.read()), /closed output roster/u);
});

test('Migration assembly pending refuses failed finalization, changed source and foreign cleaned service', async t =>
{
    for (const mutation of ['finalization', 'source', 'service'])
    {
        const fixture = pendingFixture(t);
        await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
        if (mutation === 'finalization')
        {
            fixture.adapters.requireBuild = async (_context, { finalized }) =>
            {
                assert.equal(finalized, true);
                throw new Error('original finalized owner refused');
            };
        }
        else if (mutation === 'source')
        {
            writeFileSync(join(fixture.root, 'src/migration/Fixture.cs'), 'changed current source\n');
        }
        else
        {
            fixture.adapters.readAdmission = async (_context, _env, phase) =>
            {
                assert.equal(phase, 'cleaned');
                return { contentDigest: 'foreign' };
            };
        }
        await assert.rejects(publishMigrationAssemblyPending(fixture.context, fixture.adapters),
            /finalized owner refused|stale|source drifted|finalized build\/service owner/u);
        assert.equal(fs.existsSync(join(fixture.root, 'artifacts')), false);
    }
});

test('Migration assembly pending refuses malformed manifests, forged success fields and changed inventories', async t =>
{
    const fixture = pendingFixture(t);
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    for (const mutate of [
        pending => { pending.files = {}; },
        pending => { pending.nativePassed = true; },
        pending => { pending.buildOwner.outputFile = '/tmp/foreign'; },
        pending => { pending.admissionDigest = 'permitted'; },
        pending => { pending.receipt.verificationResults[1].inputDigest = 'stale'; },
        pending => { pending.receipt.files[0].sha256 = 'stale'; }
    ])
    {
        const pending = fixture.read();
        mutate(pending);
        assert.throws(() => verifyMigrationAssemblyPending(fixture.context, pending), /pending owner|verification or source inventory/u);
    }
});

test('Migration assembly pending publication rolls back partial pair and removes only owned staging', async t =>
{
    const fixture = pendingFixture(t);
    const receipt = join(fixture.root, 'artifacts/schema-migration/migration-assembly-receipt.json');
    const binding = join(fixture.root, 'artifacts/schema-migration/migration-assembly-binding.json');
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, '{}\n');
    writeFileSync(binding, 'original binding\n');
    fixture.context.sourceState = await fixture.adapters.observeSource();
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    let calls = 0;
    await assert.rejects(publishMigrationAssemblyPending(fixture.context, {
        ...fixture.adapters,
        rename: (from, to) =>
        {
            if (++calls === 2)
            {
                throw new Error('second publication refused');
            }
            fs.renameSync(from, to);
        }
    }), /second publication refused/u);
    assert.equal(readFileSync(receipt, 'utf8'), '{}\n');
    assert.equal(readFileSync(binding, 'utf8'), 'original binding\n');
    assert.deepEqual(fs.readdirSync(dirname(receipt)).sort(), [
        'migration-assembly-binding.json', 'migration-assembly-receipt.json'
    ]);
    verifyMigrationAssemblyPending(fixture.context, fixture.read());
});

test('Migration assembly pending publishes the exact original pair once and requires fresh final qualification', async t =>
{
    const fixture = pendingFixture(t);
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    const result = await publishMigrationAssemblyPending(fixture.context, fixture.adapters);
    const pending = fixture.read();
    assert.deepEqual(JSON.parse(readFileSync(result.receipt, 'utf8')), pending.receipt);
    assert.deepEqual(JSON.parse(readFileSync(result.binding, 'utf8')), pending.binding);
    assert.equal(result.qualificationEligible, false);
    assert.equal(JSON.parse(readFileSync(fixture.paths.publication)).qualificationEligible, false);
    await assert.rejects(publishMigrationAssemblyPending(fixture.context, fixture.adapters), /cannot be repeated/u);
});

test('Migration assembly pending failed cleanup preserves foreign staging and the original publication cause', async t =>
{
    const fixture = pendingFixture(t);
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    let calls = 0;
    let foreign;
    await assert.rejects(publishMigrationAssemblyPending(fixture.context, {
        ...fixture.adapters,
        rename: (from, to) =>
        {
            if (++calls === 2)
            {
                foreign = from;
                writeFileSync(from, 'foreign staging\n');
                throw new Error('original publication failure');
            }
            fs.renameSync(from, to);
        }
    }), error =>
    {
        assert.equal(error.cause.message, 'original publication failure');
        assert.equal(error.errors[0].message, 'original publication failure');
        assert.match(error.errors[1].message, /refused a foreign staged file/u);
        return true;
    });
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign staging\n');
    assert.equal(fs.existsSync(join(fixture.root, 'artifacts/schema-migration/migration-assembly-receipt.json')), false);
    assert.equal(fs.existsSync(fixture.paths.publication), false);
});

test('Migration assembly pending fresh final source consumes new command evidence without rewriting tracked summaries', async t =>
{
    const fixture = pendingFixture(t);
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    const published = await publishMigrationAssemblyPending(fixture.context, fixture.adapters);
    const receiptBytes = readFileSync(published.receipt);
    const bindingBytes = readFileSync(published.binding);
    fixture.context.runId = 'fresh-final-source';
    fixture.context.sourceState = await fixture.adapters.observeSource();
    const originalExecute = fixture.adapters.execute;
    fixture.adapters.execute = async (...args) => (await originalExecute(...args))
        .map(result => ({ ...result, summary: 'new current-run timing' }));
    await prepareMigrationAssemblyPending(fixture.context, fixture.adapters);
    const verified = await verifyCurrentMigrationAssembly(fixture.context, fixture.adapters);
    assert.equal(verified.status, 'verified-current-run');
    assert.deepEqual(verified.sourceState, fixture.context.sourceState);
    assert.equal(verified.qualificationEligible, false);
    assert.ok(receiptBytes.equals(readFileSync(published.receipt)));
    assert.ok(bindingBytes.equals(readFileSync(published.binding)));
    writeFileSync(published.binding, 'tampered tracked binding\n');
    await assert.rejects(verifyCurrentMigrationAssembly(fixture.context, fixture.adapters), /pending owner|tracked source\/binding/u);
});

test('Migration assembly pending CLI rejects generic output and fake permission JSON before command execution', t =>
{
    const fixture = pendingFixture(t);
    for (const args of [
        ['--write', '--output', '/tmp/foreign'],
        ['--publish-current-run', '--permit', '{"success":true}'],
        ['--write', '--publish-current-run'],
        ['--write', '--write']
    ])
    {
        const result = spawnSync(process.execPath, [join(repoRoot, 'tools/db/generate-migration-assembly-receipt.mjs'),
            '--root', fixture.root, ...args], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /accepts only|duplicate options/u);
        assert.equal(fs.existsSync(fixture.paths.directory), false);
    }
    const missingAdmission = spawnSync(process.execPath, [join(repoRoot, 'tools/db/generate-migration-assembly-receipt.mjs'),
        '--root', fixture.root, '--write'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.notEqual(missingAdmission.status, 0);
    assert.match(missingAdmission.stderr, /closed current-run source context/u);
    assert.equal(fs.existsSync(fixture.paths.directory), false);
});

test('canonical migration assembly boundary is accepted', t =>
{
    const result = check(fixture(t));
    assert.equal(result.status, 0, result.stderr);
});

test('reverse Server reference and missing provider are rejected', t =>
{
    const root = fixture(t);
    mutate(root, 'src/migration/FsusBlog.Migration.csproj', source => source
        .replace('<PackageReference Include="SqlSugarCoreNoDrive" />', '')
        .replace('</ItemGroup>\n</Project>', '<ProjectReference Include="../backend/FsusBlog.Server.csproj" />\n  </ItemGroup>\n</Project>'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider package is missing/);
    assert.match(result.stderr, /may reference only FsusBlog\.Shared|forbidden framework or application reference/);
});

test('project graph cycle is rejected', t =>
{
    const root = fixture(t);
    mutate(root, 'src/shared/FsusBlog.Shared.csproj', source => source.replace(
        '</Project>',
        '  <ItemGroup><ProjectReference Include="../migration/FsusBlog.Migration.csproj" /></ItemGroup>\n</Project>'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /project graph contains a cycle/);
});

test('shared legacy column and Server linked duplicate are rejected', t =>
{
    const root = fixture(t);
    const sharedFixture = join(root, 'src/shared/LegacyLeak.cs');
    writeFileSync(sharedFixture, 'public sealed class LegacyLeak { public string LastUsernameUpdateTime { get; set; } = ""; }\n');
    mutate(root, 'src/backend/FsusBlog.Server.csproj', source => source.replace(
        '</Project>',
        '  <ItemGroup><Compile Include="../migration/SchemaMigrationPrimitives.cs" Link="SchemaMigrationPrimitives.cs" /></ItemGroup>\n</Project>'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy-only column/);
    assert.match(result.stderr, /links or duplicates migration source/);
});

test('an arbitrary project linked source and an arbitrary Server duplicate are rejected', t =>
{
    const root = fixture(t);
    const rogueProject = join(root, 'tests/rogue/Rogue.csproj');
    mkdirSync(dirname(rogueProject), { recursive: true });
    writeFileSync(rogueProject, '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../../src/migration/SchemaMigrationManifest.cs" Link="Other.cs" /></ItemGroup></Project>\n');
    const duplicate = join(root, 'src/backend/Other/UnrelatedName.cs');
    mkdirSync(dirname(duplicate), { recursive: true });
    cpSync(join(root, 'src/migration/SchemaMigrationRegistry.cs'), duplicate);
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /links or duplicates migration source outside Migration/);
    assert.match(result.stderr, /duplicate migration source at an arbitrary path/);
});

test('compatibility namespace, type forwarder, and provider current mapping are rejected', t =>
{
    const root = fixture(t);
    writeFileSync(
        join(root, 'src/migration/CompatibilityLeak.cs'),
        'using System.Runtime.CompilerServices;\n[assembly: TypeForwardedTo(typeof(FsusBlog.Migration.SchemaMigrationRegistry))]\nnamespace FsusBlog.Server.Infrastructure.SchemaMigration;\n[SugarTable("leak")] public sealed class Leak {}\n');
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate current-schema field mapping/);
    assert.match(result.stderr, /compatibility namespace or type forwarder/);
});

test('a second provider field mapping is rejected outside migration-owned source rows', t =>
{
    const root = fixture(t);
    writeFileSync(
        join(root, 'src/migration/DuplicateProviderMapping.cs'),
        'using SqlSugar;\nnamespace FsusBlog.Migration;\n[SugarTable("comment")] internal sealed class DuplicateProviderMapping { [SugarColumn(ColumnName = "id")] public long Id { get; set; } }\n');
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate current-schema field mapping/);
});

test('migration test Web host and old Server definition tree are rejected', t =>
{
    const root = fixture(t);
    mutate(root, 'tests/migration/MigrationAssemblyBoundaryTests.cs', source => `${source}\n// WebApplicationFactory forbidden fixture\n`);
    const oldPath = join(root, 'src/backend/Infrastructure/SchemaMigration/Definitions/Legacy.cs');
    mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, 'namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;\n');
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Migration tests start or reference the Server web host/);
    assert.match(result.stderr, /Legacy definitions remain in Server/);
});

test('solution registration and receipt symbol digest tamper are rejected', t =>
{
    const root = fixture(t);
    mutate(root, 'FsusBlog.slnx', source => source.replace('    <Project Path="src/migration/FsusBlog.Migration.csproj" />\n', ''));
    mutate(root, 'artifacts/schema-migration/migration-assembly-receipt.json', source => source.replace('FsusBlog.Migration', 'FsusBlog.Migration.Tampered'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not registered exactly once in the solution/);
    assert.match(result.stderr, /receipt content or symbol inventory is stale/);
    assert.match(result.stderr, /binding manifest is stale or tampered/);
});

test('old/new dual registration and Server publish legacy source are rejected', t =>
{
    const root = fixture(t);
    mutate(root, 'FsusBlog.slnx', source => source.replace(
        '    <Project Path="src/migration/FsusBlog.Migration.csproj" />',
        '    <Project Path="src/migration/FsusBlog.Migration.csproj" />\n    <Project Path="src/migration/FsusBlog.Migration.csproj" />'));
    mutate(root, 'src/backend/FsusBlog.Server.csproj', source => source.replace(
        '</Project>',
        '  <ItemGroup><Content Include="../migration/SchemaMigrationManifest.cs" CopyToPublishDirectory="Always" /></ItemGroup>\n</Project>'));
    const duplicateProject = join(root, 'src/legacy/FsusBlog.LegacyMigration.csproj');
    mkdirSync(dirname(duplicateProject), { recursive: true });
    writeFileSync(duplicateProject, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><AssemblyName>FsusBlog.Migration</AssemblyName></PropertyGroup></Project>\n');
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /assembly identity is registered more than once/);
    assert.match(result.stderr, /registered exactly once in the solution/);
    assert.match(result.stderr, /Server build\/publish includes legacy migration source/);
});

test('missing actual provider build result is rejected', t =>
{
    const root = fixture(t);
    mutate(root, 'artifacts/schema-migration/migration-assembly-receipt.json', source => source.replace(
        '"status": "passed"',
        '"status": "not-run"'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /actual independent build\/test results are failed or stale/);
});
