import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const { runPhysicalExecution } = await import(new URL('../../tools/test/physical-execution-process-tree.mjs', import.meta.url));
const { createBackendIdentity, backendEnvironmentCommand } = await import(new URL('../../tools/docker/backend-input-environment.mjs', import.meta.url));
const {
    parseBuildkitProgress,
    describeMsbuildFailure,
    discoverRepositoryRestoreConfiguration,
    requestedEvaluationProfile,
    profileMarker,
    publishProfileMarker,
    assertDockerfile,
    assertBuildScript,
    validateEvaluatedRestoreConfiguration,
    validateStructuredRestoreSettings,
    validateSdkFileHashes,
    selectEvaluatedInput,
    isMissingSdkGlobalConfigDiscovery,
    verifyBuildkitProbeRelationships
} = await import(new URL('../../tools/docker/backend-input-closure.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(root, 'tools/docker/backend-input-closure.mjs');

test('production workflow requires backend cache proof before both final image families', () =>
{
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/production-image-verification.yml'), 'utf8');
    const job = id =>
    {
        const start = workflow.indexOf(`\n    ${id}:\n`);
        assert.ok(start >= 0, `missing workflow job: ${id}`);
        const remaining = workflow.slice(start + 1);
        const next = remaining.slice(1).search(/\n\x20{4}[a-z][a-z0-9-]*:\n/u);
        return next < 0 ? remaining : remaining.slice(0, next + 1);
    };
    const cacheJob = job('backend-input-cache');
    const imageJob = job('final-image');
    for (const input of ['config/build/backend-docker-inputs.json', 'tests/tools/backend-docker-input-closure.test.mjs',
        'tools/docker/backend-input-closure.mjs', 'tools/docker/backend-input-environment.mjs'])
    {
        assert.ok(workflow.includes(`- ${input}`), input);
    }
    assert.match(cacheJob, /needs: contracts/u);
    assert.match(cacheJob, /node --test tests\/tools\/backend-docker-input-closure\.test\.mjs/u);
    assert.match(cacheJob, /backend-input-closure\.mjs probe-buildkit[\s\S]*--output \.tmp\/backend-docker-input-buildkit-probe\.json/u);
    assert.match(cacheJob, /\.tmp\/backend-docker-input-buildkit-probe\.json\.d\/\*\*/u);
    assert.match(imageJob, /needs: \[contracts, backend-input-cache\]/u);
    for (const source of [cacheJob, imageJob])
    {
        assert.match(source, /apt-get install --yes bubblewrap python3/u);
        assert.match(source, /\.tmp\/backend-input-evaluations\/\*\*/u);
    }
});

test('backend evaluation uses synthetic identity and a closed mount/environment map', () =>
{
    const identity = createBackendIdentity(1234, 4321);
    assert.match(identity.passwd, /fsusprobe:x:1234:4321:isolated backend evaluation:\/tmp\/backend-home:/u);
    assert.equal(identity['nsswitch.conf'], 'passwd: files\ngroup: files\nhosts: files\n');
    assert.equal(createBackendIdentity(0, 0).passwd.split('\n').filter(Boolean).length, 1);
    assert.throws(() => createBackendIdentity(-1, 1), /valid numeric UID/u);
    const command = backendEnvironmentCommand({ root: '/candidate', directory: '/evidence',
        node: '/opt/node/bin/node', dotnet: '/opt/dotnet/dotnet', bwrap: '/usr/bin/bwrap' });
    for (const required of ['--unshare-user', '--unshare-pid', '--unshare-net', '--clearenv'])
    {
        assert.ok(command.includes(required));
    }
    const mounts = command.flatMap((argument, index) => argument === '--ro-bind' ? [command.slice(index + 1, index + 3)] : []);
    for (const name of ['passwd', 'group', 'nsswitch.conf'])
    {
        assert.ok(mounts.some(([from, to]) => from === `/evidence/${name}` && to === `/etc/${name}`));
    }
    assert.ok(mounts.some(([from, to]) => from === '/candidate' && to === '/src'));
    assert.ok(mounts.every(([from]) => from !== '/' && from !== '/etc' && from !== '/home'));
    assert.ok(!command.includes('--bind'));
    assert.ok(!command.includes('DiscoverGlobalAnalyzerConfigFiles=false'));
});

test('MSBuild failure diagnostics retain child status and bounded output without inventing timeout', () =>
{
    const query = ['-target:_GetRestoreProjectStyle;_GetRestoreSettings', '-getProperty:_OutputConfigFilePaths,RestoreConfigFile'];
    const stdout = Buffer.from('error MSB1009: Project file does not exist.\n');
    const timeout = JSON.parse(describeMsbuildFailure({ code: 'ETIMEDOUT', status: null,
        signal: 'SIGTERM', stdout, stderr: Buffer.from('') }, query));
    assert.equal(timeout.code, 'ETIMEDOUT');
    assert.equal(timeout.status, null);
    assert.equal(timeout.signal, 'SIGTERM');
    assert.equal(timeout.timeoutMs, 60000);
    assert.deepEqual(timeout.query, query);
    assert.equal(timeout.output.stdout.text, stdout.toString());
    assert.equal(timeout.output.stdout.sha256, createHash('sha256').update(stdout).digest('hex'));
    assert.equal(timeout.output.stderr.bytes, 0);
    const failure = JSON.parse(describeMsbuildFailure({ status: 1, stdout: 'failed', stderr: 'x'.repeat(20000) }, query));
    assert.equal(failure.code, null);
    assert.equal(failure.status, 1);
    assert.equal(failure.signal, null);
    assert.equal(failure.output.stderr.bytes, 20000);
    assert.equal(failure.output.stderr.text.length, 16384);
    assert.equal(failure.output.stderr.truncated, true);
    assert.equal(failure.output.stderr.sha256, createHash('sha256').update('x'.repeat(20000)).digest('hex'));
    assert.equal(failure.output.stdout.truncated, false);
});

function write(rootPath, relativePath, contents)
{
    const destination = path.join(rootPath, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
}

let producedFixtureLocks;

async function runFixtureDotnet(fixture, id, argv)
{
    const directory = path.join(root, '.tmp', 'backend-input-fixture-executions', path.basename(fixture));
    fs.mkdirSync(directory, { recursive: true });
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const inputPaths = ['Directory.Build.props', 'Directory.Packages.props', 'src/app/App.csproj', 'src/lib/Lib.csproj',
        'config/build/backend-restore.xml', 'src/app/packages.lock.json', 'src/lib/packages.lock.json'];
    const inputs = Object.fromEntries(inputPaths.map(relativePath => [relativePath,
    fs.existsSync(path.join(fixture, relativePath)) ? digest(fs.readFileSync(path.join(fixture, relativePath))) : null]));
    const sourceIdentity = {
        checker: digest(fs.readFileSync(checker)),
        test: digest(fs.readFileSync(fileURLToPath(import.meta.url)))
    };
    const start = new Date().toISOString();
    let result;
    let failure;
    try
    {
        result = await runPhysicalExecution({ command: ['dotnet', ...argv], cwd: fixture,
            signal: AbortSignal.timeout(60000), residualRoot: path.join(directory, 'residuals'),
            stdout: { write()
            {} }, stderr: { write()
            {} },
            env: { ...process.env, MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
                NUGET_PACKAGES: path.join(fixture, '.tmp', 'nuget-packages'),
                DOTNET_CLI_HOME: path.join(fixture, '.tmp', 'dotnet-home'),
                FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(fixture, '.tmp', 'lock-producer-build') }
        });
    }
    catch (error)
    {
        failure = error;
        result = error.physicalExecution ?? { stdout: '', stderr: '', postObservation: 'unverifiable' };
    }
    const directChildren = (result.processInventory ?? []).filter(process => process.role === 'direct-child');
    const terminal = directChildren.length === 1 ? directChildren[0] : null;
    write(directory, `${id}.stdout.log`, result.stdout ?? '');
    write(directory, `${id}.stderr.log`, result.stderr ?? '');
    write(directory, `${id}.json`, JSON.stringify({ command: 'dotnet', argv, start, fixture, sourceIdentity, inputs,
        end: new Date().toISOString(), exit: terminal?.exitCode ?? null, signal: terminal?.signal ?? null, error: failure?.message,
        stdout: { path: path.join(directory, `${id}.stdout.log`), sha256: digest(result.stdout ?? '') },
        stderr: { path: path.join(directory, `${id}.stderr.log`), sha256: digest(result.stderr ?? '') },
        physicalExecution: result }, null, 2));
    if (failure)
    {
        throw failure;
    }
    assert.equal(directChildren.length, 1, 'physical execution must identify exactly one direct child');
    assert.equal(terminal.exitCode, 0);
    assert.equal(result.postObservation, 'zero-members');
    assert.equal(result.logComplete, true);
    return result;
}

async function ensureFixtureLocks(fixture)
{
    const paths = ['src/app/packages.lock.json', 'src/lib/packages.lock.json'];
    if (!producedFixtureLocks)
    {
        await runFixtureDotnet(fixture, 'generate-locks', [
            'restore', 'src/app/App.csproj', '--configfile', 'config/build/backend-restore.xml',
            '--force-evaluate', '--use-lock-file', '--disable-parallel', '-p:RestoreLockedMode=false',
            '-p:NuGetAudit=false', '-p:RestoreIgnoreFailedSources=false', '-nologo'
        ]);
        producedFixtureLocks = paths.map(relativePath =>
        {
            const bytes = fs.readFileSync(path.join(fixture, relativePath));
            const value = JSON.parse(bytes);
            assert.ok([1, 2].includes(value.version), 'canonical NuGet lock schema must be recognized');
            assert.ok(value.dependencies['net10.0']);
            for (const packages of Object.values(value.dependencies))
            {
                assert.ok(Object.values(packages).every(dependency => dependency.type === 'Project'),
                    'the isolated fixture must not acquire external package dependencies');
            }
            return bytes;
        });
    }
    for (const [index, relativePath] of paths.entries())
    {
        write(fixture, relativePath, producedFixtureLocks[index]);
    }
}

async function createFixture(t, produceLocks = true)
{
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-backend-inputs-test-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

    write(fixture, 'Directory.Build.props', `
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
  </PropertyGroup>
  <PropertyGroup Condition="'$(FSUSBLOG_PRODUCTION_BUILD_ROOT)' != ''">
    <BaseOutputPath>$(FSUSBLOG_PRODUCTION_BUILD_ROOT)/dotnet/$(MSBuildProjectName)/bin/</BaseOutputPath>
    <BaseIntermediateOutputPath>$(FSUSBLOG_PRODUCTION_BUILD_ROOT)/dotnet/$(MSBuildProjectName)/obj/</BaseIntermediateOutputPath>
    <MSBuildProjectExtensionsPath>$(FSUSBLOG_PRODUCTION_BUILD_ROOT)/dotnet/$(MSBuildProjectName)/obj/</MSBuildProjectExtensionsPath>
  </PropertyGroup>
</Project>
`.trimStart());
    write(fixture, 'Directory.Packages.props', `
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
</Project>
`.trimStart());
    write(fixture, '.editorconfig', 'root = true\n');
    write(fixture, 'src/app/App.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../lib/Lib.csproj" />
    <Content Include="../../config/moderation/policy.yaml" CopyToPublishDirectory="PreserveNewest" />
  </ItemGroup>
</Project>
`.trimStart());
    write(fixture, 'src/app/Program.cs', 'public static class Program { public static void Main() {} }\n');
    write(fixture, 'src/lib/Lib.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`.trimStart());
    write(fixture, 'src/lib/Library.cs', 'public sealed class Library {}\n');
    write(fixture, 'config/moderation/policy.yaml', 'policy: fixture\n');
    write(fixture, 'config/build/backend-restore.xml', '<configuration><packageSources><clear /></packageSources></configuration>');
    write(fixture, 'config/build/backend-docker-inputs.json', `${JSON.stringify({
        schema: 'fsusblog.backend-docker-inputs.v1',
        entryProject: 'src/app/App.csproj',
        restoreConfigFile: 'config/build/backend-restore.xml',
        evaluationProperties: {
            Configuration: 'Release',
            RuntimeIdentifier: 'linux-x64',
            SkipClientDependenciesForPublish: 'true',
            SkipClientReleaseArtifactCopy: 'true',
            SkipClientReleaseBuild: 'true'
        },
        itemTypes: [
            'AdditionalFiles',
            'Compile',
            'Content',
            'EditorConfigFiles',
            'EmbeddedResource',
            'GlobalAnalyzerConfigFiles'
        ],
        projects: [
            { path: 'src/app/App.csproj', references: ['src/lib/Lib.csproj'] },
            { path: 'src/lib/Lib.csproj', references: [] }
        ],
        imports: ['Directory.Build.props', 'Directory.Packages.props'],
        restoreFiles: [
            'config/build/backend-restore.xml',
            'Directory.Build.props',
            'Directory.Packages.props',
            'src/app/App.csproj',
            'src/app/packages.lock.json',
            'src/lib/Lib.csproj',
            'src/lib/packages.lock.json'
        ],
        allowedExternalItemRoots: ['config/moderation'],
        allowedExternalItemFiles: ['.editorconfig'],
        optionalPublishRoots: ['build/artifacts/native-zk'],
        forbiddenPrefixes: ['build/artifacts/wasm-release', 'docs', 'release-evidence', 'src/frontend', 'tests']
    }, null, 4)}\n`);
    for (const relativePath of ['ops/docker/FsusBlog.Server.Dockerfile', 'tools/build-final-image.sh'])
    {
        write(fixture, relativePath, fs.readFileSync(path.join(root, relativePath)));
    }
    if (produceLocks)
    {
        await ensureFixtureLocks(fixture);
    }
    return fixture;
}

function run(fixture, command, ...args)
{
    return runWithEnvironment(fixture, {}, command, ...args);
}

function runWithEnvironment(fixture, environment, command, ...args)
{
    return spawnSync(process.execPath, [checker, command, '--root', fixture, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...environment }
    });
}

function readSummary(fixture)
{
    const result = run(fixture, 'print');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

const buildkitNames = {
    restoreCopy: '[build 4/6] COPY --from=backend-inputs /restore/ /src/',
    restoreRun: '[build 5/6] RUN dotnet restore "./src/backend/FsusBlog.Server.csproj" --runtime "$TARGET_RUNTIME"',
    compileCopy: '[build 6/6] COPY --from=backend-inputs /compile/ /src/',
    publishRun: '[publish-debug 1/1] RUN dotnet publish "./FsusBlog.Server.csproj" -c "$BUILD_CONFIGURATION"'
};

function buildkitRaw(vertices)
{
    return Object.entries(vertices).flatMap(([id, vertex]) => [
        JSON.stringify({ vertexes: [{
            digest: vertex.vertex,
            name: buildkitNames[id],
            started: '2026-09-03T00:00:00Z'
        }] }),
        JSON.stringify({
            vertexes: [{
                digest: vertex.vertex,
                name: buildkitNames[id],
                cached: vertex.cached,
                completed: '2026-09-03T00:00:01Z'
            }]
        })
    ]).join('\n');
}

function buildkitProbeRelationships()
{
    const closure = (restore, compile, publish = 'sha256:publish') => ({
        domains: {
            restore: { digest: restore },
            compile: { digest: compile },
            publish: { digest: publish }
        }
    });
    const cold = {
        restoreCopy: { vertex: 'sha256:cold-restore-copy', cached: false },
        restoreRun: { vertex: 'sha256:cold-restore-run', cached: false },
        compileCopy: { vertex: 'sha256:cold-compile-copy', cached: false },
        publishRun: { vertex: 'sha256:cold-publish-run', cached: false }
    };
    const unrelated = Object.fromEntries(Object.entries(cold).map(([id, vertex]) => [id, {
        ...vertex,
        cached: true
    }]));
    const backendSource = {
        restoreCopy: { ...unrelated.restoreCopy },
        restoreRun: { ...unrelated.restoreRun },
        compileCopy: { vertex: 'sha256:backend-compile-copy', cached: false },
        publishRun: { vertex: 'sha256:backend-publish-run', cached: false }
    };
    const msbuildImport = {
        restoreCopy: { vertex: 'sha256:msbuild-restore-copy', cached: false },
        restoreRun: { vertex: 'sha256:msbuild-restore-run', cached: false },
        compileCopy: { vertex: 'sha256:msbuild-compile-copy', cached: false },
        publishRun: { vertex: 'sha256:msbuild-publish-run', cached: false }
    };
    return {
        cold: {
            vertices: parseBuildkitProgress(buildkitRaw(cold)),
            closure: closure('sha256:restore', 'sha256:compile')
        },
        unrelated: {
            vertices: parseBuildkitProgress(buildkitRaw(unrelated)),
            closure: closure('sha256:restore', 'sha256:compile')
        },
        'backend-source': {
            vertices: parseBuildkitProgress(buildkitRaw(backendSource)),
            closure: closure('sha256:restore', 'sha256:backend-compile')
        },
        'msbuild-import': {
            vertices: parseBuildkitProgress(buildkitRaw(msbuildImport)),
            closure: closure('sha256:msbuild-restore', 'sha256:backend-compile')
        }
    };
}

test('fixture source consumes canonical Docker consumers without invoking a lock producer', async t =>
{
    const fixture = await createFixture(t, false);
    assert.doesNotThrow(() => assertDockerfile(fixture));
    assert.doesNotThrow(() => assertBuildScript(fixture));
    for (const relativePath of ['ops/docker/FsusBlog.Server.Dockerfile', 'tools/build-final-image.sh'])
    {
        assert.deepEqual(fs.readFileSync(path.join(fixture, relativePath)), fs.readFileSync(path.join(root, relativePath)));
    }
    assert.equal(fs.existsSync(path.join(fixture, 'src/app/packages.lock.json')), false);
    assert.equal(fs.existsSync(path.join(fixture, 'src/lib/packages.lock.json')), false);
});

test('SDK byte witness rejects changed missing and duplicate profile/config files', () =>
{
    const hash = 'a'.repeat(64);
    const expected = { '/src/.backend-input-profile': hash };
    assert.doesNotThrow(() => validateSdkFileHashes(expected, `${hash}  /src/.backend-input-profile\n`));
    for (const output of ['', `${'b'.repeat(64)}  /src/.backend-input-profile\n`,
        `${hash}  /src/.backend-input-profile\n${hash}  /src/.backend-input-profile\n`])
    {
        assert.throws(() => validateSdkFileHashes(expected, output), /SDK .* witness/u);
    }
});

test('evaluated restore settings reject missing multiple and host configuration identities', () =>
{
    const expected = 'config/build/backend-restore.xml';
    assert.doesNotThrow(() => validateEvaluatedRestoreConfiguration(root, expected, path.join(root, expected)));
    for (const observed of [undefined, '', '/home/other/.nuget/NuGet/NuGet.Config',
        `${path.join(root, expected)};${path.join(root, expected)}`])
    {
        assert.throws(() => validateEvaluatedRestoreConfiguration(root, expected, observed), /exact controlled singleton/u);
    }
});

test('structured restore settings require both exact properties and reject single-property raw stdout', () =>
{
    const expected = 'config/build/backend-restore.xml';
    const config = path.join(root, expected);
    const encode = properties => JSON.stringify({ Properties: properties });
    const valid = { _OutputConfigFilePaths: config, RestoreConfigFile: config };
    assert.doesNotThrow(() => validateStructuredRestoreSettings(root, expected, encode(valid)));
    // The first real evaluation returned this single-property wire format, not JSON.
    assert.throws(() => validateStructuredRestoreSettings(root, expected, `${config}\n`), SyntaxError);
    for (const output of ['', '{}', 'null', '[]', encode({ _OutputConfigFilePaths: config }),
        encode({ ...valid, unexpected: config }), encode({ ...valid, RestoreConfigFile: null })])
    {
        assert.throws(() => validateStructuredRestoreSettings(root, expected, output));
    }
    for (const key of Object.keys(valid))
    {
        for (const value of ['', expected, '/home/other/.nuget/NuGet/NuGet.Config', `${config};${config}`, `${config};`, `;${config}`])
        {
            assert.throws(() => validateStructuredRestoreSettings(root, expected, encode({ ...valid, [key]: value })),
                /exact controlled singleton/u);
        }
    }
});

test('canonical source binds materializer profile invocation and named-context Docker consumers', async t =>
{
    assert.doesNotThrow(() => assertDockerfile(root));
    assert.doesNotThrow(() => assertBuildScript(root));
    const source = fs.readFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
    assert.match(source, /--configfile \/src\/config\/build\/backend-restore.xml/u);
    assert.equal(source.split('cat /src/.backend-input-profile').length - 1, 3);
    assert.equal(source.split('cat /src/.backend-publish-profile').length - 1, 2);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-profile-consumer-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    for (const mutation of [
        value => value.split('\n').filter(line => !line.includes('cat /src/.backend-publish-profile')).join('\n'),
        value => value.replace('--runtime "$TARGET_RUNTIME"', '--runtime linux-x64'),
        value => value.replace('--configfile /src/config/build/backend-restore.xml', '--configfile /tmp/other.xml'),
        value => value.replace('/p:RestoreConfigFile=/src/config/build/backend-restore.xml', '/p:RestoreConfigFile=/tmp/other.xml'),
        value => value.replace('/p:TieredPGO="$TIERED_PGO"', '/p:TieredPGO=false')
    ])
    {
        write(fixture, 'ops/docker/FsusBlog.Server.Dockerfile', mutation(source));
        assert.throws(() => assertDockerfile(fixture), /profile .* binding mismatch/u);
    }
});

test('requested profile binds configuration runtime and ReadyToRun without time metadata', () =>
{
    const inventory = { evaluationProperties: { Configuration: 'Release', RuntimeIdentifier: 'linux-musl-x64' } };
    const profile = requestedEvaluationProfile(inventory, { configuration: 'Debug', runtime: 'linux-x64', 'ready-to-run': 'true' });
    assert.equal(profile.Configuration, 'Debug');
    assert.equal(profile.RuntimeIdentifier, 'linux-x64');
    assert.equal(profile.ReadyToRunUseCrossgen2, 'true');
    assert.equal(profileMarker(profile), 'Debug\nlinux-x64\ntrue\n');
    assert.match(publishProfileMarker(profile), /^publish\nDebug\nlinux-x64\ntrue\n/u);
    const debug = requestedEvaluationProfile(inventory, { target: 'publish-debug', configuration: 'Debug' });
    assert.equal(publishProfileMarker(debug), 'publish-debug\nDebug\nlinux-musl-x64\nfalse\n');
    for (const option of ['single-file', 'tiered-pgo', 'quick-jit-for-loops', 'server-gc'])
    {
        assert.notEqual(publishProfileMarker(requestedEvaluationProfile(inventory, { [option]: 'false' })),
            publishProfileMarker(requestedEvaluationProfile(inventory, {})));
    }
    assert.notEqual(profileMarker(profile), profileMarker(requestedEvaluationProfile(inventory, {})));
    assert.throws(() => requestedEvaluationProfile(inventory, { configuration: 'Release;Inject=true' }), /invalid requested/u);
    assert.throws(() => requestedEvaluationProfile(inventory, { 'ready-to-run': 'unknown' }), /invalid requested/u);
});

test('restore configuration discovery includes project ancestors and SDK selection', async t =>
{
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-restore-config-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    write(fixture, 'src/app/App.csproj', '<Project />');
    write(fixture, 'NuGet.Config', '<configuration />');
    write(fixture, 'global.json', '{"sdk":{"version":"10.0.100"}}');
    write(fixture, 'src/nuget.config', '<configuration />');
    write(fixture, 'unrelated/NuGet.Config', '<configuration />');
    assert.deepEqual(discoverRepositoryRestoreConfiguration(fixture, ['src/app/App.csproj']),
        ['global.json', 'NuGet.Config', 'src/nuget.config'].sort((a, b) => a.localeCompare(b)));
    fs.unlinkSync(path.join(fixture, 'src/nuget.config'));
    fs.symlinkSync(path.join(fixture, 'NuGet.Config'), path.join(fixture, 'src/nuget.config'));
    assert.throws(() => discoverRepositoryRestoreConfiguration(fixture, ['src/app/App.csproj']), /regular file/u);
});

test('SDK globalconfig discovery exempts only exact missing ancestor candidates', t =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-globalconfig-discovery-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const fixture = path.join(temporary, 'repo');
    const toolsPath = path.join(temporary, 'sdk');
    const authority = path.join(toolsPath, 'Roslyn/Microsoft.Managed.Core.targets');
    const discoverySource = `<Project>
<GlobalAnalyzerConfigFiles Include="@(_AllDirectoriesAbove->'%(FullPath)'->Distinct()->Combine('.globalconfig'))" Condition="'$(DiscoverGlobalAnalyzerConfigFiles)' != 'false'" />
<EditorConfigFiles Include="@(GlobalAnalyzerConfigFiles->Exists())" Condition="'$(DiscoverGlobalAnalyzerConfigFiles)' != 'false'" />
</Project>`;
    write(toolsPath, 'Roslyn/Microsoft.Managed.Core.targets', discoverySource);
    write(fixture, 'src/Code.cs', 'class Code {}');
    const compile = [{ FullPath: path.join(fixture, 'src/Code.cs') }];
    const candidate = { FullPath: path.join(fixture, '.globalconfig'), DefiningProjectFullPath: authority };
    assert.equal(isMissingSdkGlobalConfigDiscovery(fixture, candidate, compile, toolsPath), true);
    for (const item of [{ ...candidate, DefiningProjectFullPath: path.join(fixture, 'Directory.Build.props') },
        { ...candidate, DefiningProjectFullPath: `${authority}.other` }, { FullPath: candidate.FullPath },
        { ...candidate, FullPath: path.join(fixture, 'unrelated/.globalconfig') }])
    {
        assert.equal(isMissingSdkGlobalConfigDiscovery(fixture, item, compile, toolsPath), false);
        assert.throws(() => selectEvaluatedInput(fixture, 'App.csproj', 'GlobalAnalyzerConfigFiles', item), /input is missing/u);
    }
    write(toolsPath, 'Roslyn/Microsoft.Managed.Core.targets', discoverySource.replace('->Exists()', ''));
    assert.equal(isMissingSdkGlobalConfigDiscovery(fixture, candidate, compile, toolsPath), false);
    write(toolsPath, 'Roslyn/Microsoft.Managed.Core.targets', discoverySource);
    fs.symlinkSync(path.join(temporary, 'missing-globalconfig'), candidate.FullPath);
    assert.equal(isMissingSdkGlobalConfigDiscovery(fixture, candidate, compile, toolsPath), false);
    assert.throws(() => selectEvaluatedInput(fixture, 'App.csproj', 'GlobalAnalyzerConfigFiles', candidate), /input is missing/u);
    fs.unlinkSync(candidate.FullPath);
    write(fixture, '.globalconfig', 'is_global = true');
    assert.equal(isMissingSdkGlobalConfigDiscovery(fixture, candidate, compile, toolsPath), false);
    assert.equal(selectEvaluatedInput(fixture, 'App.csproj', 'GlobalAnalyzerConfigFiles', candidate), '.globalconfig');
    write(temporary, '.globalconfig', 'is_global = true');
    const external = { ...candidate, FullPath: path.join(temporary, '.globalconfig') };
    assert.equal(isMissingSdkGlobalConfigDiscovery(fixture, external, compile, toolsPath), false);
    assert.throws(() => selectEvaluatedInput(fixture, 'App.csproj', 'EditorConfigFiles', external), /escapes the repository/u);
});

test('evaluated input selection preserves publish None and rejects missing explicit inputs', async t =>
{
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-input-selection-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    write(fixture, 'src/app/payload.txt', 'payload');
    const project = 'src/app/App.csproj';
    const item = { Identity: 'payload.txt', CopyToPublishDirectory: 'PreserveNewest' };
    assert.equal(selectEvaluatedInput(fixture, project, 'None', item), 'src/app/payload.txt');
    assert.equal(selectEvaluatedInput(fixture, project, 'None', { Identity: 'unconsumed.txt' }), null);
    for (const itemType of ['Compile', 'Content', 'EmbeddedResource', 'None'])
    {
        assert.throws(() => selectEvaluatedInput(fixture, project, itemType, {
            Identity: 'missing.txt', CopyToPublishDirectory: 'Always'
        }), /input is missing/u);
    }
    assert.throws(() => selectEvaluatedInput(fixture, project, 'None', {
        ...item, CopyToPublishDirectory: 'Unknown'
    }), /unsupported None copy metadata/u);
});

test('candidate BuildKit progress binds exact restore, compile, and publish cache vertices', () =>
{
    const probes = buildkitProbeRelationships();
    assert.equal(probes.unrelated.vertices.compileCopy.cached, true);
    assert.doesNotThrow(() => verifyBuildkitProbeRelationships(probes));
});

test('candidate BuildKit relationship verification fails closed on incomplete or false cache evidence', async t =>
{
    await t.test('missing compile vertex', () =>
    {
        const vertices = {
            restoreCopy: { vertex: 'sha256:restore-copy', cached: true },
            restoreRun: { vertex: 'sha256:restore-run', cached: true },
            publishRun: { vertex: 'sha256:publish-run', cached: true }
        };
        assert.throws(
            () => parseBuildkitProgress(buildkitRaw(vertices)),
            /exactly one compileCopy vertex/u
        );
    });

    await t.test('unrelated input misses compile cache', () =>
    {
        const probes = buildkitProbeRelationships();
        probes.unrelated.vertices.compileCopy.cached = false;
        assert.throws(
            () => verifyBuildkitProbeRelationships(probes),
            /unrelated-input compileCopy was not served from BuildKit cache/u
        );
    });

    await t.test('backend source reuses compile vertex', () =>
    {
        const probes = buildkitProbeRelationships();
        probes['backend-source'].vertices.compileCopy.cached = true;
        assert.throws(
            () => verifyBuildkitProbeRelationships(probes),
            /backend-source compile copy unexpectedly reused BuildKit cache/u
        );
    });

    await t.test('MSBuild import reuses restore vertex', () =>
    {
        const probes = buildkitProbeRelationships();
        probes['msbuild-import'].vertices.restoreRun.cached = true;
        assert.throws(
            () => verifyBuildkitProbeRelationships(probes),
            /MSBuild import restore unexpectedly reused BuildKit cache/u
        );
    });
});

test('materialized backend context is exact and excludes unrelated or secret files', async t =>
{
    const fixture = await createFixture(t);
    write(fixture, '.env', 'DO_NOT_COPY=secret\n');
    write(fixture, 'docs/architecture.md', 'irrelevant\n');
    write(fixture, 'src/frontend/main.ts', 'irrelevant\n');
    write(fixture, 'build/artifacts/wasm-release/receipt.json', '{"createdAt":"now"}\n');
    const output = path.join(fixture, '.tmp/backend-inputs');

    const result = run(fixture, 'materialize', '--output', output);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'closure.json'), 'utf8'));
    const receiptBytes = fs.readFileSync(summary.evaluationEvidence.path);
    assert.equal(summary.evaluationEvidence.sha256, `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}`);
    const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.inputsUnchanged, true);
    assert.deepEqual(receipt.changed, []);
    assert.equal(receipt.physicalExecution.postObservation, 'zero-members');
    assert.equal(receipt.physicalExecution.logComplete, true);
    assert.equal(fs.existsSync(path.join(output, 'restore/src/app/App.csproj')), true);
    assert.equal(fs.existsSync(path.join(output, 'compile/src/app/Program.cs')), true);
    assert.equal(fs.existsSync(path.join(output, 'compile/config/moderation/policy.yaml')), true);
    for (const excluded of ['.env', 'docs', 'src/frontend', 'build/artifacts/wasm-release'])
    {
        assert.equal(fs.existsSync(path.join(output, 'compile', excluded)), false, excluded);
        assert.equal(fs.existsSync(path.join(output, 'restore', excluded)), false, excluded);
    }
});

