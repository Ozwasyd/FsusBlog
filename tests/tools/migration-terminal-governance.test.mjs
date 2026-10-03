import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

for (const include of ['../../linked/**/*.cs', '$(UnobservedSources)'])
{
    test(`unresolved Compile ${include} alone is refused without an illegal project edge`, t =>
    {
        const root = fixture(t);
        append(root, 'src/backend/FsusBlog.Server.csproj', `<Compile Include="${include}" />`);
        add(root, 'linked/Hidden.cs', 'using FsusBlog.Migration;');
        const report = inspectMigrationTerminalGovernance(root);
        assert.ok(report.failures.some(value => value.includes('unresolved Compile input')));
        assert.equal(report.graph.directions.serverToMigration, false);
    });
}

test('an exact benign in-project Compile file remains accepted and content-bound', t =>
{
    const root = fixture(t);
    add(root, 'src/backend/Local.cs', 'public class Local {}');
    append(root, 'src/backend/FsusBlog.Server.csproj', '<Compile Include="Local.cs" />');
    const report = inspectMigrationTerminalGovernance(root);
    assert.deepEqual(report.failures, []);
    assert.ok(report.graph.inputs.some(value => value.path === 'src/backend/Local.cs'));
});

test('an imported assembly identity cannot hide duplicate Migration registration', t =>
{
    const root = fixture(t);
    add(root, 'src/duplicate/Duplicate.csproj', '<Project><Import Project="Identity.props" /></Project>');
    add(root, 'src/duplicate/Identity.props', '<Project><AssemblyName Condition="false">FsusBlog.Migration</AssemblyName></Project>');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('not registered exactly once')));
    assert.ok(report.graph.projects.find(project => project.path === 'src/duplicate/Duplicate.csproj').assemblyNames.includes('FsusBlog.Migration'));
});

test('an unresolved imported AssemblyName cannot claim exact-one identity', t =>
{
    const root = fixture(t);
    add(root, 'src/duplicate/Duplicate.csproj', '<Project><Import Project="Identity.props" /></Project>');
    add(root, 'src/duplicate/Identity.props', '<Project><AssemblyName>$(HiddenIdentity)</AssemblyName></Project>');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('unresolved AssemblyName input')));
});

for (const [name, item, target, text] of [
    ['import', '<Import Project="../../input-alias/Input.props" />', 'Input.props', '<Project><ProjectReference Include="../migration/FsusBlog.Migration.csproj" /></Project>'],
    ['linked source', '<Compile Include="../../input-alias/Hidden.cs" />', 'Hidden.cs', 'using FsusBlog.Migration;'],
    ['publish', null, 'FsusBlog.Server', 'FsusBlog.Migration']
])
{
    test(`an external symlink parent for ${name} is refused before reading its payload`, t =>
    {
        const root = fixture(t);
        const outside = mkdtempSync(join(tmpdir(), 'fsusblog-terminal-outside-'));
        t.after(() => rmSync(outside, { recursive: true, force: true }));
        writeFileSync(join(outside, target), text);
        const alias = item ? join(root, 'input-alias') : join(root, '.tmp/publish');
        mkdirSync(dirname(alias), { recursive: true });
        symlinkSync(outside, alias, 'dir');
        if (item)
        {
            append(root, 'src/backend/FsusBlog.Server.csproj', item);
        }
        const report = inspectMigrationTerminalGovernance(root);
        assert.ok(report.failures.some(value => value.includes('symbolic input path component')));
        assert.ok(report.graph.inputs.every(value => !value.path.includes('input-alias')));
        assert.equal(report.publish.files.length, 0);
    });
}

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

const friendAttributeForms = [
    'InternalsVisibleTo',
    'InternalsVisibleToAttribute',
    'System.Runtime.CompilerServices.InternalsVisibleTo',
    'System.Runtime.CompilerServices.InternalsVisibleToAttribute',
    'global::System.Runtime.CompilerServices.InternalsVisibleTo',
    'global::System.Runtime.CompilerServices.InternalsVisibleToAttribute'
];
const friendDirections = [
    ['src/migration/Friend.cs', 'FsusBlog.Server'],
    ['src/migration/Friend.cs', 'FsusBlog.Shared'],
    ['src/backend/Friend.cs', 'FsusBlog.Migration'],
    ['src/shared/Friend.cs', 'FsusBlog.Migration']
];

