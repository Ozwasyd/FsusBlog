import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { inspectProjectSource, inspectPythonSource, inspectSolutionSource, validateProjectSourceReceipt, validatePythonSourceReceipt, validateSolutionSourceReceipt } from './check-solution-source.mjs';
const { sourceGovernanceChildEntries, unsupportedSourceStageFiles } = await import(new URL('../test-matrix/pr-impact-plan.mjs', import.meta.url));

function fixture(source, action)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-solution-source-'));
    try
    {
        const directory = path.join(root, 'tools/contracts');
        fs.mkdirSync(path.join(directory, 'Sample'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'Sample/Example.csproj'), '<Project />\n');
        fs.writeFileSync(path.join(directory, 'Sample.slnx'), source);
        const git = (...args) => execFileSync('git', ['-C', root, ...args],
            { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
        git('init', '--quiet');
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled solution source fixture\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        return action({ root, directory, git });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const valid = '<Solution>\n    <Project Path="Sample/Example.csproj" />\n</Solution>\n';
const inspect = root => inspectSolutionSource({ repositoryRoot: root, files: ['tools/contracts/Sample.slnx'] });

const projectFile = 'src/migration/Example.csproj';
const projectResources = ['tools/ci/reader.mjs', 'tools/ci/artifacts.mjs', 'tools/facts/identity.mjs', 'tools/facts/lib/canonicalize.mjs'];
const projectPackages = ['AngleSharp', 'Markdig', 'Microsoft.Data.Sqlite', 'MySqlConnector', 'Npgsql', 'SqlSugarCoreNoDrive', 'SQLitePCLRaw.lib.e_sqlite3'];
const validProject = `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup>
    <ItemGroup>${projectPackages.map(include => `<PackageReference Include="${include}" />`).join('')}</ItemGroup>
    <ItemGroup><ProjectReference Include="..\\shared\\Example.csproj" /></ItemGroup>
    <ItemGroup><AssemblyMetadata Include="FsusBlog.SourceCommit" Value="$(FsusBlogCommitSha)" />
        ${projectResources.map((file, index) => `<EmbeddedResource Include="../../${file}" LogicalName="Resource${index}" />`).join('')}
    </ItemGroup>
</Project>\n`;

function commitFixture(root, git)
{
    git('add', '.');
    const tree = git('write-tree').toString('utf8').trim();
    const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
        { input: 'controlled project XML source fixture\n', env: { ...process.env,
            GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
            GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
    git('update-ref', 'HEAD', commit);
}

function projectFixture(source, action)
{
    return fixture(valid, ({ root, git }) =>
    {
        const inputs = [[projectFile, source], ['src/shared/Example.csproj', '<Project />\n'],
            ...projectResources.map(file => [file, `// inert committed resource ${file}\n`])];
        for (const [file, bytes] of inputs)
        {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), bytes);
        }
        commitFixture(root, git);
        return action({ root, git });
    });
}

const inspectProject = root => inspectProjectSource({ repositoryRoot: root, files: [projectFile] });

test('finite project XML binds versionless packages opaque metadata and every literal physical input without evaluation', () =>
{
    projectFixture(validProject, ({ root, git }) =>
    {
        const before = { head: git('rev-parse', 'HEAD'), index: fs.readFileSync(path.join(root, '.git/index')),
            refs: git('show-ref'), status: git('status', '--porcelain=v1') };
        const actual = inspectProject(root);
        const project = actual.projects[0];
        assert.equal(actual.qualificationEligible, false);
        assert.equal(actual.parser.executable, fs.realpathSync('/usr/bin/python3'));
        assert.deepEqual(project.declaration.packages.map(value => value.include), projectPackages);
        assert.deepEqual(project.declaration.assemblyMetadata, [{ include: 'FsusBlog.SourceCommit', value: '$(FsusBlogCommitSha)' }]);
        assert.deepEqual(project.projectReferences.map(value => value.file), ['src/shared/Example.csproj']);
        assert.deepEqual(project.embeddedResources.map(value => value.file), projectResources);
        assert.ok([...project.projectReferences, ...project.embeddedResources].every(value => value.blob && value.sha256 && value.epoch.nlink === '1'));
        assert.deepEqual(git('rev-parse', 'HEAD'), before.head);
        assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), before.index);
        assert.deepEqual(git('show-ref'), before.refs);
        assert.deepEqual(git('status', '--porcelain=v1'), before.status);
        const checker = fileURLToPath(new URL('./check-solution-source.mjs', import.meta.url));
        const cli = spawnSync(process.execPath, [checker, '--language', 'project-xml', '--root', root, '--file', projectFile], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(cli.stdout), actual);
    });
});

test('project XML refuses malformed roots namespaces declarations aliases and executable MSBuild shapes', () =>
{
    const sources = ['<Project>', '<Solution />', validProject.replace(' Sdk="Microsoft.NET.Sdk"', ''),
        validProject.replace('Microsoft.NET.Sdk', '$(InjectedSdk)'), validProject.replace('<Project ', '<Project xmlns="urn:msbuild" '),
        `<!DOCTYPE Project [<!ENTITY injected SYSTEM "https://example.invalid/x">]>${validProject}`,
        `<?command run?>${validProject}`, validProject.replace('AngleSharp', 'Angle&#83;harp'),
        validProject.replace('<OutputType>Exe</OutputType>', '<OutputType><![CDATA[Exe]]></OutputType>'),
        validProject.replace('<PropertyGroup>', '<PropertyGroup Condition="true">'),
        validProject.replace('</Project>', '<Import Project="../../untrusted.targets" /></Project>'),
        validProject.replace('</Project>', '<UsingTask TaskName="Injected" AssemblyFile="remote.dll" /></Project>'),
        validProject.replace('</Project>', '<Target Name="Run"><Exec Command="touch executed-marker" /></Target></Project>'),
        validProject.replace('Include="AngleSharp"', 'Include="AngleSharp" Version="1.0"'),
        validProject.replace('Include="AngleSharp"', 'Include="AngleSharp" Condition="true"'),
        validProject.replace('<OutputType>Exe</OutputType>', '<UnknownProperty>value</UnknownProperty>'),
        validProject.replace('$(FsusBlogCommitSha)', '$([System.IO.File]::ReadAllText("secret"))')];
    for (const source of sources)
    {
        projectFixture(source, ({ root }) =>
        {
            assert.throws(() => inspectProject(root), /project XML source refused/u);
            assert.equal(fs.existsSync(path.join(root, 'executed-marker')), false);
        });
    }
});

test('predefined XML escapes remain inert scalar data while nested and duplicate declarations refuse', () =>
{
    projectFixture(validProject.replace('$(FsusBlogCommitSha)', 'literal&amp;value'), ({ root }) =>
        assert.equal(inspectProject(root).projects[0].declaration.assemblyMetadata[0].value, 'literal&value'));
    for (const replacement of ['<PackageReference Include="AngleSharp"><Version>1</Version></PackageReference>',
        '<PackageReference Include="AngleSharp" /><PackageReference Include="anglesharp" />'])
    {
        projectFixture(validProject.replace('<PackageReference Include="AngleSharp" />', replacement),
            ({ root }) => assert.throws(() => inspectProject(root), /project XML source refused/u));
    }
    for (const source of [validProject.replace('</PropertyGroup>', '<TargetFramework>net10.0</TargetFramework></PropertyGroup>'),
        validProject.replace('LogicalName="Resource1"', 'LogicalName="Resource0"'),
        validProject.replace('<ItemGroup><AssemblyMetadata', '<ItemGroup><AssemblyMetadata Include="FsusBlog.SourceCommit" Value="literal" /><AssemblyMetadata')])
    {
        projectFixture(source, ({ root }) => assert.throws(() => inspectProject(root), /project XML source refused/u));
    }
});

test('project references resolve literal parent segments and backslashes but refuse escape dynamic absolute glob and aliased paths', () =>
{
    for (const include of ['../../../outside.csproj', '/tmp/outside.csproj', 'C:\\outside.csproj', '\\\\host\\share.csproj',
        '$(Project).csproj', '@(Projects)', '../shared/*.csproj', '../shared//Example.csproj', './Example.csproj', '../migration/Example.csproj'])
    {
        projectFixture(validProject.replace('..\\shared\\Example.csproj', include),
            ({ root }) => assert.throws(() => inspectProject(root), /literal relative|escapes|references itself/u));
    }
    projectFixture(validProject.replace('</Project>', '<ItemGroup><ProjectReference Include="../shared/Example.csproj" /></ItemGroup></Project>'),
        ({ root }) => assert.throws(() => inspectProject(root), /duplicate or aliased/u));
    projectFixture(validProject.replace('../../tools/ci/reader.mjs', '../../../outside.mjs'),
        ({ root }) => assert.throws(() => inspectProject(root), /escapes/u));
});

test('project and every direct input require current regular single-link HEAD index and physical bytes', () =>
{
    for (const file of [projectFile, 'src/shared/Example.csproj', ...projectResources])
    {
        projectFixture(validProject, ({ root }) =>
        {
            fs.unlinkSync(path.join(root, file));
            assert.throws(() => inspectProject(root), /ENOENT/u);
        });
        projectFixture(validProject, ({ root }) =>
        {
            fs.appendFileSync(path.join(root, file), 'source drift');
            assert.throws(() => inspectProject(root), /HEAD\/index\/physical/u);
        });
        projectFixture(validProject, ({ root }) =>
        {
            fs.linkSync(path.join(root, file), path.join(root, 'hardlinked-alias'));
            assert.throws(() => inspectProject(root), /single-link/u);
        });
        projectFixture(validProject, ({ root }) =>
        {
            fs.renameSync(path.join(root, file), path.join(root, 'linked-target'));
            fs.symlinkSync(path.join(root, 'linked-target'), path.join(root, file));
            assert.throws(() => inspectProject(root), /ELOOP/u);
        });
    }
});

test('project source refuses linked input ancestors staged substitution modes and invalid UTF-8', () =>
{
    projectFixture(validProject, ({ root }) =>
    {
        fs.renameSync(path.join(root, 'tools/facts'), path.join(root, 'actual-facts'));
        fs.symlinkSync(path.join(root, 'actual-facts'), path.join(root, 'tools/facts'));
        assert.throws(() => inspectProject(root), /linked or non-directory ancestor/u);
    });
    projectFixture(validProject, ({ root, git }) =>
    {
        fs.appendFileSync(path.join(root, projectResources[0]), 'new staged bytes');
        git('add', projectResources[0]);
        assert.throws(() => inspectProject(root), /HEAD\/index\/physical/u);
    });
    projectFixture(validProject, ({ root }) =>
    {
        fs.chmodSync(path.join(root, projectFile), 0o755);
        assert.throws(() => inspectProject(root), /HEAD\/index\/physical/u);
    });
    projectFixture(Buffer.from([0xff]), ({ root }) => assert.throws(() => inspectProject(root), /not exact UTF-8/u));
});

test('project XML closed receipts reject missing extra substituted parser declaration and dependency evidence', () =>
{
    projectFixture(validProject, ({ root }) =>
    {
        const actual = inspectProject(root);
        const validate = receipt => validateProjectSourceReceipt({ repositoryRoot: root, files: [projectFile], expectedHead: actual.head, receipt });
        assert.deepEqual(validate(structuredClone(actual)), actual);
        const mutations = [
            value =>
            {
                value.head = '0'.repeat(40);
            },
            value =>
            {
                value.indexDigest = '0'.repeat(64);
            },
            value =>
            {
                value.projects[0].sha256 = '0'.repeat(64);
            },
            value =>
            {
                value.projects[0].declaration.packages.pop();
            },
            value =>
            {
                value.projects[0].declaration.assemblyMetadata[0].value = 'evaluated-value';
            },
            value =>
            {
                value.projects[0].embeddedResources.pop();
            },
            value =>
            {
                value.projects[0].embeddedResources[0].blob = '0'.repeat(40);
            },
            value =>
            {
                value.projects[0].projectReferences[0].file = 'src/shared/Substituted.csproj';
            },
            value =>
            {
                value.parser.sourceSha256 = '0'.repeat(64);
            },
            value =>
            {
                value.parser.version = '3.0.0 substituted';
            },
            value =>
            {
                value.limits.fileBytes = 0;
            },
            value =>
            {
                value.extra = true;
            },
            value =>
            {
                value.projects[0].extra = true;
            },
            value =>
            {
                value.projects[0].embeddedResources[0].extra = true;
            },
            value =>
            {
                value.qualificationEligible = true;
            }
        ];
        for (const mutate of mutations)
        {
            const receipt = structuredClone(actual);
            mutate(receipt);
            assert.throws(() => validate(receipt), /independent current source projection/u);
        }
        assert.throws(() => validate(null), /independent current source projection/u);
        assert.throws(() => validateProjectSourceReceipt({ repositoryRoot: root, files: [projectFile], receipt: actual }), /independent candidate HEAD/u);
        assert.throws(() => validateProjectSourceReceipt({ repositoryRoot: root, files: [projectFile], expectedHead: '0'.repeat(40), receipt: actual }), /independent current source projection/u);
    });
});

test('project source held descriptors catch dependency replacement during final Git recheck', () =>
{
    for (const replace of [false, true])
    {
        projectFixture(validProject, ({ root }) =>
        {
            const original = childProcess.execFileSync;
            let indexReads = 0;
            childProcess.execFileSync = (command, args, options) =>
            {
                if (command === 'git' && args.includes('ls-files') && !args.includes('--') && ++indexReads === 2)
                {
                    const input = path.join(root, projectResources[0]);
                    if (replace)
                    {
                        fs.renameSync(input, `${input}.original`);
                    }
                    fs.writeFileSync(input, 'replacement bytes');
                }
                return original(command, args, options);
            };
            syncBuiltinESMExports();
            try
            {
                assert.throws(() => inspectProject(root), /identity changed during inspection/u);
                assert.equal(indexReads, 2);
            }
            finally
            {
                childProcess.execFileSync = original;
                syncBuiltinESMExports();
            }
        });
    }
});

test('project XML applies source structure file and batch limits before admitting inputs', () =>
{
    for (const [source, error] of [[Buffer.alloc(1024 * 1024 + 1, 32), /bounded file size/u],
        [validProject.replace('</Project>', '<ItemGroup>'.repeat(5) + '</ItemGroup>'.repeat(5) + '</Project>'), /bounded declaration structure/u],
        [validProject.replace('</Project>', '<ItemGroup />'.repeat(4096) + '</Project>'), /bounded declaration structure/u]])
    {
        projectFixture(source, ({ root }) => assert.throws(() => inspectProject(root), error));
    }
    projectFixture(validProject, ({ root, git }) =>
    {
        for (const file of projectResources)
        {
            fs.writeFileSync(path.join(root, file), Buffer.alloc(1024 * 1024, 32));
        }
        const projects = Array.from({ length: 5 }, (_, index) => `src/migration/Extra${index}.csproj`);
        for (const file of projects)
        {
            fs.writeFileSync(path.join(root, file), validProject + ' '.repeat(1024 * 1024 - Buffer.byteLength(validProject)));
        }
        commitFixture(root, git);
        assert.throws(() => inspectProjectSource({ repositoryRoot: root, files: projects }), /bounded file size/u);
    });
});

function executeProjectSourceRoute(root, expectedHead, worker)
{
    const source = fs.readFileSync(new URL('../test-matrix/source-governance.mjs', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('    const projectFiles ='), source.indexOf('    for (const file of files.filter(value => value.endsWith(\'.sh\')))'));
    const state = { files: [projectFile], root, evidence: { headCommit: expectedHead }, results: [], checkedProjects: [],
        process: { execPath: process.execPath, exitCode: 0 }, JSON, sourceGovernanceChildEntries, validateProjectSourceReceipt,
        verifyChildBeforeSpawn: checker => assert.equal(checker, sourceGovernanceChildEntries.solution), spawnSync: worker };
    vm.runInNewContext(block, state);
    return state;
}

test('the original SOURCE caller admits only independently reopened project receipts and keeps every rejected project unsupported', () =>
{
    projectFixture(validProject, ({ root }) =>
    {
        const actual = inspectProject(root);
        const successful = { status: 0, stdout: JSON.stringify(actual), stderr: '' };
        const accepted = executeProjectSourceRoute(root, actual.head, (_command, args) =>
        {
            assert.deepEqual([...args.slice(1)], ['--language', 'project-xml', '--root', root, '--file', projectFile]);
            return successful;
        });
        assert.deepEqual([...accepted.checkedProjects], [projectFile]);
        assert.deepEqual(unsupportedSourceStageFiles([projectFile], [], [], accepted.checkedProjects), []);
        const extra = structuredClone(actual);
        extra.projects[0].extra = true;
        for (const output of [{ ...successful, stdout: '{}' }, { ...successful, stdout: JSON.stringify(extra) },
            { ...successful, status: 1 }, { ...successful, error: new Error('spawn refused') }])
        {
            const rejected = executeProjectSourceRoute(root, actual.head, () => output);
            assert.equal(rejected.process.exitCode, 1);
            assert.equal(rejected.checkedProjects.length, 0);
            assert.equal(rejected.results[0].status, 'failure');
            assert.deepEqual(unsupportedSourceStageFiles([projectFile], [], [], rejected.checkedProjects), [projectFile]);
        }
        const stale = executeProjectSourceRoute(root, '0'.repeat(40), () => successful);
        assert.equal(stale.checkedProjects.length, 0);
        assert.equal(stale.process.exitCode, 1);
    });
});

test('project parser refuses forged worker output and releases descriptors after refusal', () =>
{
    projectFixture(validProject, ({ root }) =>
    {
        const original = childProcess.spawnSync;
        const before = fs.readdirSync('/proc/self/fd').length;
        childProcess.spawnSync = (...args) =>
        {
            const result = original(...args);
            const parsed = JSON.parse(result.stdout);
            parsed.extra = true;
            return { ...result, stdout: JSON.stringify(parsed) };
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspectProject(root), /worker output/u);
            assert.equal(fs.readdirSync('/proc/self/fd').length, before);
        }
        finally
        {
            childProcess.spawnSync = original;
            syncBuiltinESMExports();
        }
        assert.equal(inspectProject(root).status, 'success');
    });
});

test('project inspection refuses duplicate caller files and alternate Git context before parsing', () =>
{
    projectFixture(validProject, ({ root }) =>
    {
        assert.throws(() => inspectProjectSource({ repositoryRoot: root, files: [projectFile, projectFile] }), /distinct explicit/u);
        assert.throws(() => inspectProjectSource({ repositoryRoot: root, files: ['../Example.csproj'] }), /normalized relative/u);
        const before = process.env.GIT_INDEX_FILE;
        process.env.GIT_INDEX_FILE = path.join(root, 'alternate-index');
        try
        {
            assert.throws(() => inspectProject(root), /ambient alternate Git/u);
        }
        finally
        {
            if (before === undefined)
            {
                delete process.env.GIT_INDEX_FILE;
            }
            else
            {
                process.env.GIT_INDEX_FILE = before;
            }
        }
    });
});

test('flat solution inspection binds actual project source without evaluating it', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        const result = inspect(root);
        assert.equal(result.status, 'success');
        assert.equal(result.qualificationEligible, false);
        assert.equal(result.solutions.length, 1);
        assert.deepEqual(result.solutions[0].projects.map(value => value.file), ['tools/contracts/Sample/Example.csproj']);
        assert.equal(result.solutions[0].projects[0].bytes, 12);
        assert.ok(result.parser.sha256);
        assert.deepEqual(fs.readdirSync(path.join(directory, 'Sample')), ['Example.csproj']);
    });
});

