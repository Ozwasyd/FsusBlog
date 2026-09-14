import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const SATURATION_SCHEMA = 'fsusblog.performance-saturation.v2';
export const SATURATION_TOPOLOGIES = Object.freeze([
    'kestrel-only',
    'production-topology'
]);
export const SATURATION_ROUTES = Object.freeze([
    'l0-binary-identity',
    'l0-binary-br',
    'l0-binary-gzip',
    'l0-binary-304',
    'l0-binary-head',
    'l0-html-static',
    'l0-html-nonce',
    'l1-cache-hit',
    'l2-redis-hit',
    'db-miss-buffer-cold',
    'db-miss-buffer-warm',
    'notification-1',
    'notification-100',
    'notification-1000',
    'browser-aeds-decode',
    'browser-public-takeover',
    'browser-hydration-long-task'
]);

export const REQUIRED_METRIC_PATHS = Object.freeze([
    'request.cyclesPerRequest',
    'request.instructionsPerRequest',
    'request.ipc',
    'request.branchMissesPerRequest',
    'request.llcMissesPerRequest',
    'request.contextSwitchesPerRequest',
    'request.cpuMigrationsPerRequest',
    'request.syscallsPerRequest',
    'request.allocationBytesPerRequest',
    'request.responseBytesPerRequest',
    'request.wireBytesPerRequest',
    'process.processCpuPercent',
    'process.containerCpuPercent',
    'process.cgroupThrottledMs',
    'managed.heapBytes',
    'managed.lohBytes',
    'managed.gen0Count',
    'managed.gen1Count',
    'managed.gen2Count',
    'managed.gcPauseP95Ms',
    'managed.gcPauseP99Ms',
    'queues.threadPoolQueueLength',
    'queues.workerAvailable',
    'queues.ioAvailable',
    'queues.activeRequests',
    'queues.sockets',
    'queues.fileDescriptors',
    'queues.requestQueueSlope',
    'postgres.poolActive',
    'postgres.poolIdle',
    'postgres.poolWaitCount',
    'postgres.poolWaitP99Ms',
    'postgres.calls',
    'postgres.meanTimeMs',
    'postgres.maxTimeMs',
    'postgres.rows',
    'postgres.sharedBlocks',
    'postgres.tempBlocks',
    'postgres.walBytes',
    'redis.commandCount',
    'redis.roundtripP95Ms',
    'redis.roundtripP99Ms',
    'loadGenerator.cpuPercent',
    'loadGenerator.scheduleLagP99Ms',
    'loadGenerator.droppedArrivals'
]);

const REQUIRED_IDENTITY_PATHS = Object.freeze([
    'commitSha',
    'imageDigest',
    'capturedAt',
    'serviceHost',
    'hardware.cpuModel',
    'hardware.logicalCpus',
    'hardware.physicalCores',
    'hardware.smt',
    'hardware.microcode',
    'platform.kernel',
    'platform.libc',
    'platform.containerRuntime',
    'cgroup.cpuQuota',
    'cgroup.memoryLimitBytes',
    'cgroup.cpuset',
    'runtime.dotnetVersion',
    'runtime.environmentDigest',
    'proxy.kind',
    'proxy.configDigest',
    'proxy.tlsConfigDigest',
    'postgres.version',
    'postgres.configDigest',
    'redis.version',
    'redis.configDigest',
    'fixture.datasetId',
    'fixture.articleCount',
    'fixture.commentCount',
    'fixture.artifactCount',
    'loadGenerator.host',
    'loadGenerator.cpuModel',
    'loadGenerator.logicalCpus',
    'loadGenerator.cpuAffinity',
    'loadGenerator.networkPath',
    'serviceCpuAffinity'
]);

const REQUIRED_IDENTITY_DIGEST_PATHS = Object.freeze([
    'runtime.environmentDigest',
    'proxy.configDigest',
    'proxy.tlsConfigDigest',
    'postgres.configDigest',
    'redis.configDigest'
]);