for (const attribute of friendAttributeForms)
{
    for (const [path, target] of friendDirections)
    {
        test(`actual assembly ${attribute} declaration from ${path} to ${target} is refused`, t =>
        {
            const root = fixture(t);
            assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
            add(root, path, `using System.Runtime.CompilerServices;\n[assembly: ${attribute}("${target}")]\n`);
            const report = inspectMigrationTerminalGovernance(root);
            assert.ok(report.failures.some(value => value.includes('InternalsVisibleTo') && value.includes(path)),
                JSON.stringify(report.failures));
            assert.equal(report.graph.directions.serverToMigration, false);
            assert.equal(report.graph.directions.migrationToServer, false);
        });
    }
}

test('assembly friend literal expressions and multiple-attribute syntax cannot hide the real identity', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    for (const [index, argument] of [
        '"FsusBlog." + /* literal seam */ "Migration"',
        '@"FsusBlog.Migration"',
        '"FsusBlog.\\u004digration"',
        'assemblyName: "FsusBlog.Migration, PublicKey=0123456789abcdef"'
    ].entries())
    {
        const path = `src/backend/FriendExpression${index}.cs`;
        add(root, path, `using System.Runtime.CompilerServices;\n[assembly: global::System.CLSCompliant(false), InternalsVisibleToAttribute(${argument})]\n`);
        assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('InternalsVisibleTo')
            && value.includes(path)), path);
    }
});

test('unresolved assembly friend arguments are reported rather than assumed benign', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/backend/UnknownFriend.cs', 'using System.Runtime.CompilerServices;\n[assembly: InternalsVisibleTo(FriendConstants.Name)]\n');
    const report = inspectMigrationTerminalGovernance(root);
    assert.ok(report.failures.some(value => value.includes('unresolved InternalsVisibleTo') && value.includes('UnknownFriend.cs')));
});

