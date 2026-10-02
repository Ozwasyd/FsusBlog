import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { inspectMigrationTerminalGovernance } = await import(new URL('../../tools/db/check-migration-terminal-governance.mjs', import.meta.url));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checker = join(repoRoot, 'tools/db/check-migration-terminal-governance.mjs');
const fixturePaths = [
    'src/backend/FsusBlog.Server.csproj',
    'src/backend/Infrastructure/SchemaMigration',
    'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs',
    'src/migration',
    'src/shared',
    'src/core/FsusBlog.Core.csproj',
    'tools/architecture/FsusBlog.DiLifetimeAnalyzer/FsusBlog.DiLifetimeAnalyzer.csproj',
    'Directory.Build.props',
    'Directory.Packages.props',
    'FsusBlog.slnx'
];

function fixture(t)
{
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-terminal-gov-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const path of fixturePaths)
    {
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repoRoot, path), destination, { recursive: true });
    }
    return root;
}

function check(root)
{
    return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' });
}

test('canonical static graph passes without claiming terminal acceptance', t =>
{
    const root = fixture(t);
    const result = check(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /static-only; terminal acceptance blocked/u);
    const report = inspectMigrationTerminalGovernance(root);
    assert.equal(report.qualificationEligible, false);
    assert.equal(report.publish.status, 'not-observed');
    assert.equal(report.publish.residue, null);
    assert.deepEqual(Object.values(report.providers), ['not-run', 'not-run', 'not-run']);
    assert.equal(report.mutation.status, 'not-observed');
    assert.equal(report.benchmark.status, 'not-evaluable');
    assert.equal(report.finalAcceptance.status, 'blocked');
    assert.ok(report.graph.missingObservations.some(value => value.includes('evaluated compile/runtime assets')));
});

