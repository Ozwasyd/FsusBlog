import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const { inspectMsbuildSource, msbuildSourceFiles, msbuildSourceLimits, validateMsbuildSourceReceipt } = await import(new URL('../../tools/test-matrix/msbuild-source-inspector.mjs', import.meta.url));
const { sourceStageInspectionFiles, unsupportedSourceStageFiles } = await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));

const repository = fileURLToPath(new URL('../../', import.meta.url));
const [central, project] = msbuildSourceFiles;
const witnesses = ['src/shared/FsusBlog.Shared.csproj', 'tools/ci/migration-retained-inputs.mjs',
    'tools/ci/production-build-artifacts.mjs', 'tools/fact-extractors/identity.mjs', 'tools/fact-extractors/lib/canonicalize.mjs'];
// Real original 066 inputs, including original resource and project boundaries.
const original = new Map([central, project, ...witnesses].map(file => [file,
    execFileSync('git', ['-C', repository, 'show', `066ae14a5fa5a65dfc0258795a58fd74da60f99a:${file}`])]));

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-msbuild-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file, bytes) =>
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), bytes);
    };
    for (const [file, bytes] of original)
    {
        write(file, bytes);
    }
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    git('init', '--quiet');
    const commit = () =>
    {
        git('add', '.');
        const tree = git('write-tree').toString().trim();
        const head = execFileSync('git', ['-C', root, 'commit-tree', tree], {
            input: 'controlled MSBuild source fixture\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
        }).toString().trim();
        git('update-ref', 'HEAD', head);
        return head;
    };
    commit();
    return { root, write, git, commit, inspect: (files = [...msbuildSourceFiles]) => inspectMsbuildSource({ repositoryRoot: root, files }) };
}

test('original central packages and Migration declarations are inspected readonly, including approved #4640 changes', t =>
{
    const f = fixture(t);
    for (const approved of [false, true])
    {
        f.write(central, original.get(central).toString().replace('MessagePack" Version="2.5.301',
            `MessagePack" Version="${approved ? '2.5.307' : '2.5.301'}`));
        f.write(project, original.get(project).toString().replace('<PackageReference Include="MySqlConnector"',
            `${approved ? '<PackageReference Include="SQLitePCLRaw.lib.e_sqlite3" />\n    ' : ''}<PackageReference Include="MySqlConnector"`));
        const head = f.commit();
        const before = f.git('status', '--porcelain=v1', '--untracked-files=all');
        const actual = f.inspect();
        assert.equal(actual.head, head);
        assert.equal(actual.qualificationEligible, false);
        assert.equal(actual.status, 'success');
        assert.deepEqual(actual.sources.map(value => value.file), [...msbuildSourceFiles]);
        assert.equal(actual.sources[0].packages.find(value => value.id === 'MessagePack').version, approved ? '2.5.307' : '2.5.301');
        assert.equal(actual.sources[1].packageReferences.includes('SQLitePCLRaw.lib.e_sqlite3'), approved);
        assert.deepEqual(actual.sources[1].projectReferences, [witnesses[0]]);
        assert.deepEqual(actual.witnesses.map(value => value.file), [central, project, ...witnesses]);
        assert.deepEqual(validateMsbuildSourceReceipt({ repositoryRoot: f.root, files: [...msbuildSourceFiles], expectedHead: head, receipt: actual }), actual);
        assert.deepEqual(f.git('status', '--porcelain=v1', '--untracked-files=all'), before);
        assert.equal(fs.existsSync(path.join(f.root, 'obj')), false);
        assert.equal(fs.existsSync(path.join(f.root, 'task-ran')), false);
    }
    const centralOnly = f.inspect([central]);
    assert.deepEqual(centralOnly.sources.map(value => value.file), [central]);
    assert.deepEqual(centralOnly.witnesses.map(value => value.file), [central]);
    const projectOnly = f.inspect([project]);
    assert.deepEqual(projectOnly.sources.map(value => value.file), [project]);
    assert.deepEqual(projectOnly.witnesses.map(value => value.file), [central, project, ...witnesses]);
});