test('malformed XML and declarations or external entities are refused', () =>
{
    for (const source of ['<Solution><Project Path="Sample/Example.csproj"></Solution>',
        '<!DOCTYPE Solution><Solution><Project Path="Sample/Example.csproj" /></Solution>',
        '<!DOCTYPE Solution [<!ENTITY file SYSTEM "file:///etc/passwd">]><Solution>&file;</Solution>'])
    {
        fixture(source, ({ root }) => assert.throws(() => inspect(root), /solution XML refused/u));
    }
});

test('numeric predefined entity aliases and processing instructions cannot become literal project paths', () =>
{
    for (const value of ['Sample&#47;Example.csproj', 'Sample&#x2f;Example.csproj',
        'Sample/Example&apos;.csproj', 'Sample/Example&amp;.csproj'])
    {
        fixture(`<Solution><Project Path="${value}" /></Solution>`,
            ({ root }) => assert.throws(() => inspect(root), /source entity references/u));
    }
    fixture('<?command ignored?><Solution><Project Path="Sample/Example.csproj" /></Solution>',
        ({ root }) => assert.throws(() => inspect(root), /processing instructions/u));
});

test('source admission compares the closed complete receipt against independent current HEAD and bindings', () =>
{
    fixture(valid, ({ root }) =>
    {
        const actual = inspect(root);
        const validate = receipt => validateSolutionSourceReceipt({ repositoryRoot: root,
            files: ['tools/contracts/Sample.slnx'], expectedHead: actual.head, receipt });
        assert.deepEqual(validate(JSON.parse(JSON.stringify(actual))), actual);
        const mutations = [
            value =>
            {
                value.head = '0'.repeat(40);
            },
            value =>
            {
                value.indexDigest = '0'.repeat(64);
            },
            value =>
            {
                value.solutions[0].sha256 = '0'.repeat(64);
            },
            value =>
            {
                value.solutions[0].projects[0].file = 'tools/contracts/Alias.csproj';
            },
            value =>
            {
                value.solutions[0].projects = [];
            },
            value =>
            {
                value.uncheckedField = true;
            },
            value =>
            {
                value.solutions[0].projects[0].uncheckedField = true;
            }
        ];
        for (const mutate of mutations)
        {
            const receipt = JSON.parse(JSON.stringify(actual));
            mutate(receipt);
            assert.throws(() => validate(receipt), /independent current source projection/u);
        }
        assert.throws(() => validateSolutionSourceReceipt({ repositoryRoot: root,
            files: ['tools/contracts/Sample.slnx'], expectedHead: '0'.repeat(40), receipt: actual }),
        /independent current source projection/u);
        assert.throws(() => validateSolutionSourceReceipt({ repositoryRoot: root,
            files: ['tools/contracts/Sample.slnx'], receipt: actual }), /independent candidate HEAD/u);
    });
});