test('friend comments, literal examples, type lookalikes and ordinary test friends remain benign', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/FriendControls.cs', `using System.Runtime.CompilerServices;
// [assembly: InternalsVisibleTo("FsusBlog.Server")]
/* [assembly: global::System.Runtime.CompilerServices.InternalsVisibleToAttribute("FsusBlog.Server")] */
[assembly: InternalsVisibleTo("FsusBlog.Migration.Tests")]
[assembly: InternalsVisibleToAttribute("FsusBlog.ServerTools")]
public static class FriendControls
{
    public const string Example = "[assembly: InternalsVisibleTo(\\"FsusBlog.Server\\")]";
    public const string Verbatim = @"[assembly: InternalsVisibleTo(""FsusBlog.Server"")]";
    public const string Raw = """[assembly: InternalsVisibleTo("FsusBlog.Server")]""";
}
`);
    add(root, 'src/backend/OtherFriend.cs', `[assembly: Other.InternalsVisibleTo("FsusBlog.Migration")]
namespace Other
{
    [global::System.AttributeUsage(global::System.AttributeTargets.Assembly)]
    public sealed class InternalsVisibleToAttribute : global::System.Attribute
    {
        public InternalsVisibleToAttribute(string value) { }
    }
}
`);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
});

for (const [project, target] of [
    ['src/backend/FsusBlog.Server.csproj', 'FsusBlog.Migration'],
    ['src/shared/FsusBlog.Shared.csproj', 'FsusBlog.Migration'],
    ['src/migration/FsusBlog.Migration.csproj', 'FsusBlog.Server']
])
{
    test(`MSBuild friend item in ${project} cannot hide ${target} in a declared import`, t =>
    {
        const root = fixture(t);
        assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
        const props = `${dirname(project)}/Friend.props`;
        append(root, project, '<Import Project="Friend.props" />');
        add(root, props, `<Project><ItemGroup><InternalsVisibleTo Condition="false" Include="${target}" /></ItemGroup></Project>`);
        const report = inspectMigrationTerminalGovernance(root);
        assert.ok(report.failures.some(value => value.includes('InternalsVisibleTo') && value.includes(props)));
        assert.ok(report.graph.projects.find(value => value.path === project).friends.some(value => value.input === props
            && value.value === target && value.condition === 'false'));
    });
}

test('unresolved MSBuild friend update is refused while remove-only items and comments do not grant friendship', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    const project = 'src/backend/FsusBlog.Server.csproj';
    append(root, project, '<!-- <InternalsVisibleTo Include="FsusBlog.Migration" /> -->\n<InternalsVisibleTo Remove="FsusBlog.Migration" />\n<InternalsVisibleTo Include="FsusBlog.Tests" />');
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    append(root, project, '<InternalsVisibleTo Update="$(HiddenFriendAssembly)" />');
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('unresolved InternalsVisibleTo')));
});

const friendAliases = [
    ['type', 'using Friend = global::System.Runtime.CompilerServices.InternalsVisibleToAttribute;', 'Friend'],
    ['namespace', 'using CS = System.Runtime.CompilerServices;', 'CS.InternalsVisibleTo']
];

for (const [kind, declaration, attribute] of friendAliases)
{
    for (const [path, target] of friendDirections)
    {
        test(`assembly friend ${kind} alias from ${path} to ${target} is refused`, t =>
        {
            const root = fixture(t);
            assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
            add(root, path, `${declaration}\n[assembly: ${attribute}("${target}")]\n`);
            assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('InternalsVisibleTo')
                && value.includes(path)), path);
        });
    }

    test(`global ${kind} alias is observed across files in its owning project`, t =>
    {
        const root = fixture(t);
        assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
        add(root, 'src/migration/GlobalFriend.cs', `global ${declaration}\n`);
        add(root, 'src/migration/AliasedFriend.cs', `[assembly: ${attribute}("FsusBlog.Server")]\n`);
        assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('InternalsVisibleTo')
            && value.includes('AliasedFriend.cs')));
    });
}

test('attribute suffix aliases and unresolved external alias targets cannot silently hide friendship', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/SuffixFriend.cs', `using FriendAttribute = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
[assembly: Friend("FsusBlog.Server")]
`);
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('InternalsVisibleTo')
        && value.includes('SuffixFriend.cs')));
    add(root, 'src/migration/ExternalFriend.cs', `extern alias Hidden;
using Friend = Hidden::System.Runtime.CompilerServices.InternalsVisibleToAttribute;
[assembly: Friend("FsusBlog.Server")]
`);
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('unresolved InternalsVisibleTo')
        && value.includes('ExternalFriend.cs')));
});

test('benign friend aliases, custom attribute aliases and masked alias examples remain benign', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/AliasControls.cs', `using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
using CS = global::System.Runtime.CompilerServices;
[assembly: Friend("FsusBlog.Migration.Tests")]
[assembly: CS.InternalsVisibleTo("FsusBlog.OtherTests")]
// using Ordinary = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
/* using Other = System.Runtime.CompilerServices; */
public static class AliasControls
{
    public const string Example = "using Ordinary = System.Runtime.CompilerServices.InternalsVisibleToAttribute;";
}
`);
    add(root, 'src/backend/OrdinaryAlias.cs', `using Ordinary = Other.MarkerAttribute;
[assembly: Ordinary("FsusBlog.Migration")]
namespace Other
{
    [global::System.AttributeUsage(global::System.AttributeTargets.Assembly)]
    public sealed class MarkerAttribute : global::System.Attribute
    {
        public MarkerAttribute(string value) { }
    }
}
`);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
});

test('global aliases stay within the owning project rather than granting meaning to referenced-project attributes', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/GlobalFriend.cs', 'global using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;\n');
    add(root, 'src/backend/LocalFriend.cs', `using Friend = Other.MarkerAttribute;
[assembly: Friend("FsusBlog.Migration")]
namespace Other
{
    [global::System.AttributeUsage(global::System.AttributeTargets.Assembly)]
    public sealed class MarkerAttribute : global::System.Attribute
    {
        public MarkerAttribute(string value) { }
    }
}
`);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
});

for (const [project, target] of [
    ['src/backend/FsusBlog.Server.csproj', 'FsusBlog.Migration'],
    ['src/shared/FsusBlog.Shared.csproj', 'FsusBlog.Migration'],
    ['src/migration/FsusBlog.Migration.csproj', 'FsusBlog.Server']
])
{
    test(`MSBuild static friend lists in ${project} refuse forbidden first and later members`, t =>
    {
        const root = fixture(t);
        assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
        append(root, project, '<Import Project="FriendList.props" />');
        const props = `${dirname(project)}/FriendList.props`;
        for (const value of [`${target};FsusBlog.Tests`, `FsusBlog.Tests; ${target} ;FsusBlog.OtherTests`])
        {
            add(root, props, `<Project><ItemGroup><InternalsVisibleTo Condition="false" Include="${value}" /></ItemGroup></Project>`);
            const report = inspectMigrationTerminalGovernance(root);
            assert.ok(report.failures.some(failure => failure.includes('InternalsVisibleTo') && failure.includes(target)
                && failure.includes(props)), value);
            assert.ok(report.graph.projects.find(item => item.path === project).friends.some(item => item.input === props
                && item.value === value && item.condition === 'false'));
        }
    });
}

test('MSBuild friend lists retain benign members, update semantics and unresolved-member refusal', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    const project = 'src/backend/FsusBlog.Server.csproj';
    append(root, project, '<InternalsVisibleTo Include="FsusBlog.Tests;FsusBlog.OtherTests" />');
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    append(root, project, '<InternalsVisibleTo Update="FsusBlog.Tests;$(HiddenFriendAssembly)" Condition="false" />');
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('unresolved InternalsVisibleTo')));
    append(root, project, '<InternalsVisibleTo Update="FsusBlog.Tests;FsusBlog.Migration" />');
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('InternalsVisibleTo FsusBlog.Migration')));
});

for (const [path, target] of friendDirections)
{
    test(`namespace-local aliases cannot hide the compilation-unit friend from ${path} to ${target}`, t =>
    {
        const root = fixture(t);
        assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
        add(root, path, `using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("${target}")]
