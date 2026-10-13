import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { resolveRuntimeProfile } = await import(new URL('../../tools/runtime-profiles/runtime-publish-profile.mjs', import.meta.url));

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const dockerfile = fs.readFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
const backendInputInventory = JSON.parse(fs.readFileSync(
    path.join(root, 'config/build/backend-docker-inputs.json'),
    'utf8'
));
const bashExecutable = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const releaseId = '20260715010101-0123456789ab';
const releaseCreatedAtUtc = '2026-07-15T01:01:01Z';
const commitSha = '0123456789abcdef0123456789abcdef01234567';

test('current-native-task is a separate local tool target and never changes production Server publication', () =>
{
    const finalStage = dockerfile.split('FROM base AS final\n')[1]?.split('FROM final AS current-native-task\n')[0];
    assert.ok(finalStage);
    assert.doesNotMatch(finalStage, /migration/iu);
    assert.match(finalStage, /ENTRYPOINT \["\.\/FsusBlog\.Server"\]/u);
    const taskStage = dockerfile.split('FROM final AS current-native-task\n')[1]?.split('FROM base AS debug-final\n')[0];
    assert.ok(taskStage);
    assert.match(taskStage, /COPY --from=migration-publish[^\n]+\/app\/tools\/migration/u);
    assert.doesNotMatch(taskStage, /^(?:ENTRYPOINT|CMD)\s/gmu);
    const buildSource = fs.readFileSync(path.join(root, 'tools/build-final-image.sh'), 'utf8');
    assert.match(buildSource, /current-native-task\)[\s\S]*?LOCAL_ONLY" == "1" && "\$PUSH_IMAGE" == "0"/u);
    assert.match(buildSource, /TASK_TOOL_ARGS=\(--tool migration\)/u);
    assert.match(buildSource, /createCurrentNativeTaskToolImageBinding/u);
    assert.match(buildSource, /flag: "wx"/u);
    assert.match(buildSource, /--network none --read-only --cap-drop ALL/u);
});

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
            const copiedDestination = path.posix.normalize(path.posix.join(destination, relative));
            if (copiedDestination === expectedDestination)
            {
                return true;
            }
            return root === 'src/frontend'
                && destination === './'
                && copiedDestination === relative
                && dockerfile.includes(
                    'RUN mkdir -p /src && ln -s /app /src/frontend && test "$(readlink /src/frontend)" = /app'
                );
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