test('unknown elements attributes nested structures and text remain unsupported', () =>
{
    for (const source of ['<Solution Version="1"><Project Path="Sample/Example.csproj" /></Solution>',
        '<Solution><Folder><Project Path="Sample/Example.csproj" /></Folder></Solution>',
        '<Solution><Project Path="Sample/Example.csproj" Type="test" /></Solution>',
        '<Solution>unexpected<Project Path="Sample/Example.csproj" /></Solution>'])
    {
        fixture(source, ({ root }) => assert.throws(() => inspect(root), /solution XML refused/u));
    }
});

test('escaping substituted and duplicate project paths cannot receive source coverage', () =>
{
    for (const project of ['../Example.csproj', '/tmp/Example.csproj', 'Sample\\Example.csproj',
        '$(Project).csproj', 'Sample//Example.csproj'])
    {
        fixture(`<Solution><Project Path="${project}" /></Solution>`,
            ({ root }) => assert.throws(() => inspect(root), /normalized relative/u));
    }
    fixture('<Solution><Project Path="Sample/Example.csproj" /><Project Path="Sample/Example.csproj" /></Solution>',
        ({ root }) => assert.throws(() => inspect(root), /duplicate project/u));
});

test('missing linked and uncommitted project sources are refused', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        fs.unlinkSync(path.join(directory, 'Sample/Example.csproj'));
        assert.throws(() => inspect(root), /ENOENT/u);
    });
    fixture(valid, ({ root, directory }) =>
    {
        const project = path.join(directory, 'Sample/Example.csproj');
        fs.renameSync(project, path.join(directory, 'other.csproj'));
        fs.symlinkSync('../other.csproj', project);
        assert.throws(() => inspect(root), /ELOOP/u);
    });
    fixture(valid, ({ root, directory }) =>
    {
        fs.appendFileSync(path.join(directory, 'Sample/Example.csproj'), 'changed');
        assert.throws(() => inspect(root), /HEAD\/index\/physical/u);
    });
});