test('XML parser refuses malformed, DTD, external entity, expansion, alias, CDATA and encoding ambiguity', t =>
{
    const f = fixture(t);
    for (const prefix of ['<!DOCTYPE Project>', '<!DOCTYPE Project SYSTEM "https://example.invalid/evil.dtd">',
        '<!DOCTYPE Project [<!ENTITY secret SYSTEM "file:///etc/passwd">]>',
        '<!DOCTYPE Project [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>', '<?xml version="1.0"?>', '<?task execute?>'])
    {
        f.write(central, prefix + original.get(central));
        f.commit();
        assert.throws(() => f.inspect(), /MSBuild XML refused/u, prefix);
    }
    for (const source of ['<Project><ItemGroup></Project>', '<Project /><Project />',
        original.get(central).toString().replace('AngleSharp', 'Angle&#83;harp'),
        original.get(central).toString().replace('true', '<![CDATA[true]]>'),
        original.get(central).toString().replace('true', '&unknown;'),
        Buffer.from([0xff, 0x00]), '\uFEFF' + original.get(central)])
    {
        f.write(central, source);
        f.commit();
        assert.throws(() => f.inspect(), /MSBuild XML refused|exact UTF-8/u);
    }
});

test('imports, targets, executable tasks, property functions and unknown XML constructs never execute', t =>
{
    const f = fixture(t);
    for (const construct of ['<Import Project="evil.targets" />', '<ImportGroup />', '<UsingTask TaskName="Evil" AssemblyFile="evil.dll" />',
        '<Target Name="BeforeBuild"><Exec Command="touch task-ran" /></Target>', '<Choose><When Condition="true" /></Choose>',
        '<Sdk Name="Other.Sdk" />', '<PropertyGroup><Unknown>true</Unknown></PropertyGroup>',
        '<ItemGroup><Compile Include="../../outside.cs" /></ItemGroup>'])
    {
        for (const file of msbuildSourceFiles)
        {
            f.write(central, original.get(central));
            f.write(project, original.get(project));
            f.write(file, original.get(file).toString().replace('</Project>', `${construct}</Project>`));
            f.commit();
            assert.throws(() => f.inspect(), /unsupported/u, construct);
            assert.equal(fs.existsSync(path.join(f.root, 'task-ran')), false);
        }
    }
});

test('edited package boundaries reject unknown, duplicate, missing, ranged or independently versioned dependencies', t =>
{
    const f = fixture(t);
    const cases = [
        [central, source => source.replace('AngleSharp', 'Unknown.Package')],
        [central, source => source.replace('1.5.0', '[1.5.0,)')],
        [central, source => source.replace('2.5.301', '2.5.999')],
        [central, source => source.replace('Include="AngleSharp"', 'Update="AngleSharp"')],
        [central, source => source.replace('<PackageVersion Include="AngleSharp" Version="1.5.0" />', '')],
        [central, source => source.replace('</ItemGroup>', '<PackageVersion Include="AngleSharp" Version="1.5.0" /></ItemGroup>')],
        [central, source => source.replace('Version="1.5.0"', 'Version="$(Override)"')],
        [central, source => source.replace('<ItemGroup>', '<ItemGroup Condition="true">')],
        [project, source => source.replace('Include="AngleSharp"', 'Include="Unknown.Package"')],
        [project, source => source.replace('Include="AngleSharp"', 'Include="AngleSharp" Version="1.5.0"')],
        [project, source => source.replace('Include="AngleSharp"', 'Include="AngleSharp" VersionOverride="1.5.0"')],
        [project, source => source.replace('Include="AngleSharp"', 'Update="AngleSharp"')],
        [project, source => source.replace('<PackageReference Include="AngleSharp" />', '')],
        [project, source => source.replace('<PackageReference Include="AngleSharp" />', '<PackageReference Include="AngleSharp" /><PackageReference Include="AngleSharp" />')]
    ];
    for (const [file, mutate] of cases)
    {
        f.write(central, original.get(central));
        f.write(project, original.get(project));
        f.write(file, mutate(original.get(file).toString()));
        f.commit();
        assert.throws(() => f.inspect(), /unsupported|incomplete/u);
    }
});

