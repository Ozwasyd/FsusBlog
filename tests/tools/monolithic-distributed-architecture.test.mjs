import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
    checkMonolithicDistributedArchitecture,
    msbuildEvaluationEnvironment,
    msbuildSandboxProperties,
    parseMsbuildEvaluationEnvelope
} = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/governance/check-monolithic-distributed-architecture.mjs'
)).href);
const { parseMsbuildPropertyDocument } = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/governance/evaluate-msbuild-entrypoints.mjs'
)).href);
const sourcePolicy = path.join(repositoryRoot, 'tests/governance/monolithic-distributed-architecture.json');
const temporaryRoots = [];

function write(root, relative, contents = 'fixture\n')
{
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
}

function listFiles(root, directory = root)
{
    const files = [];
    for (const entry of readdirSync(directory))
    {
        const absolute = path.join(directory, entry);
        if (statSync(absolute).isDirectory())
        {
            files.push(...listFiles(root, absolute));
        }
        else
        {
            files.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
        }
    }
    return files;
}

function composeSource(services)
{
    return `services:\n${services.map((service) => `  ${service}:\n    image: fixture`).join('\n')}\n`;
}

function createFixture()
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-monolithic-distributed-'));
    temporaryRoots.push(root);
    const policy = JSON.parse(readFileSync(sourcePolicy, 'utf8'));
    write(root, 'tests/governance/monolithic-distributed-architecture.json', `${JSON.stringify(policy, null, 2)}\n`);
    write(root, 'tests/governance/backend-production-build-consumers.json', `${JSON.stringify({
        schema: 'fsusblog.backend-production-build-consumers.v1',
        producer: { configuration: 'Release' }
    }, null, 2)}\n`);
    write(root, policy.mainApplication.project, `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <SpaRoot>..\\frontend</SpaRoot>
    <ClientWwwRootPublishDir>wwwroot</ClientWwwRootPublishDir>
  </PropertyGroup>
  <Target Name="PublishClient"><Copy SourceFiles="@(ClientDistFiles)" /></Target>
</Project>
`);
    write(root, 'src/core/FsusBlog.Core.csproj', '<Project Sdk="Microsoft.NET.Sdk" />\n');
    write(root, 'src/migration/FsusBlog.Migration.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
</Project>
`);
    write(root, policy.mainApplication.dockerfile, 'FROM fixture\n');
    for (const [file, services] of Object.entries(policy.composeServices))
    {
        write(root, file, composeSource(Object.keys(services)));
    }
    write(root, policy.singleModeGuard.runtimeOptions, policy.singleModeGuard.runtimeRequiredTokens.join('\n'));
    write(root, policy.singleModeGuard.bootstrap, policy.singleModeGuard.bootstrapOrderedTokens.join('\n'));
    write(root, 'src/backend/Entities/Article.cs', 'namespace FsusBlog.Server.Entities;\n');
    write(root, 'src/core/Algorithms/Codec.cs', 'namespace FsusBlog.Core.Algorithms;\n');
    write(root, policy.documentation.boundary, [
        ...policy.documentation.requiredPhrases,
        ...policy.documentation.requiredIssueTitles
    ].join('\n'));
    const link = path.posix.basename(policy.documentation.boundary);
    for (const owner of policy.documentation.linkedFrom)
    {
        write(root, owner, `[boundary](${link})\n`);
    }
    return { root, policy };
}

function checkFixture(root)
{
    return checkMonolithicDistributedArchitecture({ root, files: listFiles(root) });
}

function evaluationUnitAuthority()
{
    const user = spawnSync('systemctl', ['--user', 'show-environment']);
    if (user.status === 0)
    {
        return {
            controlCommand: 'systemctl',
            controlPrefix: ['--user'],
            runCommand: 'systemd-run',
            runPrefix: ['--user']
        };
    }
    assert.equal(spawnSync('sudo', ['-n', '/usr/bin/true']).status, 0);
    return {
        controlCommand: 'sudo',
        controlPrefix: ['-n', 'systemctl'],
        runCommand: 'sudo',
        runPrefix: ['-n', 'systemd-run', `--uid=${process.getuid()}`]
    };
}

function controlEvaluationUnit(authority, args)
{
    return spawnSync(authority.controlCommand, [...authority.controlPrefix, ...args], { encoding: 'utf8' });
}

function evaluationUnits(authority, pattern)
{
    const result = controlEvaluationUnit(authority, [
        'list-units',
        '--all',
        '--no-legend',
        '--plain',
        pattern
    ]);
    assert.equal(result.status, 0);
    return String(result.stdout).trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/u)[0]).sort();
}

test.after(() =>
{
    for (const root of temporaryRoots)
    {
        rmSync(root, { recursive: true, force: true });
    }
});

test('accepts the canonical repository', () =>
{
    assert.deepEqual(checkMonolithicDistributedArchitecture({ root: repositoryRoot }).errors, []);
});

test('accepts a minimal monolithic distributed fixture with an offline migration tool', () =>
{
    const { root } = createFixture();
    assert.deepEqual(checkFixture(root).errors, []);
});

test('rejects a second business entrypoint and application Dockerfile', () =>
{
    const { root } = createFixture();
    write(root, 'src/comments/Comments.Service.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
    write(root, 'ops/docker/Comments.Service.Dockerfile', 'FROM fixture\n');
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
    assert.ok(errors.some((error) => error.includes('exactly one application Dockerfile')));
});

test('rejects a second business entrypoint declared by a single-quoted Web SDK attribute', () =>
{
    const { root } = createFixture();
    write(root, 'src/comments/SingleQuoted.Service.csproj', "<Project Sdk='Microsoft.NET.Sdk.Web' />\n");
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/comments/SingleQuoted.Service.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects a second business entrypoint declared by a child Web SDK element', () =>
{
    const { root } = createFixture();
    write(root, 'src/comments/ChildSdk.Service.csproj', `
<Project>
  <Sdk Name="Microsoft.NET.Sdk.Web" />
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/comments/ChildSdk.Service.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects an unclassified executable whose OutputType carries a condition', () =>
{
    const { root } = createFixture();
    write(root, 'src/tools/ConditionalTool.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType Condition="'$(Configuration)' == 'Debug'">Exe</OutputType>
  </PropertyGroup>
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/tools/ConditionalTool.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects an executable enabled only by the canonical Production configuration', () =>
{
    const { root } = createFixture();
    write(root, 'src/tools/ReleaseOnlyTool.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType Condition="'$(Configuration)' == 'Release'">Exe</OutputType>
  </PropertyGroup>
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/tools/ReleaseOnlyTool.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects a Web SDK enabled only by the canonical Production configuration', () =>
{
    const { root } = createFixture();
    write(root, 'src/comments/ConditionalWeb.Service.csproj', `
<Project>
  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk.Web" Condition="'$(Configuration)' == 'Release'" />
  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" Condition="'$(Configuration)' != 'Release'" />
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk.Web" Condition="'$(Configuration)' == 'Release'" />
  <Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk" Condition="'$(Configuration)' != 'Release'" />
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/comments/ConditionalWeb.Service.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects an executable enabled only for one evaluated target framework', () =>
{
    const { root } = createFixture();
    write(root, 'src/tools/TargetFrameworkTool.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net9.0;net10.0</TargetFrameworks>
    <OutputType Condition="'$(TargetFramework)' == 'net10.0'">Exe</OutputType>
  </PropertyGroup>
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/tools/TargetFrameworkTool.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('fails closed when the canonical Production configuration is not a literal name', () =>
{
    const { root } = createFixture();
    write(root, 'tests/governance/backend-production-build-consumers.json', `${JSON.stringify({
        schema: 'fsusblog.backend-production-build-consumers.v1',
        producer: { configuration: '$(UnknownConfiguration)' }
    }, null, 2)}\n`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.includes('production build configuration authority is missing or invalid'));
    assert.ok(errors.some((error) => error.includes('configuration-authority-invalid')));
});

test('fails closed on an unknown evaluated OutputType without echoing its value', () =>
{
    const { root } = createFixture();
    write(root, 'src/tools/UnknownOutputTool.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>reviewer-secret-output-type</OutputType>
  </PropertyGroup>
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('unsupported-output-type')));
    assert.ok(errors.every((error) => !error.includes('reviewer-secret-output-type')));
});

test('rejects unexpected top-level MSBuild evaluation fields', () =>
{
    assert.throws(() => parseMsbuildEvaluationEnvelope(JSON.stringify({
        schema: 'fsusblog.msbuild-entrypoint-evaluation.v1',
        projects: [],
        UnexpectedTopLevel: 'reviewer-secret'
    }), []), /invalid-evaluation-envelope/u);
});

test('rejects unexpected top-level fields in the raw MSBuild property result', () =>
{
    assert.throws(() => parseMsbuildPropertyDocument(JSON.stringify({
        Properties: {
            OutputType: 'Library',
            TargetFramework: 'net10.0',
            TargetFrameworks: '',
            UsingMicrosoftNETSdkWeb: ''
        },
        UnexpectedTopLevel: 'reviewer-secret'
    })), /invalid-property-shape/u);
});

test('keeps MSBuild evaluation networkless, read-only, and on an exact environment allowlist', () =>
{
    assert.deepEqual(msbuildSandboxProperties(['/fixture', '/tooling']), [
        'RuntimeMaxSec=45s',
        'TimeoutStopSec=5s',
        'KillMode=control-group',
        'SendSIGKILL=yes',
        'PrivateNetwork=yes',
        'RestrictAddressFamilies=AF_UNIX',
        'ProtectSystem=strict',
        'ProtectHome=tmpfs',
        'PrivateTmp=yes',
        'NoNewPrivileges=yes',
        'RestrictSUIDSGID=yes',
        'LockPersonality=yes',
        'ProtectKernelTunables=yes',
        'ProtectControlGroups=yes',
        'UMask=0077',
        'BindReadOnlyPaths=/fixture',
        'BindReadOnlyPaths=/tooling'
    ]);
    assert.deepEqual(msbuildEvaluationEnvironment('/opt/dotnet/dotnet'), [
        'PATH=/usr/bin:/bin',
        'LANG=C.UTF-8',
        'DOTNET_ROOT=/opt/dotnet',
        'HOME=/tmp',
        'DOTNET_CLI_HOME=/tmp',
        'TMPDIR=/tmp',
        'DOTNET_CLI_TELEMETRY_OPTOUT=1',
        'DOTNET_CLI_USE_MSBUILD_SERVER=0',
        'DOTNET_MULTILEVEL_LOOKUP=0',
        'DOTNET_NOLOGO=1',
        'DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1',
        'MSBUILDENABLEALLPROPERTYFUNCTIONS=0',
        'MSBUILDDISABLENODEREUSE=1',
        'MSBUILDTERMINALLOGGER=off'
    ]);
});

test('terminates the exact MSBuild sandbox unit and every descendant after its hard deadline', () =>
{
    const { root } = createFixture();
    const fifo = path.join(root, 'blocking-property-input');
    assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
    write(root, 'src/000-timeout/BlockingTool.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>$([System.IO.File]::ReadAllText('${fifo}'))</OutputType>
  </PropertyGroup>
</Project>
`);

    const neighbor = `fsusblog-msbuild-entrypoints-neighbor-${process.pid}-${Date.now()}.service`;
    const authority = evaluationUnitAuthority();
    const started = spawnSync(authority.runCommand, [
        ...authority.runPrefix,
        '--quiet',
        `--unit=${neighbor}`,
        '--property=RuntimeMaxSec=30s',
        '/usr/bin/sleep',
        '30'
    ]);
    assert.equal(started.status, 0);
    try
    {
        const ownUnitPattern = `fsusblog-msbuild-entrypoints-${process.pid}-*.service`;
        assert.deepEqual(evaluationUnits(authority, ownUnitPattern), []);
        const result = checkMonolithicDistributedArchitecture({
            root,
            files: listFiles(root),
            sandboxRuntimeMaxSeconds: 1
        });
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((error) => error.includes('sandbox-evaluation-failed')));
        assert.deepEqual(evaluationUnits(authority, ownUnitPattern), []);
        assert.equal(controlEvaluationUnit(authority, ['is-active', '--quiet', neighbor]).status, 0);
    }
    finally
    {
        controlEvaluationUnit(authority, ['stop', neighbor]);
        controlEvaluationUnit(authority, ['reset-failed', neighbor]);
    }
});

test('isolates MSBuild property-function reads and never echoes host secrets', () =>
{
    const { root } = createFixture();
    const hostRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-msbuild-host-secret-'));
    temporaryRoots.push(hostRoot);
    const secretFile = path.join(hostRoot, 'secret.txt');
    const secret = 'REVIEWER_SECRET_MUST_NOT_ESCAPE';
    writeFileSync(secretFile, secret);
    write(root, 'src/tools/SecretReader.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>$([System.IO.File]::ReadAllText('${secretFile}'))</OutputType>
  </PropertyGroup>
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('cannot evaluate MSBuild project src/tools/SecretReader.csproj')));
    assert.ok(errors.every((error) => !error.includes(secret)));
});

test('does not inherit unrestricted property functions or permit host writes', () =>
{
    const { root } = createFixture();
    const hostRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-msbuild-host-write-'));
    temporaryRoots.push(hostRoot);
    const marker = path.join(hostRoot, 'marker.txt');
    write(root, 'src/tools/SecretWriter.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>$([System.IO.File]::WriteAllText('${marker}', 'written'))Exe</OutputType>
  </PropertyGroup>
</Project>
`);
    const previous = process.env.MSBUILDENABLEALLPROPERTYFUNCTIONS;
    process.env.MSBUILDENABLEALLPROPERTYFUNCTIONS = '1';
    try
    {
        const errors = checkFixture(root).errors;
        assert.ok(errors.some((error) => error.includes('cannot evaluate MSBuild project src/tools/SecretWriter.csproj')));
        assert.ok(errors.every((error) => !error.includes(marker)));
    }
    finally
    {
        if (previous === undefined)
        {
            delete process.env.MSBUILDENABLEALLPROPERTYFUNCTIONS;
        }
        else
        {
            process.env.MSBUILDENABLEALLPROPERTYFUNCTIONS = previous;
        }
    }
    assert.equal(existsSync(marker), false);
});

test('rejects a second business entrypoint declared by expanded Web SDK imports', () =>
{
    const { root } = createFixture();
    write(root, 'src/comments/ExpandedSdk.Service.csproj', `
<Project>
  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk.Web" />
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk.Web" />
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/comments/ExpandedSdk.Service.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects an executable OutputType supplied by an imported props file', () =>
{
    const { root } = createFixture();
    write(root, 'src/tools/Executable.props', `
<Project>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
</Project>
`);
    write(root, 'src/tools/ImportedTool.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <Import Project="Executable.props" />
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/tools/ImportedTool.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects a Web SDK entrypoint whose project attribute uses an XML entity', () =>
{
    const { root } = createFixture();
    write(root, 'src/comments/EntitySdk.Service.csproj', '<Project Sdk="Microsoft.NET.Sdk.&#x57;eb" />\n');
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/comments/EntitySdk.Service.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects the classified migration tool when evaluated SDK imports make it a Web application', () =>
{
    const { root } = createFixture();
    write(root, 'src/migration/FsusBlog.Migration.csproj', `
<Project>
  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk.Web" />
  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk.Web" />
</Project>
`);
    const result = checkFixture(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('non-business tool must not use the Web SDK')));
});

test('fails closed when an imported MSBuild project cannot be evaluated', () =>
{
    const { root } = createFixture();
    write(root, 'src/tools/UnknownImport.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <Import Project="missing-executable.props" />
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('cannot evaluate MSBuild project src/tools/UnknownImport.csproj')));
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/tools/UnknownImport.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('does not treat an unclassified executable project as a non-business tool', () =>
{
    const { root } = createFixture();
    write(root, 'src/tools/LooseTool.csproj', `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
</Project>
`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/tools/LooseTool.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects missing or drifted executable project classifications', () =>
{
    const { root, policy } = createFixture();
    delete policy.executableProjectClassifications['src/migration/FsusBlog.Migration.csproj'];
    policy.executableProjectClassifications['src/core/FsusBlog.Core.csproj'] = 'non-business-tool';
    write(root, 'tests/governance/monolithic-distributed-architecture.json', `${JSON.stringify(policy, null, 2)}\n`);
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('has no architecture classification: src/migration/FsusBlog.Migration.csproj')));
    assert.ok(errors.some((error) => error.includes('classified executable project is missing or no longer executable: src/core/FsusBlog.Core.csproj')));
    assert.ok(errors.some((error) => error.includes('exactly one business entrypoint')));
});

test('rejects a Web application disguised as a non-business tool', () =>
{
    const { root, policy } = createFixture();
    write(root, 'src/comments/Comments.Tool.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
    policy.executableProjectClassifications['src/comments/Comments.Tool.csproj'] = 'non-business-tool';
    write(root, 'tests/governance/monolithic-distributed-architecture.json', `${JSON.stringify(policy, null, 2)}\n`);
    assert.ok(checkFixture(root).errors.some((error) => error.includes('non-business tool must not use the Web SDK')));
});

test('rejects an unclassified fixed business sidecar', () =>
{
    const { root } = createFixture();
    write(root, 'ops/docker/docker-compose.production.yml', composeSource(['fsusblog.server', 'comments.worker']));
    assert.ok(checkFixture(root).errors.some((error) => error.includes('Compose services drifted')));
});

test('keeps domain code infrastructure-free and remote invocation behind ports or adapters', () =>
{
    const { root } = createFixture();
    write(root, 'src/backend/Entities/RemoteArticle.cs', 'using System.Net.Http; class RemoteArticle { HttpClient Client = new(); }\n');
    write(root, 'src/backend/Services/RemoteArticleService.cs', 'class RemoteArticleService { RemoteModuleInvoker Invoker = null!; }\n');
    let errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('depends on remote or infrastructure namespace')));
    assert.ok(errors.some((error) => error.includes('depends on node-location or transport implementation')));
    assert.ok(errors.some((error) => error.includes('port or adapter boundary')));

    rmSync(path.join(root, 'src/backend/Services/RemoteArticleService.cs'));
    write(root, 'src/backend/Infrastructure/Distributed/RemoteModuleInvoker.cs', 'class RemoteModuleInvoker { }\n');
    errors = checkFixture(root).errors;
    assert.equal(errors.some((error) => error.includes('Infrastructure/Distributed/RemoteModuleInvoker.cs')), false);
});

test('rejects documentation drift and fixed-service assertions', () =>
{
    const { root, policy } = createFixture();
    write(root, policy.documentation.boundary, '单体分布式\nFsusBlog 是微服务架构\n');
    write(root, 'docs/architecture.md', 'missing boundary link\n');
    const errors = checkFixture(root).errors;
    assert.ok(errors.some((error) => error.includes('missing wording')));
    assert.ok(errors.some((error) => error.includes('must link')));
    assert.ok(errors.some((error) => error.includes('fixed-service architecture assertion is forbidden')));
});

test('rejects a single-mode bootstrap whose local fast path is reversed', () =>
{
    const { root, policy } = createFixture();
    write(root, policy.singleModeGuard.bootstrap, [...policy.singleModeGuard.bootstrapOrderedTokens].reverse().join('\n'));
    assert.ok(checkFixture(root).errors.some((error) => error.includes('ordering is missing or reversed')));
});