test('linked ancestors and hardlinked project aliases are refused', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        fs.renameSync(path.join(directory, 'Sample'), path.join(directory, 'Actual'));
        fs.symlinkSync('Actual', path.join(directory, 'Sample'));
        assert.throws(() => inspect(root), /linked or non-directory ancestor/u);
    });
    fixture(valid, ({ root, directory }) =>
    {
        fs.linkSync(path.join(directory, 'Sample/Example.csproj'), path.join(directory, 'Alias.csproj'));
        assert.throws(() => inspect(root), /single-link/u);
    });
});

test('the solution itself and exact caller arguments cannot be replaced by declarations', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        fs.appendFileSync(path.join(directory, 'Sample.slnx'), 'changed');
        assert.throws(() => inspect(root), /HEAD\/index\/physical/u);
        assert.throws(() => inspectSolutionSource({ repositoryRoot: root, files: ['../Sample.slnx'] }), /normalized relative/u);
        const checker = fileURLToPath(new URL('./check-solution-source.mjs', import.meta.url));
        const result = spawnSync(process.execPath, [checker, '--root', root, '--file', 'tools/contracts/Sample.slnx', '--write'],
            { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /accepts only/u);
    });
});

test('a source change during the final Git binding recheck is refused through the held descriptor', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        const original = childProcess.execFileSync;
        let indexReads = 0;
        childProcess.execFileSync = (command, args, options) =>
        {
            if (command === 'git' && args.includes('ls-files') && !args.includes('--'))
            {
                indexReads += 1;
                if (indexReads === 2)
                {
                    fs.appendFileSync(path.join(directory, 'Sample/Example.csproj'), 'drift');
                }
            }
            return original(command, args, options);
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspect(root), /identity changed during inspection/u);
            assert.equal(indexReads, 2);
        }
        finally
        {
            childProcess.execFileSync = original;
            syncBuiltinESMExports();
        }
    });
});

