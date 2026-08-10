import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveRuntimeProfile } from '../../tools/runtime-profiles/runtime-publish-profile.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const dockerfile = fs.readFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
const bashExecutable = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const releaseId = '20260715010101-0123456789ab';
const releaseCreatedAtUtc = '2026-07-15T01:01:01Z';
const commitSha = '0123456789abcdef0123456789abcdef01234567';

const pins = {
    runtimeVersion: '10.0.10',
    sdkVersion: '10.0.302',
    aspnetMusl: 'sha256:27b6b84beeede74fd16886177d360799c8e4299ceadfbd64eef57bafead7878a',
    aspnetGlibc: 'sha256:1fa23fc4872d95fd71c2833ebe65d7e84a43b2d51a31d119516852f13d9505a7',
    sdkMusl: 'sha256:d8ee39817ca03a3757288e83c37ed73cc969a286c603b827c7cbe33add1c2d1c',
    sdkGlibc: 'sha256:ed034a8bf0b24ded0cbbac07e17825d8e9ebfe21e308191d0f7421eaf5ad4664',
    nodeVersion: '24.17.0',
    nodeMusl: 'sha256:7c70d1235c0b4c2bc9eeed5393d19f1bbdde6885ba0d58ba62bb385d7b0f3ff1',
    nodeGlibc: 'sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532'
};

function frontendBuildStageCopies()
{
    const stageStart = dockerfile.indexOf('FROM node-runtime-musl AS frontend-build');
    const stageEnd = dockerfile.indexOf('FROM base AS final');
    assert.notEqual(stageStart, -1, 'frontend build stage is missing');
    assert.notEqual(stageEnd, -1, 'final stage is missing');
    const copies = [];
    for (const line of dockerfile.slice(stageStart, stageEnd).split(/\r?\n/u))
    {
        const match = /^COPY\s+(?!.*--from=)(\S+)\s+(\S+)\s*$/u.exec(line);
        if (match)
        {
            copies.push({ source: match[1], destination: match[2] });
        }
    }
    return copies;
}

function frontendStageCopiesRepositoryFile(copies, file)
{
    const normalized = file.replaceAll('\\', '/');
    const expectedDestination = `/${normalized}`;
    return copies.some(({ source, destination }) =>
    {
        const root = source.replace(/\/$/u, '');
        if (source.endsWith('/'))
        {
            if (!normalized.startsWith(`${root}/`))
            {
                return false;
            }
            const relative = normalized.slice(root.length + 1);
            return path.posix.normalize(path.posix.join(destination, relative)) === expectedDestination;
        }
        return normalized === source && path.posix.normalize(destination) === expectedDestination;
    });
}

function staticallyKnownModuleDependencies(file)
{
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const specifiers = new Set();
    for (const match of source.matchAll(/^\s*import(?:[\s\S]*?\sfrom)?\s*['"](\.{1,2}\/[^'"]+)['"]/gmu))
    {
        specifiers.add(match[1]);
    }
    for (const match of source.matchAll(/\b(?:import\s*\()?new URL\(\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]\s*,\s*import\.meta\.url\s*\)/gu))
    {
        specifiers.add(match[1]);
    }
    return [...specifiers].map((specifier) => path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier)
    ));
}

function restoreStageProjectCopies()
{
    const stageStart = dockerfile.indexOf('FROM build-${RUNTIME_BASE_FLAVOR} AS build');
    const restore = dockerfile.indexOf('dotnet restore "./src/backend/FsusBlog.Server.csproj"', stageStart);
    assert.notEqual(stageStart, -1, 'build stage is missing');
    assert.notEqual(restore, -1, 'backend restore is missing');
    const copies = [];
    for (const line of dockerfile.slice(stageStart, restore).split(/\r?\n/u))
    {
        const match = /^COPY\s+(\[.*\])\s*$/u.exec(line);
        if (!match)
        {
            continue;
        }
        const [source, destination] = JSON.parse(match[1]);
        copies.push({ source, destination });
    }
    return copies;
}

