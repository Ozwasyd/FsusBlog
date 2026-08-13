import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(root, 'tools/deployment/check-production-compose-environment.mjs');

function runChecker(compose, example)
{
    return spawnSync(process.execPath, [
        checker,
        '--compose',
        compose,
        '--example',
        example
    ], { encoding: 'utf8' });
}

function writeFixture(directory, composeSource, exampleSource)
{
    const compose = path.join(directory, 'compose.yml');
    const example = path.join(directory, '.env.production.example');
    fs.writeFileSync(compose, composeSource);
    fs.writeFileSync(example, exampleSource);
    return { compose, example };
}

test('production Compose variables are documented and fail closed', (context) =>
{
    const repositoryResult = runChecker(
        path.join(root, 'ops/docker/docker-compose.production.yml'),
        path.join(root, '.env.production.example')
    );
    assert.equal(repositoryResult.status, 0, repositoryResult.stderr);
    assert.match(repositoryResult.stdout, /verified 63 documented variables/u);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-compose-environment-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const valid = writeFixture(directory, `
services:
  app:
    environment:
      - Jwt__SecretKey=\${Jwt__SecretKey:?Set the signing key}
      - Jwt__KeyVersion=\${Jwt__KeyVersion:?Set the key version}
      - Jwt__RotationWindowDays=\${Jwt__RotationWindowDays:-30}
      - OPTIONAL=\${OPTIONAL:-}
`, `
Jwt__SecretKey=CHANGE_ME
Jwt__KeyVersion=CHANGE_ME
Jwt__RotationWindowDays=30
OPTIONAL=
`);
    assert.equal(runChecker(valid.compose, valid.example).status, 0);

    fs.writeFileSync(valid.compose,
        fs.readFileSync(valid.compose, 'utf8').replace(
            '${Jwt__SecretKey:?Set the signing key}',
            '${Jwt__SecretKey}'
        ));
    const bare = runChecker(valid.compose, valid.example);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /require an explicit default or non-empty must-set diagnostic/u);

    fs.writeFileSync(valid.compose,
        fs.readFileSync(valid.compose, 'utf8').replace(
            '${Jwt__SecretKey}',
            '${Jwt__SecretKey:?Set the signing key}'
        ));
    fs.writeFileSync(valid.example,
        fs.readFileSync(valid.example, 'utf8').replace('OPTIONAL=\n', ''));
    const undocumented = runChecker(valid.compose, valid.example);
    assert.notEqual(undocumented.status, 0);
    assert.match(undocumented.stderr, /missing from \.env\.production\.example: OPTIONAL/u);
});