test('unrelated changes preserve backend domains and real MSBuild inputs invalidate them', async t =>
{
    const fixture = await createFixture(t);
    const before = readSummary(fixture);
    write(fixture, 'src/frontend/main.ts', 'const changed = true\n');
    write(fixture, 'docs/architecture.md', 'changed\n');
    write(fixture, 'tests/unrelated.test.mjs', 'changed\n');
    write(fixture, 'tools/unrelated.mjs', 'changed\n');
    write(fixture, 'build/artifacts/wasm-release/receipt.json', '{"createdAt":"later"}\n');
    write(fixture, 'src/app/obj/Debug/net10.0/Generated.cs', 'internal sealed class Generated {}\n');
    write(fixture, 'src/app/bin/Debug/net10.0/App.deps.json', '{}\n');
    const unrelated = readSummary(fixture);
    assert.deepEqual(unrelated.domains, before.domains);

    write(fixture, 'src/app/Program.cs', 'Console.WriteLine("changed");\n');
    const sourceChanged = readSummary(fixture);
    assert.notEqual(sourceChanged.domains.compile.digest, before.domains.compile.digest);
    assert.equal(sourceChanged.domains.restore.digest, before.domains.restore.digest);

    write(fixture, 'Directory.Build.props', '<Project><PropertyGroup><LangVersion>preview</LangVersion></PropertyGroup></Project>\n');
    const importChanged = readSummary(fixture);
    assert.notEqual(importChanged.domains.restore.digest, before.domains.restore.digest);

    write(fixture, 'Directory.Packages.props', '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="Example" Version="1.0.0" /></ItemGroup></Project>\n');
    const centralPackageChanged = readSummary(fixture);
    assert.notEqual(centralPackageChanged.domains.restore.digest, importChanged.domains.restore.digest);

    write(fixture, 'src/app/NewBackendInput.cs', 'internal sealed class NewBackendInput {}\n');
    const sourceAdded = readSummary(fixture);
    assert.equal(sourceAdded.domains.compile.count, centralPackageChanged.domains.compile.count + 1);
    assert.notEqual(sourceAdded.domains.compile.digest, centralPackageChanged.domains.compile.digest);
});