function append(root, path, text)
{
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${readFileSync(absolute, 'utf8')}\n${text}\n`);
}

function add(root, path, text)
{
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
}

test('transitive Server dependency and cycles are derived, not hard-coded', t =>
{
    const root = fixture(t);
    append(root, 'src/core/FsusBlog.Core.csproj', '<ProjectReference Include="../migration/FsusBlog.Migration.csproj" />');
    append(root, 'src/migration/FsusBlog.Migration.csproj', '<ProjectReference Include="../backend/FsusBlog.Server.csproj" />');
    const report = inspectMigrationTerminalGovernance(root);
    assert.equal(report.graph.directions.serverToMigration, true);
    assert.equal(report.graph.directions.migrationToServer, true);
    assert.ok(report.failures.some(value => value.includes('project cycle')));
    assert.ok(report.failures.some(value => value.includes('explicit or transitive')));
});

test('literal imported props and conditional references cannot hide a Migration edge', t =>
{
    const root = fixture(t);
    append(root, 'src/core/FsusBlog.Core.csproj', '<Import Project="build/Boundary.props" />');
    add(root, 'src/core/build/Boundary.props', '<Project><ProjectReference Condition="false" Include="../migration/FsusBlog.Migration.csproj" /></Project>');
    const report = inspectMigrationTerminalGovernance(root);
    assert.equal(report.graph.directions.serverToMigration, true);
    assert.ok(report.graph.inputs.some(value => value.path === 'src/core/build/Boundary.props'));
});

test('unresolved expressions, missing projects and linked/glob sources fail closed', t =>
{
    const root = fixture(t);
    append(root, 'src/backend/FsusBlog.Server.csproj', '<ProjectReference Include="$(HiddenMigrationProject)" /><ProjectReference Include="../missing/Gone.csproj" /><Compile Include="../migration/**/*.cs" />');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('unresolved project/item')));
    assert.ok(report.failures.some(value => value.includes('missing required path')));
    assert.ok(report.failures.some(value => value.includes('includes Migration Compile')));
});

test('literal linked source outside the project directory is scanned and bound', t =>
{
    const root = fixture(t);
    append(root, 'src/backend/FsusBlog.Server.csproj', '<Compile Include="../../linked/Hidden.cs" />');
    add(root, 'linked/Hidden.cs', 'using FsusBlog.Migration; public class Hidden {}');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('Server imports Migration: linked/Hidden.cs')));
    assert.ok(report.graph.inputs.some(value => value.path === 'linked/Hidden.cs'));
});

for (const [name, text] of [
    ['string reflection', 'var type = Type.GetType("FsusBlog." + "Migration.SchemaMigrationRegistry, FsusBlog.Migration");'],
    ['assembly load', 'var assembly = Assembly.LoadFrom("FsusBlog.Migration.dll");'],
    ['keyed DI alias', 'services.AddKeyedSingleton<object>("legacy", Type.GetType("SchemaMigrationRegistry"));'],
    ['service registration', 'services.AddSingleton<ISchemaMigrationRegistry, SchemaMigrationRegistry>();'],
    ['non-generic registration', 'services.AddSingleton(typeof(ISchemaMigrationRegistry), typeof(SchemaMigrationRegistry));'],
    ['registry construction', 'var registry = new SchemaMigrationRegistry();']
])
{
    test(`${name} is rejected without banning all reflection`, t =>
    {
        const root = fixture(t);
        add(root, 'src/backend/HiddenLoad.cs', text);
        const report = inspectMigrationTerminalGovernance(root);
        assert.ok(report.failures.some(value => /reflection\/DI|DI: migration registry/u.test(value)), JSON.stringify(report.failures));
    });
}

test('comments, benign strings, safe reflection and prefix lookalikes are controls', t =>
{
    const root = fixture(t);
    add(root, 'src/backend/Benign.cs', '// Type.GetType("FsusBlog.Migration");\nvar example = "FsusBlog.Migration";\nvar type = Type.GetType("System.String");\nvar prefix = Type.GetType("FsusBlog.MigrationTools.Helper");\nusing FsusBlog.MigrationTools;');
    add(root, 'src/shared/Benign.cs', 'var example = "LastUsernameUpdateTime";');
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
});

test('Migration web-host imports, friend assemblies and duplicate identities are rejected', t =>
{
    const root = fixture(t);
    add(root, 'src/migration/HiddenHost.cs', 'using Microsoft.AspNetCore; public class HiddenHost : BackgroundService {}\n[assembly: InternalsVisibleTo("FsusBlog.Server")]\nvar assembly = Assembly.Load("FsusBlog.Server");');
    add(root, 'src/duplicate/Duplicate.csproj', '<Project><AssemblyName>FsusBlog.Migration</AssemblyName></Project>');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('Server/runtime')));
    assert.ok(report.failures.some(value => value.includes('InternalsVisibleTo')));
    assert.ok(report.failures.some(value => value.includes('Migration loads Server/runtime')));
    assert.ok(report.failures.some(value => value.includes('not registered exactly once')));
});

test('observed assets expose indirect compile/runtime residue and invalid graphs', t =>
{
    const root = fixture(t);
    add(root, 'src/backend/obj/project.assets.json', JSON.stringify({ libraries: { 'FsusBlog.Migration/1.0.0': { type: 'project', path: '../migration/FsusBlog.Migration.csproj' } }, targets: { net10: {} } }));
    add(root, 'src/migration/obj/project.assets.json', '{not-json');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('Migration in Server compile/runtime graph')));
    assert.ok(report.failures.some(value => value.includes('invalid assets')));
});

test('generated code is observed and never omitted as ordinary obj cache', t =>
{
    const root = fixture(t);
    add(root, 'src/backend/obj/Release/Hidden.g.cs', 'using FsusBlog.Migration; public class HiddenGenerated {}');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('Hidden.g.cs')));
    assert.ok(report.graph.inputs.some(value => value.path.endsWith('Hidden.g.cs')));
});

test('missing runtime assets cannot classify a legitimate shared package as migration-only', t =>
{
    const root = fixture(t);
    add(root, 'src/migration/obj/project.assets.json', JSON.stringify({ libraries: { 'Npgsql/10.0.0': { type: 'package' } }, targets: { net10: {} } }));
    add(root, '.tmp/publish/Npgsql.dll', 'legitimate runtime provider fixture');
    const report = inspectMigrationTerminalGovernance(root);
    assert.deepEqual(report.publish.observedMigrationOnlyPackages, []);
    assert.deepEqual(report.publish.residue, []);
    assert.equal(report.qualificationEligible, false);
});

test('complete observed assets bind migration-only packages without globally banning providers', t =>
{
    const root = fixture(t);
    for (const directory of ['src/backend', 'src/core', 'src/shared', 'tools/architecture/FsusBlog.DiLifetimeAnalyzer'])
    {
        add(root, `${directory}/obj/project.assets.json`, JSON.stringify({ libraries: { 'Npgsql/10.0.0': { type: 'package' } }, targets: { net10: {} } }));
    }
    add(root, 'src/migration/obj/project.assets.json', JSON.stringify({ libraries: { 'Npgsql/10.0.0': { type: 'package' }, 'MigrationOnlyProvider/1.0.0': { type: 'package' } }, targets: { net10: {} } }));
    add(root, '.tmp/publish/MigrationOnlyProvider.dll', 'provider package residue');
    add(root, '.tmp/publish/Npgsql.dll', 'legitimate runtime provider fixture');
    const report = inspectMigrationTerminalGovernance(root);
    assert.deepEqual(report.publish.observedMigrationOnlyPackages, ['MigrationOnlyProvider']);
    assert.deepEqual(report.publish.residue, ['.tmp/publish/MigrationOnlyProvider.dll']);
});

test('publish contents and chunk-boundary metadata are checked, not filenames alone', t =>
{
    const root = fixture(t);
    const prefix = Buffer.alloc(65530, 65);
    add(root, '.tmp/publish/FsusBlog.Server', Buffer.concat([prefix, Buffer.from('FsusBlog.Migration', 'utf16le')]));
    const report = inspectMigrationTerminalGovernance(root);
    assert.equal(report.publish.status, 'observed-unqualified');
    assert.deepEqual(report.publish.residue, ['.tmp/publish/FsusBlog.Server']);
    assert.ok(report.failures.some(value => value.includes('publish residue')));
    assert.equal(report.publish.files[0].bytes, prefix.length + Buffer.byteLength('FsusBlog.Migration', 'utf16le'));
});

test('a benign publish remains unqualified, not provider or benchmark evidence', t =>
{
    const root = fixture(t);
    add(root, '.tmp/publish/FsusBlog.Server', 'benign executable fixture');
    const report = inspectMigrationTerminalGovernance(root);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.publish.residue, []);
    assert.equal(report.qualificationEligible, false);
    assert.equal(report.finalAcceptance.status, 'blocked');
});

test('the graph digest binds full source beyond the old 4096-byte prefix', t =>
{
    const root = fixture(t);
    const path = 'src/backend/LateInput.cs';
    add(root, path, `${'// padding\n'.repeat(600)}public class Before {}`);
    const before = inspectMigrationTerminalGovernance(root);
    add(root, path, `${'// padding\n'.repeat(600)}public class After {}`);
    const after = inspectMigrationTerminalGovernance(root);
    assert.notEqual(before.graph.digest, after.graph.digest);
    assert.notEqual(before.graph.inputs.find(value => value.path === path).sha256, after.graph.inputs.find(value => value.path === path).sha256);
});

test('--write retains a failed non-qualifying graph instead of fabricating acceptance', t =>
{
    const root = fixture(t);
    add(root, 'src/backend/Hidden.cs', 'using FsusBlog.Migration;');
    const result = spawnSync(process.execPath, [checker, '--root', root, '--write'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(join(root, 'artifacts/schema-migration/terminal-acceptance-receipt.json'), 'utf8'));
    assert.equal(report.schema, 'fsusblog.migration-terminal-static-observation.v1');
    assert.equal(report.qualificationEligible, false);
    assert.ok(report.failures.length > 0);
    assert.equal(report.finalAcceptance.status, 'blocked');
});

test('Server→Migration and Migration→Server are rejected', t =>
{
    const root = fixture(t);
    writeFileSync(
        join(root, 'src/backend/FsusBlog.Server.csproj'),
        `${readFileSync(join(root, 'src/backend/FsusBlog.Server.csproj'), 'utf8')}\n<ProjectReference Include="../migration/FsusBlog.Migration.csproj" />\n`);
    writeFileSync(
        join(root, 'src/migration/FsusBlog.Migration.csproj'),
        `${readFileSync(join(root, 'src/migration/FsusBlog.Migration.csproj'), 'utf8')}\n<ProjectReference Include="../backend/FsusBlog.Server.csproj" />\n`);
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Server → Migration/);
    assert.match(result.stderr, /Migration → Server/);
});

test('shared legacy column and type-forwarder are rejected', t =>
{
    const root = fixture(t);
    writeFileSync(join(root, 'src/shared/LegacyLeak.cs'), 'public sealed class LegacyLeak { public string LastUsernameUpdateTime { get; set; } = ""; }\n');
    writeFileSync(
        join(root, 'src/migration/Forwarder.cs'),
        'using System.Runtime.CompilerServices;\n[assembly: TypeForwardedTo(typeof(string))]\nnamespace FsusBlog.Server.Infrastructure.SchemaMigration;\n');
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy column/);
    assert.match(result.stderr, /type-forwarder or compat namespace/);
});
