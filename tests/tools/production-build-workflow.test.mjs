import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {checkProductionComposeEnvironment, parseComposeDurationSeconds} = await import(new URL('../../tools/deployment/check-production-compose-environment.mjs', import.meta.url));
const {validateStoppedContainerState} = await import(new URL('../../tools/deployment/verify-container-termination.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowFile = path.join(root, '.github/workflows/quality-gate.yml');
const productionImageWorkflowFile = path.join(root, '.github/workflows/production-image-verification.yml');
const actionFile = path.join(root, '.github/actions/consume-production-build/action.yml');
const producerLaneFile = path.join(root, 'tools/test/lanes/production-build-artifacts.sh');

function jobSource(workflow, jobId)
{
    const escapedId = jobId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const marker = workflow.match(new RegExp(`^(?<indent>[ \\t]+)${escapedId}:[ \\t]*$`, 'mu'));
    assert.ok(marker?.groups?.indent, `missing workflow job ${jobId}`);
    const start = marker.index;
    const bodyStart = start + marker[0].length;
    const next = workflow
        .slice(bodyStart)
        .search(new RegExp(`^${marker.groups.indent}[A-Za-z0-9_-]+:[ \\t]*$`, 'mu'));
    return next === -1 ? workflow.slice(start) : workflow.slice(start, bodyStart + next);
}

test('quality gate has one smart-gated producer and all immutable-build consumers verify it', () =>
{
    const workflow = fs.readFileSync(workflowFile, 'utf8');
    const producer = jobSource(workflow, 'production-build-artifacts');
    assert.match(producer, /ci-tier production-build-artifacts --no-deps/u);
    assert.match(producer, /if-no-files-found: error/u);
    assert.match(producer, /retention-days: 3/u);
    assert.match(producer, /source_fingerprint:[\s\S]*receipt_digest:/u);
    const uploaded = producer.slice(producer.lastIndexOf('uses: actions/upload-artifact@'));
    assert.doesNotMatch(uploaded, /node_modules|~\/\.nuget\/packages/u);

    const consumers = [
        'integration-runtime', 'endpoint-depth-runtime', 'release-public', 'security-runtime',
        'browser-contract', 'resilience-runtime', 'load-smoke',
        'backend-qps-collectors', 'perf-regression'
    ];
    for (const jobId of consumers)
    {
        const source = jobSource(workflow, jobId);
        assert.match(source, /needs:[\s\S]*production-build-artifacts/u, jobId);
        assert.match(source, /uses: \.\/\.github\/actions\/consume-production-build/u, jobId);
        assert.match(source, /needs\.production-build-artifacts\.outputs\.source_fingerprint/u, jobId);
        assert.match(source, /needs\.production-build-artifacts\.outputs\.receipt_digest/u, jobId);
        const consumerAction = source.indexOf('uses: ./.github/actions/consume-production-build');
        assert.ok(source.indexOf('actions/setup-node@') < consumerAction, `${jobId} must set up Node before verification`);
        assert.ok(source.indexOf('actions/setup-dotnet@') < consumerAction, `${jobId} must set up .NET before verification`);
    }
});

test('consumer action verifies same-run source and receipt identity before tests', () =>
{
    const source = fs.readFileSync(actionFile, 'utf8');
    for (const contract of [
        'actions/download-artifact@',
        'snapshotGitWorktree',
        'production-build-artifacts-cli.mjs verify',
        '--expected-commit',
        '--expected-fingerprint',
        '--expected-workflow "$GITHUB_WORKFLOW"',
        '--expected-run-id',
        '--expected-run-attempt "$GITHUB_RUN_ATTEMPT"',
        '--expected-job production-build-artifacts',
        '--expected-current-toolchain true',
        '--expected-input-root "$GITHUB_WORKSPACE"',
        '--expected-receipt-digest',
        '--transfer-started-at-ms',
        'FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT=',
        'FSUSBLOG_RUNTIME_NO_BUILD=1'
    ])
    {
        assert.ok(source.includes(contract), contract);
    }
});

test('producer receipts existing lock, project and build configuration inputs', () =>
{
    const source = fs.readFileSync(producerLaneFile, 'utf8');
    assert.match(source, /PRODUCER_RUN_ID="\$\{GITHUB_RUN_ID:-\$\{FSUSBLOG_TEST_RUN_ID:/u);
    assert.match(source, /PRODUCER_RUN_ATTEMPT="\$\{GITHUB_RUN_ATTEMPT:-1\}"/u);
    assert.match(source, /--run-id "\$PRODUCER_RUN_ID"/u);
    assert.match(source, /--run-attempt "\$PRODUCER_RUN_ATTEMPT"/u);
    for (const input of [
        'Directory.Build.props',
        'Directory.Packages.props',
        'FsusBlog.slnx',
        'src/backend/FsusBlog.Server.csproj',
        'src/backend/packages.lock.json',
        'src/core/FsusBlog.Core.csproj',
        'src/shared/FsusBlog.Shared.csproj',
        'tests/backend/FsusBlog.Server.Tests.csproj',
        'src/frontend/package.json',
        'src/frontend/package-lock.json',
        'src/frontend/vite.config.ts',
        'tools/frontend/build.mjs',
        'tools/frontend/ensure-wasm.mjs',
        'tools/frontend/write-comment-privacy-prover-manifest.mjs',
        'tools/security/comment-privacy-build-contract.mjs',
        'security/zk/contracts/comment-v5-circuit.manifest.json',
        'security/zk/provenance/comment-v5-trusted-setup.manifest.json',
        'config/zk/anonymous-comment-v5-verifying-key.manifest.json',
        'tools/ci/production-build-artifacts.mjs',
        'tools/ci/production-build-artifacts-cli.mjs',
        'tools/ci/benchmark-production-build-materialization.mjs',
        'tests/tools/production-build-artifacts.test.mjs',
        'tests/tools/production-build-materialization-benchmark.test.mjs',
        'src/frontend/wasm/CMakeLists.txt'
    ])
    {
        assert.match(source, new RegExp(`--input ${input.replaceAll('.', '\\.')}`, 'u'), input);
    };
    assert.doesNotMatch(source, /--input global\.json/u);
    const declaredInputs = [...source.matchAll(/--input ([A-Za-z0-9_./-]+)/gu)].map(match => match[1]);
    assert.ok(declaredInputs.length > 0);
    for (const input of declaredInputs)
    {
        assert.equal(fs.existsSync(path.join(root, input)), true, `missing producer receipt input: ${input}`);
    }
});

test('producer transfers canonical build directories into the immutable domain without a payload copy', () =>
{
    const source = fs.readFileSync(producerLaneFile, 'utf8');
    assert.match(source, /AdoptDirectory/u);
    assert.match(source, /mv -- "\$source" "\$destination"/u);
    assert.match(source, /ln -s -- "\$destination" "\$source"/u);
    assert.match(source, /stat -c %d "\$source"/u);
    assert.match(source, /resumed sealed immutable artifact/u);
    assert.match(source, /--expected-input-root "\$ROOT_DIR"/u);
    assert.doesNotMatch(source, /CopyDirectory/u);
    assert.doesNotMatch(source, /cp -a "\$source\/\." "\$destination\/"/u);
    assert.doesNotMatch(source, /rm -rf "\$ARTIFACT_ROOT"/u);
});

test('smart gate selects producer exactly when an immutable build consumer is selected', t =>
{
    let temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fsusblog-build-smart-gate-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const caseSensitive = directory =>
    {
        const probe = path.join(directory, 'FsusCaseProbe');
        fs.writeFileSync(probe, '');
        const result = !fs.existsSync(path.join(directory, 'fsuscaseprobe'));
        fs.unlinkSync(probe);
        return result;
    };
    if (!caseSensitive(temp))
    {
        fs.rmSync(temp, { recursive: true, force: true });
        const ownedRoot = path.join(root, '.tmp');
        fs.mkdirSync(ownedRoot, { recursive: true });
        temp = fs.mkdtempSync(path.join(ownedRoot, 'fsusblog-build-smart-gate-'));
        assert.ok(caseSensitive(temp), 'the Git fixture requires a case-sensitive temporary filesystem');
    }
    const candidate = path.join(temp, 'candidate');
    const hooks = path.join(temp, 'hooks');
    fs.mkdirSync(hooks);
    const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-C', candidate, ...args], { encoding: 'utf8' }).trim();
    const base = execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-c', `core.hooksPath=${hooks}`, 'clone', '--quiet', '--shared', '--no-checkout', '--', root, candidate]);
    git('checkout', '--quiet', '--detach', base);
    let caseEnvironment;
    const run = changedFile =>
    {
        // Each case is an actual clean commit against the same immutable baseline.
        git('reset', '--quiet', '--hard', base);
        const input = path.join(candidate, changedFile);
        fs.mkdirSync(path.dirname(input), { recursive: true });
        fs.appendFileSync(input, '\n');
        git('add', '--', changedFile);
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test: exercise PR impact');
        const head = git('rev-parse', '--verify', 'HEAD^{commit}');
        assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
        // Bind the isolated candidate, not an enclosing CI run's identity or plan.
        caseEnvironment = { ...process.env, GITHUB_SHA: head, GITHUB_WORKSPACE: candidate,
            FSUSBLOG_REPO_ROOT: candidate, FSUSBLOG_TEST_SOURCE_COMMIT: head,
            FSUSBLOG_BASE_REF: base, FSUSBLOG_PR_EVENT_NAME: 'pull_request', FSUSBLOG_CI_STAGE: 'qualification' };
        for (const key of ['FSUSBLOG_TEST_SOURCE_FINGERPRINT', 'FSUSBLOG_CI_PR_SMART_GATE_PLAN', 'FSUSBLOG_PR_PLAN_DIGEST'])
        {
            delete caseEnvironment[key];
        }
        const changed = path.join(temp, `${path.basename(changedFile)}.txt`);
        const output = path.join(temp, `${path.basename(changedFile)}.json`);
        const githubOutput = path.join(temp, `${path.basename(changedFile)}.github-output`);
        fs.writeFileSync(changed, `${changedFile}\n`);
        const result = spawnSync(process.execPath, [
            'tools/run-test-matrix.mjs', 'ci-pr-plan',
            '--event-name', 'pull_request',
            '--base-ref', base,
            '--changed-files', changed,
            '--out', output,
            '--github-output', githubOutput
        ], { cwd: candidate, env: caseEnvironment, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(plan.sourceState.commit, head);
        assert.deepEqual(plan.changedFiles, [changedFile]);
        return {
            plan,
            githubOutput: fs.readFileSync(githubOutput, 'utf8')
        };
    };

    const runtimeResult = run('src/backend/Program.cs');
    const runtime = runtimeResult.plan;
    assert.ok(runtime.selectedTierIds.includes('production-build-artifacts'));
    assert.ok(runtime.selectedJobs.includes('production-build-artifacts'));
    const producer = runtime.selectedTiers.find(tier => tier.id === 'production-build-artifacts');
    assert.match(producer.triggerReason, /immutable production build/u);
    assert.equal(producer.reason, 'changed source input: src/backend/Program.cs');
    assert.match(runtimeResult.githubOutput, /production_build_domains=.*backend-runtime/u);
    const mismatched = path.join(temp, 'mismatched-files.txt');
    fs.writeFileSync(mismatched, 'docs/README-only.md\n');
    const refused = spawnSync(process.execPath, [
        'tools/run-test-matrix.mjs', 'ci-pr-plan', '--event-name', 'pull_request',
        '--base-ref', base, '--changed-files', mismatched
    ], { cwd: candidate, env: caseEnvironment, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /changed files input does not match the actual merge-base Git diff/u);

    const frontendResult = run('src/frontend/src/App.vue');
    assert.ok(frontendResult.plan.selectedTierIds.includes('production-build-artifacts'));
    // The current matrix selects the release XSS tier for frontend changes;
    // its browser-contract job requires both immutable frontend domains.
    assert.ok(frontendResult.plan.selectedTierIds.includes('production-xss-release'));
    assert.ok(frontendResult.plan.selectedJobs.includes('browser-contract'));
    assert.match(frontendResult.githubOutput,
        /production_build_domains=backend-runtime,frontend-dist,generated-contracts,test-runtime,wasm\n/u);
    assert.match(frontendResult.githubOutput, /browser_diagnostics=false/u);

    const docsOnlyResult = run('docs/README-only.md');
    const docsOnly = docsOnlyResult.plan;
    assert.equal(docsOnly.fullMode, false);
    assert.ok(docsOnly.selectedTierIds.includes('source-governance'));
    assert.ok(!docsOnly.selectedTierIds.includes('runtime-cache-public-hot-read'));
    assert.ok(!docsOnly.selectedTierIds.includes('production-build-artifacts'));
    assert.match(docsOnlyResult.githubOutput, /production_build_domains=\n/u);
});

test('production image workflow covers Docker changes and schedules both production base families', () =>
{
    const workflow = fs.readFileSync(productionImageWorkflowFile, 'utf8');
    assert.match(jobSource(workflow, 'contracts'), /node-version: 24\.16\.0/u);
    const imageJob = jobSource(workflow, 'final-image');
    for (const pathFilter of [
        'ops/docker/**',
        'ops/gateway/**',
        'ops/docker/FsusBlog.Server.Dockerfile'
    ])
    {
        if (pathFilter.endsWith('Dockerfile'))
        {
            assert.ok(workflow.includes('ops/docker/**'), pathFilter);
        }
        else
        {
            assert.ok(workflow.includes(`- ${pathFilter}`), pathFilter);
        }
    }
    assert.match(workflow, /schedule:\s*\n\s*- cron: "[^"]+"/u);
    assert.match(
        imageJob,
        /github\.event_name == 'pull_request'[\s\S]*throughput-musl[\s\S]*throughput-glibc/u
    );
    assert.match(imageJob, /FSUSBLOG_RUNTIME_PROFILE_ID: \$\{\{ matrix\.runtime-profile \}\}/u);
    assert.match(imageJob, /FSUSBLOG_USE_LOCAL_FSUSUI: "1"/u);
    assert.match(imageJob, /FSUSBLOG_LOCAL_FSUSUI_ROOT: \$\{\{ github\.workspace \}\}\/\.tmp\/fsusui-source/u);
    assert.match(imageJob, /repository: Ozwasyd\/FsusUI/u);
    assert.match(imageJob, /node tools\/test\/fsusui-baseline\.mjs --github-output "\$GITHUB_OUTPUT"/u);
    assert.match(imageJob, /ref: \$\{\{ steps\.fsusui-baseline\.outputs\.commit \}\}/u);
    assert.match(imageJob, /path: \.tmp\/fsusui-source/u);
    assert.match(imageJob, /node-version: 24\.x/u);
    assert.match(imageJob, /npm --prefix src\/frontend ci --ignore-scripts --no-audit/u);
    assert.match(imageJob, /--target fsusui-build-tools/u);
    assert.match(imageJob, /corepack pnpm@10\.33\.0 install --frozen-lockfile --ignore-scripts/u);
    assert.match(imageJob, /corepack pnpm@10\.33\.0 --dir vue\/internal\/build-utils run stub/u);
    assert.match(imageJob, /corepack pnpm@10\.33\.0 run build:theme/u);
    assert.match(imageJob, /corepack pnpm@10\.33\.0 run ensure:wasm/u);
    assert.match(imageJob, /"\$FSUSBLOG_FSUSUI_BUILD_TOOLS_IMAGE"[\s\S]*bash -c/u);
    assert.match(imageJob, /node tests\/browser-diagnostics\/local-fsusui-identity\.mjs/u);
    assert.match(
        imageJob,
        /tools\/test\/run-release-reliability-qualified-local\.sh --runtime-admission-only/u
    );
    assert.doesNotMatch(workflow, /docker push|FSUSBLOG_FINAL_PUSH/u);
});

test('production image workflow reuses the production builder and proves health, article AEDS, and SIGTERM', () =>
{
    const wrapper = fs.readFileSync(
        path.join(root, 'tools/test/run-release-reliability-qualified-local.sh'),
        'utf8'
    );
    const routeCatalog = JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/runtime-http-route-contracts.json'),
        'utf8'
    ));
    const runtimeRoutes = routeCatalog.producers['runtime-load-soak']
        .map(routeId => routeCatalog.routes.find(route => route.routeId === routeId));

    assert.match(
        wrapper,
        /FSUSBLOG_FINAL_LOCAL_ONLY=1 FSUSBLOG_FINAL_IMAGE_TAG="\$image" "\$root\/tools\/build-final-image\.sh"/u
    );
    assert.match(wrapper, /runtime_health_status[\s\S]*healthy\)/u);
    assert.ok(runtimeRoutes.some(route => route.pathTemplate.startsWith('/api/binary/article/')));
    assert.ok(runtimeRoutes
        .filter(route => route.pathTemplate.startsWith('/api/binary/article/'))
        .every(route => Number.isInteger(route.expectedAedsFrameType)));
    assert.match(
        wrapper,
        /verify-container-termination\.mjs" "\$backend_container_id" "\$run_id" "\$namespace" "\$invocation_id"/u
    );
    assert.match(
        wrapper,
        /if \(\(runtime_admission_only == 1\)\); then[\s\S]*exit 0\nfi\ncurrent_uid="\$\(id -u\)"\nValidateUserSystemdCarrier/u
    );

    const gateway = fs.readFileSync(
        path.join(root, 'tools/deployment/check-production-openresty-config.sh'),
        'utf8'
    );
    assert.match(gateway, /openresty\/openresty@sha256:[0-9a-f]{64}/u);
    assert.match(gateway, /ops\/gateway\/production-openresty\.conf/u);
    assert.match(gateway, /--entrypoint openresty[\s\S]*-t[\s\S]*-c \/etc\/openresty\/nginx\.conf/u);

    const dockerfile = fs.readFileSync(
        path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'),
        'utf8'
    );
    assert.match(
        dockerfile,
        /FROM emscripten\/emsdk:6\.0\.0@sha256:[0-9a-f]{64} AS fsusui-build-tools/u
    );
    assert.match(
        dockerfile,
        /COPY --from=node-runtime-glibc \/usr\/local\/lib\/node_modules\/corepack \/usr\/local\/lib\/node_modules\/corepack/u
    );
    assert.match(
        dockerfile,
        /ln -sfn \.\.\/lib\/node_modules\/corepack\/dist\/corepack\.js \/usr\/local\/bin\/corepack/u
    );
    assert.match(dockerfile, /corepack prepare pnpm@10\.33\.0 --activate/u);
    assert.match(dockerfile, /FROM fsusui-build-tools AS wasm-builder/u);
});

test('production Compose environment contract documents the exact current 60-variable inventory', () =>
{
    const report = checkProductionComposeEnvironment({ root });
    assert.deepEqual(report.errors, []);
    assert.equal(report.variableCount, 60);
    assert.equal(report.stopGracePeriodSeconds, 60);
    assert.equal(parseComposeDurationSeconds('60s'), 60);
    assert.equal(parseComposeDurationSeconds('2m'), 120);
    assert.throws(() => parseComposeDurationSeconds('0s'), /positive integer/u);
    assert.throws(() => parseComposeDurationSeconds('1.5m'), /positive integer/u);
});

test('production Compose environment contract fails closed on drift and empty documentation', t =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-production-compose-contract-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(fixtureRoot, 'config/deployment'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'ops/docker'), { recursive: true });
    const contract = JSON.parse(fs.readFileSync(
        path.join(root, 'config/deployment/production-compose-environment.json'),
        'utf8'
    ));
    fs.copyFileSync(
        path.join(root, contract.composePath),
        path.join(fixtureRoot, contract.composePath)
    );
    delete contract.variables.DB_NAME;
    contract.variables.DB_PASSWORD.expectedValue = '';
    fs.writeFileSync(
        path.join(fixtureRoot, 'config/deployment/production-compose-environment.json'),
        `${JSON.stringify(contract, null, 4)}\n`
    );

    const report = checkProductionComposeEnvironment({ root: fixtureRoot });
    assert.ok(report.errors.some(error => error.includes('undocumented Compose variable: DB_NAME')));
    assert.ok(report.errors.some(error => error.includes('DB_PASSWORD.expectedValue')));
    assert.ok(report.errors.some(error => error.includes('variableCount')));
});

test('SIGTERM observation accepts only a clean zero exit before the Compose deadline', () =>
{
    const containerId = 'a'.repeat(64);
    const runId = 'production-image-1';
    const namespace = 'production-image-namespace';
    const stopped = {
        Id: containerId,
        Config: {
            Labels: {
                'io.fsusblog.test.run-id': runId,
                'io.fsusblog.test.namespace': namespace
            }
        },
        State: {
            Running: false,
            ExitCode: 0,
            OOMKilled: false,
            Error: '',
            FinishedAt: '2026-08-23T08:30:00.000Z'
        }
    };
    const options = {
        containerId,
        runId,
        namespace,
        elapsedMilliseconds: 1250,
        stopGracePeriodSeconds: 60
    };

    assert.deepEqual(validateStoppedContainerState(stopped, options), {
        exitCode: 0,
        oomKilled: false,
        error: '',
        finishedAtUtc: '2026-08-23T08:30:00.000Z'
    });
    assert.throws(
        () => validateStoppedContainerState({
            ...stopped,
            State: { ...stopped.State, ExitCode: 137 }
        }, options),
        /did not exit cleanly/u
    );
    assert.throws(
        () => validateStoppedContainerState(stopped, {
            ...options,
            elapsedMilliseconds: 60_000
        }),
        /did not exit cleanly/u
    );
});
