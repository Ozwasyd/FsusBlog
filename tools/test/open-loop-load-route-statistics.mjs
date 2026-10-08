import { canonicalJson, sealContentDigest } from './attempt-provenance.mjs';
import { routeCatalogDigest, routeContract } from './lanes/runtime-http-route-contract.mjs';
import { verifyOpenLoopLoadSchedule, verifyOpenLoopLoadTimeline } from './open-loop-load-schedule.mjs';

const policySchema = 'fsusblog.release-load-route-statistics-policy.v1';
const statisticsSchema = 'fsusblog.release-load-route-statistics.v1';
const thresholdKeys = ['latencyP95Ms', 'latencyP99Ms', 'latencyMaxMs', 'errorRate', 'timeoutRate', 'dropRate'];

function exactObject(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    {
        throw new Error(`${label} requires its exact explicit fields`);
    }
}

function boundedNumber(value, maximum, label, integer = false)
{
    if (!Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isSafeInteger(value)))
    {
        throw new Error(`${label} requires a finite non-negative ${integer ? 'integer' : 'number'}`);
    }
}

function freeze(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function digest(value)
{
    return sealContentDigest(value).contentDigest;
}

/**
 * Validate explicit route limits against an existing exact arrival schedule and
 * the consumer's actual producer route IDs. No limits are inferred from samples.
 * Returns a canonical immutable policy; malformed or incomplete input throws.
 */
export function validateLoadRouteStatisticsPolicy(candidate, schedule, expectedRouteIds)
{
    verifyOpenLoopLoadSchedule(schedule, expectedRouteIds);
    if (!Array.isArray(expectedRouteIds) || expectedRouteIds.length === 0)
    {
        throw new Error('route statistics requires explicit producer route membership');
    }
    exactObject(candidate, ['schema', 'routes'], 'route statistics policy');
    if (candidate.schema !== policySchema || !Array.isArray(candidate.routes)
        || candidate.routes.length !== expectedRouteIds.length)
    {
        throw new Error('route statistics policy schema or route membership is incomplete');
    }
    const routes = candidate.routes.map((route) =>
    {
        exactObject(route, ['routeId', 'minimumValidSamples', 'thresholds'], 'route statistics member');
        routeContract(route.routeId);
        boundedNumber(route.minimumValidSamples, schedule.plannedCount, 'minimumValidSamples', true);
        if (route.minimumValidSamples === 0)
        {
            throw new Error('minimumValidSamples must be positive for every route');
        }
        exactObject(route.thresholds, thresholdKeys, 'per-route thresholds');
        for (const key of thresholdKeys)
        {
            boundedNumber(route.thresholds[key], key.endsWith('Rate') ? 1 : Number.MAX_SAFE_INTEGER, key);
        }
        return { routeId: route.routeId, minimumValidSamples: route.minimumValidSamples,
            thresholds: { ...route.thresholds } };
    }).sort((left, right) => left.routeId < right.routeId ? -1 : Number(left.routeId > right.routeId));
    if (new Set(routes.map((route) => route.routeId)).size !== routes.length
        || canonicalJson(routes.map((route) => route.routeId)) !== canonicalJson([...expectedRouteIds].sort()))
    {
        throw new Error('route statistics policy differs from exact producer route membership');
    }
    return freeze({ schema: policySchema, routes });
}

function validateSample(sample, routeId)
{
    const contract = routeContract(routeId);
    exactObject(sample, ['routeId', 'contractDigest', 'status', 'contentType', 'bodyBytes',
        'latencyMs', 'frameType', 'failureKind', 'ok'], 'settled route sample');
    if (sample.routeId !== routeId || sample.contractDigest !== routeCatalogDigest()
        || typeof sample.ok !== 'boolean' || sample.ok !== (sample.failureKind === null)
        || (sample.failureKind !== null && (typeof sample.failureKind !== 'string' || !sample.failureKind)))
    {
        throw new Error('settled sample differs from its actual route contract identity or outcome');
    }
    boundedNumber(sample.latencyMs, Number.MAX_SAFE_INTEGER, 'sample.latencyMs');
    boundedNumber(sample.bodyBytes, Number.MAX_SAFE_INTEGER, 'sample.bodyBytes', true);
    boundedNumber(sample.status, 599, 'sample.status', true);
    if (sample.ok && (sample.status !== contract.expectedStatus
        || !contract.expectedContentType.includes(sample.contentType)
        || sample.bodyBytes < contract.minimumBodyBytes || sample.bodyBytes > contract.maximumBodyBytes
        || (contract.expectedAedsFrameType !== null && sample.frameType !== contract.expectedAedsFrameType)))
    {
        throw new Error('contract-passed sample contradicts the route response contract');
    }
}

function percentile(sorted, fraction)
{
    return sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1];
}