test('edited project, SDK, resource and property boundaries fail closed', t =>
{
    const f = fixture(t);
    for (const mutate of [source => source.replace('Microsoft.NET.Sdk', 'Evil.Sdk'),
        source => source.replace('net10.0', 'net9.0'), source => source.replace('>Exe<', '>Library<'),
        source => source.replace('..\\shared\\FsusBlog.Shared.csproj', '..\\backend\\FsusBlog.Server.csproj'),
        source => source.replace('..\\shared\\FsusBlog.Shared.csproj', '$(ProjectPath)'),
        source => source.replace('..\\shared\\FsusBlog.Shared.csproj', '../../outside.csproj'),
        source => source.replace('Include="..\\shared', 'Condition="true" Include="..\\shared'),
        source => source.replace('$(FsusBlogCommitSha)', '$([System.IO.File]::ReadAllText("/etc/passwd"))'),
        source => source.replace('$(FsusBlogCommitSha)', '$(Unknown)'),
        source => source.replace('RetainedReader.tools.ci.migration', 'RetainedReader.other.migration'),
        source => source.replace('../../tools/ci/migration-retained-inputs.mjs', '../../tools/evil.mjs'),
        source => source.replace('LogicalName="FsusBlog.Migration', 'CopyToOutputDirectory="Always" LogicalName="FsusBlog.Migration'),
        source => source.replace('<Project Sdk=', '<Project xmlns="urn:other" Sdk=')])
    {
        f.write(project, mutate(original.get(project).toString()));
        f.commit();
        assert.throws(() => f.inspect(), /unsupported|MSBuild XML refused/u);
    }
});

test('unknown inputs and unvalidated or deleted original paths retain SOURCE refusal', t =>
{
    const f = fixture(t);
    const unknown = ['tools/Other.props', 'src/Other.csproj', 'Directory.Build.props', 'a.targets',
        'nested/Directory.Packages.props', '../Directory.Packages.props', '/Directory.Packages.props', central + '\0'];
    for (const file of unknown)
    {
        assert.throws(() => f.inspect([file]), /explicit original inputs/u);
    }
    for (const files of [[], [central, central], [central, project, central]])
    {
        assert.throws(() => f.inspect(files), /explicit original inputs/u);
    }
    assert.deepEqual(unsupportedSourceStageFiles([...msbuildSourceFiles, ...unknown]), [...msbuildSourceFiles, ...unknown]);
    assert.deepEqual(unsupportedSourceStageFiles([...msbuildSourceFiles, ...unknown], [], [], [], [], [...msbuildSourceFiles, ...unknown]), unknown);
    assert.deepEqual(sourceStageInspectionFiles([], [...msbuildSourceFiles]), [...msbuildSourceFiles]);
    fs.unlinkSync(path.join(f.root, project));
    assert.throws(() => f.inspect(), /ENOENT/u);
    assert.deepEqual(unsupportedSourceStageFiles(sourceStageInspectionFiles([], [project])), [project]);
});