function projectReferenceClosure(initialProjects)
{
    const pending = [...initialProjects];
    const closure = new Set();
    while (pending.length > 0)
    {
        const project = pending.pop();
        if (closure.has(project))
        {
            continue;
        }
        closure.add(project);
        const source = fs.readFileSync(path.join(root, project), 'utf8');
        for (const match of source.matchAll(/<ProjectReference\b[^>]*\bInclude="([^"]+)"/gu))
        {
            const resolved = path.posix.normalize(path.posix.join(
                path.posix.dirname(project),
                match[1].replaceAll('\\', '/')
            ));
            assert.equal(resolved.startsWith('../'), false, `ProjectReference escapes repository: ${project}`);
            pending.push(resolved);
        }
    }
    return closure;
}

function restoreStageCopiesProject(copies, project)
{
    const expectedDestination = `/src/${project}`;
    return copies.some(({ source, destination }) => (
        source === project
      && path.posix.join('/src', destination, path.posix.basename(source)) === expectedDestination
    ));
}

test('final Dockerfile pins musl and glibc .NET and Node images to one patch set', () =>
{
    for (const [name, value] of [
        ['DOTNET_RUNTIME_VERSION', pins.runtimeVersion],
        ['DOTNET_SDK_VERSION', pins.sdkVersion],
        ['DOTNET_ASPNET_MUSL_DIGEST', pins.aspnetMusl],
        ['DOTNET_ASPNET_GLIBC_DIGEST', pins.aspnetGlibc],
        ['DOTNET_SDK_MUSL_DIGEST', pins.sdkMusl],
        ['DOTNET_SDK_GLIBC_DIGEST', pins.sdkGlibc],
        ['NODE_VERSION', pins.nodeVersion],
        ['NODE_MUSL_DIGEST', pins.nodeMusl],
        ['NODE_GLIBC_DIGEST', pins.nodeGlibc]
    ])
    {
        assert.match(dockerfile, new RegExp(`ARG ${name}=${value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
    }

    assert.match(dockerfile, /aspnet:\$\{DOTNET_RUNTIME_VERSION\}-alpine3\.23@\$\{DOTNET_ASPNET_MUSL_DIGEST\}/u);
    assert.match(dockerfile, /aspnet:\$\{DOTNET_RUNTIME_VERSION\}-noble@\$\{DOTNET_ASPNET_GLIBC_DIGEST\}/u);
    assert.match(dockerfile, /sdk:\$\{DOTNET_SDK_VERSION\}-alpine3\.23@\$\{DOTNET_SDK_MUSL_DIGEST\}/u);
    assert.match(dockerfile, /sdk:\$\{DOTNET_SDK_VERSION\}-noble@\$\{DOTNET_SDK_GLIBC_DIGEST\}/u);
    assert.match(dockerfile, /FROM node:\$\{NODE_VERSION\}-alpine3\.23@\$\{NODE_MUSL_DIGEST\} AS node-runtime-musl/u);
    assert.match(dockerfile, /FROM node:\$\{NODE_VERSION\}-bookworm-slim@\$\{NODE_GLIBC_DIGEST\} AS node-runtime-glibc/u);
    assert.match(dockerfile, /COPY --from=node-runtime-musl \/usr\/local\/bin\/node \/usr\/local\/bin\/node/u);
    assert.match(dockerfile, /COPY --from=node-runtime-glibc \/usr\/local\/bin\/node \/usr\/local\/bin\/node/u);
    assert.doesNotMatch(dockerfile, /\bnodejs\b/u);
    const buildMusl = dockerfile.slice(
        dockerfile.indexOf(' AS build-musl'),
        dockerfile.indexOf(' AS build-glibc')
    );
    const buildGlibc = dockerfile.slice(
        dockerfile.indexOf(' AS build-glibc'),
        dockerfile.indexOf('FROM build-${RUNTIME_BASE_FLAVOR} AS build')
    );
    for (const [stage, source] of [[buildMusl, 'node-runtime-musl'], [buildGlibc, 'node-runtime-glibc']])
    {
        assert.ok(stage.includes(`COPY --from=${source} /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm`));
        assert.doesNotMatch(stage, new RegExp(`COPY --from=${source} /usr/local/bin/npm /usr/local/bin/npx`, 'u'));
        assert.match(stage, /ln -sfn \.\.\/lib\/node_modules\/npm\/bin\/npm-cli\.js \/usr\/local\/bin\/npm/u);
        assert.match(stage, /ln -sfn \.\.\/lib\/node_modules\/npm\/bin\/npx-cli\.js \/usr\/local\/bin\/npx/u);
        assert.match(stage, /test "\$\(node --version\)" = "v\$\{NODE_VERSION\}"/u);
        assert.match(stage, /test "\$\(npm --version\)" = "11\.13\.0"/u);
        assert.match(stage, /test "\$\(npx --version\)" = "11\.13\.0"/u);
    }
    const baseStages = dockerfile.slice(dockerfile.indexOf(' AS base-musl'), dockerfile.indexOf('FROM base-${RUNTIME_BASE_FLAVOR} AS base'));
    assert.equal(baseStages.match(/! command -v npm/gu)?.length, 2);
    const wasmBuilder = dockerfile.slice(
        dockerfile.indexOf('FROM emscripten/emsdk:'),
        dockerfile.indexOf('FROM scratch AS wasm-artifact')
    );
    assert.match(wasmBuilder, /COPY --from=node-runtime-glibc \/usr\/local\/bin\/node \/usr\/local\/bin\/node\s+ENV PATH="\/usr\/local\/bin:\$\{PATH\}"\s+RUN test "\$\(node --version\)" = "v\$\{NODE_VERSION\}"/u);
    for (const label of [
        'io.fsusblog.runtime.dotnet-version',
        'io.fsusblog.build.dotnet-sdk-version',
        'io.fsusblog.runtime.base-image',
        'io.fsusblog.runtime.base-image-digest',
        'io.fsusblog.build.sdk-image',
        'io.fsusblog.build.sdk-image-digest',
        'io.fsusblog.runtime.node-version',
        'io.fsusblog.runtime.node-image',
        'io.fsusblog.runtime.node-image-digest',
        'io.fsusblog.runtime.gc-heap-count-mode',
        'io.fsusblog.runtime.gc-heap-hard-limit-mode',
        'io.fsusblog.runtime.gc-heap-hard-limit-percent',
        'io.fsusblog.runtime.thread-pool-min-threads-per-cpu'
    ])
    {
        assert.ok(dockerfile.includes(label), `missing ${label}`);
    }
});

test('frontend Docker stage copies the complete static module and child-script closure of its real build entrypoints', () =>
{
    const copies = frontendBuildStageCopies();
    const pending = [
        'tools/frontend/build.mjs',
        'tools/test/run-command-manifest.mjs'
    ];
    const visited = new Set();
    while (pending.length > 0)
    {
        const file = pending.pop();
        if (visited.has(file))
        {
            continue;
        }
        visited.add(file);
        assert.equal(
            frontendStageCopiesRepositoryFile(copies, file),
            true,
            `frontend Docker stage does not copy imported module ${file}`
        );
        pending.push(...staticallyKnownModuleDependencies(file));
    }
    assert.ok(visited.has('tools/test/command-manifest-runtime.mjs'));
    assert.ok(visited.has('tools/release/release-id.mjs'));
    for (const childScript of [
        'tools/frontend/ensure-wasm.mjs',
        'tools/frontend/generate-public-page-manifest.mjs',
        'tools/frontend/generate-public-shell-emergency.mjs',
        'tools/frontend/build-public-ssr-bundle.mjs'
    ])
    {
        assert.ok(visited.has(childScript), `frontend build does not audit child script ${childScript}`);
    }
});

test('Docker restore layer copies the recursive backend ProjectReference closure before restore', () =>
{
    const projects = projectReferenceClosure([
        'src/backend/FsusBlog.Server.csproj',
        'src/core/FsusBlog.Core.csproj',
        'src/shared/FsusBlog.Shared.csproj'
    ]);
    const copies = restoreStageProjectCopies();
    for (const project of projects)
    {
        assert.equal(
            restoreStageCopiesProject(copies, project),
            true,
            `Docker restore layer does not copy ProjectReference ${project}`
        );
    }
    assert.ok(projects.has('tools/architecture/FsusBlog.DiLifetimeAnalyzer/FsusBlog.DiLifetimeAnalyzer.csproj'));
});

test('frontend Docker stage validates transported Wasm before scoped ensure-wasm skipping', () =>
{
    const stageStart = dockerfile.indexOf('FROM node-runtime-musl AS frontend-build');
    const stageEnd = dockerfile.indexOf('FROM base AS final');
    const frontendStage = dockerfile.slice(stageStart, stageEnd);
    const checksumValidation = frontendStage.indexOf('RUN test -f public/wasm/SHA256SUMS');
    const envelopeValidation = frontendStage.indexOf('wasm-build-receipt.mjs verify-envelope');
    const buildRun = frontendStage.indexOf('RUN FSUSBLOG_SKIP_ENSURE_WASM=1 npm run build:release');
    assert.ok(checksumValidation >= 0, 'frontend stage must validate Wasm transport checksums');
    assert.ok(envelopeValidation > checksumValidation, 'frontend stage must verify the receipt envelope after checksums');
    assert.ok(buildRun > envelopeValidation, 'ensure-wasm may be skipped only after portable artifact validation');
    assert.equal(
        frontendStage.match(/FSUSBLOG_SKIP_ENSURE_WASM=1/gu)?.length,
        1,
        'ensure-wasm skip must be scoped to exactly one frontend build RUN'
    );
    assert.ok(
        frontendStage.indexOf('COPY tools/release/release-id.mjs /tools/release/release-id.mjs')
      > frontendStage.indexOf('npm ci'),
        'release identity module must remain outside the npm dependency cache layer'
    );
});

function runBuildWithInspect(t, labels, extraEnv = {})
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-toolchain-pin-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binDir = path.join(directory, 'bin');
    const dockerArgs = path.join(directory, 'docker-args.txt');
    const dockerRunArgs = path.join(directory, 'docker-run-args.txt');
    const inspectJson = JSON.stringify([{
        Id: `sha256:${'a'.repeat(64)}`,
        Config: { Labels: {
            'org.opencontainers.image.version': releaseId,
            'org.opencontainers.image.created': releaseCreatedAtUtc,
            'org.opencontainers.image.revision': commitSha,
            ...labels
        } }
    }]);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'node'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  */tools/check-wasm-artifact-ownership.mjs|*/tools/frontend/wasm-build-receipt.mjs) exit 0 ;;
esac
exec "${process.execPath}" "$@"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "build" ]]; then printf '%s\\n' "$*" > "${dockerArgs}"; exit 0; fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then printf '%s\\n' '${inspectJson}'; exit 0; fi
if [[ "\${1:-}" == "run" ]]; then printf '%s\\n' "$*" > "${dockerRunArgs}"; printf '%s\\n' 'v${pins.nodeVersion}'; exit 0; fi
exit 91
`, { mode: 0o755 });

    const result = spawnSync(bashExecutable, ['--noprofile', '--norc', path.join(root, 'tools/build-final-image.sh')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            GITHUB_PACKAGES_TOKEN: 'fixture-token',
            FSUSBLOG_COMMIT_SHA: commitSha,
            FSUSBLOG_RELEASE_ID: releaseId,
            FSUSBLOG_RELEASE_CREATED_AT_UTC: releaseCreatedAtUtc,
            FSUSBLOG_FINAL_IMAGE_REPOSITORY: 'fsusblogapp',
            FSUSBLOG_FINAL_IMAGE_TARGET: 'final',
            FSUSBLOG_FINAL_PUSH: '0',
            FSUSBLOG_FINAL_LOCAL_ONLY: '1',
            FSUSBLOG_FINAL_SKIP_WASM: '1',
            ...extraEnv
        }
    });
    return { result, dockerArgs, dockerRunArgs };
}

test('build-final passes the complete pin set and accepts matching inherited labels', (t) =>
{
    const runtimeProfile = resolveRuntimeProfile('throughput-musl');
    const runtimeImage = `mcr.microsoft.com/dotnet/aspnet:${pins.runtimeVersion}-alpine3.23@${pins.aspnetMusl}`;
    const sdkImage = `mcr.microsoft.com/dotnet/sdk:${pins.sdkVersion}-alpine3.23@${pins.sdkMusl}`;
    const nodeImage = `node:${pins.nodeVersion}-alpine3.23@${pins.nodeMusl}`;
    const { result, dockerArgs, dockerRunArgs } = runBuildWithInspect(t, {
        'io.fsusblog.runtime.dotnet-version': pins.runtimeVersion,
        'io.fsusblog.build.dotnet-sdk-version': pins.sdkVersion,
        'io.fsusblog.runtime.base-image': runtimeImage,
        'io.fsusblog.runtime.base-image-digest': pins.aspnetMusl,
        'io.fsusblog.build.sdk-image': sdkImage,
        'io.fsusblog.build.sdk-image-digest': pins.sdkMusl,
        'io.fsusblog.runtime.node-version': pins.nodeVersion,
        'io.fsusblog.runtime.node-image': nodeImage,
        'io.fsusblog.runtime.node-image-digest': pins.nodeMusl,
        'io.fsusblog.runtime.base-family': 'musl',
        'io.fsusblog.runtime.target-runtime': 'linux-musl-x64',
        'io.fsusblog.runtime.profile-id': runtimeProfile.profile.id,
        'io.fsusblog.runtime.profile-manifest-digest': runtimeProfile.digest,
        'io.fsusblog.runtime.profile-digest': runtimeProfile.profileDigest,
        'io.fsusblog.runtime.publish-single-file': 'true',
        'io.fsusblog.runtime.publish-ready-to-run': 'false',
        'io.fsusblog.runtime.tiered-pgo': 'true',
        'io.fsusblog.runtime.quick-jit-for-loops': 'true',
        'io.fsusblog.runtime.server-gc': 'true',
        'io.fsusblog.runtime.native-aot': 'false',
        'io.fsusblog.runtime.gc-heap-count-mode': 'container-default',
        'io.fsusblog.runtime.gc-heap-hard-limit-mode': 'container-limit',
        'io.fsusblog.runtime.gc-heap-hard-limit-percent': '0',
        'io.fsusblog.runtime.thread-pool-mode': 'runtime-default',
        'io.fsusblog.runtime.thread-pool-min-threads-per-cpu': '0',
        'io.fsusblog.runtime.topology-mode': 'smt-visible'
    });

    assert.equal(result.status, 0, result.stderr);
    const args = fs.readFileSync(dockerArgs, 'utf8');
    for (const [name, value] of [
        ['DOTNET_RUNTIME_VERSION', pins.runtimeVersion],
        ['DOTNET_SDK_VERSION', pins.sdkVersion],
        ['DOTNET_ASPNET_MUSL_DIGEST', pins.aspnetMusl],
        ['DOTNET_ASPNET_GLIBC_DIGEST', pins.aspnetGlibc],
        ['DOTNET_SDK_MUSL_DIGEST', pins.sdkMusl],
        ['DOTNET_SDK_GLIBC_DIGEST', pins.sdkGlibc],
        ['NODE_VERSION', pins.nodeVersion],
        ['NODE_MUSL_DIGEST', pins.nodeMusl],
        ['NODE_GLIBC_DIGEST', pins.nodeGlibc]
    ])
    {
        assert.ok(args.includes(`${name}=${value}`), `missing build arg ${name}`);
    }
    assert.match(result.stdout, /verified image toolchain identity: runtime=10\.0\.10 sdk=10\.0\.302 node=24\.17\.0/u);
    assert.match(fs.readFileSync(dockerRunArgs, 'utf8'), /node --version; if command -v npm/u);
});

test('build-final rejects a built image whose SDK provenance label drifts', (t) =>
{
    const { result } = runBuildWithInspect(t, {
        'io.fsusblog.runtime.dotnet-version': pins.runtimeVersion,
        'io.fsusblog.build.dotnet-sdk-version': '10.0.301'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /image identity mismatch io\.fsusblog\.build\.dotnet-sdk-version/u);
    assert.match(result.stderr, /built image toolchain identity is invalid/u);
});

test('build-final rejects a partial Node servicing override before Docker build', (t) =>
{
    const { result, dockerArgs } = runBuildWithInspect(t, {}, {
        FSUSBLOG_NODE_VERSION: '24.17.1'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FSUSBLOG_NODE_\* servicing overrides must replace the version and digest set together/u);
    assert.equal(fs.existsSync(dockerArgs), false);
});
