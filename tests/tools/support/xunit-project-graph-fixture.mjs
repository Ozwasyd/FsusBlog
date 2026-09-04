import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

[global::System.AttributeUsage(global::System.AttributeTargets.Method)]
public sealed class GeneratedRegexAttribute : global::System.Attribute
{
}

public sealed partial class XunitSemanticStaleMemberProbeTests
{
    [GeneratedRegex]
    public static partial global::System.Text.RegularExpressions.Regex ShadowedGeneratedRegex();

    [Fact]
    public void ShadowAttributeMustNotSuppressCompilerErrors()
    {
        _ = ShadowedGeneratedRegex();
    }
}
`);
        const shadowGeneratedRegex = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed partial class XunitSemanticStaleMemberProbeTests
{
    [global::System.Text.RegularExpressions.GeneratedRegex("probe")]
    public static partial global::System.Text.RegularExpressions.Regex InvalidGeneratedRegex(string value);

    [Fact]
    public void InvalidGeneratedRegexSignatureMustNotSuppressCompilerErrors()
    {
        _ = InvalidGeneratedRegex("probe");
    }
}
`);
        const invalidGeneratedRegexSignature = runAdapter(
            adapterAssembly,
            checkoutRoot,
            projectPath,
            environment
        );

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed partial class XunitSemanticStaleMemberProbeTests
{
    [global::System.Text.RegularExpressions.GeneratedRegex("probe")]
    public static partial global::System.Text.RegularExpressions.Regex ValidGeneratedRegex();

    [Fact]
    public void OtherCompilerErrorsRemainFatal()
    {
        _ = ValidGeneratedRegex();
        _ = string.DoesNotExist;
    }
}
`);
        const generatedRegexWithOtherError = runAdapter(
            adapterAssembly,
            checkoutRoot,
            projectPath,
            environment
        );

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed partial class XunitSemanticStaleMemberProbeTests
{
    [global::System.Text.RegularExpressions.GeneratedRegex("probe")]
    public static partial ref global::System.Text.RegularExpressions.Regex RefGeneratedRegex();

    [Fact]
    public void RefGeneratedRegexReturnMustNotSuppressCompilerErrors()
    {
        _ = RefGeneratedRegex();
    }
}
`);
        const refGeneratedRegex = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed partial class XunitSemanticStaleMemberProbeTests
{
    [global::System.Text.RegularExpressions.GeneratedRegex("probe")]
    public static partial ref readonly global::System.Text.RegularExpressions.Regex RefReadonlyGeneratedRegex();

    [Fact]
    public void RefReadonlyGeneratedRegexReturnMustNotSuppressCompilerErrors()
    {
        _ = RefReadonlyGeneratedRegex();
    }
}
`);
        const refReadonlyGeneratedRegex = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed partial class XunitSemanticStaleMemberProbeTests
{
    [global::System.Text.RegularExpressions.GeneratedRegex("(")]
    public static partial global::System.Text.RegularExpressions.Regex InvalidPatternGeneratedRegex();

    [Fact]
    public void InvalidGeneratedRegexPatternFailsClosed()
    {
        _ = InvalidPatternGeneratedRegex();
    }
}
`);
        const invalidGeneratedRegexPattern = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);

        writeFileSync(probePath, `\
namespace FsusBlog.Server.Tests;

public sealed partial class XunitSemanticStaleMemberProbeTests
{
    [global::System.Text.RegularExpressions.GeneratedRegex(
        "probe",
        global::System.Text.RegularExpressions.RegexOptions.None,
        -2)]
    public static partial global::System.Text.RegularExpressions.Regex InvalidTimeoutGeneratedRegex();

    [Fact]
    public void InvalidGeneratedRegexTimeoutFailsClosed()
    {
        _ = InvalidTimeoutGeneratedRegex();
    }
}
`);
        const invalidGeneratedRegexTimeout = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);

        const fakeAssemblyRoot = path.join(fixtureRoot, 'fake-system-text-regular-expressions');
        const fakeAssemblyOutput = path.join(fakeAssemblyRoot, 'output');
        mkdirSync(fakeAssemblyRoot, { recursive: true });
        writeFileSync(path.join(fakeAssemblyRoot, 'FakeSystemTextRegularExpressions.csproj'), `\
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <AssemblyName>System.Text.RegularExpressions</AssemblyName>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <NoWarn>CS0436</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="FakeTypes.cs" />
  </ItemGroup>
</Project>
`);
        writeFileSync(path.join(fakeAssemblyRoot, 'FakeTypes.cs'), `\
namespace System.Text.RegularExpressions;

[global::System.AttributeUsage(global::System.AttributeTargets.Method)]
public sealed class GeneratedRegexAttribute : global::System.Attribute
{
    public GeneratedRegexAttribute(string pattern)
    {
    }
}

public class Regex
{
    public Regex(string pattern)
    {
    }
}
`);
        runRequired('dotnet', [
            'build',
            path.join(fakeAssemblyRoot, 'FakeSystemTextRegularExpressions.csproj'),
            '--disable-build-servers',
            '-v:minimal',
            '-o', fakeAssemblyOutput,
            '/p:NuGetAudit=false'
        ], { cwd: fakeAssemblyRoot, env: environment });
        const testOutput = path.join(
            buildRoot,
            'dotnet/FsusBlog.Server.Tests/bin/Debug/net10.0'
        );
        const fakeAssemblyPath = path.join(testOutput, 'System.Text.RegularExpressions.dll');
        copyFileSync(
            path.join(fakeAssemblyOutput, 'System.Text.RegularExpressions.dll'),
            fakeAssemblyPath
        );
        let sameNameMetadataShadow;
        try
        {
            sameNameMetadataShadow = runAdapter(adapterAssembly, checkoutRoot, projectPath, environment);
        }
        finally
        {
            rmSync(fakeAssemblyPath, { force: true });
        }

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
            cs1061,
            shadowGeneratedRegex,
            invalidGeneratedRegexSignature,
            generatedRegexWithOtherError,
            refGeneratedRegex,
            refReadonlyGeneratedRegex,
            invalidGeneratedRegexPattern,
            invalidGeneratedRegexTimeout,
            sameNameMetadataShadow
        };
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}
