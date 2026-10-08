import { inspectCohort } from './production-fresh-cohort.mjs';
import { assert, canonical, loadPerformanceRun, runInvalidReasons, seal } from './production-fresh-contract.mjs';
import { classifyPerformanceRun, metricRegistry } from './production-fresh-disposition.mjs';

export const comparisonSchema = 'fsusblog.production-fresh.performance-comparison.v1';

function sameMetric(left, right)
{
    return left.name === right.name && (left.name === 'longestUnproductiveMs'
        || (left.bundleId === right.bundleId && left.stepId === right.stepId));
}

/** Read-only comparison. No scheduler/qualification writes, retry, discovery or baseline selection. */
export function comparePerformance({ root, currentLocator, baselineLocator })
{
    const current = loadPerformanceRun(root, currentLocator);
    const baseline = inspectCohort(root, baselineLocator);
    const binding = current.receipt.binding;
    const common = { schema: comparisonSchema, terminal: true, binding, current: current.ref, baseline: baseline.ref,
        baselineIdentityDigest: baseline.cohort.identityDigest, currentIdentityDigest: current.identityDigest,
        reproduce: { executable: 'node', arguments: ['tools/perf/production-fresh-cli.mjs', 'compare', '--root', root,
            '--current-run', currentLocator, '--baseline', baselineLocator, '--out', 'reproduced-comparison.json'], currentLocator, baselineLocator } };
    if (current.identityDigest !== baseline.cohort.identityDigest)
    {
        return seal({ ...common, verdict: 'not-evaluable', reasons: ['identity-mismatch'], classification: null, differences: [] });
    }
    const invalid = runInvalidReasons(current);
    const vetoNames = new Set(['swap', 'oom', 'resource-kill', 'benchmark-isolation-invalid', 'benchmark-cv-invalid', 'planned-executed-drift']);
    const vetoes = invalid.filter(reason => vetoNames.has(reason));
    // Invalid isolation must remain a veto even if its interval can no longer be admitted as quiet.
    if (invalid.length)
    {
        return seal({ ...common, verdict: vetoes.length ? 'regression' : 'not-evaluable', reasons: invalid,
            classification: null, differences: [] });
    }
    const classification = classifyPerformanceRun(root, current);
    const reasons = [...classification.reasons];
    const differences = [];
    for (const metric of classification.metrics)
    {
        const old = baseline.cohort.statistics.find(item => sameMetric(metric, item));
        assert(old, `baseline metric roster drift: ${canonical(metric)}`);
        const definition = metricRegistry[metric.name];
        const required = metric.required;
        const floor = current.noise.floors[metric.name];
        const baselineFloors = baseline.runs.map(run => run.noise.floors[metric.name]);
        const needsNoise = required && definition.direction !== 'veto';
        if (needsNoise && (!Number.isFinite(floor) || baselineFloors.some(value => !Number.isFinite(value))))
        {
            reasons.push(`missing-machine-noise-floor:${metric.name}`);
        }
        const measured = metric.status === 'measured' && old.distribution !== null;
        const noiseFloor = measured && Number.isFinite(floor) && baselineFloors.every(Number.isFinite)
            ? Math.max(floor, ...baselineFloors, old.distribution.spread) : null;
        const delta = measured ? metric.value - old.distribution.p50 : null;
        const relativeDelta = measured && old.distribution.p50 > 0 ? delta / old.distribution.p50 : null;
        // Every regression crosses both the baseline p90 envelope and the calibrated relative/noise margin.
        const margin = measured && noiseFloor !== null
            ? Math.max(noiseFloor, old.distribution.p50 * current.policy.relativeTolerance) : null;
        const regression = measured && margin !== null && definition.disposition === 'gate' && definition.direction === 'increase'
            && delta > margin && metric.value - old.distribution.p90 > noiseFloor;
        const improvement = measured && margin !== null && ['wallClockMs', 'criticalPathMs'].includes(metric.name)
            && -delta > margin;
        differences.push({ bundleId: metric.bundleId, stepId: metric.stepId, intervalId: metric.intervalId ?? null,
            metric: metric.name, baselineDistribution: old.distribution, currentValue: metric.value,
            status: metric.status, noiseFloor, relativeDelta, disposition: metric.disposition,
            relation: regression ? 'regression' : improvement ? 'improvement' : measured ? 'noise-only' : 'not-evaluable',
            reason: regression ? 'exceeds-relative-and-machine-noise-envelope'
                : improvement ? 'wall-or-critical-path-improvement' : measured ? 'within-envelope-or-diagnostic' : 'unknown-metric' });
    }
    const regressions = differences.filter(item => item.relation === 'regression');
    const improvements = differences.filter(item => item.relation === 'improvement');
    return seal({ ...common, verdict: reasons.length ? 'not-evaluable' : regressions.length ? 'regression'
        : improvements.length ? 'improvement' : 'noise-only',
    reasons: reasons.length ? reasons : regressions.length ? regressions.map(item => `regression:${item.metric}`)
        : improvements.length ? ['significant-wall-or-critical-path-improvement'] : ['within-machine-noise-envelope'],
    classification, differences });
}