namespace N
{
    using InternalsVisibleTo = Other.MarkerAttribute;
}
namespace Other
{
    public sealed class MarkerAttribute : global::System.Attribute
    {
        public MarkerAttribute(string value) { }
    }
}
`);
        assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes(`InternalsVisibleTo ${target}`)
            && value.includes(path)), path);
    });
}

test('a namespace-local same-name alias does not conflict with a permitted outer friend alias', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/ScopedFriend.cs', `using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
[assembly: Friend("FsusBlog.Migration.Tests")]
namespace N
{
    using Friend = Other.MarkerAttribute;
    namespace Nested
    {
        using Friend = System.ObsoleteAttribute;
    }
}
namespace Other
{
    public sealed class MarkerAttribute : global::System.Attribute
    {
        public MarkerAttribute(string value) { }
    }
}
`);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
});

test('file-scoped namespace aliases do not rebind a preceding global assembly attribute', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/FileScopedFriend.cs', `using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("FsusBlog.Server")]
namespace N;
using InternalsVisibleTo = global::System.ObsoleteAttribute;
`);
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('InternalsVisibleTo FsusBlog.Server')
        && value.includes('FileScopedFriend.cs')));
});

test('permitted outer aliases remain visible before a file-scoped namespace with a local same-name alias', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/PermittedFileScopedFriend.cs', `using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
[assembly: Friend("FsusBlog.Migration.Tests")]
namespace N;
using Friend = global::System.ObsoleteAttribute;
`);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
});

test('only compilation-unit global aliases enter the owning project alias map', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/GlobalScopedFriend.cs', 'global using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;\n');
    add(root, 'src/migration/LocalScopedFriend.cs', `namespace N
{
    using Friend = System.ObsoleteAttribute;
}
`);
    add(root, 'src/migration/GlobalFriendUse.cs', '[assembly: Friend("FsusBlog.Migration.Tests")]\n');
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/GlobalFriendUse.cs', '[assembly: Friend("FsusBlog.Server")]\n');
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('InternalsVisibleTo FsusBlog.Server')
        && value.includes('GlobalFriendUse.cs')));
});

for (const [path, target] of friendDirections)
{
    test(`conditional namespace braces cannot silently omit the real friend from ${path} to ${target}`, t =>
    {
        const root = fixture(t);
        assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
        add(root, path, `#if false
namespace N {
#endif
using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
[assembly: Friend("${target}")]
#if false
}
#endif
`);
        assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('unresolved InternalsVisibleTo')
            && value.includes(path)), path);
    });
}

test('conditionally uncertain permitted friend scope is explicitly unsupported rather than silently complete', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/ConditionalPermittedFriend.cs', `#if false
namespace N {
#endif
using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
[assembly: Friend("FsusBlog.Migration.Tests")]
#if false
}
#endif
`);
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('unresolved InternalsVisibleTo')
        && value.includes('ConditionalPermittedFriend.cs')));
});

test('unrelated directives and conditional code do not erase unambiguous permitted outer aliases', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/DirectiveControls.cs', `#define UNUSED
#region Documentary namespace N { }
#endregion
using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
[assembly: Friend("FsusBlog.Migration.Tests")]
#if false
namespace Unused { public sealed class Example { } }
#endif
`);
    add(root, 'src/migration/ConditionalNoScopeChange.cs', `#if true
using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
#endif
[assembly: Friend("FsusBlog.Migration.Tests")]
`);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
});

test('conditional file-scoped namespaces cannot hide a project-global friend alias in another file', t =>
{
    const root = fixture(t);
    assert.deepEqual(inspectMigrationTerminalGovernance(root).failures, []);
    add(root, 'src/migration/ConditionalGlobalAlias.cs', `#if false
namespace N;
#endif
global using Friend = System.Runtime.CompilerServices.InternalsVisibleToAttribute;
`);
    add(root, 'src/migration/ConditionalGlobalUse.cs', '[assembly: Friend("FsusBlog.Server")]\n');
    assert.ok(inspectMigrationTerminalGovernance(root).failures.some(value => value.includes('unresolved InternalsVisibleTo')
        && value.includes('ConditionalGlobalUse.cs')));
});
