import { canonicalDigest, exactKeys } from './distribution-contract.mjs';

function assertCount(value, label, allowZero = true)
{
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    {
        throw new Error(`${label} must be a ${allowZero ? 'nonnegative' : 'positive'} safe integer`);
    }
}

function assertSampleSet(sampleSet)
{
    if (typeof sampleSet !== 'string' || sampleSet.trim() !== sampleSet || sampleSet.length === 0)
    {
        throw new Error('sampleSet must be an explicit nonempty identifier');
    }
}

/**
 * Requires the caller's complete current identity contract to match exactly,
 * including schema/status versions, source digests, roles and counts. This does
 * not establish that either identity was read from the authoritative database.
 */
export function assertStatisticsIdentity(expected, actual)
{
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
        || Object.keys(expected).length === 0)
    {
        throw new Error('explicit nonempty expected identity is required');
    }
    exactKeys(actual, Object.keys(expected), 'statistics identity');
    if (canonicalDigest(expected) !== canonicalDigest(actual))
    {
        throw new Error('identity/exactness failure: statistics identity differs from current expected identity');
    }
}

function observation(metricId, algorithmVersion, sampleSet, sampleCount, value, reason = null)
{
    return {
        metricId,
        algorithmVersion,
        sampleSet,
        sampleCount,
        value,
        status: reason === null ? 'measured' : 'not-evaluable',
        reason
    };
}

/**
 * Consumes a strictly ascending, complete frequency stream, never raw DB rows.
 * Integer accumulation is exact; quantiles use nearest rank and top shares use
 * ceil(population * fraction) members, including only the required boundary bin.
 * This pure calculation is not evidence of a database read or graph identity.
 */
export function summarizeWeightedHistogram(entries, options)
{
    exactKeys(options, Object.hasOwn(options, 'metricPrefix')
        ? ['sampleSet', 'sampleCount', 'metricPrefix'] : ['sampleSet', 'sampleCount'], 'histogram options');
    const { sampleSet, sampleCount, metricPrefix = 'hotness' } = options;
    assertSampleSet(sampleSet);
    assertCount(sampleCount, 'sampleCount');
    if (typeof metricPrefix !== 'string' || metricPrefix.length === 0)
    {
        throw new Error('metricPrefix must be nonempty');
    }
    if (entries === null || typeof entries?.[Symbol.iterator] !== 'function')
    {
        throw new Error('entries must be a sorted frequency iterable');
    }

    const quantiles = [50, 90, 99].map((percent) => ({
        percent,
        rank: Math.max(1, Number((BigInt(sampleCount) * BigInt(percent) + 99n) / 100n)),
        value: null
    }));
    const topCounts = [1, 10].map((percent) => ({
        percent,
        count: Number((BigInt(sampleCount) * BigInt(percent) + 99n) / 100n),
        sum: 0n
    }));
    let previousValue = -1;
    let count = 0;
    let total = 0n;
    let giniNumerator = 0n;
    let distinctValues = 0;
    for (const entry of entries)
    {
        exactKeys(entry, ['value', 'count'], 'frequency entry');
        assertCount(entry.value, 'frequency value');
        assertCount(entry.count, 'frequency count', false);
        if (entry.value <= previousValue)
        {
            throw new Error('frequency values must be strictly ascending without duplicate bins');
        }
        if (entry.count > sampleCount - count)
        {
            throw new Error('exactness failure: histogram exceeds explicit sampleCount');
        }
        const endRank = count + entry.count;
        const value = BigInt(entry.value);
        const frequency = BigInt(entry.count);
        total += value * frequency;
        giniNumerator += value * frequency * (2n * BigInt(count) + frequency - BigInt(sampleCount));
        for (const quantile of quantiles)
        {
            if (quantile.value === null && quantile.rank <= endRank)
            {
                quantile.value = entry.value;
            }
        }
        for (const top of topCounts)
        {
            const includedCount = Math.max(0, endRank - Math.max(count, sampleCount - top.count));
            top.sum += value * BigInt(includedCount);
        }
        count = endRank;
        previousValue = entry.value;
        distinctValues += 1;
    }
    if (count !== sampleCount)
    {
        throw new Error('exactness failure: histogram count differs from explicit sampleCount');
    }

    const emptyReason = sampleCount === 0 ? 'empty sample' : null;
    const shareReason = emptyReason ?? (total === 0n ? 'zero total weight' : null);
    const ratio = (numerator, denominator) => Number(numerator) / Number(denominator);
    const metrics = [
        observation(`${metricPrefix}.gini`, 'weighted-frequency-v1', sampleSet, count,
            shareReason === null ? ratio(giniNumerator, BigInt(count) * total) : null, shareReason),
        ...topCounts.map((top) => observation(`${metricPrefix}.top-${top.percent}-percent-share`,
            'weighted-frequency-v1', sampleSet, count,
            shareReason === null ? ratio(top.sum, total) : null, shareReason)),
        ...quantiles.map((quantile) => observation(`${metricPrefix}.p${quantile.percent}`,
            'nearest-rank-v1', sampleSet, count, quantile.value, emptyReason))
    ];
    return { sampleSet, sampleCount: count, distinctValues, metrics };
}

