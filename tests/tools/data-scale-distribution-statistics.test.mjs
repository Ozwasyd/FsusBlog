import assert from 'node:assert/strict';
import test from 'node:test';

const { distributionCatalog } = await import(new URL('../../tools/data-scale/distribution-catalog.mjs', import.meta.url));
const {
    assertStatisticsIdentity,
    compareDistributionMetrics,
    measureCountRatio,
    summarizeWeightedHistogram
} = await import(new URL('../../tools/data-scale/distribution-statistics.mjs', import.meta.url));

const sampleSet = 'unit-corpus:articles';

function frequencies(values)
{
    const counts = new Map();
    for (const value of values)
    {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort(([left], [right]) => left - right).map(([value, count]) => ({ value, count }));
}

function summarize(values)
{
    return summarizeWeightedHistogram(frequencies(values), { sampleSet, sampleCount: values.length });
}

function metric(summary, metricId)
{
    return summary.metrics.find((item) => item.metricId === metricId);
}

function expected(metricId, min = 0, max = 1, overrides = {})
{
    return {
        metricId,
        dimension: 'unit-corpus',
        algorithmVersion: 'exact-count-ratio-v1',
        sampleSet,
        minSampleCount: 1,
        interval: { min, max },
        status: 'specified',
        authorityRef: 'unit-test-only',
        ...overrides
    };
}

test('weighted Gini agrees with independent pairwise definition on known unequal/Zipf corpora', () =>
{
    const corpora = [[0, 0, 0, 10], [1, 1, 1, 1], [0, 1, 2, 3],
        Array.from({ length: 100 }, (_, index) => Math.floor(1000 / (index + 1)))];
    for (const values of corpora)
    {
        const summary = summarize(values);
        const total = values.reduce((sum, value) => sum + value, 0);
        let pairwiseDifference = 0;
        for (const left of values)
        {
            for (const right of values)
            {
                pairwiseDifference += Math.abs(left - right);
            }
        }
        const expectedGini = pairwiseDifference / (2 * values.length * total);
        assert.ok(Math.abs(metric(summary, 'hotness.gini').value - expectedGini) < 1e-14);
    }
});

test('top shares include ceil rank boundaries and quantiles use explicit nearest rank', () =>
{
    const values = Array.from({ length: 101 }, (_, index) => index);
    const summary = summarize(values);
    assert.equal(metric(summary, 'hotness.top-1-percent-share').value, (100 + 99) / 5050);
    assert.equal(metric(summary, 'hotness.top-10-percent-share').value, 1045 / 5050);
    assert.equal(metric(summary, 'hotness.p50').value, 50);
    assert.equal(metric(summary, 'hotness.p90').value, 90);
    assert.equal(metric(summary, 'hotness.p99').value, 99);
    assert.equal(metric(summary, 'hotness.gini').algorithmVersion, 'weighted-frequency-v1');
    assert.equal(metric(summary, 'hotness.p50').algorithmVersion, 'nearest-rank-v1');
});

test('empty samples and zero total weights preserve not-evaluable values', () =>
{
    const empty = summarize([]);
    assert.ok(empty.metrics.every((item) => item.value === null && item.status === 'not-evaluable'));
    const zeros = summarize([0, 0, 0]);
    assert.equal(metric(zeros, 'hotness.gini').value, null);
    assert.equal(metric(zeros, 'hotness.gini').reason, 'zero total weight');
    assert.equal(metric(zeros, 'hotness.p50').value, 0);
    const ratio = measureCountRatio({ metricId: 'thread.zero-comment-share', sampleSet, numerator: 0, denominator: 0 });
    assert.equal(ratio.value, null);
    assert.equal(ratio.status, 'not-evaluable');
});

test('histogram rejects incompleteness, duplicate/unsorted bins and lossy count inputs', () =>
{
    const calculate = (entries, sampleCount = 4) => summarizeWeightedHistogram(entries, { sampleSet, sampleCount });
    assert.throws(() => calculate([{ value: 1, count: 3 }]), /exactness failure/);
    assert.throws(() => calculate([{ value: 1, count: 5 }]), /exactness failure/);
    assert.throws(() => calculate([{ value: 1, count: 2 }, { value: 1, count: 2 }]), /strictly ascending/);
    assert.throws(() => calculate([{ value: 2, count: 2 }, { value: 1, count: 2 }]), /strictly ascending/);
    for (const invalid of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    {
        assert.throws(() => calculate([{ value: invalid, count: 4 }]), /safe integer|noncanonical/);
        assert.throws(() => calculate([{ value: 1, count: invalid }]), /safe integer|noncanonical/);
    }
    assert.throws(() => calculate([{ value: 1, count: 4, planValue: 1 }]), /fields_invalid/);
    assert.throws(() => summarizeWeightedHistogram([], { sampleSet, sampleCount: 0, retry: true }), /fields_invalid/);
    assert.throws(() => measureCountRatio({ metricId: 'x', sampleSet, numerator: 5, denominator: 4 }), /exactness failure/);
});

test('100k/1M sample corpora use a single bounded frequency stream and no expanded population', () =>
{
    for (const sampleCount of [100_000, 1_000_000])
    {
        let reads = 0;
        function* entries()
        {
            reads += 1;
            yield { value: 0, count: sampleCount - 100 };
            reads += 1;
            yield { value: Number.MAX_SAFE_INTEGER, count: 100 };
        }
        const summary = summarizeWeightedHistogram(entries(), { sampleSet, sampleCount });
        assert.equal(reads, 2);
        assert.equal(summary.distinctValues, 2);
        assert.equal(metric(summary, 'hotness.gini').value, (sampleCount - 100) / sampleCount);
        assert.equal(metric(summary, 'hotness.top-1-percent-share').value, 1);
        assert.equal(summary.metrics.length, 6);
        assert.ok(summary.metrics.every((item) => item.sampleCount === sampleCount));
    }
});

test('comparison preserves failures and not-evaluable reasons per metric with no aggregate masking', () =>
{
    const actualMetrics = ['taxonomy.empty-category-share', 'thread.zero-comment-share', 'media.no-cover-share'].map((metricId, index) =>
        measureCountRatio({ metricId, sampleSet, numerator: index + 1, denominator: 10 }));
    const expectedStatistics = [expected(actualMetrics[0].metricId, 0.05, 0.15), expected(actualMetrics[1].metricId, 0.5, 0.6),
        expected(actualMetrics[2].metricId, 0, 1, { minSampleCount: 11 }),
        expected('id.gap-share', 0, 1, { status: 'blocked', interval: null, authorityRef: null })];
    const result = compareDistributionMetrics({ scenarioId: 'non-uniform-unit-corpus', expectedStatistics, actualMetrics });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.metrics.map((item) => item.status), ['passed', 'failed', 'not-evaluable', 'not-evaluable']);
    assert.equal(result.metrics[1].deviation, -0.3);
    assert.equal(result.metrics[2].reason, 'insufficient sample');
    assert.equal(result.metrics[3].reason, 'catalog metric authority is blocked');
    assert.equal(result.releaseEvidenceEligible, false);
});

test('uniform metrics passing their intervals never admit release evidence', () =>
{
    const actual = measureCountRatio({ metricId: 'taxonomy.empty-category-share', sampleSet, numerator: 0, denominator: 100 });
    const result = compareDistributionMetrics({ scenarioId: 'uniform-baseline', expectedStatistics: [expected(actual.metricId, 0, 0)], actualMetrics: [actual] });
    assert.equal(result.status, 'passed');
    assert.equal(result.releaseEvidenceEligible, false);
    assert.match(result.releaseIneligibilityReason, /uniform/);
});

test('missing/unsupported observations are not zero and algorithm/sample drift fails closed', () =>
{
    const contract = expected('thread.depth-10-share', 0, 0);
    const missing = compareDistributionMetrics({ scenarioId: 'unit-corpus', expectedStatistics: [contract], actualMetrics: [] });
    assert.equal(missing.status, 'not-evaluable');
    assert.equal(missing.metrics[0].actual, null);
    assert.equal(missing.metrics[0].sampleCount, null);
    const actual = measureCountRatio({ metricId: contract.metricId, sampleSet, numerator: 0, denominator: 10 });
    for (const changes of [{ algorithmVersion: 'private-v2' }, { sampleSet: 'other-roles' }])
    {
        const result = compareDistributionMetrics({ scenarioId: 'unit-corpus', expectedStatistics: [contract], actualMetrics: [{ ...actual, ...changes }] });
        assert.equal(result.status, 'failed');
        assert.match(result.metrics[0].reason, /mismatch/);
    }
    const unsupported = { ...actual, value: null, status: 'not-evaluable', reason: 'unsupported current graph fact' };
    assert.equal(compareDistributionMetrics({ scenarioId: 'unit-corpus', expectedStatistics: [contract], actualMetrics: [unsupported] }).status, 'not-evaluable');
    assert.throws(() => compareDistributionMetrics({ scenarioId: 'unit-corpus', expectedStatistics: [contract], actualMetrics: [{ ...unsupported, value: 0 }] }), /invalid actual/);
});

test('comparison is closed and rejects duplicate, extra, malformed and inverted contracts', () =>
{
    const actual = measureCountRatio({ metricId: 'x', sampleSet, numerator: 1, denominator: 10 });
    const compare = (expectedStatistics, actualMetrics) => compareDistributionMetrics({ scenarioId: 'unit-corpus', expectedStatistics, actualMetrics });
    assert.throws(() => compare([expected('x')], [actual, actual]), /duplicate actual/);
    assert.throws(() => compare([expected('x'), expected('x')], [actual]), /duplicate expected/);
    assert.throws(() => compare([expected('y')], [actual]), /unexpected actual/);
    assert.throws(() => compare([expected('x', 1, 0)], [actual]), /ordered bounds/);
    assert.throws(() => compare([expected('x', 0, 1, { status: 'blocked' })], [actual]), /must be null/);
    assert.throws(() => compare([expected('x')], [{ ...actual, planCopy: true }]), /fields_invalid/);
    assert.throws(() => compare([], []), /nonempty expected/);
    assert.throws(() => compareDistributionMetrics({ scenarioId: 'unit-corpus', expectedStatistics: [expected('x')], actualMetrics: [actual], privateThreshold: 0 }), /fields_invalid/);
});

test('all eight canonical scenario contracts retain complete per-metric missing evidence', () =>
{
    assert.equal(distributionCatalog.scenarios.length, 8);
    for (const scenario of distributionCatalog.scenarios)
    {
        const comparison = compareDistributionMetrics({ scenarioId: scenario.id,
            expectedStatistics: scenario.expectedStatistics, actualMetrics: [] });
        assert.equal(comparison.status, 'not-evaluable');
        assert.equal(comparison.metrics.length, scenario.expectedStatistics.length);
        assert.ok(comparison.metrics.every((item) => item.actual === null && item.sampleCount === null && item.status === 'not-evaluable'));
        assert.equal(comparison.releaseEvidenceEligible, false);
    }
});

test('identity equality rejects schema/status/source/count/role drift and unknown fields', () =>
{
    const identity = { schemaVersion: 'unit-corpus-v1', status: 'verified-unit-corpus', sourceDigest: 'unit-source',
        graphDigest: 'unit-graph', counts: { articles: 10 }, roles: ['article-a', 'article-b'] };
    assert.doesNotThrow(() => assertStatisticsIdentity(identity, structuredClone(identity)));
    for (const changes of [{ schemaVersion: 'unit-corpus-v2' }, { status: 'stale' }, { sourceDigest: 'changed' },
        { graphDigest: 'changed' }, { counts: { articles: 9 } }, { roles: ['article-b', 'article-a'] }])
    {
        assert.throws(() => assertStatisticsIdentity(identity, { ...identity, ...changes }), /identity\/exactness failure/);
    }
    assert.throws(() => assertStatisticsIdentity(identity, { ...identity, latest: true }), /fields_invalid/);
    assert.throws(() => assertStatisticsIdentity({}, identity), /nonempty expected/);
});
