import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    copyFileSync,
    chmodSync,
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
const { checkMonolithicDistributedArchitecture } = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/governance/check-monolithic-distributed-architecture.mjs'
)).href);
const { observeRuntimeRoleDeploymentAuthority } = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/governance/check-monolithic-distributed-architecture.mjs'
)).href);
const sourcePolicy = path.join(repositoryRoot, 'tests/governance/monolithic-distributed-architecture.json');
const temporaryRoots = [];

function canonical(value)
{
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function resealPolicy(policy)
{
    const { contentDigest: _contentDigest, ...unsigned } = policy;
    policy.contentDigest = `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}`;
}

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
    mkdirSync(path.dirname(path.join(root, policy.mainApplication.dockerfile)), { recursive: true });
    copyFileSync(path.join(repositoryRoot, policy.mainApplication.dockerfile), path.join(root, policy.mainApplication.dockerfile));
    for (const [file, services] of Object.entries(policy.composeServices))
    {
        if (file === 'ops/docker/docker-compose.production.yml')
        {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
        }
        else
        {
            write(root, file, composeSource(Object.keys(services)));
        }
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

function createAuthorityFixture()
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-role-authority-'));
    temporaryRoots.push(root);
    for (const relative of [
        'tests/governance/monolithic-distributed-architecture.json',
        'src/backend/FsusBlog.Server.csproj',
        'ops/docker/FsusBlog.Server.Dockerfile',
        'ops/docker/docker-compose.production.yml'
    ])
    {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(repositoryRoot, relative), target);
    }
    return root;
}

function checkFixture(root)
{
    return checkMonolithicDistributedArchitecture({ root, files: listFiles(root) });
}

test.after(() =>
{
    for (const root of temporaryRoots)
    {
        rmSync(root, { recursive: true, force: true });
    }
});