const REQUIRED_IDENTITY_POSITIVE_INTEGER_PATHS = Object.freeze([
    'hardware.logicalCpus',
    'hardware.physicalCores',
    'cgroup.memoryLimitBytes',
    'fixture.articleCount',
    'fixture.commentCount',
    'fixture.artifactCount',
    'loadGenerator.logicalCpus'
]);

export const DEFAULT_SATURATION_POLICY = Object.freeze({
    minimumRepeats: 3,
    minimumOfferedLoadSteps: 4,
    saturationFloorPercent: 85,
    saturationCeilingPercent: 95,
    maximumErrorRate: 0.005,
    maximumTimeoutRate: 0,
    maximumP99AtSafeMs: 250,
    maximumP999AtSafeMs: 500,
    maximumThroughputVariance: 0.1,
    maximumGeneratorCpuPercent: 85,
    maximumGeneratorScheduleLagP99Ms: 5,
    safeHeadroomPercent: 15,
    maximumEvidenceAgeMs: 24 * 60 * 60 * 1000
});

export function parseSaturationPolicy(text)
{
    const section = String(text).match(/(?:^|\n)saturationEvidence:\n([\s\S]*)$/u)?.[1];
    if (!section)
    {
        throw new Error('perf policy is missing saturationEvidence');
    }
    const scalar = (name) => section.match(new RegExp(`^  ${name}:\\s*(.+)$`, 'mu'))?.[1]?.trim();
    const number = (name) =>
    {
        const value = Number(scalar(name));
        if (!Number.isFinite(value))
        {
            throw new Error(`saturationEvidence.${name} must be numeric`);
        }
        return value;
    };
    const list = (name) =>
    {
        const inline = scalar(name);
        if (inline?.startsWith('['))
        {
            return inline.slice(1, -1).split(',').map((value) => value.trim()).filter(Boolean);
        }
        const block = section.match(new RegExp(`^  ${name}:\\n((?:    - .+\\n?)+)`, 'mu'))?.[1] ?? '';
        return [...block.matchAll(/^ {4}- (.+)$/gmu)].map((match) => match[1].trim());
    };
    const routes = list('routes');
    const topologies = list('topologies');
    if (scalar('schema') !== SATURATION_SCHEMA)
    {
        throw new Error(`saturationEvidence.schema must equal ${SATURATION_SCHEMA}`);
    }
    if (scalar('evidenceKind') !== 'real')
    {
        throw new Error('saturationEvidence.evidenceKind must equal real');
    }
    if (JSON.stringify(routes) !== JSON.stringify(SATURATION_ROUTES))
    {
        throw new Error('saturationEvidence.routes drifted from the v2 route matrix');
    }
    if (JSON.stringify(topologies) !== JSON.stringify(SATURATION_TOPOLOGIES))
    {
        throw new Error('saturationEvidence.topologies drifted from the v2 topology matrix');
    }
    return {
        schema: SATURATION_SCHEMA,
        evidenceKind: 'real',
        routes,
        topologies,
        policy: {
            minimumRepeats: number('minimumRepeats'),
            minimumOfferedLoadSteps: number('minimumOfferedLoadSteps'),
            saturationFloorPercent: number('saturationFloorPercent'),
            saturationCeilingPercent: number('saturationCeilingPercent'),
            safeHeadroomPercent: number('safeHeadroomPercent'),
            maximumErrorRate: number('maximumErrorRate'),
            maximumTimeoutRate: number('maximumTimeoutRate'),
            maximumP99AtSafeMs: number('maximumP99AtSafeMs'),
            maximumP999AtSafeMs: number('maximumP999AtSafeMs'),
            maximumThroughputVariance: number('maximumThroughputVariance'),
            maximumGeneratorCpuPercent: number('maximumGeneratorCpuPercent'),
            maximumGeneratorScheduleLagP99Ms: number('maximumGeneratorScheduleLagP99Ms'),
            maximumEvidenceAgeMs: number('maximumEvidenceAgeHours') * 60 * 60 * 1000
        }
    };
}

