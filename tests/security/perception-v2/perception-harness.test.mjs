import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    buildPrompt,
    createDefaultThresholds,
    generateSyntheticDataset,
    runPerceptionBenchmark
} from '../../../benchmarks/security/perception-v2/perception-harness.mjs';

const rateFields = [
    'humanSuccessRate',
    'botSingleTrySuccessRate',
    'botThreeAttemptSuccessRate'
];
const fourDecimalRoundingTolerance = 1e-4;

function assertProbability(value, label)
{
    assert.equal(Number.isFinite(value), true, `${label} must be finite`);
    assert.ok(value >= 0 && value <= 1, `${label} must be within [0, 1]`);
}

function assertGroupRateAggregation(report, expectedSampleCount)
{
    const groupIdentities = new Set();
    const weightedRateTotals = Object.fromEntries(rateFields.map((field) => [field, 0]));
    let groupedSampleCount = 0;

    assert.equal(report.totals.sampleCount, expectedSampleCount);
    for (const field of rateFields)
    {
        assertProbability(report.metrics[field], `report.metrics.${field}`);
    }

    for (const group of report.groups)
    {
        const identity = JSON.stringify([group.taskKind, group.family, group.variant]);
        assert.equal(groupIdentities.has(identity), false, `duplicate group identity: ${identity}`);
        groupIdentities.add(identity);
        groupedSampleCount += group.sampleCount;

        for (const field of rateFields)
        {
            assertProbability(group[field], `group ${identity}.${field}`);
            weightedRateTotals[field] += group[field] * group.sampleCount;
        }
    }

    assert.equal(groupedSampleCount, report.totals.sampleCount);
    for (const field of rateFields)
    {
        const weightedRate = weightedRateTotals[field] / groupedSampleCount;
        assert.ok(
            Math.abs(weightedRate - report.metrics[field]) <= fourDecimalRoundingTolerance,
            `${field} weighted group rate ${weightedRate} must match global rate ${report.metrics[field]}`
        );
    }
}

test('prompt builder preserves supported-kind goldens and rejects unknown kinds', () =>
{
    assert.equal(
        buildPrompt('localization', 'spatial-grid', 'moving-hotspot', 'cell-5-4'),
        'Select cell-5-4 after resolving spatial-grid/moving-hotspot spatial decoys.'
    );
    assert.equal(
        buildPrompt('micro-interaction', 'gesture-chain', 'press-drag-release', 'gesture-dr14l'),
        'Complete gesture-dr14l through the gesture-chain/press-drag-release interaction path.'
    );
    assert.throws(
        () => buildPrompt('unknown', 'unsupported-family', 'unsupported-variant', 'unexpected-answer'),
        /Unsupported perception task kind: unknown/
    );
});

test('synthetic dataset is deterministic and covers perception-sealed v2 task surfaces', () =>
{
    const first = generateSyntheticDataset({ seed: 521, samples: 72 });
    const second = generateSyntheticDataset({ seed: 521, samples: 72 });

    assert.deepEqual(first, second);
    assert.equal(first.length, 72);
    assert.deepEqual(new Set(first.map((sample) => sample.taskKind)), new Set([
        'localization',
        'micro-interaction'
    ]));

    for (const sample of first)
    {
        assert.match(sample.id, /^pv2-/);
        assert.ok(sample.family.length > 0);
        assert.ok(sample.variant.length > 0);
        assert.ok(sample.payloadBytes > 0);
        assert.ok(sample.clientRenderMs > 0);
        assert.ok(sample.serverVerifyMs > 0);
        assert.ok(sample.expectedHumanSuccessRate >= 0.8);
    }
});

