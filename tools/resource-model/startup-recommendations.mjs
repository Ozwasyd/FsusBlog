import { confidence, digestJson, finite, quantile, requireCondition, sameIdentity, seal } from './contract.mjs';
import { recommendationInputs } from './sample-ledger.mjs';

export const startupSchema = 'fsusblog.adaptive.startup-recommendations.v1';
const hardConditions = Object.freeze([
    'dependenciesSatisfied', 'markersSealed', 'cpuFeasible', 'memoryFeasible',
    'exclusiveAvailable', 'filesystemOrdered', 'stateConflictFree', 'outputConflictFree', 'benchmarkAllowed'
]);

/** Only already admissible producers are scored. Aging is unbounded; learned benefit is bounded. */
export function recommendStartup(inputs)
{
    const history = recommendationInputs(inputs);
    const { candidates, now, identity } = inputs;
    sameIdentity(identity, history.identity, 'ready-set.identity');
    finite(now, 'now');
    requireCondition(Array.isArray(candidates)
        && new Set(candidates.map((row) => row.producerId)).size === candidates.length,
    'invalid-ready-set', 'candidates');
    const excluded = [];
    const recommendations = [];
    for (const candidate of candidates)
    {
        const previous = history.defaults.find((row) => row.producerId === candidate.producerId);
        requireCondition(previous, 'unknown-producer', candidate.producerId);
        finite(candidate.readyAt, 'candidate.readyAt');
        requireCondition(candidate.readyAt <= now, 'future-ready-time', candidate.producerId);
        const blocked = hardConditions.filter((field) => candidate[field] !== true);
        if (blocked.length)
        {
            excluded.push({ producerId: candidate.producerId, reasonVector: blocked });
            continue;
        }
        const rows = history.rows(candidate.producerId);
        const score = rows.length ? confidence(rows.map((row) => row.firstProductiveChildAt - row.readyAt), 5) : 0;
        let benefit = 0;
        let reason = 'low-confidence';
        if (rows.length >= 5 && score >= 0.8)
        {
            const unlock = quantile(rows.map((row) => row.downstreamUnlockValue), 0.5);
            const latency = quantile(rows.map((row) => row.firstProductiveChildAt - row.readyAt), 0.5);
            const cost = quantile(rows.map((row) => row.startupCpuUnits / inputs.capacity.effectiveCpuUnits
                + row.startupMemoryGiB / inputs.capacity.totalMemoryGiB), 0.5);
            const critical = rows.filter((row) => row.criticalPath).length / rows.length;
            const blockedMs = quantile(rows.map((row) => row.startupCapacityBlockedMs), 0.5);
            const historicalAge = quantile(rows.map((row) => row.queueAgeMs), 0.5);
            benefit = Math.min(100, (20 * critical + 10 * Math.log1p(unlock)
                + Math.min(10, (blockedMs + historicalAge) / 1000)) / (1 + cost + latency / 1000));
            reason = 'critical-unlock-cost-history';
        }
        const aging = (now - candidate.readyAt) / 1000;
        recommendations.push({
            producerId: candidate.producerId, recommendedStartupPriority: previous.startupPriority + benefit,
            score: previous.startupPriority + benefit + aging, aging,
            confidence: score, sampleCount: rows.length, decision: benefit === 0 ? 'no-change' : 'recommend',
            reasonVector: [reason, 'deterministic-aging']
        });
    }
    recommendations.sort((left, right) => right.score - left.score
        || left.producerId.localeCompare(right.producerId));
    excluded.sort((left, right) => left.producerId.localeCompare(right.producerId));
    return seal({
        schema: startupSchema, authority: 'DATA_ONLY', identity: history.identity, ledgerHead: history.head,
        defaultsDigest: digestJson(history.defaults), capacity: structuredClone(inputs.capacity),
        learningRunIds: history.samples.map((sample) => sample.runId),
        readySetDigest: digestJson(candidates), now, recommendations, excluded
    });
}