test('HEAD/index/physical binding refuses untracked, unstaged, staged, linked, executable or missing witnesses', t =>
{
    const f = fixture(t);
    for (const file of [central, project, ...witnesses])
    {
        f.write(file, Buffer.concat([original.get(file), Buffer.from('\n')]));
        assert.throws(() => f.inspect(), /HEAD\/index\/physical/u);
        f.git('add', file);
        assert.throws(() => f.inspect(), /HEAD\/index\/physical/u);
        f.write(file, original.get(file));
        f.git('add', file);
    }
    fs.chmodSync(path.join(f.root, project), 0o755);
    assert.throws(() => f.inspect(), /HEAD\/index\/physical/u);
    fs.chmodSync(path.join(f.root, project), 0o644);
    fs.linkSync(path.join(f.root, central), path.join(f.root, 'hardlink'));
    assert.throws(() => f.inspect(), /single-link/u);
    fs.unlinkSync(path.join(f.root, 'hardlink'));
    fs.unlinkSync(path.join(f.root, project));
    fs.symlinkSync(path.join(repository, project), path.join(f.root, project));
    assert.throws(() => f.inspect(), /ELOOP/u);
    fs.unlinkSync(path.join(f.root, project));
    f.write(project, original.get(project));
    f.git('rm', '--cached', project);
    assert.throws(() => f.inspect(), /HEAD\/index\/physical/u);
});

test('bounded XML, file bytes and witness inputs refuse before unbounded evaluation', t =>
{
    const f = fixture(t);
    for (const source of [' '.repeat(msbuildSourceLimits.fileBytes + 1), '<Project>' + '<ItemGroup />'.repeat(129) + '</Project>',
        '<Project><A><B><C><D /></C></B></A></Project>'])
    {
        f.write(central, source);
        f.commit();
        assert.throws(() => f.inspect(), /bounded|bounds|XML refused/u);
    }
});

test('alternate Git context, linked ancestors and actual FIFOs cannot supply inspection inputs', t =>
{
    const f = fixture(t);
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE'])
    {
        const previous = process.env[key];
        try
        {
            process.env[key] = '/untrusted';
            assert.throws(() => f.inspect(), /ambient alternate Git/u);
        }
        finally
        {
            if (previous === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = previous;
            }
        }
    }
    fs.renameSync(path.join(f.root, 'src/migration'), path.join(f.root, 'src/linked-migration'));
    fs.symlinkSync('linked-migration', path.join(f.root, 'src/migration'));
    assert.throws(() => f.inspect(), /linked or non-directory/u);
    fs.unlinkSync(path.join(f.root, 'src/migration'));
    fs.renameSync(path.join(f.root, 'src/linked-migration'), path.join(f.root, 'src/migration'));
    fs.unlinkSync(path.join(f.root, central));
    execFileSync('mkfifo', [path.join(f.root, central)]);
    assert.throws(() => f.inspect(), /bounded regular/u);
});

test('the new regression has one canonical static-governance physical owner', () =>
{
    const registry = JSON.parse(fs.readFileSync(path.join(repository, 'tests/governance/test-lifecycle-registry.json')));
    const entries = registry.nodeTests.filter(value => value.file === 'tests/tools/msbuild-source.test.mjs');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].owner, 'repository-governance:static-node-contracts');
    assert.equal(entries[0].physicalExecutionCount, 1);
    assert.equal(entries[0].staticGovernance.category, 'real-subprocess-lifecycle');
});

test('receipt tamper, forged checked paths, qualification, extra fields and stale witnesses are rejected', t =>
{
    const f = fixture(t);
    const receipt = f.inspect();
    for (const mutate of [value =>
    {
        value.head = '0'.repeat(40);
    }, value =>
    {
        value.indexDigest = '0'.repeat(64);
    },
    value =>
    {
        value.qualificationEligible = true;
    }, value =>
    {
        value.reviewed = true;
    }, value =>
    {
        value.sources.pop();
    },
    value =>
    {
        value.sources[1].file = 'Other.csproj';
    }, value =>
    {
        value.sources[1].projectReferences = [];
    },
    value =>
    {
        value.sources[0].packages[0].version = '999.0.0';
    }, value =>
    {
        value.witnesses.pop();
    },
    value =>
    {
        value.witnesses[0].sha256 = '0'.repeat(64);
    }, value =>
    {
        value.parser.sourceSha256 = '0'.repeat(64);
    }])
    {
        const changed = structuredClone(receipt);
        mutate(changed);
        assert.throws(() => validateMsbuildSourceReceipt({ repositoryRoot: f.root,
            files: [...msbuildSourceFiles], expectedHead: receipt.head, receipt: changed }), /independently reopened/u);
    }
    f.write(witnesses[1], Buffer.concat([original.get(witnesses[1]), Buffer.from('\n')]));
    f.commit();
    assert.throws(() => validateMsbuildSourceReceipt({ repositoryRoot: f.root,
        files: [...msbuildSourceFiles], expectedHead: receipt.head, receipt }), /independently reopened/u);
});