function releaseBackendCompileProducerViolations(source)
{
    const buildStart = source.indexOf('FROM build-${RUNTIME_BASE_FLAVOR} AS build');
    const publishStart = source.indexOf('FROM build AS publish', buildStart);
    const debugPublishStart = source.indexOf('FROM build AS publish-debug', publishStart);
    if (buildStart < 0 || publishStart < 0 || debugPublishStart < 0)
    {
        return ['release backend build/publish stages are missing'];
    }

    const buildStage = source.slice(buildStart, publishStart);
    const releaseStages = source.slice(buildStart, debugPublishStart);
    const publishStage = source.slice(publishStart, debugPublishStart);
    const violations = [];
    if (/\bdotnet\s+build\b/u.test(releaseStages))
    {
        violations.push('release backend path must not run standalone dotnet build');
    }
    if (releaseStages.includes('/app/build'))
    {
        violations.push('release backend path must not materialize /app/build');
    }
    const restoreIndex = buildStage.indexOf('dotnet restore "./src/backend/FsusBlog.Server.csproj"');
    const preciseInputCopyIndex = buildStage.indexOf('\nCOPY --from=backend-inputs /compile/ /src/\n');
    if (restoreIndex < 0 || preciseInputCopyIndex < restoreIndex)
    {
        violations.push('release backend publish must remain downstream of the verified compile input copy');
    }
    if ((publishStage.match(/\bRUN\s+dotnet\s+publish\b/gu) ?? []).length !== 1)
    {
        violations.push('release backend path must own exactly one direct dotnet publish producer');
    }
    if (/\bfor\s+\w+\s+in\s+[^;]+;\s*do\s+dotnet\s+publish\b/u.test(publishStage))
    {
        violations.push('release backend publish must fail directly without a compile retry loop');
    }
    for (const option of [
        '--no-restore',
        '--self-contained true',
        '-r "$TARGET_RUNTIME"',
        '-o /app/publish',
        '/p:PublishSingleFile="$PUBLISH_SINGLE_FILE"',
        '/p:PublishReadyToRun="$PUBLISH_READY_TO_RUN"'
    ])
    {
        if (!publishStage.includes(option))
        {
            violations.push(`release backend publish must preserve ${option}`);
        }
    }
    if (publishStage.includes('--no-build'))
    {
        violations.push('release backend publish must remain the compile-capable producer');
    }
    return violations;
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
    assert.match(wasmBuilder, /COPY --from=node-runtime-glibc \/usr\/local\/bin\/node \/usr\/local\/bin\/node/u);
    assert.match(wasmBuilder, /COPY --from=node-runtime-glibc \/usr\/local\/lib\/node_modules\/corepack \/usr\/local\/lib\/node_modules\/corepack/u);
    assert.match(wasmBuilder, /ln -sfn \.\.\/lib\/node_modules\/corepack\/dist\/corepack\.js \/usr\/local\/bin\/corepack/u);
    assert.match(wasmBuilder, /test "\$\(node --version\)" = "v\$\{NODE_VERSION\}"/u);
    assert.match(wasmBuilder, /corepack enable/u);
    assert.match(wasmBuilder, /corepack prepare pnpm@10\.33\.0 --activate/u);
    assert.match(wasmBuilder, /test "\$\(pnpm --version\)" = "10\.33\.0"/u);
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

test('frontend Docker stage materializes /src/frontend as the exact /app alias after copying source', () =>
{
    const stageStart = dockerfile.indexOf('FROM node-runtime-musl AS frontend-build');
    const stageEnd = dockerfile.indexOf('FROM base AS final');
    const frontendStage = dockerfile.slice(stageStart, stageEnd);
    const sourceCopy = frontendStage.indexOf('COPY src/frontend/ ./');
    const sourceAlias = frontendStage.indexOf(
        'RUN mkdir -p /src && ln -s /app /src/frontend && test "$(readlink /src/frontend)" = /app'
    );
    assert.ok(sourceCopy >= 0, 'frontend stage must copy the complete frontend source');
    assert.ok(sourceAlias > sourceCopy, 'frontend source must be copied before creating its absolute alias');
    assert.doesNotMatch(
        frontendStage.slice(0, sourceAlias),
        /^COPY\s+\S+\s+\/src\/frontend(?:\/\S*)?\s*$/gmu,
        'a COPY destination must not materialize /src/frontend before the alias is created'
    );
});

test('Docker restore layer copies the recursive backend ProjectReference closure before restore', () =>
{
    const projects = projectReferenceClosure([
        'src/backend/FsusBlog.Server.csproj',
        'src/core/FsusBlog.Core.csproj',
        'src/shared/FsusBlog.Shared.csproj'
    ]);
    assert.deepEqual(
        backendInputInventory.projects.map(project => project.path),
        [...projects].sort(),
        'the backend inventory must own the exact recursive ProjectReference closure'
    );
    const buildStart = dockerfile.indexOf('FROM build-${RUNTIME_BASE_FLAVOR} AS build');
    const restore = dockerfile.indexOf('dotnet restore "./src/backend/FsusBlog.Server.csproj"', buildStart);
    const preciseRestoreCopy = dockerfile.indexOf('COPY --from=backend-inputs /restore/ /src/', buildStart);
    assert.ok(preciseRestoreCopy >= buildStart && preciseRestoreCopy < restore);
    assert.ok(projects.has('tools/architecture/FsusBlog.DiLifetimeAnalyzer/FsusBlog.DiLifetimeAnalyzer.csproj'));
});

test('release backend final-image path uses one compile-capable publish producer', () =>
{
    assert.deepEqual(releaseBackendCompileProducerViolations(dockerfile), []);

    const mutated = dockerfile.replace(
        'FROM build AS publish',
        [
            'RUN dotnet build "./FsusBlog.Server.csproj" -o /app/build --no-restore',
            '',
            'FROM build AS publish'
        ].join('\n')
    );
    assert.ok(
        releaseBackendCompileProducerViolations(mutated).includes(
            'release backend path must not run standalone dotnet build'
        ),
        'governance must reject a reintroduced standalone release build'
    );

    const retryMutation = dockerfile.replace(
        'RUN dotnet publish "./FsusBlog.Server.csproj"',
        'RUN sh -lc \'for attempt in 1 2; do dotnet publish "./FsusBlog.Server.csproj"'
    );
    assert.ok(
        releaseBackendCompileProducerViolations(retryMutation).includes(
            'release backend publish must fail directly without a compile retry loop'
        ),
        'governance must reject a release publish compile retry loop'
    );

    const staleInputMutation = dockerfile.replace('\nCOPY --from=backend-inputs /compile/ /src/\n', '\n');
    assert.ok(
        releaseBackendCompileProducerViolations(staleInputMutation).includes(
            'release backend publish must remain downstream of the verified compile input copy'
        ),
        'governance must keep source, project, Directory.Build, and NuGet lock inputs ahead of publish'
    );
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
    const materializerArgs = path.join(directory, 'materializer-args.txt');
    const inspectJson = JSON.stringify([{
        Id: `sha256:${'a'.repeat(64)}`,
        Config: { Labels: {
            'org.opencontainers.image.version': releaseId,
            'org.opencontainers.image.created': releaseCreatedAtUtc,
            'org.opencontainers.image.revision': commitSha,
            'io.fsusblog.release.manifest-schema': 'fsusblog.release-manifest.v3',
            ...labels
        } }
    }]);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'node'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  "${path.join(root, 'tools/docker/backend-input-closure.mjs')}")
    [[ "\${2:-}" == "materialize" ]] || exit 92
    printf '%s\\n' "$@" > "${materializerArgs}"
    exit 0 ;;
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
    return { result, dockerArgs, dockerRunArgs, materializerArgs };
}

test('build-final passes the complete pin set and accepts matching inherited labels', (t) =>
{
    const runtimeProfile = resolveRuntimeProfile('throughput-musl');
    const runtimeImage = `mcr.microsoft.com/dotnet/aspnet:${pins.runtimeVersion}-alpine3.23@${pins.aspnetMusl}`;
    const sdkImage = `mcr.microsoft.com/dotnet/sdk:${pins.sdkVersion}-alpine3.23@${pins.sdkMusl}`;
    const nodeImage = `node:${pins.nodeVersion}-alpine3.23@${pins.nodeMusl}`;
    const { result, dockerArgs, dockerRunArgs, materializerArgs } = runBuildWithInspect(t, {
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
    // This fixture owns image-label wiring; the closure suite executes the real materializer.
    const materializerInvocation = fs.readFileSync(materializerArgs, 'utf8').trim().split('\n');
    assert.deepEqual(materializerInvocation.slice(0, -2), [
        path.join(root, 'tools/docker/backend-input-closure.mjs'), 'materialize', '--root', root,
        '--configuration', 'Release', '--runtime', 'linux-musl-x64', '--ready-to-run', 'false',
        '--target', 'publish', '--single-file', 'true', '--tiered-pgo', 'true',
        '--quick-jit-for-loops', 'true', '--server-gc', 'true',
        '--release-id', releaseId, '--commit-sha', commitSha
    ]);
    assert.equal(materializerInvocation.at(-2), '--output');
    assert.ok(path.isAbsolute(materializerInvocation.at(-1)));
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

test('build-final rejects missing deployment receipt before materialization or Docker build', (t) =>
{
    const { result, dockerArgs, materializerArgs } = runBuildWithInspect(t, {}, {
        FSUSBLOG_FINAL_PUSH: '1', FSUSBLOG_FINAL_LOCAL_ONLY: '0',
        FSUSBLOG_CURRENT_SCHEMA_RECEIPT: '', FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256: ''
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /current receipt reference projection failed before build or registry writes/u);
    assert.equal(fs.existsSync(materializerArgs), false);
    assert.equal(fs.existsSync(dockerArgs), false);
});

test('build-final rejects a real FIFO receipt without a writer or any build products', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-build-current-fifo-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fifo = path.join(fs.realpathSync(directory), 'current.fifo');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(created.status, 0, created.stderr);
    const { result, dockerArgs, materializerArgs } = runBuildWithInspect(t, {}, {
        FSUSBLOG_FINAL_PUSH: '1', FSUSBLOG_FINAL_LOCAL_ONLY: '0',
        FSUSBLOG_CURRENT_SCHEMA_RECEIPT: fifo, FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256: '1'.repeat(64)
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular artifact/u);
    assert.equal(fs.existsSync(materializerArgs), false);
    assert.equal(fs.existsSync(dockerArgs), false);
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
});

test('build-final rejects retired schema windows and deployment references in local-only mode', (t) =>
{
    for (const extraEnv of [
        { FSUSBLOG_SCHEMA_MINIMUM_COORDINATE: releaseId },
        { FSUSBLOG_SCHEMA_MAXIMUM_COORDINATE: releaseId },
        { FSUSBLOG_CURRENT_SCHEMA_RECEIPT: '/missing/current.json', FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256: '1'.repeat(64) }
    ])
    {
        const { result, dockerArgs, materializerArgs } = runBuildWithInspect(t, {}, extraEnv);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /windows are retired|cannot consume deployment receipt references/u);
        assert.equal(fs.existsSync(materializerArgs), false);
        assert.equal(fs.existsSync(dockerArgs), false);
    }
});
