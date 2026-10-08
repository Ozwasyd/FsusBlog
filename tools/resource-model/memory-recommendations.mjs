import { clamp, confidence, digestJson, finite, quantile, requireCondition, seal } from './contract.mjs';
import { recommendationInputs } from './sample-ledger.mjs';

export const memorySchema = 'fsusblog.adaptive.memory-recommendations.v1';

/** A high quantile with upper-tail winsorization resists a single extreme sample. */
function robustHighRss(rows)
{
    const values = rows.map((row) => row.peakRssGiB).sort((left, right) => left - right);
    const ceiling = values[Math.floor((values.length - 1) * 0.8)];
    return quantile(values.map((value) => Math.min(value, ceiling)), 0.9);
}

export function recommendMemory(inputs)
{
    const history = recommendationInputs(inputs);
    const { capacity } = inputs;
    finite(capacity.absoluteReserveFloorGiB, 'capacity.absoluteReserveFloorGiB', 0.001);
    finite(capacity.proportionalReserveFloor, 'capacity.proportionalReserveFloor', 0.001);
    requireCondition(capacity.proportionalReserveFloor < 1, 'invalid-reserve-floor', 'capacity');
    const reserve = Math.max(capacity.absoluteReserveFloorGiB,
        capacity.totalMemoryGiB * capacity.proportionalReserveFloor);
    requireCondition(reserve < capacity.totalMemoryGiB, 'infeasible-reserve', 'capacity');
    const recommendations = history.defaults.map((previous) =>
    {
        const rows = history.rows(previous.producerId);
        const score = rows.length ? confidence(rows.map((row) => row.peakRssGiB), 5) : 0;
        const attributions = new Set(rows.map((row) => row.attribution));
        let target = previous.memoryGiB;
        const reasons = [];
        if (rows.length < 5 || score < 0.8)
        {
            reasons.push('low-confidence');
        }
        else if (previous.benchmark || rows.some((row) => row.waitClass === 'benchmark'))
        {
            reasons.push('fixed-benchmark-grant');
        }
        else if (attributions.size !== 1 || attributions.has('unknown'))
        {
            reasons.push('attribution-veto');
        }
        else
        {
            const demand = robustHighRss(rows) * 1.3;
            const pressure = rows.some((row) => row.memoryPsi > 0 || row.majorFaults > 0
                || (row.gcPressure ?? 0) > 0 || (row.allocationPressure ?? 0) > 0);
            target = clamp(demand, previous.memoryGiB, 0.2);
            if (pressure && target < previous.memoryGiB)
            {
                target = previous.memoryGiB;
                reasons.push('pressure-shrink-veto');
            }
            else
            {
                reasons.push('winsorized-high-rss-with-margin');
            }
        }
        const lifetimeMs = rows.length ? quantile(rows.map((row) => row.lifetimeMs), 0.9) : null;
        return {
            producerId: previous.producerId, recommendedMemoryGiB: target,
            attribution: attributions.size === 1 ? [...attributions][0] : 'unknown', lifetimeMs,
            confidence: score, sampleCount: rows.length,
            decision: target === previous.memoryGiB ? 'no-change' : 'recommend', reasonVector: reasons
        };
    });
    let concurrentDemand = 0;
    requireCondition(capacity.maxConcurrentInstances
        && Object.keys(capacity.maxConcurrentInstances).sort().join()
        === recommendations.map((row) => row.producerId).sort().join(),
    'missing-concurrency-envelope', 'capacity.maxConcurrentInstances');
    for (const row of recommendations)
    {
        const copies = capacity.maxConcurrentInstances[row.producerId];
        requireCondition(Number.isSafeInteger(copies) && copies >= 1,
            'invalid-concurrency-envelope', row.producerId);
        // Unknown attribution keeps the full held grant and worst-case concurrency.
        concurrentDemand += row.recommendedMemoryGiB * (row.attribution === 'resident' ? 1 : copies);
    }
    requireCondition(concurrentDemand + reserve <= capacity.totalMemoryGiB,
        'infeasible-memory-envelope', 'capacity', `demand=${concurrentDemand}; reserve=${reserve}`);
    return seal({
        schema: memorySchema, authority: 'DATA_ONLY', identity: history.identity, ledgerHead: history.head,
        defaultsDigest: digestJson(history.defaults), capacity: structuredClone(capacity),
        learningRunIds: history.samples.map((sample) => sample.runId),
        recommendedSystemReserveGiB: reserve, concurrentDemandGiB: concurrentDemand,
        policy: { minimumSamples: 5, minimumConfidence: 0.8, maximumUpdateFraction: 0.2,
            rssQuantile: 0.9, upperWinsorQuantile: 0.8, safetyMargin: 0.3 }, recommendations
    });
}
