#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const buildScript = path.join(root, 'src/frontend/wasm/build.sh');
const cmakeBootstrap = path.join(root, 'tools/frontend/ensure-cmake.sh');
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

function plan(env) {
  const cleanEnv = { ...process.env };
  for (const variable of budgetVariables) {
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

function assertPlan(env, { requestedCpu, source, expectedWorkerLimit = null }) {
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
  if (expectedWorkerLimit !== null) assert.equal(Number(header.workers), expectedWorkerLimit);
  let plannedVariants = 0;
  for (const line of lines.slice(1)) {
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
const buildSource = readFileSync(buildScript, 'utf8');
const simdBuild = buildSource.match(/build_simd\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? '';
const basicBuild = buildSource.match(/build_basic\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? '';
const basicTargetList = basicBuild.match(/local targets=\((?<targets>[\s\S]*?)\n  \)/u)?.groups?.targets ?? '';

for (const target of ['FsusPowEngine', 'aeds_decoder', 'FsusSearchRuntime', 'FsusCommentPrivacyRuntime']) {
  assert.match(simdBuild, new RegExp(`\\b${target}\\b`, 'u'), `SIMD build must retain ${target}`);
}
assert.match(simdBuild, /targets\+=\(FsusImageCodec\)/u, 'SIMD build must retain the optional image codec target');
for (const target of ['FsusPowEngine', 'FsusSearchRuntime']) {
  assert.match(basicBuild, new RegExp(`\\b${target}\\b`, 'u'), `basic build must retain ${target}`);
}
assert.match(basicBuild, /targets\+=\(FsusImageCodec\)/u, 'basic build must retain the optional image codec target');
assert.doesNotMatch(basicTargetList, /\baeds_decoder\b/u, 'basic build must not duplicate the mode-invariant AEDS decoder');
assert.doesNotMatch(basicTargetList, /\bFsusCommentPrivacyRuntime\b/u, 'basic build must not duplicate the mode-invariant comment privacy runtime');
assert.doesNotMatch(buildSource, /\$\{STAGE_BASIC_DIR\}\/(?:aeds_decoder|comment_privacy_runtime)/u,
  'mode-invariant artifacts must never be published from the scalar stage');
assert.match(buildSource, /--target "\$\{targets\[@\]\}" --parallel "\$\{jobs\}"/u,
  'variant builds must explicitly build only their publication targets under the granted parallelism');
for (const token of [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_NODE_TEST_CONCURRENCY',
  'schedulerManaged',
  'failed_modes',
  'optimize_pow_wasm_parallel',
  'failed_optimizations'
]) assert.match(buildSource, new RegExp(token, 'u'));
assert.equal((buildSource.match(/^optimize_pow_wasm_parallel \\/gmu) ?? []).length, 1,
  'all four independent PoW artifacts must enter one dynamically bounded optimization pool');

assert.match(bootstrapSource, /CMAKE_VERSION="4\.1\.2"/u);
assert.match(bootstrapSource, /\.tmp\/dependency-cache/u);
assert.match(bootstrapSource, /flock 9/u);
assert.match(bootstrapSource, /sha256sum -c -/u);
assert.match(bootstrapSource, /mv "\$\{WORK_DIR\}\/root" "\$\{CMAKE_ROOT\}"/u);

console.log('[check-wasm-build-resource-budget] ok');
