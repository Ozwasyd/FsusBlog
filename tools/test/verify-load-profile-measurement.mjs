import { createLoadExecutionPlan, loadWindowFailures } from './load-profile-window.mjs';
import { calculateLoadSampleMetrics, normalizeLoadResourceObservability } from './load-sample-metrics.mjs';
import { digestValue } from './release-reliability-receipt.mjs';

const same = (left, right) => digestValue({ value: left }) === digestValue({ value: right });

/** Recalculate measurement evidence; source/lease/noise admission remains external. */
export function verifyLoadProfileMeasurement(document, { routeIds, paths, requireBoundIdentity = true })
{
    if (!['fsusblog.release-load-profile.v2', 'fsusblog.qualified-load-profile-summary.v1'].includes(document.schema)
        || document.contentDigest !== digestValue(document) || document.status !== 'ok')
    {
        throw new Error('load measurement schema/status/content digest mismatch');
    }
    const probe = document.runtime;
    const plan = createLoadExecutionPlan(document.effective, routeIds);
    if (!same(probe.plan, plan) || document.executionPlanDigest !== plan.contentDigest
        || probe.generatorBudget?.maxDispatchedRequests !== plan.maximumDispatchedRequests
        || probe.dispatches.length > plan.maximumDispatchedRequests
        || document.policyDigest !== document.policy.fileDigest
        || document.sampling.minimumCompletedRequests !== plan.minimumCompletedRequests
        || document.sampling.totalRequests !== probe.dispatches.length
        || probe.dispatches.some((d) => d.path !== paths[routeIds.indexOf(d.routeId)]))
    {
        throw new Error('load execution plan/path distribution mismatch');
    }
    const failures = loadWindowFailures(probe);
    if (failures.length > 0 || probe.routeFailures.length > 0 || probe.failureReasons.length > 0
        || probe.status !== 'ok' || !same(probe.identityBefore, probe.identityAfter))
    {
        throw new Error(`load window rejected: ${failures.join(', ')}`);
    }
    if (requireBoundIdentity && (document.evidenceClass !== 'correctness'
        || !document.releaseReliability
        || !same(probe.identityBefore.binding, document.releaseReliability)
        || probe.identityBefore.target?.kind !== 'docker-container'
        || probe.identityBefore.target?.status !== 'ok'))
    {
        throw new Error('diagnostic or unbound load evidence cannot qualify');
    }
    const calculated = calculateLoadSampleMetrics({ samples: probe.samples,
        expectedRequests: probe.expectedRequests, durationMs: probe.window.totalElapsedMs });
    if (calculated.completed === 0 || calculated.cancelledCount !== 0
        || !same(calculated, probe.calculated) || document.sampleCount !== calculated.sampleCount
        || probe.sampleCount !== calculated.sampleCount || probe.concurrency !== plan.concurrency
        || document.samplesDigest !== calculated.samplesDigest
        || !same(document.outcomeCounts, calculated.outcomeCounts)
        || !same(document.statusDistribution, calculated.statusDistribution))
    {
        throw new Error('load sample statistics differ from dispatched membership');
    }
    const expectedMetrics = {
        rps: calculated.rps, p50Ms: calculated.latencyMs.p50,
        p95Ms: calculated.latencyMs.p95, p99Ms: calculated.latencyMs.p99,
        maxLatencyMs: calculated.latencyMs.max,
        errorRate: calculated.errorRate, timeoutRate: calculated.timeoutRate,
        ...normalizeLoadResourceObservability(document.resourceObservability)
    };
    if (!same(document.metrics, expectedMetrics))
    {
        throw new Error('load metrics differ from canonical sample calculation');
    }
    const distribution = routeIds.map((routeId, index) => ({ routeId, path: paths[index],
        planned: probe.dispatches.filter((d) => d.routeId === routeId).length,
        actual: probe.samples.filter((s) => s.path === paths[index]).length }));
    if (!same(document.pathDistribution, distribution)
        || distribution.some((d) => d.planned !== d.actual))
    {
        throw new Error('load planned/actual route counts differ');
    }
    const readings = document.resourceSamples;
    const window = probe.window;
    if (!Array.isArray(readings) || readings.length < 2
        || readings[0].phase !== 'start' || readings.at(-1).phase !== 'end'
        || !Number.isFinite(window.resourceSamplingStartedMonotonicMs)
        || !Number.isFinite(window.resourceSamplingFinishedMonotonicMs)
        || window.resourceSamplingStartedMonotonicMs < 0
        || window.resourceSamplingStartedMonotonicMs > window.measurementStart
        || window.resourceSamplingFinishedMonotonicMs < window.finishedMonotonicMs
        || window.resourceSamplingFinishedMonotonicMs > window.identityVerificationStartedMonotonicMs
        || readings[0].observedMonotonicMs < window.resourceSamplingStartedMonotonicMs
        || readings[0].observedMonotonicMs > window.measurementStart
        || readings.at(-1).observedMonotonicMs < window.finishedMonotonicMs
        || readings.at(-1).observedMonotonicMs > window.resourceSamplingFinishedMonotonicMs
        || readings.some((reading, index) => !Number.isFinite(reading.observedMonotonicMs)
            || index > 0 && reading.observedMonotonicMs <= readings[index - 1].observedMonotonicMs
            || index > 0 && index < readings.length - 1
                && (reading.phase !== 'interval' || reading.observedMonotonicMs < window.measurementStart
                    || reading.observedMonotonicMs > window.finishedMonotonicMs)))
    {
        throw new Error('load resource sample curve is incomplete or outside observed load window');
    }
    if (document.resourceObservability.rssBytes.status === 'ok'
        && (readings.some((r) => r.status !== 'ok' || !Number.isSafeInteger(r.value) || r.value < 0)
            || document.resourceObservability.rssBytes.value !== readings.reduce((max, r) => Math.max(max, r.value), 0)))
    {
        throw new Error('load RSS availability/peak differs from resource samples');
    }
    return calculated;
}
