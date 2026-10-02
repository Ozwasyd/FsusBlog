import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function exerciseXunitConfigurationFixture({ repositoryRoot, adapterAssembly })
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsus-xunit-configuration-'));
    try
    {
        copyFileSync(path.join(repositoryRoot, 'Directory.Build.props'), path.join(root, 'Directory.Build.props'));
        const buildRoot = path.join(root, 'artifacts');
        const project = path.join(root, 'tests/ConfigurationFixtureTests.csproj');
        mkdirSync(path.dirname(project), { recursive: true });
        mkdirSync(path.join(root, 'dependency'));
        mkdirSync(path.join(root, 'linked'));
        writeFileSync(project, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <DefineConstants>$(DefineConstants);CONFIGURATION_FIXTURE</DefineConstants>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../dependency/ConfigurationDependency.csproj" />
    <Compile Remove="Excluded.cs" />
    <Compile Include="../linked/LinkedCases.cs" Link="LinkedCases.cs" />
  </ItemGroup>
  <ItemGroup Condition="'$(Configuration)' == 'Debug'">
    <Compile Remove="ReleaseOnly.cs" />
  </ItemGroup>
  <ItemGroup Condition="'$(Configuration)' == 'Release'">
    <Compile Remove="DebugOnly.cs" />
  </ItemGroup>
  <Target Name="ConfigurationFixtureGeneratedSource" BeforeTargets="CoreCompile">
    <WriteLinesToFile File="$(IntermediateOutputPath)BoundGenerated.cs"
      Lines="public sealed class GeneratedCases { [Xunit.Fact] public void GeneratedCase() { } }"
      Overwrite="true" />
    <ItemGroup>
      <Compile Include="$(IntermediateOutputPath)BoundGenerated.cs" />
      <Compile Include="$(IntermediateOutputPath)InvalidOtherConfiguration.g.cs"
        Condition="'$(Configuration)' == 'Debug' and Exists('$(IntermediateOutputPath)InvalidOtherConfiguration.g.cs')" />
    </ItemGroup>
  </Target>
</Project>
`);
        writeFileSync(path.join(root, 'dependency/ConfigurationDependency.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>
`);
        writeFileSync(path.join(root, 'dependency/Values.cs'), `public static class Values
{
#if DEBUG
    public static int DebugValue => 1;
#else
    public static int ReleaseValue => 2;
#endif
}
`);
        writeFileSync(path.join(root, 'tests/Cases.cs'), `namespace Xunit
{
    public sealed class FactAttribute : System.Attribute { }
}

public sealed class ConfigurationCases
{
    [Xunit.Fact]
    public void SharedCase() { }
#if DEBUG && NET10_0
    [Xunit.Fact]
    public void DebugCase() { _ = Values.DebugValue; }
#endif
#if RELEASE && CONFIGURATION_FIXTURE && NET10_0
    [Xunit.Fact]
    public unsafe void ReleaseCase() { int value = Values.ReleaseValue; int* pointer = &value; _ = *pointer; }
#endif
}
`);
        writeFileSync(path.join(root, 'tests/Excluded.cs'), `#error Compile Remove must exclude this file
public sealed class ExcludedCases { [Xunit.Fact] public void ExcludedCase() { } }
`);
        writeFileSync(path.join(root, 'tests/DebugOnly.cs'),
            'public sealed class DebugOnlyCases { [Xunit.Fact] public void DebugIncludedCase() { } }\n');
        writeFileSync(path.join(root, 'tests/ReleaseOnly.cs'),
            'public sealed class ReleaseOnlyCases { [Xunit.Fact] public void ReleaseIncludedCase() { } }\n');
        writeFileSync(path.join(root, 'linked/LinkedCases.cs'),
            'public sealed class LinkedCases { [Xunit.Fact] public void LinkedCase() { } }\n');
        writeFileSync(path.join(root, 'dependency/DependencyCases.cs'), `namespace DependencyFixture
{
    public sealed class FactAttribute : System.Attribute { }
    public sealed class DependencyCases { [Fact] public void ForeignDependencyCase() { } }
}
`);
        const environment = {
            ...process.env,
            CI: 'false',
            GITHUB_ACTIONS: 'false',
            FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot
        };
        const invoke = (args) => spawnSync('dotnet', args, {
            cwd: root,
            env: environment,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024
        });
        const runAdapter = (args = []) =>
        {
            const result = invoke([adapterAssembly, root, project, ...args]);
            return {
                status: result.status,
                report: result.stdout.trim() ? JSON.parse(result.stdout) : null,
                stderr: result.stderr
            };
        };
        const explicit = (configuration) => runAdapter(['--configuration', configuration]);
        for (const configuration of ['Debug', 'Release'])
        {
            const build = invoke([
                'build', project, '-c', configuration, '-v:q', '-m:1',
                '/p:UseSharedCompilation=false', '/p:NuGetAudit=false'
            ]);
            if (build.status !== 0)
            {
                throw new Error(`configuration fixture build failed: ${build.stdout}\n${build.stderr}`);
            }
        }
        const debug = explicit('Debug');
        const release = explicit('Release');
        const defaultConfiguration = runAdapter();
        const invalidArguments = [
            ['--configuration', 'release'],
            ['--configuration', 'Unregistered'],
            ['--configuration'],
            ['--ignored', 'Release'],
            ['--configuration', 'Release', 'extra']
        ].map((args) => runAdapter(args));

        const debugIntermediate = path.join(buildRoot, 'dotnet/ConfigurationFixtureTests/obj/Debug/net10.0');
        writeFileSync(path.join(debugIntermediate, 'InvalidOtherConfiguration.g.cs'), '#error wrong configuration source\n');
        const releaseIgnoresDebugGenerated = explicit('Release');
        const debugRejectsInvalidGenerated = explicit('Debug');

        const releaseAssembly = path.join(
            buildRoot, 'dotnet/ConfigurationFixtureTests/bin/Release/net10.0/ConfigurationFixtureTests.dll'
        );
        renameSync(releaseAssembly, `${releaseAssembly}.fixture-backup`);
        const missingReleaseAssembly = explicit('Release');
        renameSync(`${releaseAssembly}.fixture-backup`, releaseAssembly);
        const releaseIntermediate = path.join(buildRoot, 'dotnet/ConfigurationFixtureTests/obj/Release/net10.0');
        renameSync(releaseIntermediate, `${releaseIntermediate}.fixture-backup`);
        const missingReleaseIntermediate = explicit('Release');
        rmSync(releaseIntermediate, { recursive: true, force: true });
        renameSync(`${releaseIntermediate}.fixture-backup`, releaseIntermediate);
        const restoredRelease = explicit('Release');
        writeFileSync(path.join(releaseIntermediate, 'NotACompileItem.g.cs'), '#error not a Compile item\n');
        const releaseIgnoresUnownedGenerated = explicit('Release');
        renameSync(path.join(root, 'linked/LinkedCases.cs'), path.join(root, 'linked/LinkedCases.cs.backup'));
        const missingLinkedSource = explicit('Release');
        renameSync(path.join(root, 'linked/LinkedCases.cs.backup'), path.join(root, 'linked/LinkedCases.cs'));
        const restoredLinkedSource = explicit('Release');
        return {
            debug,
            release,
            defaultConfiguration,
            invalidArguments,
            releaseIgnoresDebugGenerated,
            debugRejectsInvalidGenerated,
            missingReleaseAssembly,
            missingReleaseIntermediate,
            restoredRelease,
            releaseIgnoresUnownedGenerated,
            missingLinkedSource,
            restoredLinkedSource
        };
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}