test('original SOURCE dispatch counts only independently reopened receipts and retains each inspection failure', t =>
{
    const f = fixture(t);
    const source = fs.readFileSync(path.join(repository, 'tools/test-matrix/source-governance.mjs'), 'utf8');
    const start = source.indexOf('    const msbuildFiles = evidence.changedFiles.filter');
    const end = source.indexOf('    const solutions =', start);
    assert.ok(start > 0 && end > start);
    const dispatch = inspect =>
    {
        const context = { root: f.root, evidence: { changedFiles: [...msbuildSourceFiles],
            headCommit: f.git('rev-parse', 'HEAD').toString().trim() }, msbuildSourceFiles,
        inspectMsbuildSource: inspect, validateMsbuildSourceReceipt, process: { exitCode: 0 }, results: [], checkedMsbuild: [] };
        vm.runInNewContext(source.slice(start, end), context);
        return context;
    };
    const good = dispatch(inspectMsbuildSource);
    assert.deepEqual([...good.checkedMsbuild], [...msbuildSourceFiles]);
    assert.equal(good.results[0].status, 'success');
    assert.equal(good.results[0].receipt.qualificationEligible, false);
    const forged = dispatch(options => ({ ...inspectMsbuildSource(options), qualificationEligible: true }));
    assert.equal(forged.checkedMsbuild.length, 0);
    assert.equal(forged.results[0].status, 'failure');
    assert.match(forged.results[0].bindingError, /independently reopened/u);
    assert.equal(forged.process.exitCode, 1);
    assert.deepEqual(unsupportedSourceStageFiles([...msbuildSourceFiles], [], [], [], [], forged.checkedMsbuild), [...msbuildSourceFiles]);
    f.write(project, original.get(project).toString().replace('</Project>', '<Import Project="unknown.targets" /></Project>'));
    f.commit();
    const invalid = dispatch(inspectMsbuildSource);
    assert.equal(invalid.checkedMsbuild.length, 0);
    assert.equal(invalid.results[0].status, 'failure');
    assert.equal(invalid.process.exitCode, 1);
});

test('CLI rejects unknown options and emits a real nonqualifying original-input receipt', t =>
{
    const f = fixture(t);
    const checker = path.join(repository, 'tools/test-matrix/msbuild-source-inspector.mjs');
    const run = args => spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
    assert.equal(run(['--root', f.root, '--restore', project]).status, 1);
    const result = run(['--root', f.root, '--file', central, '--file', project]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).qualificationEligible, false);
});