function metrics(records)
{
    const valid = records.filter((record) => record.outcome === 'completed' && record.sample?.ok === true);
    const latencies = valid.map((record) => record.sample.latencyMs).sort((a, b) => a - b);
    const bytes = valid.map((record) => record.sample.bodyBytes).sort((a, b) => a - b);
    const plannedSamples = records.length;
    const completedSamples = records.filter((record) => ['completed', 'timed-out'].includes(record.outcome)).length;
    const failedSamples = records.filter((record) => record.outcome === 'completed' && record.sample?.ok !== true).length;
    const timedOutSamples = records.filter((record) => record.outcome === 'timed-out').length;
    const droppedSamples = records.filter((record) => record.outcome === 'dropped').length;
    return { plannedSamples,
        dispatchedSamples: records.filter((record) => record.dispatchedAtMs !== null).length,
        completedSamples,
        contractPassedSamples: valid.length, failedSamples, timedOutSamples, droppedSamples,
        latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95),
        latencyP99Ms: percentile(latencies, 0.99), latencyMaxMs: latencies.at(-1) ?? null,
        bodyBytesP50: percentile(bytes, 0.5), bodyBytesP99: percentile(bytes, 0.99),
        errorRate: completedSamples === 0 ? null : failedSamples / completedSamples,
        timeoutRate: completedSamples === 0 ? null : timedOutSamples / completedSamples,
        dropRate: droppedSamples / plannedSamples };
}

function membership(records)
{
    return records.map(({ sample, ...record }) => ({ ...record, sampleDigest: sample === null ? null : digest(sample) }));
}

/**
 * Consume {schedule,timeline,routePolicy,expectedRouteIds,sourceSha,includeAggregate?}.
 * sourceSha is a full Git SHA, not a runtime receipt. Policy identity combines the
 * unchanged arrival policy with explicit route limits. Percentiles use nearest rank
 * over only contract-passed completed samples. completedSamples includes settled
 * completed and timed-out outcomes; failedSamples counts unsuccessful completed
 * outcomes, excluding timeouts, drops and cancellations. Error/timeout rates use
 * completedSamples as denominator and remain null when it is zero. dropRate is
 * droppedSamples / plannedSamples, measuring unsent planned arrivals separately.
 * Any route or arrival-conformance failure
 * makes passed false. Optional aggregate metrics have no pass authority.
 * This pure source oracle performs no HTTP and grants no runtime qualification.
 */
export function buildOpenLoopLoadRouteStatistics({
    schedule, timeline, routePolicy, expectedRouteIds, sourceSha, includeAggregate = true
})
{
    const policy = validateLoadRouteStatisticsPolicy(routePolicy, schedule, expectedRouteIds);
    if (typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceSha)
        || typeof includeAggregate !== 'boolean')
    {
        throw new Error('route statistics requires a full source SHA and boolean aggregate selection');
    }
    const arrivalValidation = verifyOpenLoopLoadTimeline(schedule, timeline);
    const records = [...timeline.records].sort((left, right) => left.sequence - right.sequence);
    for (const record of records)
    {
        if (record.sample !== null)
        {
            validateSample(record.sample, record.routeId);
        }
    }
    const routePolicyDigest = digest(policy);
    const policyDigest = digest({ arrivalPolicyDigest: schedule.policyDigest, routePolicyDigest });
    const catalogDigest = routeCatalogDigest();
    const candidateIdentity = digest({ sourceSha, policyDigest, routeCatalogDigest: catalogDigest });
    const grouped = new Map(policy.routes.map((route) => [route.routeId, []]));
    for (const record of records)
    {
        grouped.get(record.routeId).push(record);
    }
    const routes = policy.routes.map((route) =>
    {
        const members = grouped.get(route.routeId);
        const statistics = metrics(members);
        const failures = [];
        if (statistics.completedSamples === 0)
        {
            failures.push('no-completed-samples');
        }
        if (statistics.contractPassedSamples < route.minimumValidSamples)
        {
            failures.push('minimum-valid-samples');
        }
        for (const key of thresholdKeys)
        {
            if (statistics[key] === null || statistics[key] > route.thresholds[key])
            {
                failures.push(key);
            }
        }
        if (members.some((record) => record.outcome === 'cancelled'))
        {
            failures.push('cancelled-samples');
        }
        const sampleMembership = membership(members);
        return { ...route, ...statistics, sampleMembership, membershipDigest: digest({ members: sampleMembership }),
            failures, passed: failures.length === 0 };
    });
    return freeze(sealContentDigest({ schema: statisticsSchema, sourceSha, profileId: schedule.policy.profileId,
        policy, arrivalPolicyDigest: schedule.policyDigest, routePolicyDigest, policyDigest,
        routeCatalogDigest: catalogDigest, candidateIdentity, scheduleDigest: schedule.contentDigest,
        timelineDigest: timeline.contentDigest, membershipDigest: digest({ members: membership(records) }),
        routes, ...(includeAggregate ? { aggregate: metrics(records) } : {}),
        arrivalPassed: arrivalValidation.passed, passed: arrivalValidation.passed && routes.every((route) => route.passed),
        qualificationEligible: false }));
}

/** Recompute statistics, exact membership, digests and pass decisions from inputs. */
export function verifyOpenLoopLoadRouteStatistics(statistics, inputs)
{
    if (!statistics || typeof statistics !== 'object' || Array.isArray(statistics))
    {
        throw new Error('route statistics summary must be an object');
    }
    const expected = buildOpenLoopLoadRouteStatistics({ ...inputs,
        includeAggregate: Object.hasOwn(statistics, 'aggregate') });
    if (canonicalJson(statistics) !== canonicalJson(expected))
    {
        throw new Error('route statistics differs from exact policy, sample membership, metrics or decision');
    }
    return expected;
}
