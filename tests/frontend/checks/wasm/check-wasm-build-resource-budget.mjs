#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const buildScript = path.join(root, 'src/frontend/wasm/build.sh');
const cmakeBootstrap = path.join(root, 'tools/frontend/ensure-cmake.sh');
const binaryenBootstrap = path.join(root, 'tools/frontend/ensure-binaryen.sh');
const buildWasmArtifact = path.join(root, 'tools/build-wasm-artifact.sh');
const serverDockerfile = path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile');
const serviceWorker = path.join(root, 'src/frontend/public/sw.js');
const budgetVariables = [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_WASM_CPU_BUDGET',
    'FSUSBLOG_BUILD_CPU_BUDGET',
    'FSUSBLOG_BUILD_MAX_WORKERS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MAX_WORKERS',
    'FSUSBLOG_VITEST_MAX_WORKERS'
];

function plan(env)
{
    const cleanEnv = { ...process.env };
    for (const variable of budgetVariables)
    {
        delete cleanEnv[variable];
    }
    const result = spawnSync('bash', [buildScript, '--print-resource-plan'], {
        cwd: path.join(root, 'src/frontend'),
        env: { ...cleanEnv, ...env },
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\r?\n/u);
}

function assertPlan(env, { requestedCpu, source, expectedWorkerLimit = null })
{
    const lines = plan(env);
    const header = lines[0].match(
        /cpu_budget=(?<cpu>\d+) source=(?<source>\S+) memory_budget_gib=(?<memory>[\d.]+) memory_source=(?<memorySource>\S+) memory_worker_limit=(?<memoryLimit>\d+) variant_workers=(?<workers>\d+) variants=(?<variants>\d+)/u
    )?.groups;
    assert.ok(header, `invalid resource header: ${lines[0]}`);
    const hostCpu = os.availableParallelism?.() ?? os.cpus().length;
    const expectedCpu = Math.max(1, Math.min(hostCpu, requestedCpu));
    assert.equal(Number(header.cpu), expectedCpu);
    assert.equal(header.source, source);
    assert.equal(Number(header.variants), 4);
    assert.equal(Number(header.workers), Math.min(4, expectedCpu, Number(header.memoryLimit)));
    if (expectedWorkerLimit !== null)
    {
        assert.equal(Number(header.workers), expectedWorkerLimit);
    }
    let plannedVariants = 0;
    for (const line of lines.slice(1))
    {
        const wave = line.match(/jobs=(?<jobs>[\d,]+) total=(?<total>\d+) memory_gib_per_child=(?<memory>[\d.]+)/u)?.groups;
        assert.ok(wave, `invalid wave: ${line}`);
        const jobs = wave.jobs.split(',').map(Number);
        assert.ok(jobs.length <= Number(header.workers));
        assert.equal(jobs.reduce((total, value) => total + value, 0), Number(wave.total));
        assert.equal(Number(wave.total), expectedCpu);
        assert.ok(Math.abs(Number(wave.memory) * jobs.length - Number(header.memory)) < 0.00001);
        plannedVariants += jobs.length;
    }
    assert.equal(plannedVariants, 4);
}

assertPlan({ FSUSBLOG_VITEST_MAX_WORKERS: '2' }, {
    requestedCpu: 2,
    source: 'FSUSBLOG_VITEST_MAX_WORKERS'
});

assertPlan({ FSUSBLOG_BUILD_CPU_BUDGET: '5' }, {
    requestedCpu: 5,
    source: 'FSUSBLOG_BUILD_CPU_BUDGET'
});

assertPlan({
    FSUSBLOG_STEP_CPU_BUDGET: '3',
    FSUSBLOG_STEP_MEMORY_GIB: '6',
    FSUSBLOG_WASM_CPU_BUDGET: '3',
    FSUSBLOG_BUILD_CPU_BUDGET: '8',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '7',
    FSUSBLOG_VITEST_MAX_WORKERS: '6'
}, {
    requestedCpu: 3,
    source: 'FSUSBLOG_STEP_CPU_BUDGET'
});

assertPlan({ FSUSBLOG_BUNDLE_MAX_WORKERS: '1' }, {
    requestedCpu: 1,
    source: 'FSUSBLOG_BUNDLE_MAX_WORKERS',
    expectedWorkerLimit: 1
});

assertPlan({ FSUSBLOG_STEP_CPU_BUDGET: '8', FSUSBLOG_STEP_MEMORY_GIB: '0.000001' }, {
    requestedCpu: 8,
    source: 'FSUSBLOG_STEP_CPU_BUDGET',
    expectedWorkerLimit: Math.min(4, os.availableParallelism?.() ?? os.cpus().length)
});

assertPlan({ FSUSBLOG_STEP_MEMORY_GIB: '0.000001' }, {
    requestedCpu: os.availableParallelism?.() ?? os.cpus().length,
    source: 'detected-cpu',
    expectedWorkerLimit: 1
});

const bootstrapSource = readFileSync(cmakeBootstrap, 'utf8');
const binaryenBootstrapSource = readFileSync(binaryenBootstrap, 'utf8');
const buildWasmArtifactSource = readFileSync(buildWasmArtifact, 'utf8');
const serverDockerfileSource = readFileSync(serverDockerfile, 'utf8');
const buildSource = readFileSync(buildScript, 'utf8');
const serviceWorkerSource = readFileSync(serviceWorker, 'utf8');
const simdBuild = buildSource.match(/BuildSimd\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? '';
const basicBuild = buildSource.match(/BuildBasic\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? '';
const basicTargetList = basicBuild.match(/local targets=\((?<targets>[\s\S]*?)\n {2}\)/u)?.groups?.targets ?? '';

for (const target of ['FsusPowEngine', 'aeds_decoder_speed', 'FsusSearchRuntime', 'FsusCommentPrivacyRuntime'])
{
    assert.match(simdBuild, new RegExp(`\\b${target}\\b`, 'u'), `SIMD build must retain ${target}`);
}
assert.match(simdBuild, /targets\+=\(FsusImageCodec\)/u, 'SIMD build must retain the optional image codec target');
for (const target of ['FsusPowEngine', 'aeds_decoder_basic', 'FsusSearchRuntime'])
{
    assert.match(basicBuild, new RegExp(`\\b${target}\\b`, 'u'), `basic build must retain ${target}`);
}
assert.match(basicBuild, /targets\+=\(FsusImageCodec\)/u, 'basic build must retain the optional image codec target');
assert.doesNotMatch(basicTargetList, /\bFsusCommentPrivacyRuntime\b/u, 'basic build must not duplicate the mode-invariant comment privacy runtime');
assert.match(buildSource, /\$\{STAGE_BASIC_DIR\}\/aeds_decoder_basic/u,
    'the scalar AEDS artifact must be published from the basic stage');
assert.doesNotMatch(buildSource, /\$\{STAGE_BASIC_DIR\}\/comment_privacy_runtime/u,
    'the mode-invariant comment privacy runtime must never be published from the scalar stage');
assert.match(buildSource, /--target "\$\{targets\[@\]\}" --parallel "\$\{jobs\}"/u,
    'variant builds must explicitly build only their publication targets under the granted parallelism');
for (const token of [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
    'FSUSBLOG_NODE_TEST_CONCURRENCY',
    'schedulerManaged',
    'failed_modes',
    'OptimizePowWasmParallel',
    'failedOptimizations'
])
{
    assert.match(buildSource, new RegExp(token, 'u'));
}
for (const token of ['ensure-binaryen.sh', 'OptimizeAedsSpeedWasm', '--enable-simd', 'mandatory AEDS speed wasm-opt failed'])
{
    assert.match(buildSource, new RegExp(token, 'u'));
}
assert.equal((buildSource.match(/^OptimizePowWasmParallel \\/gmu) ?? []).length, 1,
    'all four independent PoW artifacts must enter one dynamically bounded optimization pool');

assert.match(bootstrapSource, /CMAKE_VERSION="4\.3\.3"/u);
assert.match(buildSource, /VersionLessThan "\$\{version\}" "3\.24\.0"/u,
    'CMake versions without --fresh support must fall back before configuring a wasm variant');
assert.match(buildSource, /VersionLessThan "\$\{version\}" "4\.3\.3"/u,
    'CMake 4.3.3 must be accepted while known-incompatible earlier 4.2/4.3 releases remain blocked');
assert.match(buildSource, /command -v cmake/u,
    'the build must reuse a supported host CMake before bootstrapping the pinned fallback');
assert.match(buildSource, /COMMENT_PRIVACY_PROVER_KEY/u,
    'the wasm build must resolve the current proving-key input only behind the production gate');
assert.match(serverDockerfileSource,
    /ARG FSUSBLOG_ZK_PRODUCTION_ENABLED=0/u,
    'the isolated wasm builder must default production ZK packaging to disabled');
assert.match(serverDockerfileSource,
    /comment-privacy-build-contract\.mjs/u,
    'the isolated wasm builder must validate the current v5 setup before optional prover packaging');
assert.doesNotMatch(serverDockerfileSource,
    new RegExp(`COMMENT_PRIVACY_${'PROVER_KEY_PATH'}`, 'u'),
    'the isolated wasm builder must not retain a retired proving-key path or restore argument');
assert.match(serverDockerfileSource,
    /ENV FSUSBLOG_FRONTEND_WASM_ROOT=\/work\/src\/frontend\/public\/wasm/u,
    'manifest tools in the isolated wasm builder must receive the explicit frontend output root');
for (const cacheTarget of [
    '/.tmp/dependency-cache',
    '/.cache/emscripten',
    '/.cache/vcpkg/downloads',
    '/.cache/vcpkg/archives'
])
{
    assert.match(serverDockerfileSource, new RegExp(`type=cache[^\\n]+target=${cacheTarget.replaceAll('/', '\\/')}`, 'u'),
        `the isolated wasm builder must persist ${cacheTarget} across failed source rebuilds`);
}
assert.match(buildWasmArtifactSource, /FSUSBLOG_ZK_PRODUCTION_ENABLED/u,
    'the Wasm artifact producer must forward the explicit production-ZK build gate');
assert.match(buildWasmArtifactSource, /FSUSBLOG_WASM_IMAGE_CODEC_ENABLE/u,
    'the Wasm artifact producer must forward the explicit image-codec feature identity');
assert.ok(
    serverDockerfileSource.indexOf('bash /work/tools/frontend/install-wasm-codec-deps.sh')
    < serverDockerfileSource.indexOf('COPY src/frontend/wasm/ /work/src/frontend/wasm/'),
    'codec dependency installation must stay cacheable independently of frontend source changes'
);
assert.match(bootstrapSource, /\.tmp\/dependency-cache/u);
assert.match(bootstrapSource, /flock 9/u);
assert.match(bootstrapSource, /sha256sum -c -/u);
assert.match(bootstrapSource, /mv "\$\{WORK_DIR\}\/root" "\$\{CMAKE_ROOT\}"/u);
for (const token of ['BINARYEN_VERSION="version_123"', 'ARCHIVE_SHA256', 'sha256sum', 'flock 9'])
{
    assert.match(binaryenBootstrapSource, new RegExp(token, 'u'));
}
assert.match(serviceWorkerSource, /IMMUTABLE_RELEASE_WASM_ASSET_PATTERN/u);
assert.match(serviceWorkerSource, /isCanonicalReleaseAssetPath\(url\.pathname, IMMUTABLE_RELEASE_WASM_ASSET_PATTERN\)[\s\S]*cacheFirstStatic/u,
    'immutable release-scoped AEDS JS/Wasm/manifest assets must remain cacheable for N/N-1');

console.log('[check-wasm-build-resource-budget] ok');