// Preserve the checkpoint's original inspector controls above. These explicit
// text-node mutations exercise the P2 at every supported structural boundary.
const feffTextCases = [
    ['central scalar before', central, '>true<', '>\uFEFFtrue<'],
    ['central scalar inside', central, '>true<', '>tr\uFEFFue<'],
    ['central scalar after', central, '>true<', '>true\uFEFF<'],
    ['project scalar before', project, '>net10.0<', '>\uFEFFnet10.0<'],
    ['project scalar inside', project, '>net10.0<', '>net\uFEFF10.0<'],
    ['project scalar after', project, '>net10.0<', '>net10.0\uFEFF<'],
    ['central root before groups', central, '<Project>', '<Project>\uFEFF'],
    ['central root between groups', central, '</PropertyGroup>', '</PropertyGroup>\uFEFF'],
    ['central root after groups', central, '</ItemGroup>', '</ItemGroup>\uFEFF'],
    ['central properties before scalar', central, '<PropertyGroup>', '<PropertyGroup>\uFEFF'],
    ['central properties after scalar', central, '</ManagePackageVersionsCentrally>', '</ManagePackageVersionsCentrally>\uFEFF'],
    ['central items before packages', central, '<ItemGroup>', '<ItemGroup>\uFEFF'],
    ['central items between packages', central, '<PackageVersion Include="AngleSharp" Version="1.5.0" />', '<PackageVersion Include="AngleSharp" Version="1.5.0" />\uFEFF'],
    ['central items after packages', central, '</ItemGroup>', '\uFEFF</ItemGroup>'],
    ['central empty package text', central, '<PackageVersion Include="AngleSharp" Version="1.5.0" />', '<PackageVersion Include="AngleSharp" Version="1.5.0">\uFEFF</PackageVersion>'],
    ['project root before groups', project, '<Project Sdk="Microsoft.NET.Sdk">', '<Project Sdk="Microsoft.NET.Sdk">\uFEFF'],
    ['project root between groups', project, '</PropertyGroup>', '</PropertyGroup>\uFEFF'],
    ['project root after groups', project, '</Project>', '\uFEFF</Project>'],
    ['project properties before scalars', project, '<PropertyGroup>', '<PropertyGroup>\uFEFF'],
    ['project properties after scalars', project, '</ImplicitUsings>', '</ImplicitUsings>\uFEFF'],
    ['project items before packages', project, '<ItemGroup>\n    <PackageReference', '<ItemGroup>\uFEFF\n    <PackageReference'],
    ['project items between packages', project, '<PackageReference Include="AngleSharp" />', '<PackageReference Include="AngleSharp" />\uFEFF'],
    ['project items after packages', project, '<PackageReference Include="SqlSugarCoreNoDrive" />\n  </ItemGroup>', '<PackageReference Include="SqlSugarCoreNoDrive" />\n  \uFEFF</ItemGroup>'],
    ['project empty package text', project, '<PackageReference Include="AngleSharp" />', '<PackageReference Include="AngleSharp">\uFEFF</PackageReference>'],
    ['project empty reference text', project, '<ProjectReference Include="..\\shared\\FsusBlog.Shared.csproj" />', '<ProjectReference Include="..\\shared\\FsusBlog.Shared.csproj">\uFEFF</ProjectReference>']
];

function dispatchCurrentMsbuild(f)
{
    const source = fs.readFileSync(path.join(repository, 'tools/test-matrix/source-governance.mjs'), 'utf8');
    const start = source.indexOf('    const msbuildFiles = evidence.changedFiles.filter');
    const end = source.indexOf('    const solutions =', start);
    assert.ok(start > 0 && end > start);
    const context = { root: f.root, evidence: { changedFiles: [...msbuildSourceFiles],
        headCommit: f.git('rev-parse', 'HEAD').toString().trim() }, msbuildSourceFiles,
    inspectMsbuildSource, validateMsbuildSourceReceipt, process: { exitCode: 0 }, results: [], checkedMsbuild: [] };
    vm.runInNewContext(source.slice(start, end), context);
    return context;
}