/** Computes a proportion from complete independently observed integer counts. */
export function measureCountRatio(options)
{
    exactKeys(options, ['metricId', 'sampleSet', 'numerator', 'denominator'], 'ratio options');
    const { metricId, sampleSet, numerator, denominator } = options;
    assertSampleSet(sampleSet);
    if (typeof metricId !== 'string' || metricId.length === 0)
    {
        throw new Error('metricId must be nonempty');
    }
    assertCount(numerator, 'numerator');
    assertCount(denominator, 'denominator');
    if (numerator > denominator)
    {
        throw new Error('exactness failure: numerator exceeds denominator');
    }
    return observation(metricId, 'exact-count-ratio-v1', sampleSet, denominator,
        denominator === 0 ? null : numerator / denominator, denominator === 0 ? 'zero denominator' : null);
}

function assertExpectedMetric(metric)
{
    exactKeys(metric, ['metricId', 'dimension', 'algorithmVersion', 'sampleSet', 'minSampleCount', 'interval', 'status', 'authorityRef'], 'expected metric');
    assertSampleSet(metric.sampleSet);
    assertCount(metric.minSampleCount, 'minSampleCount', false);
    if (typeof metric.metricId !== 'string' || metric.metricId.length === 0
        || typeof metric.algorithmVersion !== 'string' || metric.algorithmVersion.length === 0
        || typeof metric.dimension !== 'string' || metric.dimension.length === 0
        || !['specified', 'blocked'].includes(metric.status))
    {
        throw new Error('invalid expected metric contract');
    }
    if (metric.status === 'blocked')
    {
        if (metric.interval !== null)
        {
            throw new Error('blocked metric interval must be null');
        }
        return;
    }
    exactKeys(metric.interval, ['min', 'max'], 'expected interval');
    if (!Number.isFinite(metric.interval.min) || !Number.isFinite(metric.interval.max)
        || metric.interval.min > metric.interval.max)
    {
        throw new Error('expected interval must have finite ordered bounds');
    }
}

/**
 * Compares every catalog metric without aggregating away failures. A comparison
 * cannot admit release evidence: DB provenance and independent remeasurement are
 * separate required capabilities, and no producer for them is implemented here.
 */
export function compareDistributionMetrics(options)
{
    exactKeys(options, ['scenarioId', 'expectedStatistics', 'actualMetrics'], 'comparison options');
    const { scenarioId, expectedStatistics, actualMetrics } = options;
    if (typeof scenarioId !== 'string' || scenarioId.length === 0
        || !Array.isArray(expectedStatistics) || expectedStatistics.length === 0
        || !Array.isArray(actualMetrics))
    {
        throw new Error('explicit scenario and nonempty expected statistics are required');
    }
    const actualById = new Map();
    for (const actual of actualMetrics)
    {
        exactKeys(actual, ['metricId', 'algorithmVersion', 'sampleSet', 'sampleCount', 'value', 'status', 'reason'], 'actual metric');
        assertSampleSet(actual.sampleSet);
        assertCount(actual.sampleCount, 'actual sampleCount');
        if (!['measured', 'not-evaluable'].includes(actual.status)
            || (actual.status === 'measured' && (!Number.isFinite(actual.value) || actual.reason !== null))
            || (actual.status === 'not-evaluable' && (actual.value !== null || typeof actual.reason !== 'string' || actual.reason.length === 0)))
        {
            throw new Error('invalid actual metric status/value/reason');
        }
        if (actualById.has(actual.metricId))
        {
            throw new Error(`duplicate actual metric: ${actual.metricId}`);
        }
        actualById.set(actual.metricId, actual);
    }
    const expectedIds = new Set();
    const metrics = expectedStatistics.map((expected) =>
    {
        assertExpectedMetric(expected);
        if (expectedIds.has(expected.metricId))
        {
            throw new Error(`duplicate expected metric: ${expected.metricId}`);
        }
        expectedIds.add(expected.metricId);
        const actual = actualById.get(expected.metricId);
        let status = 'not-evaluable';
        let reason = expected.status === 'blocked' ? 'catalog metric authority is blocked' : 'missing actual metric';
        let deviation = null;
        if (actual && (actual.sampleSet !== expected.sampleSet || actual.algorithmVersion !== expected.algorithmVersion))
        {
            status = 'failed';
            reason = 'sample identity or algorithm version mismatch';
        }
        else if (expected.status === 'specified' && actual)
        {
            if (actual.status === 'not-evaluable')
            {
                reason = actual.reason;
            }
            else if (actual.sampleCount < expected.minSampleCount)
            {
                reason = 'insufficient sample';
            }
            else
            {
                deviation = actual.value < expected.interval.min ? actual.value - expected.interval.min
                    : actual.value > expected.interval.max ? actual.value - expected.interval.max : 0;
                status = deviation === 0 ? 'passed' : 'failed';
                reason = deviation === 0 ? null : 'outside expected interval';
            }
        }
        return { metricId: expected.metricId, dimension: expected.dimension,
            algorithmVersion: expected.algorithmVersion, sampleSet: expected.sampleSet,
            sampleCount: actual?.sampleCount ?? null, actual: actual?.value ?? null,
            expected: expected.interval, status, deviation, reason };
    });
    for (const metricId of actualById.keys())
    {
        if (!expectedIds.has(metricId))
        {
            throw new Error(`unexpected actual metric: ${metricId}`);
        }
    }
    const status = metrics.some((metric) => metric.status === 'failed') ? 'failed'
        : metrics.some((metric) => metric.status === 'not-evaluable') ? 'not-evaluable' : 'passed';
    return {
        scenarioId,
        status,
        metrics,
        releaseEvidenceEligible: false,
        releaseIneligibilityReason: scenarioId === 'uniform-baseline'
            ? 'uniform baseline is never release evidence' : 'current DB provenance and independent remeasurement are required'
    };
}