function pythonFixture(source, action)
{
    return fixture(valid, ({ root, directory, git }) =>
    {
        const file = 'tools/contracts/Sample/Example.py';
        fs.writeFileSync(path.join(root, file), source);
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled Python AST source fixture\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        return action({ root, directory, git, file });
    });
}

const inspectPython = (root, file) => inspectPythonSource({ repositoryRoot: root, files: [file] });

test('Python AST syntax does not execute imports bodies bytecode or lifecycle', () =>
{
    pythonFixture('import nonexistent_source_dependency\nraise RuntimeError("never executed")\n', ({ root, directory, git, file }) =>
    {
        const source = path.join(root, file);
        fs.appendFileSync(source, `open(${JSON.stringify(path.join(directory, 'marker'))}, "w").write("executed")\n`);
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled marker source\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        const before = { head: git('rev-parse', 'HEAD'), index: fs.readFileSync(path.join(root, '.git/index')),
            refs: git('show-ref'), status: git('status', '--porcelain=v1') };
        const result = inspectPython(root, file);
        assert.equal(result.status, 'success');
        assert.equal(result.qualificationEligible, false);
        assert.equal(result.sources[0].file, file);
        assert.equal(result.sources[0].bytes, fs.statSync(source).size);
        assert.equal(result.parser.executable, fs.realpathSync('/usr/bin/python3'));
        assert.match(result.parser.version, /^3\.\d+\.\d+ /u);
        assert.match(result.parser.sha256, /^[a-f0-9]{64}$/u);
        assert.deepEqual(fs.readdirSync(path.join(directory, 'Sample')), ['Example.csproj', 'Example.py']);
        assert.equal(fs.existsSync(path.join(directory, 'marker')), false);
        assert.deepEqual(git('rev-parse', 'HEAD'), before.head);
        assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), before.index);
        assert.deepEqual(git('show-ref'), before.refs);
        assert.deepEqual(git('status', '--porcelain=v1'), before.status);
        const checker = fileURLToPath(new URL('./check-solution-source.mjs', import.meta.url));
        const cli = spawnSync(process.execPath, [checker, '--language', 'python-ast', '--root', root, '--file', file],
            { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(cli.stdout), result);
    });
});