for (const [index, [name, file, before, after]] of feffTextCases.entries())
{
    test(`XML whitespace P2 ${String(index + 1).padStart(2, '0')}: U+FEFF ${name} refuses inspection, reopen and dispatch`, t =>
    {
        const f = fixture(t);
        const originalReceipt = f.inspect();
        const source = original.get(file).toString();
        assert.equal(source.split(before).length, 2, 'the mutation must bind one original declaration');
        f.write(file, source.replace(before, after));
        const head = f.commit();
        assert.throws(() => f.inspect(), /unsupported MSBuild construct or value/u);
        // This is a real original-input receipt, not a constructed receipt for the
        // hostile input. Reopen must reject the XML before comparing stale fields.
        assert.throws(() => validateMsbuildSourceReceipt({ repositoryRoot: f.root,
            files: [...msbuildSourceFiles], expectedHead: head, receipt: originalReceipt }), /unsupported MSBuild construct or value/u);
        const actual = dispatchCurrentMsbuild(f);
        assert.equal(actual.process.exitCode, 1);
        assert.equal(actual.checkedMsbuild.length, 0);
        assert.equal(actual.results[0].status, 'failure');
        assert.equal(actual.results[0].qualificationEligible, false);
        assert.equal(actual.results[0].receipt, null);
        assert.match(actual.results[0].bindingError, /unsupported MSBuild construct or value/u);
        assert.deepEqual(unsupportedSourceStageFiles([...msbuildSourceFiles], [], [], [], [], actual.checkedMsbuild), [...msbuildSourceFiles]);
    });
}

// Complete ECMAScript trim whitespace outside XML 1.0 S. VT and FF are invalid
// XML; the other code points are valid characters but never XML whitespace.
const nonXmlTrimCodePoints = [0x000b, 0x000c, 0x00a0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];

test('XML whitespace rejects every JavaScript-trim-only character before, inside and after scalar text', t =>
{
    const f = fixture(t);
    for (const point of nonXmlTrimCodePoints)
    {
        const character = String.fromCodePoint(point);
        assert.equal(character.trim(), '', 'control must expose JavaScript trim semantics');
        for (const value of [`${character}true`, `tr${character}ue`, `true${character}`])
        {
            f.write(central, original.get(central).toString().replace('>true<', `>${value}<`));
            f.commit();
            assert.throws(() => f.inspect(), /unsupported MSBuild construct or value|MSBuild XML refused/u,
                `U+${point.toString(16).toUpperCase()} ${JSON.stringify(value)}`);
        }
    }
});

test('XML whitespace preserves exactly space, tab, CR and LF in both genuine supported input grammars', t =>
{
    const f = fixture(t);
    for (const approved of [false, true])
    {
        for (const whitespace of [' ', '\t', '\r', '\n', ' \t\r\n'])
        {
            for (const file of msbuildSourceFiles)
            {
                let source = original.get(file).toString();
                if (approved && file === central)
                {
                    source = source.replace('MessagePack" Version="2.5.301', 'MessagePack" Version="2.5.307');
                }
                if (approved && file === project)
                {
                    source = source.replace('<PackageReference Include="MySqlConnector"',
                        '<PackageReference Include="SQLitePCLRaw.lib.e_sqlite3" />\n    <PackageReference Include="MySqlConnector"');
                }
                source = source.replace(/>([^<]*)</gu, (match, value) => `>${whitespace}${value}${whitespace}<`);
                f.write(file, `${whitespace}${source}${whitespace}`);
            }
            const head = f.commit();
            const actual = f.inspect();
            assert.equal(actual.status, 'success');
            assert.equal(actual.qualificationEligible, false);
            assert.equal(actual.sources[0].packages.length, 47);
            assert.equal(actual.sources[0].packages.find(value => value.id === 'MessagePack').version,
                approved ? '2.5.307' : '2.5.301');
            assert.equal(actual.sources[1].packageReferences.includes('SQLitePCLRaw.lib.e_sqlite3'), approved);
            assert.deepEqual(validateMsbuildSourceReceipt({ repositoryRoot: f.root,
                files: [...msbuildSourceFiles], expectedHead: head, receipt: actual }), actual);
            const dispatched = dispatchCurrentMsbuild(f);
            assert.equal(dispatched.process.exitCode, 0);
            assert.deepEqual([...dispatched.checkedMsbuild], [...msbuildSourceFiles]);
        }
    }
});