test('production build outputs and NuGet generated imports do not enter the source closure', async t =>
{
    const fixture = await createFixture(t);
    const productionRoot = path.join(fixture, '.tmp/build/production-probe');
    const lockPaths = ['src/app/packages.lock.json', 'src/lib/packages.lock.json'];
    const beforeLocks = lockPaths.map(relativePath => fs.readFileSync(path.join(fixture, relativePath)));
    const outputProperty = `-p:FSUSBLOG_PRODUCTION_BUILD_ROOT=${productionRoot}`;
    await runFixtureDotnet(fixture, 'locked-restore', [
        'restore', 'src/app/App.csproj', '--configfile', 'config/build/backend-restore.xml',
        '--locked-mode', '--disable-parallel', '-p:RestoreLockedMode=true', '-p:NuGetAudit=false', outputProperty, '-nologo'
    ]);
    await runFixtureDotnet(fixture, 'no-restore-build', [
        'build', 'src/app/App.csproj', '--no-restore', '-nologo', '-m:1', '-nr:false',
        '-p:UseSharedCompilation=false', '-p:RestoreLockedMode=true', outputProperty
    ]);
    for (const [index, relativePath] of lockPaths.entries())
    {
        assert.deepEqual(fs.readFileSync(path.join(fixture, relativePath)), beforeLocks[index]);
    }

    const withoutProductionEnvironment = runWithEnvironment(
        fixture,
        { FSUSBLOG_PRODUCTION_BUILD_ROOT: '' },
        'print'
    );
    assert.equal(withoutProductionEnvironment.status, 0, withoutProductionEnvironment.stderr);

    const result = runWithEnvironment(
        fixture,
        { FSUSBLOG_PRODUCTION_BUILD_ROOT: productionRoot },
        'print'
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
        JSON.parse(result.stdout).domains,
        JSON.parse(withoutProductionEnvironment.stdout).domains
    );
});

