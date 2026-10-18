import { assert, canonical, digest, exactKeys, readRef } from './production-fresh-contract.mjs';

export const intervalClasses = Object.freeze([
    'productive', 'legitimate-isolation', 'external-io', 'dependency-blocked', 'readiness-blocked',
    'capacity-blocked', 'exclusive-blocked', 'unexplained'
]);
const metricDefinitions = {
    wallClockMs: ['gate', 'increase'], criticalPathMs: ['gate', 'increase'],
    longestUnproductiveMs: ['gate', 'increase'], peakRssBytes: ['gate', 'increase'],
    cpuPressure: ['gate', 'increase'], memoryPressure: ['gate', 'increase'], ioPressure: ['gate', 'increase'],
    swapBytes: ['gate', 'veto'], oomCount: ['gate', 'veto'], resourceKillCount: ['gate', 'veto'],
    benchmarkCv: ['gate', 'veto'], actualCpuSeconds: ['diagnostic', 'increase'],
    grantedCpuSeconds: ['diagnostic', 'increase'], cpuGrantEfficiency: ['diagnostic', 'decrease'],
    voluntaryContextSwitches: ['diagnostic', 'increase'], involuntaryContextSwitches: ['diagnostic', 'increase'],
    throttleSeconds: ['diagnostic', 'increase'], readBytes: ['diagnostic', 'increase'], writeBytes: ['diagnostic', 'increase'],
    averageRssBytes: ['diagnostic', 'increase'], processSpawnCount: ['diagnostic', 'increase'],
    idleCapacitySeconds: ['diagnostic', 'increase'], reservedCpuUnits: ['diagnostic', 'increase'],
    load: ['diagnostic', 'increase'], runnableQueueDepth: ['diagnostic', 'increase'],
    collectorCpuSeconds: ['diagnostic', 'increase'], collectorNanoseconds: ['diagnostic', 'increase']
};
for (const name of intervalClasses)
{
    metricDefinitions[`waitMs:${name}`] = [name.endsWith('blocked') || name === 'unexplained' ? 'gate' : 'diagnostic', 'increase'];
}
export const metricRegistry = Object.freeze(Object.fromEntries(Object.entries(metricDefinitions)
    .map(([name, [disposition, direction]]) => [name, Object.freeze({ disposition, direction })])));
export const dispositionDigest = digest(metricRegistry);
const derivedNames = new Set(['longestUnproductiveMs', 'cpuGrantEfficiency', ...intervalClasses.map(name => `waitMs:${name}`)]);
const healthNames = ['swapBytes', 'oomCount', 'resourceKillCount', 'benchmarkCv'];
const reasonClasses = Object.freeze({
    'dependency-blocked': 'dependency-blocked', 'readiness-marker-blocked': 'readiness-blocked',
    'waiting-for-startup-capacity': 'capacity-blocked', 'capacity-blocked': 'capacity-blocked',
    'counted-resource-blocked': 'capacity-blocked', 'exclusive-resource-blocked': 'exclusive-blocked',
    'external-service-io-blocked': 'external-io', 'benchmark-isolation-cooldown': 'legitimate-isolation',
    'actual-cpu': 'productive'
});

function metricKey(metric)
{
    return canonical([metric.bundleId, metric.stepId, metric.name]);
}