export function readSaturationPolicy(file)
{
    return parseSaturationPolicy(fs.readFileSync(file, 'utf8'));
}

function atPath(value, dottedPath)
{
    return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

function isNonEmpty(value)
{
    return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

function isFiniteNonNegative(value)
{
    return Number.isFinite(value) && value >= 0;
}

function mean(values)
{
    return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values, percentileValue)
{
    if (values.length === 0)
    {
        return null;
    }
    const ordered = [...values].sort((left, right) => left - right);
    const index = Math.min(
        ordered.length - 1,
        Math.max(0, Math.ceil(percentileValue / 100 * ordered.length) - 1)
    );
    return ordered[index];
}

function coefficientOfVariation(values)
{
    const average = mean(values);
    if (average === 0)
    {
        return 0;
    }
    const variance = mean(values.map((value) => (value - average) ** 2));
    return Math.sqrt(variance) / average;
}

function round(value, digits = 3)
{
    return Number(value.toFixed(digits));
}

function digestJson(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function parseCpuSet(value)
{
    const cpus = new Set();
    for (const segment of String(value ?? '').split(','))
    {
        const match = segment.trim().match(/^(\d+)(?:-(\d+))?$/u);
        if (!match)
        {
            return null;
        }
        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        if (end < start || end - start > 65_535)
        {
            return null;
        }
        for (let cpu = start; cpu <= end; cpu += 1)
        {
            cpus.add(cpu);
        }
    }
    return cpus.size > 0 ? cpus : null;
}

export function createOpenLoopSchedule({ rate, durationMs, startMs = 0 })
{
    if (!Number.isFinite(rate) || rate <= 0)
    {
        throw new Error('open-loop rate must be positive');
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0)
    {
        throw new Error('open-loop durationMs must be positive');
    }
    const intervalMs = 1000 / rate;
    const count = Math.max(1, Math.floor(rate * durationMs / 1000));
    return Array.from({ length: count }, (_, index) => startMs + index * intervalMs);
}

export function summarizeOpenLoopAttempts({ attempts, durationMs, processCpuPercent = 0 })
{
    if (!Array.isArray(attempts) || attempts.length === 0)
    {
        throw new Error('open-loop attempts are required');
    }
    const completed = attempts.filter((attempt) => attempt.completed === true);
    const successful = completed.filter((attempt) => attempt.error !== true);
    const elapsedSeconds = durationMs / 1000;
    const latencies = successful.map((attempt) => Number(attempt.latencyMs));
    const lags = attempts.map((attempt) => Number(attempt.scheduleLagMs));
    const errors = attempts.filter((attempt) => attempt.error === true).length;
    const timeouts = attempts.filter((attempt) => attempt.timeout === true).length;
    const dropped = attempts.filter((attempt) => attempt.dropped === true).length;
    return {
        offeredRps: round(attempts.length / elapsedSeconds),
        achievedRps: round(completed.length / elapsedSeconds),
        p50Ms: round(percentile(latencies, 50) ?? 0),
        p95Ms: round(percentile(latencies, 95) ?? 0),
        p99Ms: round(percentile(latencies, 99) ?? 0),
        p999Ms: round(percentile(latencies, 99.9) ?? 0),
        errorRate: round(errors / attempts.length, 6),
        timeoutRate: round(timeouts / attempts.length, 6),
        responseCount: completed.length,
        durationMs,
        generator: {
            cpuPercent: round(processCpuPercent),
            scheduleLagP99Ms: round(percentile(lags, 99) ?? 0),
            droppedArrivals: dropped
        }
    };
}

export function validateMeasurementSample(sample)
{
    const errors = [];
    for (const field of [
        'offeredRps', 'achievedRps', 'p50Ms', 'p95Ms', 'p99Ms', 'p999Ms',
        'errorRate', 'timeoutRate', 'durationMs', 'repeat', 'responseCount'
    ])
    {
        if (!isFiniteNonNegative(sample?.[field]))
        {
            errors.push(`sample.${field} must be a finite non-negative number`);
        }
    }
    for (const field of ['offeredRps', 'achievedRps', 'durationMs'])
    {
        if (!(sample?.[field] > 0))
        {
            errors.push(`sample.${field} must be positive`);
        }
    }
    if (!Number.isInteger(sample?.repeat) || sample.repeat < 1)
    {
        errors.push('sample.repeat must be a positive integer');
    }
    if (!Number.isInteger(sample?.responseCount) || sample.responseCount < 0)
    {
        errors.push('sample.responseCount must be a non-negative integer');
    }
    if (sample?.achievedRps > sample?.offeredRps)
    {
        errors.push('sample.achievedRps cannot exceed offeredRps');
    }
    if (sample?.errorRate > 1 || sample?.timeoutRate > 1 || sample?.timeoutRate > sample?.errorRate)
    {
        errors.push('sample error/timeout rates must be ordered fractions between 0 and 1');
    }
    const latencyOrder = ['p50Ms', 'p95Ms', 'p99Ms', 'p999Ms'].map((field) => sample?.[field]);
    if (latencyOrder.some((value, index) => index > 0 && value < latencyOrder[index - 1]))
    {
        errors.push('sample latency percentiles must be monotonic');
    }
    if (sample?.durationMs > 0 && Number.isInteger(sample?.responseCount))
    {
        const derivedAchievedRps = sample.responseCount / (sample.durationMs / 1000);
        if (Math.abs(derivedAchievedRps - sample.achievedRps) > 0.001)
        {
            errors.push('sample.achievedRps does not match responseCount and durationMs');
        }
    }
    for (const resource of ['cpu', 'memory', 'tlsNic', 'redis', 'postgres'])
    {
        const value = sample?.resourceSaturation?.[resource];
        if (!isFiniteNonNegative(value) || value > 100)
        {
            errors.push(`sample.resourceSaturation.${resource} must be between 0 and 100`);
        }
    }
    for (const metricPath of REQUIRED_METRIC_PATHS)
    {
        if (!isFiniteNonNegative(atPath(sample?.metrics, metricPath)))
        {
            errors.push(`sample.metrics.${metricPath} must be a finite non-negative number`);
        }
    }
    for (const metricPath of ['request.cyclesPerRequest', 'request.instructionsPerRequest', 'request.ipc'])
    {
        if (!(atPath(sample?.metrics, metricPath) > 0))
        {
            errors.push(`sample.metrics.${metricPath} must be positive`);
        }
    }
    const startedAt = Date.parse(sample?.window?.startedAt);
    const endedAt = Date.parse(sample?.window?.endedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt)
    {
        errors.push('sample.window must contain ordered ISO startedAt/endedAt timestamps');
    }
    else
    {
        const windowDurationMs = endedAt - startedAt;
        if (Math.abs(windowDurationMs - sample.durationMs) > Math.max(1000, sample.durationMs * 0.1))
        {
            errors.push('sample.window duration does not match load duration');
        }
    }
    for (const source of ['load', 'systemMetrics'])
    {
        if (!/^sha256:[0-9a-f]{64}$/u.test(String(sample?.sourceDigests?.[source] ?? '')))
        {
            errors.push(`sample.sourceDigests.${source} must be a sha256 digest`);
        }
    }
    return errors;
}

export function validateSaturationIdentity(identity, {
    expectedCommit,
    expectedImageDigest,
    now = Date.now(),
    maximumEvidenceAgeMs = DEFAULT_SATURATION_POLICY.maximumEvidenceAgeMs
} = {})
{
    const errors = [];
    for (const identityPath of REQUIRED_IDENTITY_PATHS)
    {
        if (!isNonEmpty(atPath(identity, identityPath)))
        {
            errors.push(`identity.${identityPath} is required`);
        }
    }
    if (!/^[0-9a-f]{40}$/u.test(String(identity?.commitSha ?? '')))
    {
        errors.push('identity.commitSha must be a full lowercase commit SHA');
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(identity?.imageDigest ?? '')))
    {
        errors.push('identity.imageDigest must be an OCI sha256 digest');
    }
    for (const identityPath of REQUIRED_IDENTITY_DIGEST_PATHS)
    {
        if (!/^sha256:[0-9a-f]{64}$/u.test(String(atPath(identity, identityPath) ?? '')))
        {
            errors.push(`identity.${identityPath} must be a sha256 digest`);
        }
    }
    for (const identityPath of REQUIRED_IDENTITY_POSITIVE_INTEGER_PATHS)
    {
        const value = atPath(identity, identityPath);
        if (!Number.isSafeInteger(value) || value <= 0)
        {
            errors.push(`identity.${identityPath} must be a positive integer`);
        }
    }
    if (typeof identity?.hardware?.smt !== 'boolean')
    {
        errors.push('identity.hardware.smt must be boolean');
    }
    if (expectedCommit && identity?.commitSha !== expectedCommit)
    {
        errors.push('identity.commitSha does not match the current commit');
    }
    if (expectedImageDigest && identity?.imageDigest !== expectedImageDigest)
    {
        errors.push('identity.imageDigest does not match the selected image');
    }
    const capturedAt = Date.parse(identity?.capturedAt);
    if (!Number.isFinite(capturedAt))
    {
        errors.push('identity.capturedAt must be an ISO timestamp');
    }
    else if (capturedAt > now + 60_000 || now - capturedAt > maximumEvidenceAgeMs)
    {
        errors.push('identity evidence is stale or from the future');
    }
    if (identity?.loadGenerator?.host === identity?.serviceHost)
    {
        errors.push('load generator and service must use separate hosts for production evidence');
    }
    const generatorCpuSet = parseCpuSet(identity?.loadGenerator?.cpuAffinity);
    const serviceCpuSet = parseCpuSet(identity?.serviceCpuAffinity);
    if (!generatorCpuSet)
    {
        errors.push('identity.loadGenerator.cpuAffinity must use Linux cpuset syntax');
    }
    if (!serviceCpuSet)
    {
        errors.push('identity.serviceCpuAffinity must use Linux cpuset syntax');
    }
    if (generatorCpuSet && serviceCpuSet && [...generatorCpuSet].some((cpu) => serviceCpuSet.has(cpu)))
    {
        errors.push('load generator and service CPU affinity must be isolated');
    }
    return errors;
}

function groupSamplesByOfferedLoad(samples)
{
    const groups = new Map();
    for (const sample of samples)
    {
        const key = Number(sample.offeredRps);
        if (!groups.has(key))
        {
            groups.set(key, []);
        }
        groups.get(key).push(sample);
    }
    return [...groups.entries()]
        .sort(([left], [right]) => left - right)
        .map(([offeredRps, groupSamples]) => ({ offeredRps, samples: groupSamples }));
}

function groupSummary(group)
{
    const samples = group.samples;
    const resource = Object.fromEntries(['cpu', 'memory', 'tlsNic', 'redis', 'postgres'].map((name) => [
        name,
        mean(samples.map((sample) => sample.resourceSaturation[name]))
    ]));
    return {
        offeredRps: group.offeredRps,
        achievedRps: mean(samples.map((sample) => sample.achievedRps)),
        p99Ms: Math.max(...samples.map((sample) => sample.p99Ms)),
        p999Ms: Math.max(...samples.map((sample) => sample.p999Ms)),
        errorRate: Math.max(...samples.map((sample) => sample.errorRate)),
        timeoutRate: Math.max(...samples.map((sample) => sample.timeoutRate)),
        queueSlope: Math.max(...samples.map((sample) => sample.metrics.queues.requestQueueSlope)),
        throughputVariance: coefficientOfVariation(samples.map((sample) => sample.achievedRps)),
        resource,
        samples
    };
}

function limitingResource(resource)
{
    return Object.entries(resource).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
}

function averageMetric(samples, path)
{
    return mean(samples.map((sample) => atPath(sample.metrics, path)));
}

export function analyzeSaturationScenario(samples, policyOverrides = {})
{
    const policy = { ...DEFAULT_SATURATION_POLICY, ...policyOverrides };
    const blockers = [];
    if (!Array.isArray(samples) || samples.length === 0)
    {
        return { status: 'blocked', blockers: ['no measurements'] };
    }
    for (const [index, sample] of samples.entries())
    {
        blockers.push(...validateMeasurementSample(sample).map((error) => `measurement ${index + 1}: ${error}`));
    }
    if (blockers.length > 0)
    {
        return { status: 'blocked', blockers: [...new Set(blockers)].sort() };
    }

    const groups = groupSamplesByOfferedLoad(samples);
    if (groups.length < policy.minimumOfferedLoadSteps)
    {
        blockers.push(`requires at least ${policy.minimumOfferedLoadSteps} offered-load steps`);
    }
    for (const group of groups)
    {
        const repeats = new Set(group.samples.map((sample) => sample.repeat));
        if (repeats.size < policy.minimumRepeats)
        {
            blockers.push(`offered load ${group.offeredRps} requires at least ${policy.minimumRepeats} repeats`);
        }
    }
    const generatorSaturated = samples.some((sample) => (
        sample.metrics.loadGenerator.cpuPercent >= policy.maximumGeneratorCpuPercent ||
    sample.metrics.loadGenerator.scheduleLagP99Ms > policy.maximumGeneratorScheduleLagP99Ms ||
    sample.metrics.loadGenerator.droppedArrivals > 0
    ));
    if (generatorSaturated)
    {
        blockers.push('load generator saturated or dropped scheduled arrivals');
    }
    if (blockers.length > 0)
    {
        return { status: 'blocked', blockers: [...new Set(blockers)].sort() };
    }

    const summaries = groups.map(groupSummary);
    const kneeIndex = summaries.findIndex((summary) =>
    {
        const [, peak] = limitingResource(summary.resource);
        return peak >= policy.saturationFloorPercent ||
      summary.queueSlope > 0 ||
      summary.errorRate > policy.maximumErrorRate ||
      summary.timeoutRate > policy.maximumTimeoutRate ||
      summary.achievedRps / summary.offeredRps < 0.95;
    });
    if (kneeIndex <= 0)
    {
        return { status: 'blocked', blockers: ['saturation knee was not found after a stable lower-load step'] };
    }
    const knee = summaries[kneeIndex];
    const safe = summaries[kneeIndex - 1];
    const [resourceName, resourcePercent] = limitingResource(knee.resource);
    if (resourcePercent < policy.saturationFloorPercent || resourcePercent > policy.saturationCeilingPercent)
    {
        blockers.push('saturation knee does not identify a resource inside the policy saturation band');
    }
    const simultaneouslySaturated = Object.entries(knee.resource)
        .filter(([name, percent]) => name !== resourceName && percent >= policy.saturationFloorPercent)
        .map(([name]) => name);
    if (simultaneouslySaturated.length > 0)
    {
        blockers.push(`other resources lack headroom at the knee: ${simultaneouslySaturated.join(', ')}`);
    }
    if (safe.throughputVariance > policy.maximumThroughputVariance)
    {
        blockers.push('safe-point throughput variance exceeds policy');
    }
    if (safe.queueSlope > 0)
    {
        blockers.push('request queue grows at the proposed safe operating point');
    }
    if (safe.errorRate > policy.maximumErrorRate || safe.timeoutRate > policy.maximumTimeoutRate)
    {
        blockers.push('safe operating point violates error or timeout policy');
    }
    if (safe.p99Ms > policy.maximumP99AtSafeMs || safe.p999Ms > policy.maximumP999AtSafeMs)
    {
        blockers.push('safe operating point violates p99 or p99.9 latency policy');
    }
    if (blockers.length > 0)
    {
        return { status: 'blocked', blockers };
    }

    const safeOperatingRps = Math.min(
        safe.achievedRps,
        knee.achievedRps * (1 - policy.safeHeadroomPercent / 100)
    );
    return {
        status: 'ok',
        blockers: [],
        conclusion: {
            limitingResource: resourceName,
            limitingResourcePercent: round(resourcePercent),
            saturationPointRps: round(knee.achievedRps),
            safeOperatingRps: round(safeOperatingRps),
            p99AtSafeOperatingPoint: round(safe.p99Ms),
            p999AtSafeOperatingPoint: round(safe.p999Ms),
            cyclesPerRequest: round(averageMetric(safe.samples, 'request.cyclesPerRequest')),
            instructionsPerRequest: round(averageMetric(safe.samples, 'request.instructionsPerRequest')),
            allocationBytesPerRequest: round(averageMetric(safe.samples, 'request.allocationBytesPerRequest')),
            queueGrowthStatus: 'stable',
            throughputVariance: round(safe.throughputVariance, 6),
            saturationOfferedRps: knee.offeredRps,
            safeOfferedRps: safe.offeredRps
        }
    };
}

export function buildSaturationReport({
    identity,
    measurements = [],
    generatedAt = new Date().toISOString(),
    policy: policyOverrides = {},
    evidenceKind = 'real'
})
{
    const policy = { ...DEFAULT_SATURATION_POLICY, ...policyOverrides };
    const identityErrors = validateSaturationIdentity(identity, {
        now: Date.parse(generatedAt),
        maximumEvidenceAgeMs: policy.maximumEvidenceAgeMs
    });
    if (identityErrors.length > 0)
    {
        throw new AggregateError(identityErrors.map((message) => new Error(message)), identityErrors.join('; '));
    }
    const scenarios = [];
    for (const routeId of SATURATION_ROUTES)
    {
        for (const topology of SATURATION_TOPOLOGIES)
        {
            const candidates = measurements.filter((measurement) => measurement.routeId === routeId && measurement.topology === topology);
            const samples = candidates.flatMap((measurement) => measurement.samples ?? []);
            const analysis = analyzeSaturationScenario(samples, policy);
            scenarios.push({
                routeId,
                topology,
                status: analysis.status,
                sampleCount: samples.length,
                ...(analysis.status === 'ok' ? { samples, conclusion: analysis.conclusion } : { blockers: analysis.blockers })
            });
        }
    }
    const status = evidenceKind === 'real' && scenarios.every((scenario) => scenario.status === 'ok') ? 'ok' : 'blocked';
    return {
        schema: SATURATION_SCHEMA,
        status,
        evidenceKind,
        generatedAt,
        identity,
        identityDigest: digestJson(identity),
        policy,
        routeMatrix: [...SATURATION_ROUTES],
        topologies: [...SATURATION_TOPOLOGIES],
        scenarios,
        blockers: evidenceKind === 'real'
            ? scenarios.filter((scenario) => scenario.status !== 'ok').map((scenario) => `${scenario.topology}/${scenario.routeId}: ${scenario.blockers.join(', ')}`)
            : ['synthetic evidence cannot produce a capacity conclusion']
    };
}

export function validateSaturationReport(report, options = {})
{
    const errors = [];
    if (report?.schema !== SATURATION_SCHEMA)
    {
        errors.push(`schema must equal ${SATURATION_SCHEMA}`);
    }
    if (!['ok', 'blocked'].includes(report?.status))
    {
        errors.push('status must be ok or blocked');
    }
    if (report?.evidenceKind !== 'real')
    {
        errors.push('release evidence must use evidenceKind=real');
    }
    const generatedAt = Date.parse(report?.generatedAt);
    const now = options.now ?? Date.now();
    const maximumEvidenceAgeMs = options.maximumEvidenceAgeMs ?? DEFAULT_SATURATION_POLICY.maximumEvidenceAgeMs;
    if (!Number.isFinite(generatedAt))
    {
        errors.push('generatedAt must be an ISO timestamp');
    }
    else if (generatedAt > now + 60_000 || now - generatedAt > maximumEvidenceAgeMs)
    {
        errors.push('report is stale or from the future');
    }
    errors.push(...validateSaturationIdentity(report?.identity, options));
    if (report?.identityDigest !== digestJson(report?.identity))
    {
        errors.push('identityDigest does not match identity');
    }
    const expectedPolicy = options.expectedPolicy ?? DEFAULT_SATURATION_POLICY;
    if (JSON.stringify(report?.policy) !== JSON.stringify(expectedPolicy))
    {
        errors.push('report policy does not match the authoritative perf policy');
    }
    if (JSON.stringify(report?.routeMatrix) !== JSON.stringify(SATURATION_ROUTES))
    {
        errors.push('routeMatrix does not match the authoritative route matrix');
    }
    if (JSON.stringify(report?.topologies) !== JSON.stringify(SATURATION_TOPOLOGIES))
    {
        errors.push('topologies do not match the authoritative topology matrix');
    }
    const expectedKeys = SATURATION_ROUTES.flatMap((routeId) => SATURATION_TOPOLOGIES.map((topology) => `${topology}/${routeId}`)).sort();
    const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : [];
    const actualKeys = scenarios.map((scenario) => `${scenario.topology}/${scenario.routeId}`).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
    {
        errors.push('scenarios must contain every route and topology exactly once');
    }
    for (const scenario of scenarios)
    {
        const label = `${scenario.topology}/${scenario.routeId}`;
        if (scenario.status === 'ok')
        {
            if (!Array.isArray(scenario.samples) || scenario.samples.length === 0)
            {
                errors.push(`${label} ok scenario requires samples`);
            }
            if (scenario.sampleCount !== scenario.samples?.length)
            {
                errors.push(`${label} sampleCount does not match samples`);
            }
            for (const [index, sample] of (scenario.samples ?? []).entries())
            {
                errors.push(...validateMeasurementSample(sample).map((error) => `${label} sample ${index + 1}: ${error}`));
            }
            const conclusion = scenario.conclusion;
            for (const field of [
                'saturationPointRps', 'safeOperatingRps', 'p99AtSafeOperatingPoint',
                'p999AtSafeOperatingPoint', 'cyclesPerRequest', 'instructionsPerRequest',
                'allocationBytesPerRequest'
            ])
            {
                if (!isFiniteNonNegative(conclusion?.[field]))
                {
                    errors.push(`${label} conclusion.${field} is required`);
                }
            }
            if (!['cpu', 'memory', 'tlsNic', 'redis', 'postgres'].includes(conclusion?.limitingResource))
            {
                errors.push(`${label} conclusion.limitingResource is invalid`);
            }
            if (conclusion?.queueGrowthStatus !== 'stable')
            {
                errors.push(`${label} queueGrowthStatus must be stable`);
            }
            if (conclusion?.safeOperatingRps > conclusion?.saturationPointRps)
            {
                errors.push(`${label} safeOperatingRps exceeds saturationPointRps`);
            }
            const recomputed = analyzeSaturationScenario(scenario.samples ?? [], report.policy);
            if (recomputed.status !== 'ok' || JSON.stringify(recomputed.conclusion) !== JSON.stringify(conclusion))
            {
                errors.push(`${label} conclusion does not match recomputed measurements`);
            }
        }
        else if (!Array.isArray(scenario.blockers) || scenario.blockers.length === 0)
        {
            errors.push(`${label} blocked scenario requires blockers`);
        }
    }
    if (report?.status === 'ok' && scenarios.some((scenario) => scenario.status !== 'ok'))
    {
        errors.push('ok report contains blocked scenarios');
    }
    if (report?.status === 'ok' && (report?.blockers?.length ?? 0) > 0)
    {
        errors.push('ok report must not contain blockers');
    }
    if (report?.status === 'blocked' && scenarios.length > 0 && scenarios.every((scenario) => scenario.status === 'ok'))
    {
        errors.push('blocked report does not contain a blocked scenario');
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertValidSaturationReport(report, options = {})
{
    const result = validateSaturationReport(report, options);
    if (!result.valid)
    {
        throw new AggregateError(result.errors.map((message) => new Error(message)), result.errors.join('; '));
    }
    return report;
}