test('Python AST refuses malformed UTF-8 syntax and bounded input overflow', () =>
{
    for (const [source, error] of [[Buffer.from([0xff]), /not exact UTF-8/u],
        ['def invalid(:\n', /Python AST source refused/u],
        [Buffer.alloc(1024 * 1024 + 1, 32), /bounded file size/u]])
    {
        pythonFixture(source, ({ root, file }) => assert.throws(() => inspectPython(root, file), error));
    }
});

test('Python AST reuses regular single-link source HEAD index and path refusals', () =>
{
    const source = 'value = 1\n';
    pythonFixture(source, ({ root, directory, file }) =>
    {
        const target = path.join(root, file);
        fs.renameSync(target, path.join(directory, 'Actual.py'));
        fs.symlinkSync('../Actual.py', target);
        assert.throws(() => inspectPython(root, file), /ELOOP/u);
    });
    pythonFixture(source, ({ root, directory, file }) =>
    {
        fs.renameSync(path.join(directory, 'Sample'), path.join(directory, 'Actual'));
        fs.symlinkSync('Actual', path.join(directory, 'Sample'));
        assert.throws(() => inspectPython(root, file), /linked or non-directory ancestor/u);
    });
    pythonFixture(source, ({ root, directory, file }) =>
    {
        fs.linkSync(path.join(root, file), path.join(directory, 'Alias.py'));
        assert.throws(() => inspectPython(root, file), /single-link/u);
    });
    pythonFixture(source, ({ root, file }) =>
    {
        fs.appendFileSync(path.join(root, file), 'changed');
        assert.throws(() => inspectPython(root, file), /HEAD\/index\/physical/u);
        assert.throws(() => inspectPython(root, '../Example.py'), /normalized relative/u);
        assert.throws(() => inspectPythonSource({ repositoryRoot: root, files: [file, file] }), /distinct explicit/u);
    });
});

