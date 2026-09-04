import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function commandOutput(result)
{
    return `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim();
}

function runRequired(command, args, options)
{
    const result = spawnSync(command, args, {
        ...options,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'spawn'}): ${commandOutput(result)}`);
    }
    return result;
}

function runAdapter(adapterAssembly, repositoryRoot, projectPath, environment)
{
    const result = spawnSync('dotnet', [adapterAssembly, repositoryRoot, projectPath], {
        cwd: repositoryRoot,
        env: environment,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024
    });
    let report;
    try
    {
        report = JSON.parse(result.stdout);
    }
    catch (error)
    {
        throw new Error(`xunit fixture adapter output is not JSON: ${commandOutput(result)}`, { cause: error });
    }
    return { status: result.status, report, stderr: result.stderr };
}

export function exerciseXunitProjectGraphFixture({ repositoryRoot, adapterAssembly, buildRoot })
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'fsus-xunit-project-graph-'));
    const checkoutRoot = path.join(fixtureRoot, 'repository');
    try
    {
        const sourceCommit = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
            encoding: 'utf8'
        }).trim();
        runRequired('git', [
            'clone', '--quiet', '--shared', '--no-checkout', repositoryRoot, checkoutRoot
        ], { cwd: repositoryRoot });
        runRequired('git', [
            '-C', checkoutRoot, 'checkout', '--quiet', '--detach', sourceCommit
        ], { cwd: repositoryRoot });

        const projectPath = path.join(checkoutRoot, 'tests/backend/FsusBlog.Server.Tests.csproj');
        const projectSource = readFileSync(projectPath, 'utf8');
        const fixtureDependencyRoot = path.join(checkoutRoot, '.tmp/xunit-lock-graph-fixture');
        const fixtureDependencyProject = path.join(fixtureDependencyRoot, 'LockGraphFixtureDependency.csproj');
        mkdirSync(fixtureDependencyRoot, { recursive: true });
        writeFileSync(fixtureDependencyProject, `\
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
</Project>
`);
        const staleGraphItem = `\

  <ItemGroup Condition="'$(FsusBlogLockGraphFixture)' != 'stale'">
    <ProjectReference Include="${fixtureDependencyProject}" />
  </ItemGroup>
`;
        writeFileSync(projectPath, projectSource.replace(/\s*<\/Project>\s*$/u, `${staleGraphItem}\n</Project>\n`));

        const environment = {
            ...process.env,
            CI: 'false',
            GITHUB_ACTIONS: 'false',
            FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot
        };
        const restoreArguments = [
            'restore', projectPath,
            '--disable-build-servers',
            '-v:minimal',
            '/p:NuGetAudit=false'
        ];
        runRequired('dotnet', [
            ...restoreArguments,
            '--force-evaluate',
            '/p:RestoreLockedMode=false',
            '/p:FsusBlogLockGraphFixture=stale'
        ], { cwd: checkoutRoot, env: environment });

        const staleLockedRestore = spawnSync('dotnet', [
            ...restoreArguments,
            '--locked-mode'
        ], {
            cwd: checkoutRoot,
            env: environment,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024
        });

        const regeneratedRestore = runRequired('dotnet', [
            ...restoreArguments,
            '--force-evaluate',
            '/p:RestoreLockedMode=false'
        ], { cwd: checkoutRoot, env: environment });
        const currentLockedRestore = runRequired('dotnet', [
            ...restoreArguments,
            '--locked-mode'
        ], { cwd: checkoutRoot, env: environment });
        const build = runRequired('dotnet', [
            'build', projectPath,
            '--configuration', 'Debug',
            '--no-restore',
            '--disable-build-servers',
            '-m:1',
            '-v:minimal',
            '/p:NuGetAudit=false'
        ], { cwd: checkoutRoot, env: environment });

        const current = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);
        const probePath = path.join(checkoutRoot, 'tests/backend/XunitSemanticStaleMemberProbeTests.cs');
        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed class XunitSemanticStaleMemberProbeTests
{
    [Fact]
    public void StaticMemberMustResolve()
    {
        _ = string.DoesNotExist;
    }
}
`);
        const cs0117 = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed class XunitSemanticStaleMemberProbeTests
{
    [Fact]
    public void InstanceMemberMustResolve()
    {
        _ = string.Empty.DoesNotExist;
    }
}
`);
        const cs1061 = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);

        return {
            sourceCommit,
            staleLockedRestore: {
                status: staleLockedRestore.status,
                output: commandOutput(staleLockedRestore)
            },
            regeneratedRestoreStatus: regeneratedRestore.status,
            currentLockedRestoreStatus: currentLockedRestore.status,
            buildStatus: build.status,
            currentInventory: {
                status: current.status,
                testCaseCount: current.report.testCases?.length ?? 0,
                errorDiagnostics: (current.report.diagnostics ?? []).filter((entry) => entry.severity === 'error'),
                hasRuntimeRollupCase: (current.report.testCases ?? []).some((entry) => (
                    entry.ownerFile === 'tests/backend/Unit/CurrentSchemaRuntimeRollupTablesTests.cs'
                    && entry.methodName === 'RuntimeRollupCatalog_MatchesPostCodeFirstEnsureTableSteps'
                ))
            },
            cs0117,
            cs1061
        };
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}