test('undeclared project dependency fails closed', async t =>
{
    const fixture = await createFixture(t);
    write(fixture, 'src/extra/Extra.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n');
    write(fixture, 'src/extra/Extra.cs', 'public sealed class Extra {}\n');
    const project = fs.readFileSync(path.join(fixture, 'src/app/App.csproj'), 'utf8');
    write(fixture, 'src/app/App.csproj', project.replace('</ItemGroup>', '  <ProjectReference Include="../extra/Extra.csproj" />\n  </ItemGroup>'));

    const result = run(fixture, 'check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ProjectReference closure mismatch/u);
});

test('missing undeclared project dependency fails closed before build', async t =>
{
    const fixture = await createFixture(t);
    const project = fs.readFileSync(path.join(fixture, 'src/app/App.csproj'), 'utf8');
    write(fixture, 'src/app/App.csproj', project.replace(
        '</ItemGroup>',
        '  <ProjectReference Include="../missing/Missing.csproj" />\n  </ItemGroup>'
    ));

    const result = run(fixture, 'check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ProjectReference closure mismatch/u);
});

test('declared project outside the entry project graph fails closed', async t =>
{
    const fixture = await createFixture(t);
    write(fixture, 'src/extra/Extra.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n');
    write(fixture, 'src/extra/Extra.cs', 'public sealed class Extra {}\n');
    const inventoryPath = path.join(fixture, 'config/build/backend-docker-inputs.json');
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    inventory.projects.push({ path: 'src/extra/Extra.csproj', references: [] });
    inventory.projects.sort((left, right) => left.path.localeCompare(right.path));
    inventory.restoreFiles.push('src/extra/Extra.csproj', 'src/extra/packages.lock.json');
    inventory.restoreFiles.sort((left, right) => left.localeCompare(right));
    write(fixture, 'config/build/backend-docker-inputs.json', `${JSON.stringify(inventory, null, 4)}\n`);

    const result = run(fixture, 'check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not reachable from entryProject/u);
});

test('symlinked source input fails closed', async t =>
{
    const fixture = await createFixture(t);
    fs.symlinkSync('Program.cs', path.join(fixture, 'src/app/Linked.cs'));

    const result = run(fixture, 'check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Compile input must be a regular non-symlink file: /u);
});

test('undeclared repo-local import and source dependency fail closed', async t =>
{
    await t.test('import', async child =>
    {
        const fixture = await createFixture(child);
        write(fixture, 'build/custom.targets', '<Project />\n');
        const project = fs.readFileSync(path.join(fixture, 'src/app/App.csproj'), 'utf8');
        write(fixture, 'src/app/App.csproj', project.replace('</Project>', '  <Import Project="../../build/custom.targets" />\n</Project>'));
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /MSBuild import closure mismatch/u);
    });

    await t.test('source', async child =>
    {
        const fixture = await createFixture(child);
        write(fixture, 'generated/Rogue.cs', 'public sealed class Rogue {}\n');
        const project = fs.readFileSync(path.join(fixture, 'src/app/App.csproj'), 'utf8');
        write(fixture, 'src/app/App.csproj', project.replace('</ItemGroup>', '  <Compile Include="../../generated/Rogue.cs" />\n  </ItemGroup>'));
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /outside declared source roots/u);
    });
});

test('repo-wide backend COPY and alternate backend-input projection fail closed', async t =>
{
    await t.test('broad copy', async child =>
    {
        const fixture = await createFixture(child);
        const dockerfile = fs.readFileSync(path.join(fixture, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
        write(fixture, 'ops/docker/FsusBlog.Server.Dockerfile', dockerfile.replace(
            'COPY --from=backend-inputs /compile/ /src/',
            'COPY . .'
        ));
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /backend SDK COPY authority mismatch/u);
    });

    await t.test('second authority', async child =>
    {
        const fixture = await createFixture(child);
        const dockerfile = fs.readFileSync(path.join(fixture, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
        write(fixture, 'ops/docker/FsusBlog.Server.Dockerfile', dockerfile.replace(
            'COPY --from=backend-inputs /publish/ /src/',
            'COPY . .\nCOPY --from=backend-inputs /publish/ /src/'
        ));
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /backend SDK COPY authority mismatch/u);
    });

    await t.test('shadowed named context', async child =>
    {
        const fixture = await createFixture(child);
        const dockerfile = fs.readFileSync(path.join(fixture, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
        write(fixture, 'ops/docker/FsusBlog.Server.Dockerfile', `FROM scratch AS backend-inputs\n${dockerfile}`);
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /must not shadow/u);
    });

    await t.test('alternate named-context source', async child =>
    {
        const fixture = await createFixture(child);
        const buildScript = fs.readFileSync(path.join(fixture, 'tools/build-final-image.sh'), 'utf8');
        write(fixture, 'tools/build-final-image.sh', buildScript.replace(
            'backend-inputs=$BACKEND_INPUT_CONTEXT',
            'backend-inputs=$ROOT_DIR'
        ));
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /context binding must be exact/u);
    });

    await t.test('broad copy in an SDK base stage', async child =>
    {
        const fixture = await createFixture(child);
        const dockerfile = fs.readFileSync(path.join(fixture, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
        write(fixture, 'ops/docker/FsusBlog.Server.Dockerfile', dockerfile.replace(
            'FROM build-${RUNTIME_BASE_FLAVOR} AS build',
            'FROM build-base AS build-musl\nCOPY . /src\nFROM build-${RUNTIME_BASE_FLAVOR} AS build'
        ));
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /SDK base stage reads an unverified context/u);
    });

    await t.test('root bind mount in an SDK stage', async child =>
    {
        const fixture = await createFixture(child);
        const dockerfile = fs.readFileSync(path.join(fixture, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
        write(fixture, 'ops/docker/FsusBlog.Server.Dockerfile', dockerfile.replace(
            'COPY --from=backend-inputs /compile/ /src/',
            'COPY --from=backend-inputs /compile/ /src/\nRUN --mount=type=bind,target=/unverified true'
        ));
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /SDK RUN mount reads an unverified context/u);
    });

    await t.test('second named-context read in another stage', async child =>
    {
        const fixture = await createFixture(child);
        const dockerfile = fs.readFileSync(path.join(fixture, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
        write(fixture, 'ops/docker/FsusBlog.Server.Dockerfile', `${dockerfile}\nFROM scratch AS unrelated\nCOPY --from=backend-inputs /compile/ /leak/\n`);
        const result = run(fixture, 'check');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /named-context authority mismatch/u);
    });
});

test('symlinked optional publish root fails closed', async t =>
{
    const fixture = await createFixture(t);
    fs.mkdirSync(path.join(fixture, 'build/artifacts'), { recursive: true });
    fs.symlinkSync(path.join(fixture, 'src/app'), path.join(fixture, 'build/artifacts/native-zk'));

    const result = run(fixture, 'check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publish input root must be a regular directory/u);
});

test('Docker ancestor configuration guard cannot be removed or placed after input copying', async t =>
{
    const fixture = await createFixture(t, false);
    const dockerfile = 'ops/docker/FsusBlog.Server.Dockerfile';
    const source = fs.readFileSync(path.join(fixture, dockerfile), 'utf8');
    const guard = source.split('\n').find(line => line.startsWith('RUN for input in /.editorconfig'));
    assert.ok(guard);
    write(fixture, dockerfile, source.replace(guard, ''));
    assert.throws(() => assertDockerfile(fixture), /ancestor absence guard/u);
    write(fixture, dockerfile, source.replace(guard, '').replace('COPY --from=backend-inputs /restore/ /src/',
        `COPY --from=backend-inputs /restore/ /src/\n${guard}`));
    assert.throws(() => assertDockerfile(fixture), /ancestor absence guard/u);
});
