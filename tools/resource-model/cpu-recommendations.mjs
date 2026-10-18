import { clamp, confidence, digestJson, quantile, requireCondition, seal } from './contract.mjs';
import { recommendationInputs } from './sample-ledger.mjs';

export const cpuSchema = 'fsusblog.adaptive.cpu-recommendations.v1';

/** Relative weights are clamped; protected grants stay held inside the unchanged CPU envelope. */
export function recommendCpu(inputs)
{
    const history = recommendationInputs(inputs);
    const { capacity } = inputs;
    const heldCpuUnits = new Map();
    const recommendations = history.defaults.map((previous) =>
    {
        const rows = history.rows(previous.producerId);
        const score = rows.length ? confidence(rows.map((row) => row.actualCpuUnits), 5) : 0;
        let weight = previous.cpuWeight;
        let holdGrant = true;
        const reasons = [];
        if (rows.length < 5 || score < 0.8)
        {
            reasons.push('low-confidence');
        }
        else if (previous.benchmark || rows.some((row) => ['benchmark', 'quiet'].includes(row.waitClass)))
        {
            reasons.push('protected-quiet-window');
        }
        else if (rows.some((row) => row.throttledMs > 0))
        {
            reasons.push('throttling-veto');
        }
        else if (rows.some((row) => ['dependency', 'readiness'].includes(row.waitClass)))
        {
            reasons.push('dependency-readiness-veto');
        }
        else
        {
            holdGrant = false;
            const utilization = quantile(rows.map((row) => row.actualCpuUnits / row.grantedCpuUnits), 0.5);
            const efficiency = quantile(rows.map((row) => row.grantEfficiency), 0.5);
            const blocked = quantile(rows.map((row) => row.capacityBlockedMs), 0.5);
            const critical = rows.filter((row) => row.criticalPath).length / rows.length >= 0.8;
            if (critical && utilization >= 0.85 && efficiency >= 0.8 && blocked > 0
                && rows.every((row) => row.waitClass === 'cpu'))
            {
                weight = clamp(previous.cpuWeight * 1.2, previous.cpuWeight, 0.2);
                reasons.push('efficient-critical-capacity-blocked');
            }
            else if (rows.every((row) => row.waitClass === 'io') && utilization < 0.5)
            {
                weight = clamp(previous.cpuWeight * 0.8, previous.cpuWeight, 0.2);
                reasons.push('io-elastic-share');
            }
            else
            {
                reasons.push('no-supported-change');
            }
        }
        if (holdGrant)
        {
            heldCpuUnits.set(previous.producerId, previous.cpuUnits);
        }
        return {
            producerId: previous.producerId, recommendedCpuWeight: weight,
            recommendedMinCpuUnits: previous.minCpuUnits, confidence: score, sampleCount: rows.length,
            benchmark: previous.benchmark, fixedCpuUnits: previous.benchmark ? previous.cpuUnits : null,
            reasonVector: [...reasons, 'retain-safe-minimum']
        };
    });
    const minimumTotal = recommendations.reduce((sum, row) => sum + row.recommendedMinCpuUnits, 0);
    requireCondition(minimumTotal <= capacity.minimumSupportedCpuUnits,
        'infeasible-cpu-minimum', 'recommendations');
    const reservedCpu = recommendations.reduce((sum, row) => sum
        + (heldCpuUnits.get(row.producerId) ?? row.recommendedMinCpuUnits), 0);
    requireCondition(reservedCpu <= capacity.effectiveCpuUnits, 'infeasible-cpu-envelope', 'recommendations');
    const totalWeight = recommendations.filter((row) => !heldCpuUnits.has(row.producerId))
        .reduce((sum, row) => sum + row.recommendedCpuWeight, 0);
    for (const [index, row] of recommendations.entries())
    {
        const previous = history.defaults[index];
        row.recommendedCpuUnits = heldCpuUnits.get(row.producerId) ?? (row.recommendedMinCpuUnits
            + (capacity.effectiveCpuUnits - reservedCpu) * row.recommendedCpuWeight / totalWeight);
        row.decision = row.recommendedCpuWeight === previous.cpuWeight
            && row.recommendedMinCpuUnits === previous.minCpuUnits
            && row.recommendedCpuUnits === previous.cpuUnits ? 'no-change' : 'recommend';
        if (row.recommendedCpuUnits !== previous.cpuUnits)
        {
            row.reasonVector.push('normalized-cpu-grant-change');
        }
    }
    requireCondition(recommendations.reduce((sum, row) => sum + row.recommendedCpuUnits, 0)
        <= capacity.effectiveCpuUnits + 1e-9, 'infeasible-cpu-envelope', 'recommendations');
    return seal({
        schema: cpuSchema, authority: 'DATA_ONLY', identity: history.identity,
        ledgerHead: history.head, defaultsDigest: digestJson(history.defaults), capacity: structuredClone(capacity),
        learningRunIds: history.samples.map((sample) => sample.runId),
        policy: { minimumSamples: 5, minimumConfidence: 0.8, maximumUpdateFraction: 0.2 }, recommendations
    });
}