function classifyInterval(root, run, interval)
{
    exactKeys(interval, ['id', 'bundleId', 'stepId', 'startMs', 'endMs', 'evidence'], 'critical interval');
    assert(typeof interval.id === 'string' && interval.id.length > 0 && typeof interval.bundleId === 'string'
        && typeof interval.stepId === 'string' && Array.isArray(interval.evidence), 'interval identity/evidence required');
    const classes = new Set();
    for (const ref of interval.evidence)
    {
        const state = readRef(root, ref);
        assert(['scheduler', 'marker', 'resource'].includes(state.authority)
            && canonical(state.binding) === canonical(run.receipt.binding)
            && state.intervalId === interval.id && state.startMs === interval.startMs && state.endMs === interval.endMs
            && state.bundleId === interval.bundleId && state.stepId === interval.stepId,
        'interval authority/time/owner binding mismatch');
        const classification = reasonClasses[state.kind];
        assert(classification && typeof state.detail === 'object' && state.detail !== null
            && Object.keys(state.detail).length > 0, 'interval state reason/detail missing');
        if (classification === 'productive')
        {
            assert(state.authority === 'resource' && Number.isFinite(state.detail.actualCpuSeconds)
                && state.detail.actualCpuSeconds > 0, 'productive interval requires actual CPU evidence');
        }
        else if (classification === 'legitimate-isolation')
        {
            assert(state.authority === 'scheduler' && state.detail.exclusive === true
                && run.noise.valid && run.resource.health.isolationValid, 'invalid benchmark quiet authority');
        }
        else if (classification === 'readiness-blocked')
        {
            assert(state.authority === 'marker' && typeof state.detail.marker === 'string', 'readiness marker authority required');
        }
        else
        {
            assert(state.authority === 'scheduler', 'wait requires scheduler state authority');
        }
        classes.add(classification);
    }
    return { ...interval, classification: classes.size === 1 ? [...classes][0] : 'unexplained',
        reason: classes.size > 1 ? 'conflicting-authority' : classes.size === 0 ? 'missing-authority' : 'observed-state' };
}

