import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  createDefaultThresholds,
  generateSyntheticDataset,
  runPerceptionBenchmark
} from '../../../benchmarks/security/perception-v2/perception-harness.mjs';

test('synthetic dataset is deterministic and covers perception-sealed v2 task surfaces', () => {
  const first = generateSyntheticDataset({ seed: 521, samples: 72 });
  const second = generateSyntheticDataset({ seed: 521, samples: 72 });

  assert.deepEqual(first, second);
  assert.equal(first.length, 72);
  assert.deepEqual(new Set(first.map((sample) => sample.taskKind)), new Set([
    'text-task',
    'localization',
    'micro-interaction'
  ]));

  for (const sample of first) {
    assert.match(sample.id, /^pv2-/);
    assert.ok(sample.family.length > 0);
    assert.ok(sample.variant.length > 0);
    assert.ok(sample.payloadBytes > 0);
    assert.ok(sample.clientRenderMs > 0);
    assert.ok(sample.serverVerifyMs > 0);
    assert.ok(sample.expectedHumanSuccessRate >= 0.8);
  }
});

test('benchmark report aggregates by task kind, family, and variant without production DB input', () => {
  const dataset = generateSyntheticDataset({ seed: 521, samples: 90 });
  const report = runPerceptionBenchmark({
    dataset,
    profile: 'pr',
    generatedAt: '2026-06-19T00:00:00.000Z',
    thresholds: createDefaultThresholds('pr')
  });

  assert.equal(report.profile, 'pr');
  assert.equal(report.totals.sampleCount, 90);
  assert.equal(report.environment.productionDatabaseRequired, false);
  assert.ok(report.metrics.issueP99Ms > 0);
  assert.ok(report.metrics.clientRenderP95Ms > 0);
  assert.ok(report.metrics.serverVerifyP99Ms > 0);
  assert.ok(report.metrics.payloadP95Bytes > 0);
  assert.ok(report.groups.length >= 12);

  for (const group of report.groups) {
    assert.ok(group.taskKind);
    assert.ok(group.family);
    assert.ok(group.variant);
    assert.ok(group.sampleCount > 0);
    assert.ok(group.humanSuccessRate >= 0);
    assert.ok(group.botSingleTrySuccessRate >= 0);
    assert.ok(group.botThreeAttemptSuccessRate >= 0);
    assert.ok(group.medianSolveTimeMs > 0);
  }
});

test('benchmark produces configurable regression failures when solver success rises', () => {
  const dataset = generateSyntheticDataset({ seed: 521, samples: 36 });
  const report = runPerceptionBenchmark({
    dataset,
    profile: 'pr',
    generatedAt: '2026-06-19T00:00:00.000Z',
    thresholds: {
      ...createDefaultThresholds('pr'),
      maxBotSingleTrySuccessRate: 0.05,
      maxBotThreeAttemptSuccessRate: 0.1
    },
    solvers: [
      {
        name: 'oracle-cracked-vlm',
        family: 'vlm',
        solve: (sample) => ({
          accepted: true,
          answer: sample.expectedAnswer,
          confidence: 1
        })
      }
    ]
  });

  assert.equal(report.status, 'fail');
  assert.ok(report.failures.some((failure) => failure.metric === 'botSingleTrySuccessRate'));
  assert.ok(report.failures.some((failure) => failure.metric === 'botThreeAttemptSuccessRate'));
});

test('benchmark fails closed when issue, verify, payload, or render budgets are exceeded', () => {
  const dataset = generateSyntheticDataset({ seed: 521, samples: 36 });
  const report = runPerceptionBenchmark({
    dataset,
    profile: 'pr',
    generatedAt: '2026-06-19T00:00:00.000Z',
    thresholds: {
      ...createDefaultThresholds('pr'),
      maxIssueP99Ms: 1,
      maxServerVerifyP99Ms: 1,
      maxPayloadP95Bytes: 1,
      maxClientRenderP95Ms: 1
    }
  });

  assert.equal(report.status, 'fail');
  assert.ok(report.failures.some((failure) => failure.metric === 'issueP99Ms'));
  assert.ok(report.failures.some((failure) => failure.metric === 'serverVerifyP99Ms'));
  assert.ok(report.failures.some((failure) => failure.metric === 'payloadP95Bytes'));
  assert.ok(report.failures.some((failure) => failure.metric === 'clientRenderP95Ms'));
});

test('nightly profile defaults pass the deterministic synthetic baseline', () => {
  const dataset = generateSyntheticDataset({ seed: 521, samples: 960 });
  const report = runPerceptionBenchmark({
    dataset,
    profile: 'nightly',
    generatedAt: '2026-06-19T00:00:00.000Z',
    thresholds: createDefaultThresholds('nightly')
  });

  assert.equal(report.status, 'pass');
  assert.deepEqual(report.failures, []);
});

test('partial nightly threshold overrides preserve nightly defaults', () => {
  const dataset = generateSyntheticDataset({ seed: 521, samples: 120 });
  const report = runPerceptionBenchmark({
    dataset,
    profile: 'nightly',
    generatedAt: '2026-06-19T00:00:00.000Z',
    thresholds: {
      maxBotSingleTrySuccessRate: 0.4
    }
  });

  assert.equal(report.thresholds.maxBotSingleTrySuccessRate, 0.4);
  assert.equal(report.thresholds.maxBotThreeAttemptSuccessRate, createDefaultThresholds('nightly').maxBotThreeAttemptSuccessRate);
  assert.notEqual(report.thresholds.maxBotThreeAttemptSuccessRate, createDefaultThresholds('pr').maxBotThreeAttemptSuccessRate);
});

test('runner rejects malformed numeric CLI and environment overrides', () => {
  const badSamples = spawnSync(
    process.execPath,
    ['benchmarks/security/perception-v2/run.mjs', '--profile', 'pr', '--samples', '96oops'],
    { encoding: 'utf8' }
  );
  assert.notEqual(badSamples.status, 0);
  assert.match(`${badSamples.stdout}${badSamples.stderr}`, /samples must be a positive integer/);

  const badThreshold = spawnSync(
    process.execPath,
    ['benchmarks/security/perception-v2/run.mjs', '--profile', 'pr', '--samples', '12', '--out', '.tmp/security/perception-v2/parser-test'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSUSBLOG_PERCEPTION_V2_MAX_BOT_SINGLE_TRY: '99oops'
      }
    }
  );
  assert.notEqual(badThreshold.status, 0);
  assert.match(`${badThreshold.stdout}${badThreshold.stderr}`, /FSUSBLOG_PERCEPTION_V2_MAX_BOT_SINGLE_TRY must be a number/);
});

test('quality gate and scheduled workflow expose PR and nightly red-team lanes', () => {
  const matrix = readFileSync('tests/matrix.yml', 'utf8');
  const qualityGate = readFileSync('.github/workflows/quality-gate.yml', 'utf8');
  const scheduled = readFileSync('.github/workflows/daily-operations-checks.yml', 'utf8');

  assert.match(matrix, /id: perception-v2-redteam-pr[\s\S]*command: tools\/test\/lanes\/perception-v2-redteam\.sh pr/);
  assert.match(matrix, /id: perception-v2-redteam-nightly[\s\S]*command: tools\/test\/lanes\/perception-v2-redteam\.sh nightly/);
  assert.match(qualityGate, /\.\/tools\/test\.sh perception-v2-redteam-pr --no-deps/);
  assert.match(scheduled, /tools\/test\/lanes\/perception-v2-redteam\.sh nightly/);
});
