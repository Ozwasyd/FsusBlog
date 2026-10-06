import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

const { authorizeProductionBuildNestedProcess, productionDotnetArtifacts, resolveProductionBuildLayout } = await import(new URL('../../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
const { nestedExecutionChannelKey } = await import(new URL('../../../tools/test/physical-execution-nested-channel.mjs', import.meta.url));
const { runPhysicalExecution } = await import(new URL('../../../tools/test/physical-execution-process-tree.mjs', import.meta.url));
const { currentProcessIdentity } = await import(new URL('../../../tools/test/process-identity.mjs', import.meta.url));

export async function exerciseXunitConfigurationFixture({ repositoryRoot, adapterAssembly })
{
    // A channel descriptor is only a locator. The retained owner independently
    // checks the live caller and service membership before any fixture writes.
    const channelValue = process.env[nestedExecutionChannelKey];
    if (!channelValue)
    {
        throw new Error('xunit configuration fixture requires its live original build owner channel');
    }
    const channel = JSON.parse(channelValue);
    authorizeProductionBuildNestedProcess(channel, currentProcessIdentity());
    const layout = resolveProductionBuildLayout(channel.reference.context);
    if (path.resolve(repositoryRoot) !== path.resolve(channel.reference.context.root)
        || process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT !== layout.runRoot
        || path.resolve(adapterAssembly) !== productionDotnetArtifacts(layout).xunitAdapterDll
        || !existsSync(adapterAssembly))
    {
        throw new Error('xunit configuration fixture requires its original source/layout and prebuilt adapter');
    }
    const fixtureBase = path.join(layout.runRoot, 'xunit-configuration-fixtures');
    if (!existsSync(fixtureBase))
    {
        mkdirSync(fixtureBase);
    }
    const baseMetadata = lstatSync(fixtureBase);
    if (baseMetadata.isSymbolicLink() || !baseMetadata.isDirectory())
    {
        throw new Error('xunit configuration fixture root cannot be a link or special file');
    }
    const root = mkdtempSync(path.join(fixtureBase, 'fixture-'));
    try
    {
        copyFileSync(path.join(repositoryRoot, 'Directory.Build.props'), path.join(root, 'Directory.Build.props'));
        if (existsSync(path.join(repositoryRoot, 'global.json')))
        {
            copyFileSync(path.join(repositoryRoot, 'global.json'), path.join(root, 'global.json'));
        }
        // These two fixture projects have no package dependencies. Preserve
        // locked-mode policy with their real empty dependency lock, and deny feeds.
        writeFileSync(path.join(root, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
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
    <DefineConstants>$(DefineConstants);RELEASE;CONFIGURATION_FIXTURE</DefineConstants>
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
        for (const directory of ['tests', 'dependency'])
        {
            writeFileSync(path.join(root, directory, 'packages.lock.json'),
                JSON.stringify({ version: 2, dependencies: { 'net10.0': directory === 'tests'
                    ? { configurationdependency: { type: 'Project' } } : {} } }));
        }
        const environment = {
            ...process.env,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot
        };
        const invoke = async (args) =>
        {
            let stdout = '';
            let stderr = '';
            const capture = (append) => new Writable({ write(chunk, _encoding, done)
            {
                append(chunk.toString());
                done();
            } });
            try
            {
                await runPhysicalExecution({ command: ['dotnet', ...args], cwd: root, env: environment,
                    linuxReadWritePaths: [root], stdout: capture((chunk) =>
                    {
                        stdout += chunk;
                    }),
                    stderr: capture((chunk) =>
                    {
                        stderr += chunk;
                    }) });
                return { status: 0, stdout, stderr };
            }
            catch (error)
            {
                // Only a fully observed nonzero child exit is a negative oracle.
                // Authentication, grant, containment and cleanup errors propagate.
                if (!Number.isInteger(error.exitCode) || error.physicalExecution?.postObservation !== 'zero-members'
                    || error.physicalExecution?.logComplete !== true)
                {
                    throw error;
                }
                return { status: error.exitCode, stdout, stderr };
            }
        };
        const runAdapter = async (args = []) =>
        {
            const result = await invoke([adapterAssembly, root, project, ...args]);
            return {
                status: result.status,
                report: result.stdout.trim() ? JSON.parse(result.stdout) : null,
                stderr: result.stderr
            };
        };
        const explicit = (configuration) => runAdapter(['--configuration', configuration]);
        for (const configuration of ['Debug', 'Release'])
        {
            const build = await invoke([
                'build', project, '-c', configuration, '-v:q', '-m:1',
                '/p:UseSharedCompilation=false', '/p:NuGetAudit=false'
            ]);
            if (build.status !== 0)
            {
                throw new Error(`configuration fixture build failed: ${build.stdout}\n${build.stderr}`);
            }
        }
        const debug = await explicit('Debug');
        const release = await explicit('Release');
        const defaultConfiguration = await runAdapter();
        const invalidArguments = [];
        for (const args of [
            ['--configuration', 'release'],
            ['--configuration', 'Unregistered'],
            ['--configuration'],
            ['--ignored', 'Release'],
            ['--configuration', 'Release', 'extra']
        ])
        {
            invalidArguments.push(await runAdapter(args));
        }

        const debugIntermediate = path.join(buildRoot, 'dotnet/ConfigurationFixtureTests/obj/Debug/net10.0');
        writeFileSync(path.join(debugIntermediate, 'InvalidOtherConfiguration.g.cs'), '#error wrong configuration source\n');
        const releaseIgnoresDebugGenerated = await explicit('Release');
        const debugRejectsInvalidGenerated = await explicit('Debug');

        const releaseAssembly = path.join(
            buildRoot, 'dotnet/ConfigurationFixtureTests/bin/Release/net10.0/ConfigurationFixtureTests.dll'
        );
        renameSync(releaseAssembly, `${releaseAssembly}.fixture-backup`);
        const missingReleaseAssembly = await explicit('Release');
        renameSync(`${releaseAssembly}.fixture-backup`, releaseAssembly);
        const releaseIntermediate = path.join(buildRoot, 'dotnet/ConfigurationFixtureTests/obj/Release/net10.0');
        renameSync(releaseIntermediate, `${releaseIntermediate}.fixture-backup`);
        const missingReleaseIntermediate = await explicit('Release');
        rmSync(releaseIntermediate, { recursive: true, force: true });
        renameSync(`${releaseIntermediate}.fixture-backup`, releaseIntermediate);
        const restoredRelease = await explicit('Release');
        writeFileSync(path.join(releaseIntermediate, 'NotACompileItem.g.cs'), '#error not a Compile item\n');
        const releaseIgnoresUnownedGenerated = await explicit('Release');
        renameSync(path.join(root, 'linked/LinkedCases.cs'), path.join(root, 'linked/LinkedCases.cs.backup'));
        const missingLinkedSource = await explicit('Release');
        renameSync(path.join(root, 'linked/LinkedCases.cs.backup'), path.join(root, 'linked/LinkedCases.cs'));
        const restoredLinkedSource = await explicit('Release');
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