test('accepts the canonical repository and a minimal monolithic distributed fixture', () =>
{
    assert.deepEqual(checkMonolithicDistributedArchitecture({ root: repositoryRoot }).errors, []);
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

test('deployment authority observes one process/service and exact blue-green mounts', () =>
{
    const root = createAuthorityFixture();
    const observation = observeRuntimeRoleDeploymentAuthority({ root });
    assert.equal(observation.ownership.claimEligible, true);
    assert.equal(observation.application.processEntrypoint.join(' '), './FsusBlog.Server');
    assert.equal(observation.application.image, '${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}');
    assert.deepEqual(observation.application.serviceRoster, ['fsusblog.server']);
    assert.deepEqual(observation.application.effectivePid1, ['./FsusBlog.Server']);
    assert.equal(observation.application.pid1Source, 'docker-final-entrypoint-no-compose-override');
    assert.equal(Object.keys(observation.volumeTopology).length, 10);
});

test('standalone and deployment observers reject an unknown production service', () =>
{
    const root = createAuthorityFixture();
    const compose = path.join(root, 'ops/docker/docker-compose.production.yml');
    const source = readFileSync(compose, 'utf8').replace(
        'services:\n',
        'services:\n    unknown.worker:\n        image: fixture\n'
    );
    writeFileSync(compose, source);
    const observation = observeRuntimeRoleDeploymentAuthority({ root });
    assert.equal(observation.ownership.claimEligible, false);
    assert.ok(observation.ownership.failureReasons.some((reason) => reason.includes('Compose effective services drifted')));
    assert.ok(checkFixture(root).errors.some((reason) => reason.includes('Compose services drifted')));
});

test('deployment authority rejects image and PID1 overrides', () =>
{
    for (const [label, mutate] of [
        ['image', (source) => source.replace(
            'image: ${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}',
            'image: mutable:latest')],
        ['entrypoint', (source) => source.replace(
            '        pull_policy: always',
            '        entrypoint: ["/bin/sh"]\n        pull_policy: always')],
        ['command', (source) => source.replace(
            '        pull_policy: always',
            '        command: ["serve"]\n        pull_policy: always')]
    ])
    {
        const root = createAuthorityFixture();
        const compose = path.join(root, 'ops/docker/docker-compose.production.yml');
        writeFileSync(compose, mutate(readFileSync(compose, 'utf8')));
        const observation = observeRuntimeRoleDeploymentAuthority({ root });
        assert.equal(observation.ownership.claimEligible, false, label);
        assert.ok(observation.ownership.failureReasons.some((reason) => reason.includes('immutable pulled image')), label);
    }
});

test('effective Compose oracle rejects extends, build, pull-policy and profile mutations', () =>
{
    for (const [label, prepare, pattern] of [
        [
            'extends image',
            (root, source) =>
            {
                write(root, 'ops/docker/runtime-base.yml', 'services:\n  base:\n    image: mutable:latest\n');
                return source
                    .replace('        image: ${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}\n', '')
                    .replace('        pull_policy: always', '        extends:\n            file: runtime-base.yml\n            service: base\n        pull_policy: always');
            },
            /immutable pulled image/u
        ],
        [
            'build',
            (_root, source) => source.replace(
                '        pull_policy: always',
                '        build: ../..\n        pull_policy: always'),
            /immutable pulled image/u
        ],
        [
            'pull policy',
            (_root, source) => source.replace('        pull_policy: always', '        pull_policy: missing'),
            /immutable pulled image/u
        ],
        [
            'profile hidden',
            (_root, source) => source.replace(
                '        pull_policy: always',
                '        profiles: [manual]\n        pull_policy: always'),
            /effective services drifted/u
        ]
    ])
    {
        const root = createAuthorityFixture();
        const compose = path.join(root, 'ops/docker/docker-compose.production.yml');
        writeFileSync(compose, prepare(root, readFileSync(compose, 'utf8')));
        const observation = observeRuntimeRoleDeploymentAuthority({ root });
        assert.equal(observation.ownership.claimEligible, false, label);
        assert.match(observation.ownership.failureReasons.join('\n'), pattern, label);
    }
});

test('effective Compose oracle rejects a PATH-prepended fake Docker executable', () =>
{
    const root = createAuthorityFixture();
    const fakeBin = path.join(root, 'fake-bin');
    write(root, 'fake-bin/docker', '#!/usr/bin/env bash\nexec /usr/bin/docker "$@"\n');
    chmodSync(path.join(fakeBin, 'docker'), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
    try
    {
        const observation = observeRuntimeRoleDeploymentAuthority({ root });
        assert.equal(observation.ownership.claimEligible, false);
        assert.ok(observation.ownership.failureReasons.some((reason) =>
            /trusted non-symlink system binary/u.test(reason)));
    }
    finally
    {
        process.env.PATH = originalPath;
    }
});

test('deployment authority rejects a Docker CMD tail that changes PID1 arguments', () =>
{
    const root = createAuthorityFixture();
    const dockerfile = path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile');
    const source = readFileSync(dockerfile, 'utf8').replace(
        'ENTRYPOINT ["./FsusBlog.Server"]',
        'ENTRYPOINT ["./FsusBlog.Server"]\nCMD ["serve"]'
    );
    writeFileSync(dockerfile, source);
    const observation = observeRuntimeRoleDeploymentAuthority({ root });
    assert.equal(observation.ownership.claimEligible, false);
    assert.ok(observation.ownership.failureReasons.some((reason) => reason.includes('no CMD tail')));
});

test('deployment authority rejects a second final process entrypoint', () =>
{
    const root = createAuthorityFixture();
    const dockerfile = path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile');
    const source = readFileSync(dockerfile, 'utf8').replace(
        'ENTRYPOINT ["./FsusBlog.Server"]',
        'ENTRYPOINT ["./FsusBlog.Server"]\nENTRYPOINT ["dotnet", "Other.dll"]'
    );
    writeFileSync(dockerfile, source);
    const observation = observeRuntimeRoleDeploymentAuthority({ root });
    assert.equal(observation.ownership.claimEligible, false);
    assert.ok(observation.ownership.failureReasons.some((reason) => reason.includes('exactly the authority-owned')));
});

test('deployment authority rejects resealed cross-scope slot-private volume identity', () =>
{
    const root = createAuthorityFixture();
    const policyPath = path.join(root, 'tests/governance/monolithic-distributed-architecture.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.blueGreenMounts['/app/data'].source = 'fsus-storage';
    policy.blueGreenMounts['/app/data'].volumeName = '${FSUSBLOG_STORAGE_VOLUME:-fsusblog-storage}';
    resealPolicy(policy);
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 4)}\n`);
    const compose = path.join(root, 'ops/docker/docker-compose.production.yml');
    const source = readFileSync(compose, 'utf8').replace(
        'fsus-slot-data:/app/data',
        'fsus-storage:/app/data'
    );
    writeFileSync(compose, source);
    const observation = observeRuntimeRoleDeploymentAuthority({ root });
    assert.equal(observation.ownership.claimEligible, false);
    assert.ok(observation.ownership.failureReasons.some((reason) =>
        reason.includes('/app/data slot-private identity must be slot-specific')
        || reason.includes('identity crosses slot-private and shared scope')));
});

test('deployment authority rejects a missing Dockerfile in a freshly sealed observation', () =>
{
    const root = createAuthorityFixture();
    rmSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'));
    const observation = observeRuntimeRoleDeploymentAuthority({ root });
    assert.equal(observation.schema, 'fsusblog.runtime-role-deployment-observation.v1');
    assert.match(observation.observationDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(observation.ownership.claimEligible, false);
    assert.ok(observation.ownership.failureReasons.some((reason) =>
        reason.includes('cannot read ops/docker/FsusBlog.Server.Dockerfile')));
});

test('deployment authority rejects a resealed but reversed role-separation claim', () =>
{
    const root = createAuthorityFixture();
    const policyPath = path.join(root, 'tests/governance/monolithic-distributed-architecture.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.runtimeRoleOwnership.separation = 'runtime-roles-are-independent-services';
    resealPolicy(policy);
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 4)}\n`);
    const observation = observeRuntimeRoleDeploymentAuthority({ root });
    assert.equal(observation.ownership.claimEligible, false);
    assert.ok(observation.ownership.failureReasons.some((reason) => reason.includes('unsupported split deployments')));
});