test('Python AST receipt cannot substitute HEAD source parser version limits or extra output', () =>
{
    pythonFixture('value = 1\n', ({ root, file }) =>
    {
        const actual = inspectPython(root, file);
        const validate = receipt => validatePythonSourceReceipt({ repositoryRoot: root,
            files: [file], expectedHead: actual.head, receipt });
        assert.deepEqual(validate(JSON.parse(JSON.stringify(actual))), actual);
        const mutations = [
            value =>
            {
                value.head = '0'.repeat(40);
            },
            value =>
            {
                value.indexDigest = '0'.repeat(64);
            },
            value =>
            {
                value.sources = [];
            },
            value =>
            {
                value.sources[0].sha256 = '0'.repeat(64);
            },
            value =>
            {
                value.sources[0].mode = '100755';
            },
            value =>
            {
                value.parser.version = '3.0.0 foreign';
            },
            value =>
            {
                value.parser.sourceSha256 = '0'.repeat(64);
            },
            value =>
            {
                value.limits.timeoutMs = 0;
            },
            value =>
            {
                value.extra = true;
            },
            value =>
            {
                value.sources[0].extra = true;
            }
        ];
        for (const mutate of mutations)
        {
            const changed = JSON.parse(JSON.stringify(actual));
            mutate(changed);
            assert.throws(() => validate(changed), /independent current source projection/u);
        }
        assert.throws(() => validatePythonSourceReceipt({ repositoryRoot: root, files: [file],
            expectedHead: '0'.repeat(40), receipt: actual }), /independent current source projection/u);
        assert.throws(() => validatePythonSourceReceipt({ repositoryRoot: root, files: [file], receipt: actual }), /independent candidate HEAD/u);
    });
});

test('Python AST held descriptor refuses input replacement during the final index recheck', () =>
{
    for (const replace of [false, true])
    {
        pythonFixture('value = 1\n', ({ root, file }) =>
        {
            const original = childProcess.execFileSync;
            let indexReads = 0;
            childProcess.execFileSync = (command, args, options) =>
            {
                if (command === 'git' && args.includes('ls-files') && !args.includes('--'))
                {
                    indexReads += 1;
                    if (indexReads === 2)
                    {
                        if (replace)
                        {
                            fs.renameSync(path.join(root, file), path.join(root, `${file}.original`));
                        }
                        fs.writeFileSync(path.join(root, file), 'value = 2\n');
                    }
                }
                return original(command, args, options);
            };
            syncBuiltinESMExports();
            try
            {
                assert.throws(() => inspectPython(root, file), /identity changed during inspection/u);
                assert.equal(indexReads, 2);
            }
            finally
            {
                childProcess.execFileSync = original;
                syncBuiltinESMExports();
            }
        });
    }
});

test('Python AST fixed worker refuses added fields and ignores caller Python import paths', () =>
{
    pythonFixture('value = 1\n', ({ root, directory, file }) =>
    {
        const original = childProcess.spawnSync;
        childProcess.spawnSync = (...args) =>
        {
            const result = original(...args);
            if (args[0] === fs.realpathSync('/usr/bin/python3'))
            {
                const parsed = JSON.parse(result.stdout);
                parsed.extra = true;
                result.stdout = JSON.stringify(parsed);
            }
            return result;
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspectPython(root, file), /worker output/u);
        }
        finally
        {
            childProcess.spawnSync = original;
            syncBuiltinESMExports();
        }
        fs.writeFileSync(path.join(directory, 'ast.py'), 'raise RuntimeError("foreign import must not run")\n');
        const previous = process.env.PYTHONPATH;
        process.env.PYTHONPATH = directory;
        try
        {
            assert.equal(inspectPython(root, file).status, 'success');
            assert.equal(fs.existsSync(path.join(directory, '__pycache__')), false);
        }
        finally
        {
            if (previous === undefined)
            {
                delete process.env.PYTHONPATH;
            }
            else
            {
                process.env.PYTHONPATH = previous;
            }
        }
    });
});

