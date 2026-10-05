import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checker = join(repoRoot, 'tools/db/check-migration-terminal-governance.mjs');
const { bindPhysicalGraphInputs, findMigrationLoadingLiterals, inspectPhysicalProjectGraph } = await import(pathToFileURL(checker).href);
const fixturePaths = [
    'src/backend/FsusBlog.Server.csproj',
    'src/backend/Infrastructure/SchemaMigration',
    'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs',
    'src/core/FsusBlog.Core.csproj',
    'src/migration',
    'src/shared',
    'tools/architecture/FsusBlog.DiLifetimeAnalyzer/FsusBlog.DiLifetimeAnalyzer.csproj'
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

function check(root, args = [])
{
    return spawnSync(process.execPath, [checker, '--root', root, ...args], { encoding: 'utf8' });
}

test('canonical terminal graph alone does not qualify terminal acceptance', t =>
{
    const result = check(fixture(t));
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /graph: (?!evaluated compile\/runtime assets and compiled loading observations are missing)|source:|current-schema-authority:|shared current contract/);
    assert.match(result.stderr, /graph: evaluated compile\/runtime assets and compiled loading observations are missing/);
    assert.match(result.stderr, /benchmark: not-evaluable cannot qualify terminal acceptance/);
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

test('missing publish and executable observations cannot qualify terminal acceptance', t =>
{
    const result = check(fixture(t));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publish: no published output was observed/);
    assert.match(result.stderr, /providers: executable PostgreSQL, MySQL and SQLite observations are missing/);
    assert.match(result.stderr, /mutation: terminal mutation results were not observed/);
    assert.match(result.stderr, /benchmark: not-evaluable cannot qualify terminal acceptance/);
    assert.doesNotMatch(result.stdout, /ok graph/);
});

test('incomplete observations cannot write an acceptance receipt', t =>
{
    const root = fixture(t);
    mkdirSync(join(root, '.tmp/publish'), { recursive: true });
    const result = check(root, ['--write']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publish: published output is empty/);
    assert.match(result.stderr, /benchmark: not-evaluable cannot qualify terminal acceptance/);
    assert.equal(existsSync(join(root, 'artifacts/schema-migration/terminal-acceptance-receipt.json')), false);
});

function addProjectReference(root, project, include)
{
    const path = join(root, project);
    const text = readFileSync(path, 'utf8');
    assert.equal((text.match(/<\/Project>/g) ?? []).length, 1);
    writeFileSync(path, text.replace('</Project>', `<ItemGroup><ProjectReference Include="${include}" /></ItemGroup></Project>`));
}

function relay(root, target)
{
    const path = join(root, 'src/relay/Relay.csproj');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include='${target}' /></ItemGroup></Project>\n`);
    return path;
}

test('physical graph accepts benign Relay closure and binds complete sorted inputs', t =>
{
    const root = fixture(t);
    relay(root, '../shared/FsusBlog.Shared.csproj');
    addProjectReference(root, 'src/backend/FsusBlog.Server.csproj', '../relay/Relay.csproj');
    const graph = inspectPhysicalProjectGraph(root);
    assert.deepEqual(graph.errors, []);
    assert.equal(graph.evaluatedAssetsObserved, false);
    assert.equal(graph.directions.serverToMigration, false);
    assert.ok(graph.projects.some(project => project.path === 'src/relay/Relay.csproj'));
    const path = join(root, 'src/backend/CompleteBinding.cs');
    writeFileSync(path, '// ' + 'a'.repeat(8192) + '\npublic sealed class BindingFirst {}\n');
    const first = bindPhysicalGraphInputs(root, graph);
    writeFileSync(path, '// ' + 'a'.repeat(8192) + '\npublic sealed class BindingSecond {}\n');
    const second = bindPhysicalGraphInputs(root, inspectPhysicalProjectGraph(root));
    assert.notEqual(first.digest, second.digest);
    assert.deepEqual(second.sources.map(input => input.path), [...second.sources.map(input => input.path)].sort());
    assert.ok(second.sources.some(input => input.path === 'src/backend/CompleteBinding.cs'));
    const relayPath = join(root, 'src/relay/Relay.csproj');
    writeFileSync(relayPath, readFileSync(relayPath, 'utf8').replace('<ItemGroup>', '<!-- full project binding -->\n<ItemGroup>'));
    const third = bindPhysicalGraphInputs(root, inspectPhysicalProjectGraph(root));
    assert.notEqual(second.digest, third.digest);
});

test('physical graph rejects Server to Migration through a Relay', t =>
{
    const root = fixture(t);
    relay(root, '../migration/FsusBlog.Migration.csproj');
    addProjectReference(root, 'src/backend/FsusBlog.Server.csproj', '../relay/Relay.csproj');
    const graph = inspectPhysicalProjectGraph(root);
    assert.equal(graph.directions.serverToMigration, true);
    assert.ok(graph.errors.includes('graph: Server → Migration through physical ProjectReference closure'));
});

test('physical graph rejects Migration to Server through a Relay', t =>
{
    const root = fixture(t);
    relay(root, '../backend/FsusBlog.Server.csproj');
    addProjectReference(root, 'src/migration/FsusBlog.Migration.csproj', '../relay/Relay.csproj');
    const graph = inspectPhysicalProjectGraph(root);
    assert.equal(graph.directions.migrationToServer, true);
    assert.ok(graph.errors.includes('graph: Migration → Server through physical ProjectReference closure'));
});

test('physical graph parses single quotes and XML entities but ignores commented references', t =>
{
    const root = fixture(t);
    const path = relay(root, '../sh&#97;red/FsusBlog.Shared.csproj');
    writeFileSync(path, readFileSync(path, 'utf8').replace('</Project>', '<!-- <ProjectReference Include="../migration/FsusBlog.Migration.csproj" /> --></Project>'));
    addProjectReference(root, 'src/backend/FsusBlog.Server.csproj', '../relay/Relay.csproj');
    const graph = inspectPhysicalProjectGraph(root);
    assert.deepEqual(graph.errors, []);
    assert.deepEqual(graph.projects.find(project => project.path === 'src/relay/Relay.csproj').references,
        ['src/shared/FsusBlog.Shared.csproj']);
});

for (const [name, xml, diagnostic] of [
    ['missing reference', '<Project><ItemGroup><ProjectReference Include="../absent/Missing.csproj" /></ItemGroup></Project>', /ENOENT/],
    ['escaping reference', '<Project><ItemGroup><ProjectReference Include="../../../outside.csproj" /></ItemGroup></Project>', /path escapes repository/],
    ['computed reference', '<Project><ItemGroup><ProjectReference Include="$(TargetProject)" /></ItemGroup></Project>', /nonliteral ProjectReference/],
    ['conditional reference', '<Project><ItemGroup Condition="false"><ProjectReference Include="../shared/FsusBlog.Shared.csproj" /></ItemGroup></Project>', /conditional or computed ProjectReference/],
    ['explicit import', '<Project><Import Project="refs.props" /></Project>', /imported project references/],
    ['malformed project XML', '<Project><ItemGroup><ProjectReference Include="../shared/FsusBlog.Shared.csproj" /></Project>', /unbalanced XML elements/]
])
{
    test(`physical graph fails closed for ${name}`, t =>
    {
        const root = fixture(t);
        const path = relay(root, '../shared/FsusBlog.Shared.csproj');
        writeFileSync(path, xml);
        addProjectReference(root, 'src/backend/FsusBlog.Server.csproj', '../relay/Relay.csproj');
        const graph = inspectPhysicalProjectGraph(root);
        assert.ok(graph.errors.some(error => diagnostic.test(error)), graph.errors.join('\n'));
    });
}

test('physical graph rejects project and source symlinks', t =>
{
    const root = fixture(t);
    const path = join(root, 'src/relay/Relay.csproj');
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(root, 'src/shared/FsusBlog.Shared.csproj'), path);
    addProjectReference(root, 'src/backend/FsusBlog.Server.csproj', '../relay/Relay.csproj');
    assert.ok(inspectPhysicalProjectGraph(root).errors.some(error => error.includes('symlink')));
    const graph = inspectPhysicalProjectGraph(root);
    symlinkSync(join(root, 'src/backend/FsusBlog.Server.csproj'), join(root, 'src/shared/LinkedSource.cs'));
    assert.throws(() => bindPhysicalGraphInputs(root, graph), /symlink/);
});

test('physical graph rejects cycles without recursive admission', t =>
{
    const root = fixture(t);
    relay(root, 'Relay.csproj');
    addProjectReference(root, 'src/backend/FsusBlog.Server.csproj', '../relay/Relay.csproj');
    assert.ok(inspectPhysicalProjectGraph(root).errors.some(error => error.includes('ProjectReference cycle')));
});

for (const [name, source, kind] of [
    ['Assembly.Load', 'System.Reflection.Assembly.Load("FsusBlog.Migration");', 'reflection-assembly-load'],
    ['Type.GetType', 'System.Type.GetType("FsusBlog.Migration.SchemaMigrationRegistry, FsusBlog.Migration");', 'reflection-assembly-load'],
    ['constant assembly alias', 'const string Alias = "FsusBlog" + ".Migration"; Assembly.Load(Alias);', 'reflection-assembly-load'],
    ['escaped assembly literal', 'Assembly.Load("FsusBlog\\u002eMigration");', 'reflection-assembly-load'],
    ['keyed DI alias', 'const string Alias = "FsusBlog.Migration"; services.AddKeyedSingleton<IRegistry>(Alias, registry);', 'keyed-di-alias']
])
{
    test(`targeted loading diagnostic rejects ${name} independently of absent terminal observations`, () =>
    {
        const matches = findMigrationLoadingLiterals(source);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].kind, kind);
    });
}

test('targeted diagnostics allow benign reflection and ignore commented migration calls', () =>
{
    const source = `
        // Assembly.Load("FsusBlog.Migration");
        /* Type.GetType("FsusBlog.Migration.Registry"); */
        const string Alias = "CurrentContracts";
        Assembly.Load(Alias);
        Type.GetType("System.String");
        services.AddKeyedSingleton<IRegistry>("current", registry);
        Assembly.Load("FsusBlog.Migrationally");
    `;
    assert.deepEqual(findMigrationLoadingLiterals(source), []);
});