test('production gateway is a complete config admitted by a pinned syntax image', () =>
{
    const config = fs.readFileSync(
        path.join(root, 'ops/gateway/production-openresty.conf'),
        'utf8'
    );
    const syntaxLane = fs.readFileSync(
        path.join(root, 'tools/deployment/check-production-gateway-config.sh'),
        'utf8'
    );
    assert.match(config, /^worker_processes auto;/u);
    assert.match(config, /^events \{/mu);
    assert.match(config, /^http \{/mu);
    assert.match(config, /http2 on;/u);
    assert.doesNotMatch(config, /listen [^;]*\bhttp2\b/u);
    assert.match(syntaxLane, /nginx:1\.29\.5-alpine@sha256:[0-9a-f]{64}/u);
    assert.match(syntaxLane, /--entrypoint nginx[\s\S]*-t -c \/etc\/nginx\/nginx\.conf/u);
});

test('one matrix lane owns local and hosted production image smoke', () =>
{
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const workflow = fs.readFileSync(
        path.join(root, '.github/workflows/quality-gate.yml'),
        'utf8'
    );
    const lane = fs.readFileSync(
        path.join(root, 'tools/test/lanes/production-image-smoke.sh'),
        'utf8'
    );
    const wrapper = fs.readFileSync(
        path.join(root, 'tools/test/run-release-reliability-qualified-local.sh'),
        'utf8'
    );
    const dockerfile = fs.readFileSync(
        path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'),
        'utf8'
    );
    const tier = matrix.slice(
        matrix.indexOf('    - id: production-image-smoke'),
        matrix.indexOf('    - id: frontend-build')
    );
    assert.match(tier, /command: bash tools\/test\/lanes\/production-image-smoke\.sh/u);
    assert.match(tier, /ciJob: production-image-smoke/u);
    assert.match(tier, /ops\/docker\/\*\*/u);
    assert.match(tier, /ops\/gateway\/\*\*/u);
    assert.match(workflow, /schedule:\s*\n\s*- cron: "17 2 \* \* \*"/u);
    assert.match(
        workflow,
        /profile: \$\{\{ fromJSON\(github\.event_name == 'schedule' && '\["throughput-musl","throughput-glibc"\]'/u
    );
    assert.match(workflow, /\.\/tools\/test\.sh ci-tier production-image-smoke --no-deps/u);
    assert.match(lane, /check-production-compose-environment\.mjs/u);
    assert.match(lane, /check-production-gateway-config\.sh/u);
    assert.match(lane, /RUN_ID="\$BASE_RUN_ID"/u);
    assert.match(lane, /IMAGE_TAG="fsusblog-production-smoke:\$\{RUN_ID\}-\$\{PROFILE_ID\}"/u);
    assert.doesNotMatch(lane, /RUN_ID="\$\{BASE_RUN_ID\}-\$\{PROFILE_ID\}"/u);
    assert.match(lane, /unset FSUSBLOG_RELEASE_ID FSUSBLOG_RELEASE_CREATED_AT_UTC/u);
    assert.match(lane, /FSUSBLOG_COMMIT_SHA="\$\(git -C "\$ROOT_DIR" rev-parse HEAD\)"/u);
    assert.match(lane, /run-release-reliability-qualified-local\.sh" \\\s*\n\s*--runtime-admission-only/u);
    assert.match(wrapper, /FSUSBLOG_FINAL_LOCAL_ONLY=1[\s\S]*tools\/build-final-image\.sh/u);
    assert.doesNotMatch(lane, /\bdocker push\b|FSUSBLOG_FINAL_PUSH=1/u);
    assert.doesNotMatch(
        dockerfile,
        /COPY src\/frontend\/scripts\/fsusui-root\.mjs \/src\/frontend\/scripts\/fsusui-root\.mjs/u
    );
    assert.match(
        dockerfile,
        /test ! -e \/src\/frontend[\s\S]*ln -s \/app \/src\/frontend[\s\S]*test -x \/src\/frontend\/node_modules\/\.bin\/vue-tsc/u
    );
});

test('runtime admission proves clean SIGTERM before its configured grace', () =>
{
    const wrapper = fs.readFileSync(
        path.join(root, 'tools/test/run-release-reliability-qualified-local.sh'),
        'utf8'
    );
    const runtimeBranch = wrapper.lastIndexOf('if ((runtime_admission_only == 1)); then');
    const branchEnd = wrapper.indexOf('\nfi', runtimeBranch);
    const bounded = wrapper.slice(runtimeBranch, branchEnd);
    assert.match(wrapper, /StopOwnedBackendGracefully\(\)/u);
    assert.match(wrapper, /docker stop --time "\$graceSeconds"/u);
    assert.match(wrapper, /signal: 'SIGTERM'/u);
    assert.match(wrapper, /elapsedMs.*graceSeconds \* 1000/su);
    assert.match(bounded, /StopOwnedBackendGracefully/u);
    assert.ok(
        wrapper.indexOf('ValidateUserSystemdCarrier "${XDG_RUNTIME_DIR:-}"', branchEnd)
        > branchEnd,
        'runtime-admission-only must finish before the release-only user-systemd carrier gate'
    );
});