test('Python AST bounded FD reader refuses growth after the small initial stat without reading beyond cap plus one', () =>
{
    pythonFixture('value = 1\n', ({ root, file }) =>
    {
        const target = path.join(root, file);
        const sourceStat = fs.statSync(target, { bigint: true });
        const limit = 1024 * 1024;
        const originalStat = fs.fstatSync;
        const originalRead = fs.readSync;
        const originalReadFile = fs.readFileSync;
        const originalSpawn = childProcess.spawnSync;
        let descriptor = null;
        let initialSize = null;
        let grew = false;
        let requested = 0;
        let returned = 0;
        let workerSpawns = 0;
        fs.fstatSync = (actual, options) =>
        {
            const result = originalStat(actual, options);
            if (options?.bigint && result.dev === sourceStat.dev && result.ino === sourceStat.ino)
            {
                descriptor = actual;
                initialSize = result.size;
            }
            return result;
        };
        fs.readSync = (actual, buffer, offset, length, position) =>
        {
            if (actual === descriptor)
            {
                if (!grew)
                {
                    fs.truncateSync(target, limit + 32);
                    grew = true;
                }
                requested += length;
            }
            const count = originalRead(actual, buffer, offset, length, position);
            if (actual === descriptor)
            {
                returned += count;
            }
            return count;
        };
        fs.readFileSync = (actual, ...args) =>
        {
            assert.notEqual(actual, descriptor, 'bounded Python source must not use an unbounded FD read');
            return originalReadFile(actual, ...args);
        };
        childProcess.spawnSync = (...args) =>
        {
            workerSpawns += 1;
            return originalSpawn(...args);
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspectPython(root, file), /bounded file size/u);
            assert.equal(initialSize, sourceStat.size);
            assert.ok(initialSize < BigInt(limit));
            assert.equal(grew, true);
            assert.equal(requested, limit + 1);
            assert.equal(returned, limit + 1);
            assert.equal(workerSpawns, 0);
            assert.throws(() => originalStat(descriptor), /EBADF/u);
        }
        finally
        {
            fs.fstatSync = originalStat;
            fs.readSync = originalRead;
            fs.readFileSync = originalReadFile;
            childProcess.spawnSync = originalSpawn;
            syncBuiltinESMExports();
        }
    });
});

test('Python AST batch budget refuses the next committed source before reading or parsing beyond eight MiB', () =>
{
    pythonFixture('value = 1\n', ({ root, directory, git, file }) =>
    {
        const files = [];
        const buffer = Buffer.alloc(64 * 1024, 35);
        for (let index = 0; index < 8; index += 1)
        {
            const name = `tools/contracts/Sample/Bounded${index}.py`;
            files.push(name);
            const descriptor = fs.openSync(path.join(root, name), 'wx');
            try
            {
                for (let chunk = 0; chunk < 16; chunk += 1)
                {
                    fs.writeSync(descriptor, buffer);
                }
            }
            finally
            {
                fs.closeSync(descriptor);
            }
        }
        files.push(file);
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled bounded Python batch fixture\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        const inodes = new Set(files.map(value => fs.statSync(path.join(root, value), { bigint: true }).ino));
        const originalStat = fs.fstatSync;
        const originalRead = fs.readSync;
        const originalSpawn = childProcess.spawnSync;
        const descriptors = new Set();
        let returned = 0;
        let workerSpawns = 0;
        fs.fstatSync = (actual, options) =>
        {
            const result = originalStat(actual, options);
            if (options?.bigint && inodes.has(result.ino))
            {
                descriptors.add(actual);
            }
            return result;
        };
        fs.readSync = (actual, ...args) =>
        {
            const count = originalRead(actual, ...args);
            if (descriptors.has(actual))
            {
                returned += count;
            }
            return count;
        };
        childProcess.spawnSync = (...args) =>
        {
            workerSpawns += 1;
            return originalSpawn(...args);
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspectPythonSource({ repositoryRoot: root, files }), /bounded file size/u);
            assert.equal(returned, 8 * 1024 * 1024);
            assert.equal(workerSpawns, 8);
            assert.equal(fs.existsSync(path.join(directory, 'Sample/__pycache__')), false);
        }
        finally
        {
            fs.fstatSync = originalStat;
            fs.readSync = originalRead;
            childProcess.spawnSync = originalSpawn;
            syncBuiltinESMExports();
        }
    });
});