/** No names/log inference, thresholds or comparison. Unsupported values remain null. */
export function classifyPerformanceRun(root, run)
{
    assert(run.policy.dispositionDigest === dispositionDigest, 'metric registry policy digest mismatch');
    const metrics = run.resource.metrics.map(metric =>
    {
        exactKeys(metric, ['bundleId', 'stepId', 'name', 'status', 'value'], 'metric');
        assert(typeof metric.bundleId === 'string' && typeof metric.stepId === 'string'
            && typeof metric.name === 'string' && Object.hasOwn(metricRegistry, metric.name)
            && !derivedNames.has(metric.name) && !healthNames.includes(metric.name), 'unknown/derived resource metric');
        assert(['measured', 'unsupported', 'unavailable'].includes(metric.status), 'unknown metric status');
        assert(metric.status === 'measured' ? Number.isFinite(metric.value) && metric.value >= 0 : metric.value === null,
            'unsupported/unavailable metric must be null');
        return { ...metric, disposition: metric.status === 'unsupported' ? 'unsupported' : metricRegistry[metric.name].disposition,
            required: metricRegistry[metric.name].disposition === 'gate' };
    });
    for (const name of healthNames)
    {
        metrics.push({ bundleId: 'production', stepId: 'run', name, status: 'measured', value: run.resource.health[name],
            disposition: 'gate', required: true });
    }
    const identities = new Set(metrics.map(metricKey));
    assert(identities.size === metrics.length, 'duplicate metric owner/name');
    const unknown = [];
    for (const [name, definition] of Object.entries(metricRegistry))
    {
        if (definition.disposition === 'gate' && !derivedNames.has(name)
            && !metrics.some(metric => metric.name === name && metric.bundleId === 'production' && metric.stepId === 'run'))
        {
            unknown.push(`missing-required:${name}`);
        }
    }
    const stepIdentities = new Set();
    const plannedSteps = run.identity.values.physicalPlan.steps;
    assert(Array.isArray(plannedSteps) && plannedSteps.length === run.resource.steps.length, 'planned resource step roster mismatch');
    for (const step of run.resource.steps)
    {
        exactKeys(step, ['bundleId', 'stepId', 'cpuHeavy', 'samplingComplete'], 'step');
        assert(typeof step.bundleId === 'string' && typeof step.stepId === 'string'
            && typeof step.cpuHeavy === 'boolean' && typeof step.samplingComplete === 'boolean', 'invalid step');
        assert(plannedSteps.some(planned => planned.bundleId === step.bundleId && planned.stepId === step.stepId
            && planned.cpuHeavy === step.cpuHeavy), 'CPU-heavy applicability differs from sealed physical plan');
        const key = canonical([step.bundleId, step.stepId]);
        assert(!stepIdentities.has(key), 'duplicate step');
        stepIdentities.add(key);
        const actual = metrics.find(metric => metric.bundleId === step.bundleId && metric.stepId === step.stepId && metric.name === 'actualCpuSeconds');
        const grant = metrics.find(metric => metric.bundleId === step.bundleId && metric.stepId === step.stepId && metric.name === 'grantedCpuSeconds');
        const measured = step.cpuHeavy && step.samplingComplete && actual?.status === 'measured'
            && grant?.status === 'measured' && grant.value > 0;
        metrics.push({ bundleId: step.bundleId, stepId: step.stepId, name: 'cpuGrantEfficiency',
            status: !step.cpuHeavy ? 'not-applicable' : measured ? 'measured' : 'unavailable',
            value: measured ? actual.value / grant.value : null, required: step.cpuHeavy,
            disposition: !step.cpuHeavy ? 'not-applicable' : 'diagnostic' });
    }
    for (const metric of metrics)
    {
        assert((metric.bundleId === 'production' && metric.stepId === 'run')
            || stepIdentities.has(canonical([metric.bundleId, metric.stepId])), 'metric owner outside sealed step roster');
    }
    exactKeys(run.intervals, ['binding', 'items'], 'critical-path facts');
    assert(Array.isArray(run.intervals.items), 'critical-path intervals required');
    const intervals = run.intervals.items.map(interval => classifyInterval(root, run, interval))
        .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
    const duration = metrics.find(metric => metric.name === 'criticalPathMs' && metric.bundleId === 'production' && metric.stepId === 'run');
    const wall = metrics.find(metric => metric.name === 'wallClockMs' && metric.bundleId === 'production' && metric.stepId === 'run');
    if (duration?.status === 'measured' && wall?.status === 'measured' && duration.value > wall.value)
    {
        unknown.push('critical-path-exceeds-full-wall-clock');
    }
    const intervalIds = new Set();
    let cursor = 0;
    for (const interval of intervals)
    {
        assert(stepIdentities.has(canonical([interval.bundleId, interval.stepId])), 'interval owner outside sealed step roster');
        assert(Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.startMs === cursor
            && interval.endMs > interval.startMs && !intervalIds.has(interval.id), 'overlapping/gapped/duplicate critical interval');
        intervalIds.add(interval.id);
        cursor = interval.endMs;
        if (interval.classification === 'unexplained')
        {
            unknown.push(`unexplained-interval:${interval.id}`);
        }
    }
    if (duration?.status !== 'measured' || cursor !== duration.value)
    {
        unknown.push('incomplete-critical-path-coverage');
    }
    for (const classification of intervalClasses)
    {
        metrics.push({ bundleId: 'production', stepId: 'run', name: `waitMs:${classification}`, status: 'measured',
            value: intervals.filter(interval => interval.classification === classification)
                .reduce((total, interval) => total + interval.endMs - interval.startMs, 0),
            disposition: metricRegistry[`waitMs:${classification}`].disposition,
            required: metricRegistry[`waitMs:${classification}`].disposition === 'gate' });
    }
    const unproductive = intervals.filter(interval => interval.classification.endsWith('blocked') || interval.classification === 'unexplained');
    const longest = [...unproductive].sort((left, right) => (right.endMs - right.startMs) - (left.endMs - left.startMs))[0];
    metrics.push({ bundleId: longest?.bundleId ?? 'production', stepId: longest?.stepId ?? 'run',
        name: 'longestUnproductiveMs', status: 'measured', value: longest ? longest.endMs - longest.startMs : 0,
        intervalId: longest?.id ?? null, disposition: 'gate', required: true });
    for (const metric of metrics)
    {
        if (metric.required && metric.status !== 'measured')
        {
            unknown.push(`unknown-required:${metricKey(metric)}`);
        }
    }
    return { schema: 'fsusblog.production-fresh.performance-classification.v1', dispositionDigest,
        status: unknown.length ? 'not-evaluable' : 'classified', reasons: unknown, metrics, intervals };
}