test('benchmark report aggregates by task kind, family, and variant without production DB input', () =>
{
    const dataset = generateSyntheticDataset({ seed: 521, samples: 90 });
    const report = runPerceptionBenchmark({
        dataset,
        profile: 'pr',
        generatedAt: '2026-06-19T00:00:00.000Z',
        thresholds: createDefaultThresholds('pr')
    });

    assert.equal(report.profile, 'pr');
    assert.equal(report.status, 'pass');
    assert.deepEqual(report.failures, []);
    assert.equal(report.environment.productionDatabaseRequired, false);
    assert.ok(report.metrics.issueP99Ms > 0);
    assert.ok(report.metrics.clientRenderP95Ms > 0);
    assert.ok(report.metrics.serverVerifyP99Ms > 0);
    assert.ok(report.metrics.payloadP95Bytes > 0);
    assert.ok(report.groups.length >= 8);

    for (const group of report.groups)
    {
        assert.ok(group.taskKind);
        assert.ok(group.family);
        assert.ok(group.variant);
        assert.ok(group.sampleCount > 0);
        assert.ok(group.medianSolveTimeMs > 0);
    }

    assertGroupRateAggregation(report, 90);
});

test('group rate aggregation oracle rejects invalid probabilities and denominators', () =>
{
    const report = runPerceptionBenchmark({
        dataset: generateSyntheticDataset({ seed: 521, samples: 90 }),
        profile: 'pr',
        generatedAt: '2026-06-19T00:00:00.000Z',
        thresholds: createDefaultThresholds('pr')
    });

    for (const invalidRate of [1.01, Number.NaN, Number.POSITIVE_INFINITY, -0.01])
    {
        const invalidGroupReport = structuredClone(report);
        invalidGroupReport.groups[0].humanSuccessRate = invalidRate;
        assert.throws(
            () => assertGroupRateAggregation(invalidGroupReport, 90),
            /must be (?:finite|within \[0, 1\])/
        );

        const invalidGlobalReport = structuredClone(report);
        invalidGlobalReport.metrics.botSingleTrySuccessRate = invalidRate;
        assert.throws(
            () => assertGroupRateAggregation(invalidGlobalReport, 90),
            /must be (?:finite|within \[0, 1\])/
        );
    }

    const duplicateIdentityReport = structuredClone(report);
    duplicateIdentityReport.groups[1].taskKind = duplicateIdentityReport.groups[0].taskKind;
    duplicateIdentityReport.groups[1].family = duplicateIdentityReport.groups[0].family;
    duplicateIdentityReport.groups[1].variant = duplicateIdentityReport.groups[0].variant;
    assert.throws(
        () => assertGroupRateAggregation(duplicateIdentityReport, 90),
        /duplicate group identity/
    );

    const invalidDenominatorReport = structuredClone(report);
    invalidDenominatorReport.groups[0].sampleCount += 1;
    assert.throws(
        () => assertGroupRateAggregation(invalidDenominatorReport, 90),
        /Expected values to be strictly equal/
    );

    const invalidAggregateReport = structuredClone(report);
    invalidAggregateReport.groups[0].botThreeAttemptSuccessRate += 0.01;
    assert.throws(
        () => assertGroupRateAggregation(invalidAggregateReport, 90),
        /weighted group rate/
    );
});

test('benchmark produces configurable regression failures when solver success rises', () =>
{
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

test('benchmark fails closed when issue, verify, payload, or render budgets are exceeded', () =>
{
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

test('nightly profile defaults pass the deterministic synthetic baseline', () =>
{
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

test('partial nightly threshold overrides preserve nightly defaults', () =>
{
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

test('runner rejects malformed numeric CLI and environment overrides', () =>
{
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

test('quality gate and scheduled workflow expose PR and nightly red-team lanes', () =>
{
    const matrix = readFileSync('tests/matrix.yml', 'utf8');
    const qualityGate = readFileSync('.github/workflows/quality-gate.yml', 'utf8');
    const scheduled = readFileSync('.github/workflows/daily-operations-checks.yml', 'utf8');

    assert.match(matrix, /id: perception-v2-redteam-pr[\s\S]*command: tools\/test\/lanes\/perception-v2-redteam\.sh pr/);
    assert.match(matrix, /id: perception-v2-redteam-nightly[\s\S]*command: tools\/test\/lanes\/perception-v2-redteam\.sh nightly/);
    assert.match(qualityGate, /\.\/tools\/test\.sh perception-v2-redteam-pr --no-deps/);
    assert.match(scheduled, /tools\/test\/lanes\/perception-v2-redteam\.sh nightly/);
});
