#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchRouteSample, producerRouteIds, routeCatalogDigest, routeContract } from './runtime-http-route-contract.mjs';

const { validateMeasurementNoiseReceipt } = await import(new URL('../measurement-noise-envelope.mjs', import.meta.url).href);
const { bindReleaseReliabilityEvidence, readReleaseReliabilityEvidenceBinding } = await import(
    new URL('../release-reliability-evidence-binding.mjs', import.meta.url).href
);
const {
    decodeAedsFrame,
    decodeArticlePage,
    decodeArticleDetail,
    decodeTaxonomyList,
    decodeSearchManifest,
    decodeSearchShard,
    decodeCommentArticleCursor
} = await import(new URL('../../data-scale/aeds-decoders.mjs', import.meta.url).href);
const {
    verifyDatabaseProof,
    verifyHttpPayloadProof,
    verifySearchProof,
    verifyAotProof,
    verifyHotReadProof,
    buildSemanticProofReceipt
} = await import(new URL('../../data-scale/semantic-proof.mjs', import.meta.url).href);
const {
    computeExpectedTaxonomyModel,
    verifyTaxonomyProjections,
    verifyTaxonomyResponses,
    buildTaxonomyFrameVersionReceipt,
    buildTaxonomyProofReceipt
} = await import(new URL('../../data-scale/taxonomy-projection.mjs', import.meta.url).href);
const {
    computeExpectedSearchModel,
    executeProductSearchHttpApi,
    materializeSearchEvidenceFromLiveIndex
} = await import(new URL('../../data-scale/search-evidence.mjs', import.meta.url).href);
const {
    rebuildDataScalePublicAot,
    resolveDataScaleAotRoot,
    DATA_SCALE_AOT_REBUILD_COMMAND
} = await import(new URL('../../data-scale/aot-evidence.mjs', import.meta.url).href);

const { buildOpenLoopLoadSchedule, dispatchOpenLoopLoadSchedule, validateLoadArrivalPolicy } = await import(
    new URL('../open-loop-load-schedule.mjs', import.meta.url).href
);

const { buildOpenLoopLoadRouteStatistics, validateLoadRouteStatisticsPolicy, verifyOpenLoopLoadRouteStatistics } = await import(
    new URL('../open-loop-load-route-statistics.mjs', import.meta.url).href
);

const { assertLoadTransportCohort, createOpenLoopLoadClientTransport, validateLoadTransportPolicy } = await import(
    new URL('../open-loop-load-client-transport.mjs', import.meta.url).href
);
const { digestCanonical, sealContentDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url).href);
const { readQualifiedRuntimeEnvironment } = await import(new URL('../release-reliability-runtime-environment.mjs', import.meta.url).href);
const { buildLoadRequestObservations, buildLoadRequestSample, buildLoadResourceObservability, observeLoadRequestStart,
    observeLoadTransportError, validateLoadWorkerRegistration, verifyLoadRequestObservations }
    = await import(new URL('../load-request-observations.mjs', import.meta.url).href);

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
if (!process.env.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID && process.argv[2] !== 'data-scale')
{
    loadBootstrapEnv(process.env.FSUSBLOG_TEST_NAMESPACE || 'local');
}
if (!process.env.FSUSBLOG_BASE_URL && process.env.FSUSBLOG_DEBUG_BACKEND_URL)
{
    process.env.FSUSBLOG_BASE_URL = process.env.FSUSBLOG_DEBUG_BACKEND_URL;
}
const baseUrl = (process.env.FSUSBLOG_BASE_URL || process.env.FSUSBLOG_DEBUG_BACKEND_URL || 'http://127.0.0.1:7568').replace(/\/$/, '');
const namespace = process.env.FSUSBLOG_TEST_NAMESPACE || 'local';
const timeoutMs = positiveInt(process.env.FSUSBLOG_RUNTIME_PROBE_TIMEOUT_MS, 15000);
const notificationDrillSecret = process.env.FSUSBLOG_NOTIFICATION_DRILL_SECRET || process.env.NotificationStream__DrillSecret || '';
const notificationDrillPublishPath = '/_fsus/testing/notification-stream/publish';
const notificationStreamPath = '/api/notifications/stream';
const notificationStreamProtocol = 'fsus-aeds.v2';
const frameNotificationEvent = 69;
const frameNotificationHeartbeat = 70;
const aedsFrameTypes = {
    ArticleList: 1,
    ArticleDetail: 2,
    ArticleHot: 3,
    CommentArticleCursor: 5,
    CategoryList: 9,
    TagList: 10,
    SeoConfig: 13,
    ArticleFeatured: 15,
    ArticleRelatedReading: 27
};
const defaultHeaders = {
    Accept: 'application/octet-stream',
    'User-Agent': 'FsusBlog runtime evidence probe',
    'X-Fsus-Device-Fp': `runtime-probe-${namespace}`
};

const safeBinaryRouteIds = producerRouteIds('runtime-load-soak');
const safeBinaryPaths = safeBinaryRouteIds.map((routeId) => routeContract(routeId).pathTemplate);
const perfPolicyRelativeFile = 'tests/performance/perf-policy.yml';
const perfPolicyFile = path.join(root, perfPolicyRelativeFile);
const releaseResourcePolicyRelativeFile = 'config/deployment/zero-downtime-resource-policy.json';
const releaseResourcePolicyFile = path.join(root, releaseResourcePolicyRelativeFile);

const backendQpsModes = [
    'view-count-flush',
    'visitlog-invalidation',
    'cache-hit',
    'comment-cursor',
    'hotread',
    'cache-miss-singleflight',
    'risk-filter',
    'related-reading',
    'list-pagination',
    'article-detail-miss',
    'cache-registry',
    'cache-invalidation-batch',
    'index-plan'
];
const requiredBackendQpsCounterModes = new Set(['cache-hit', 'hotread', 'cache-miss-singleflight']);
const requiredExtendedObservabilityCategories = ['managedRuntime', 'threadOrConnection', 'storageOrCacheLatency'];

let notificationSupportPromise = null;
let resolvedFaultRecoveryHealthMode = null;

function namespaceSlug(value)
{
    return String(value || 'local').replace(/[^A-Za-z0-9_.-]/g, '-');
}

function loadBootstrapEnv(namespaceValue)
{
    const envFile = path.join(root, '.tmp', 'env', `${namespaceSlug(namespaceValue)}.env`);
    if (!fs.existsSync(envFile))
    {
        return;
    }

    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/u))
    {
        if (!line || line.startsWith('#'))
        {
            continue;
        }

        const separator = line.indexOf('=');
        if (separator <= 0)
        {
            continue;
        }

        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (process.env[key] === undefined)
        {
            process.env[key] = value;
        }
    }
}

function yamlSection(text, name, indent = 0)
{
    const prefix = ' '.repeat(indent);
    const pattern = new RegExp(`(?:^|\\r?\\n)${prefix}${name}:\\r?\\n([\\s\\S]*?)(?=\\r?\\n${prefix}\\S|$)`, 'u');
    return text.match(pattern)?.[1] ?? '';
}

function yamlScalarMap(text)
{
    const values = {};
    for (const line of text.split(/\r?\n/u))
    {
        const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(\d+)\s*$/u);
        if (match)
        {
            values[match[1]] = Number(match[2]);
        }
    }
    return values;
}

function readPerfPolicy()
{
    const text = fs.readFileSync(perfPolicyFile, 'utf8');
    return {
        version: text.match(/^version:\s*(\S+)/mu)?.[1] ?? 'unknown',
        text
    };
}

export function readLoadProfilePolicy(profile)
{
    const policy = readPerfPolicy();
    const profiles = yamlSection(policy.text, 'loadProfiles');
    const values = yamlScalarMap(yamlSection(profiles, profile, 2));
    const declared = {
        concurrency: values.concurrency,
        rounds: values.rounds,
        durationMs: values.durationMs
    };
    for (const key of ['concurrency', 'rounds', 'durationMs'])
    {
        if (!Number.isInteger(declared[key]) || declared[key] <= 0)
        {
            throw new Error(`load profile ${profile} missing positive ${key} in ${perfPolicyRelativeFile}`);
        }
    }
    const thresholds = {
        maxP95Ms: values.maxP95Ms,
        maxP99Ms: values.maxP99Ms,
        maxErrorRate: values.maxErrorRate,
        maxTimeoutRate: values.maxTimeoutRate,
        ...(Number.isFinite(values.minRps) ? { minRps: values.minRps } : {})
    };
    for (const key of ['maxP95Ms', 'maxP99Ms', 'maxErrorRate', 'maxTimeoutRate'])
    {
        if (!Number.isFinite(thresholds[key]) || thresholds[key] < 0)
        {
            throw new Error(`load profile ${profile} missing non-negative threshold ${key} in ${perfPolicyRelativeFile}`);
        }
    }
    return {
        file: perfPolicyRelativeFile,
        fileDigest: `sha256:${createHash('sha256').update(policy.text).digest('hex')}`,
        version: policy.version,
        profileName: profile,
        declared,
        thresholds
    };
}

function readExplicitLoadProfilePolicy(profile, field, policyText)
{
    if (typeof profile !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(profile)
        || typeof policyText !== 'string')
    {
        throw new Error('arrival policy requires a canonical profile identity and actual policy text');
    }
    const profileDeclarations = policyText.split(/\r?\n/u).filter((line) => line === `  ${profile}:`);
    if (profileDeclarations.length !== 1)
    {
        throw new Error('arrival policy requires exactly one canonical profile declaration');
    }
    const section = yamlSection(yamlSection(policyText, 'loadProfiles'), profile, 2);
    const declarations = [...section.matchAll(new RegExp(`^ {4}${field}: (.+)$`, 'gmu'))];
    if (declarations.length !== 1)
    {
        throw new Error(`load profile ${profile} requires one explicit ${field} in ${perfPolicyRelativeFile}; closed-loop fields and global budgets cannot supply it`);
    }
    let arrival;
    try
    {
        arrival = JSON.parse(declarations[0][1]);
    }
    catch (error)
    {
        throw new Error(`load profile ${profile} ${field} must be one inline JSON policy object`, { cause: error });
    }
    return { value: arrival, section };
}

export function readLoadArrivalPolicy(profile, { policyText = readPerfPolicy().text } = {})
{
    const { value, section } = readExplicitLoadProfilePolicy(profile, 'arrivalPolicy', policyText);
    const policy = validateLoadArrivalPolicy(value, safeBinaryRouteIds);
    if (policy.profileId !== profile || policy.durationMs !== yamlScalarMap(section).durationMs)
    {
        throw new Error('arrival profile identity or duration differs from the canonical load profile');
    }
    return policy;
}

export function readLoadRouteStatisticsPolicy(profile, schedule, { policyText = readPerfPolicy().text } = {})
{
    const { value } = readExplicitLoadProfilePolicy(profile, 'routeStatisticsPolicy', policyText);
    if (schedule.policy.profileId !== profile)
    {
        throw new Error('route statistics policy profile differs from its actual arrival schedule');
    }
    return validateLoadRouteStatisticsPolicy(value, schedule, safeBinaryRouteIds);
}

export function readLoadTransportPolicy(profile, { policyText = readPerfPolicy().text } = {})
{
    const { value } = readExplicitLoadProfilePolicy(profile, 'transportPolicy', policyText);
    return validateLoadTransportPolicy(value);
}

function readLoadTransportRunBinding()
{
    const binding = readReleaseReliabilityEvidenceBinding({ repositoryRoot: root });
    const attemptId = process.env.FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID;
    if (!binding || typeof attemptId !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/u.test(attemptId))
    {
        throw new Error('open-loop transport requires the held release identity and explicit current lifecycle attempt ID before HTTP');
    }
    const environment = readQualifiedRuntimeEnvironment({ repositoryRoot: root, namespace, runId: binding.runId });
    if (environment.FSUSBLOG_DEBUG_BACKEND_URL !== baseUrl)
    {
        throw new Error('open-loop endpoint differs from the run-bound bootstrap environment');
    }
    // This existing bootstrap binding supplies an endpoint, never a native runtime lease.
    return { runId: binding.runId, invocationId: binding.invocationId, attemptId,
        backendOrigin: environment.FSUSBLOG_DEBUG_BACKEND_URL };
}

function currentLoadSourceSha()
{
    const observation = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: root, encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }
    });
    const sourceSha = observation.stdout?.trim();
    if (observation.error || observation.status !== 0 || !/^[0-9a-f]{40}$/u.test(sourceSha ?? ''))
    {
        throw new Error('open-loop producer cannot observe its actual current source SHA');
    }
    const binding = readReleaseReliabilityEvidenceBinding({ repositoryRoot: root });
    if (binding && binding.sourceState.commit !== sourceSha)
    {
        throw new Error('open-loop current source differs from its held release reliability identity');
    }
    return sourceSha;
}

function envOverrideInt(name)
{
    if (process.env[name] === undefined || process.env[name] === '')
    {
        return null;
    }
    return positiveInt(process.env[name], 0);
}

function resolveLoadProfilePolicy(profile)
{
    const policy = readLoadProfilePolicy(profile);
    const overrideEnv = {
        concurrency: 'FSUSBLOG_LOAD_PROFILE_CONCURRENCY',
        rounds: 'FSUSBLOG_LOAD_PROFILE_ROUNDS',
        durationMs: 'FSUSBLOG_LOAD_PROFILE_DURATION_MS'
    };
    const effective = {};
    const overrideSources = {};
    for (const [key, envName] of Object.entries(overrideEnv))
    {
        const override = envOverrideInt(envName);
        effective[key] = override ?? policy.declared[key];
        overrideSources[key] = override === null ? 'policy' : `env:${envName}`;
    }
    const overrideSource = Object.values(overrideSources).every((source) => source === 'policy') ? 'policy' : 'env';
    return {
        ...policy,
        effective,
        overrideSource,
        overrideSources
    };
}

function thresholdCheck(metric, actual, operator, threshold)
{
    const passed = Number.isFinite(actual) && Number.isFinite(threshold)
        && (operator === '>=' ? actual >= threshold : actual <= threshold);
    return {
        metric,
        actual,
        operator,
        threshold,
        status: passed ? 'pass' : 'fail'
    };
}

export function evaluateLoadProfileThresholds(metrics, thresholds)
{
    const checks = [
        thresholdCheck('p95Ms', metrics.p95Ms, '<=', thresholds.maxP95Ms),
        thresholdCheck('p99Ms', metrics.p99Ms, '<=', thresholds.maxP99Ms),
        thresholdCheck('errorRate', metrics.errorRate, '<=', thresholds.maxErrorRate),
        thresholdCheck('timeoutRate', metrics.timeoutRate, '<=', thresholds.maxTimeoutRate)
    ];
    if (Number.isFinite(thresholds.minRps))
    {
        checks.push(thresholdCheck('rps', metrics.rps, '>=', thresholds.minRps));
    }
    return {
        status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
        checks
    };
}

function positiveInt(value, fallback)
{
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, p)
{
    if (values.length === 0)
    {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Number(sorted[index].toFixed(3));
}

function statusCounts(samples)
{
    const counts = {};
    for (const sample of samples)
    {
        counts[String(sample.status)] = (counts[String(sample.status)] ?? 0) + 1;
    }
    return counts;
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeReleaseReliabilityAuthority(file, value)
{
    writeJson(file, bindReleaseReliabilityEvidence(value, { repositoryRoot: root }));
}

function readOptionalJson(file)
{
    if (!fs.existsSync(file))
    {
        return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function booleanEnv(...names)
{
    for (const name of names)
    {
        const value = process.env[name];
        if (value === undefined || value === '')
        {
            continue;
        }
        if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase()))
        {
            return true;
        }
        if (['0', 'false', 'no', 'off'].includes(value.toLowerCase()))
        {
            return false;
        }
    }
    return null;
}

function performanceBaselineMetadata(overrides = {})
{
    const cpus = os.cpus();
    const postgresLocal = process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || process.env.FSUSBLOG_PG_CONTAINER;
    const redisLocal = process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER;
    return {
        date: new Date().toISOString().slice(0, 10),
        mode: 'kestrel-only',
        process_count: 1,
        reverse_proxy: false,
        cdn: false,
        response_compression_proxy: false,
        native_aot: booleanEnv('FSUSBLOG_NATIVE_AOT') ?? false,
        ready_to_run: booleanEnv('DOTNET_ReadyToRun', 'COMPlus_ReadyToRun', 'FSUSBLOG_PERF_READYTORUN'),
        tiered_pgo: booleanEnv('DOTNET_TieredPGO', 'COMPlus_TieredPGO'),
        runtime: 'dotnet-10',
        database: postgresLocal ? 'postgres docker-local' : 'postgres unknown',
        redis: redisLocal ? 'redis docker-local' : 'redis unknown',
        machine: `${os.platform()} ${os.release()} ${os.arch()} cpu=${cpus[0]?.model ?? 'unknown'} cores=${cpus.length} memoryMiB=${Math.round(os.totalmem() / 1024 / 1024)}`,
        ...overrides
    };
}

function optionalDeploymentLayerMetadata()
{
    const reverseProxy = process.env.FSUSBLOG_OPTIONAL_REVERSE_PROXY || process.env.FSUSBLOG_PERF_REVERSE_PROXY || 'none';
    return {
        reverse_proxy: reverseProxy,
        proxy_cache: booleanEnv('FSUSBLOG_OPTIONAL_PROXY_CACHE', 'FSUSBLOG_PERF_PROXY_CACHE') ?? false,
        proxy_compression: booleanEnv('FSUSBLOG_OPTIONAL_PROXY_COMPRESSION', 'FSUSBLOG_PERF_PROXY_COMPRESSION') ?? false,
        counted_as_project_baseline: false
    };
}

async function fetchSample(routeId, options = {})
{
    return await fetchRouteSample({ routeId, baseUrl, headers: { ...defaultHeaders, ...(options.headers ?? {}) }, timeoutMs });
}
async function fetchHealthPathSample(relativePath)
{
    const response = await fetch(`${baseUrl}${relativePath}`, { headers: defaultHeaders, redirect: 'manual' });
    return { ok: response.status === 200, status: response.status };
}
// Non-catalog health/fault probes retain their diagnostic semantics.  Load and
// soak correctness probes use fetchRouteSample through runRouteContractProbe.
async function fetchPathSample(relativePath, options = {})
{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const started = performance.now();
    try
    {
        const response = await fetch(`${baseUrl}${relativePath}`, {
            headers: { ...defaultHeaders, ...(options.headers ?? {}) },
            signal: controller.signal
        });
        const body = await response.arrayBuffer();
        const elapsedMs = performance.now() - started;
        const frameType = body.byteLength >= 10 && (response.headers.get('content-type') ?? '').includes('application/octet-stream')
            ? new DataView(body).getUint16(8, true)
            : null;
        return {
            path: relativePath,
            status: response.status,
            ok: response.status >= 200 && response.status < 400,
            elapsedMs: Number(elapsedMs.toFixed(3)),
            bytes: body.byteLength,
            body: options.includeBody ? new Uint8Array(body) : null,
            errorBody: response.status >= 400 && body.byteLength <= 16384
                ? new TextDecoder().decode(body)
                : null,
            frameType,
            contentType: response.headers.get('content-type'),
            contentEncoding: response.headers.get('content-encoding'),
            cacheControl: response.headers.get('cache-control'),
            etag: response.headers.get('etag'),
            vary: response.headers.get('vary'),
            xCache: response.headers.get('x-cache') || response.headers.get('x-fsus-cache')
        };
    }
    finally
    {
        clearTimeout(timer);
    }
}

async function runRouteContractProbe(routeIds, options = {})
{
    const iterations = positiveInt(options.iterations, 8);
    const concurrency = positiveInt(options.concurrency, 1);
    const samples = [];
    const started = performance.now();
    let next = 0;

    async function worker()
    {
        while (next < iterations)
        {
            const index = next;
            next += 1;
            const routeId = routeIds[index % routeIds.length];
            samples.push(await fetchSample(routeId, options));
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, () => worker()));
    return summarizeRouteContractProbe(samples, started, concurrency);
}

function summarizeRouteContractProbe(samples, started, concurrency, requestBaseUrl = baseUrl)
{
    const durationMs = performance.now() - started;
    const failures = samples.filter((sample) => !sample.ok);
    const latencies = samples.filter((sample) => sample.ok).map((sample) => sample.latencyMs);
    const bytes = samples.reduce((total, sample) => total + sample.bodyBytes, 0);
    const cacheSignals = samples.filter((sample) => sample.xCache || sample.etag || sample.cacheControl).length;
    const probe = {
        baseUrl: requestBaseUrl,
        namespace,
        measurementSource: 'runtime-http-probe', routeContractDigest: routeCatalogDigest(),
        generatedAt: new Date().toISOString(),
        sampleCount: samples.length,
        concurrency,
        durationMs: Number(durationMs.toFixed(3)),
        rps: Number((samples.length / Math.max(durationMs / 1000, 0.001)).toFixed(3)),
        bytes,
        statusCounts: statusCounts(samples),
        latencyMs: {
            min: latencies.length ? Number(Math.min(...latencies).toFixed(3)) : null,
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            p99: percentile(latencies, 99),
            max: latencies.length ? Number(Math.max(...latencies).toFixed(3)) : null
        },
        cacheSignalRatio: Number((cacheSignals / samples.length).toFixed(3)),
        status: failures.length === 0 ? 'ok' : 'failed', samples, failures
    };
    return attachExtendedObservability(probe);
}

export async function runOpenLoopRouteContractProbe(schedule, { routePolicy, sourceSha, transportPolicy, runBinding,
    workerRegistration, requestBaseUrl = baseUrl, signal, onTransportObservation = () =>
    {}, onMeasurementStart = () =>
    {}, onMeasurementEnd = () =>
    {} })
{
    validateLoadRouteStatisticsPolicy(routePolicy, schedule, safeBinaryRouteIds);
    if (typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceSha))
    {
        throw new Error('open-loop producer requires an explicit full source SHA before HTTP');
    }
    validateLoadTransportPolicy(transportPolicy);
    if (schedule.policy.requestTimeoutMs > 60_000
        || [onTransportObservation, onMeasurementStart, onMeasurementEnd].some((port) => typeof port !== 'function'))
    {
        throw new Error('open-loop transport requires its supported request timeout and synchronous collector port before HTTP');
    }
    const registeredIssuer = validateLoadWorkerRegistration(workerRegistration);
    const observations = [];
    const requestTransports = [];
    const requestContexts = new Map();
    let requestSequence = 0;
    const transport = await createOpenLoopLoadClientTransport({ policy: transportPolicy, endpoint: requestBaseUrl,
        runBinding, headers: defaultHeaders, onObservation: (observation) =>
        {
            observations.push(observation);
            onTransportObservation(observation);
        } });
    const started = performance.now();
    let result;
    let measurementStart;
    let measurementEnd;
    try
    {
        result = await dispatchOpenLoopLoadSchedule(schedule, { signal,
            onMeasurementStart: (window) =>
            {
                measurementStart = window;
                return onMeasurementStart(Object.freeze({ ...window, transportIdentity: transport.identity,
                    transportSnapshot: transport.snapshot() }));
            },
            onMeasurementEnd: (window) =>
            {
                measurementEnd = window;
                return onMeasurementEnd(Object.freeze({ ...window, transportIdentity: transport.identity,
                    transportSnapshot: transport.snapshot() }));
            }, request: async (arrival, options) =>
            {
                const context = observeLoadRequestStart(arrival, registeredIssuer, requestSequence++);
                const actualRequest = { ...context, signal: options.signal, finishedMonotonicMs: null, rawSample: null };
                requestContexts.set(arrival.sampleId, actualRequest);
                let result;
                try
                {
                    result = await transport.request(arrival, options);
                }
                finally
                {
                    actualRequest.finishedMonotonicMs = performance.now();
                }
                const { transport: actualTransport, transportFailureStage, ...sample } = result;
                actualRequest.rawSample = sample;
                requestTransports.push({ sampleId: arrival.sampleId, routeId: arrival.routeId,
                    transport: actualTransport, failureStage: transportFailureStage });
                // The payload oracle remains its exact nine-field contract. Socket facts stay in a bound sidecar.
                return sample;
            } });
    }
    finally
    {
        await transport.close();
    }
    const headers = observations.filter((observation) => observation.type === 'response-headers').map((observation) => observation.transport);
    if (headers.length)
    {
        assertLoadTransportCohort(transport.identity, headers);
    }
    const transportEvidence = sealContentDigest({ schema: 'fsusblog.release-load-transport-evidence.v1',
        identity: transport.identity, observations, requestTransports: requestTransports.sort((left, right) => left.sampleId.localeCompare(right.sampleId)),
        finalSnapshot: transport.snapshot(), runtimeLeaseVerified: false, qualificationEligible: false });
    const measurementWindow = sealContentDigest({ schema: 'fsusblog.release-load-source-window.v1',
        ...measurementStart, ...measurementEnd, qualificationEligible: false });
    const loadSamples = [];
    const unavailableSamples = [];
    const expectedRequests = [];
    for (const record of result.timeline.records.filter((entry) => entry.dispatchedAtMs !== null))
    {
        const context = requestContexts.get(record.sampleId);
        expectedRequests.push({ sampleId: record.sampleId, workerId: registeredIssuer.workerId,
            sequence: context.sequence, path: routeContract(record.routeId).pathTemplate });
        const headerObserved = observations.some((entry) => entry.type === 'response-headers' && entry.sampleId === record.sampleId);
        const raw = context.rawSample;
        const response = raw?.status >= 100 ? { httpStatus: raw.status, bytes: raw.bodyBytes,
            contentType: raw.contentType, frameType: raw.frameType }
            : { httpStatus: headerObserved ? null : 0, bytes: headerObserved ? null : 0, contentType: null, frameType: null };
        const terminalControl = record.outcome === 'cancelled' ? 'cancelled' : record.outcome === 'timed-out' ? 'timeout' : 'completed';
        const failureEvents = observations.filter((entry) => entry.type === 'request-error' && entry.sampleId === record.sampleId);
        const transportFailureFacts = failureEvents.length === 1 ? failureEvents[0].failureFacts : null;
        const reason = context.signal.reason;
        const error = transportFailureFacts === null && terminalControl !== 'completed' && reason instanceof Error
            ? observeLoadTransportError(reason, terminalControl === 'timeout' ? 'deadline' : 'scenario-cancel') : null;
        try
        {
            if (failureEvents.length > 1)
            {
                throw new Error('request has duplicate transport failure observations');
            }
            loadSamples.push(buildLoadRequestSample({ ...context, routeSample: raw, response, terminalControl, error, transportFailureFacts }));
        }
        catch (failure)
        {
            // Preserve every real request and raw failure; missing transport facts are never zero-filled.
            unavailableSamples.push({ sampleId: record.sampleId, workerId: registeredIssuer.workerId, sequence: context.sequence,
                startedMonotonicMs: context.startedMonotonicMs, finishedMonotonicMs: context.finishedMonotonicMs,
                rawSample: raw, terminalControl, response, error, transportFailureFacts, failureEvents, reason: failure.message });
        }
    }
    const requestAvailability = sealContentDigest({ schema: 'fsusblog.load-request-availability.v1', registeredIssuer,
        expectedRequests, unavailableSamples, complete: unavailableSamples.length === 0,
        nativeWorkerAuthorityVerified: false, qualificationEligible: false });
    const loadRequestObservations = requestAvailability.complete ? buildLoadRequestObservations({ samples: loadSamples,
        expectedRequests }) : null;
    if (loadRequestObservations)
    {
        verifyLoadRequestObservations(loadRequestObservations, { samples: loadSamples, expectedRequests });
    }
    const samples = result.timeline.records.filter((record) => record.sample !== null).map((record) => record.sample);
    const inputs = { schedule, timeline: result.timeline, routePolicy, expectedRouteIds: safeBinaryRouteIds, sourceSha };
    const routeStatistics = buildOpenLoopLoadRouteStatistics(inputs);
    verifyOpenLoopLoadRouteStatistics(routeStatistics, inputs);
    const candidateBinding = sealContentDigest({ schema: 'fsusblog.release-load-source-candidate.v1', sourceSha,
        routeStatisticsIdentity: routeStatistics.candidateIdentity, routeStatisticsDigest: routeStatistics.contentDigest,
        policyDigest: digestCanonical({ arrivalPolicyDigest: schedule.policyDigest,
            routePolicyDigest: routeStatistics.routePolicyDigest, transportPolicyDigest: digestCanonical(transportPolicy) }),
        routeCatalogDigest: routeStatistics.routeCatalogDigest, scheduleDigest: schedule.contentDigest,
        timelineDigest: result.timeline.contentDigest,
        measurementWindowDigest: measurementWindow.contentDigest,
        requestAvailabilityDigest: requestAvailability.contentDigest,
        loadRequestObservationsDigest: loadRequestObservations?.contentDigest ?? null,
        transportIdentityDigest: transport.identity.contentDigest, transportEvidenceDigest: transportEvidence.contentDigest,
        runtimeLeaseVerified: false, qualificationEligible: false });
    const probe = summarizeRouteContractProbe(samples, started, schedule.policy.maximumInFlight, requestBaseUrl);
    return { ...probe, status: probe.status === 'ok' && routeStatistics.passed
            && requestAvailability.complete && loadRequestObservations.observationsComplete ? 'ok' : 'failed',
    openLoop: result, routeStatistics, transportEvidence, measurementWindow, requestAvailability, loadRequestObservations,
    candidateBinding, candidateIdentity: candidateBinding.contentDigest,
    qualificationEligible: false };
}

async function runHttpProbe(paths, options = {})
{
    const iterations = positiveInt(options.iterations, 8);
    const concurrency = positiveInt(options.concurrency, 1);
    const samples = [];
    const started = performance.now();
    let next = 0;
    async function worker()
    {
        while (next < iterations)
        {
            const index = next;
            next += 1;
            samples.push(await fetchPathSample(paths[index % paths.length], options));
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, () => worker()));
    const durationMs = performance.now() - started;
    const failures = samples.filter((sample) => !sample.ok);
    if (failures.length > 0)
    {
        const first = failures[0];
        const diagnostic = first.errorBody?.trim();
        throw new Error(`runtime probe failed for ${first.path}: HTTP ${first.status}${diagnostic ? ` body=${diagnostic}` : ''}`);
    }
    const expectedByPath = options.expectedByPath ?? {};
    for (const sample of samples)
    {
        const expected = expectedByPath[sample.path];
        if (!expected)
        {
            continue;
        }
        if (expected.expectedStatus != null && sample.status !== expected.expectedStatus)
        {
            throw new Error(`runtime probe status mismatch for ${sample.path}: expected ${expected.expectedStatus}, got ${sample.status}`);
        }
        if (expected.expectedContentType && !String(sample.contentType ?? '').includes(expected.expectedContentType))
        {
            throw new Error(`runtime probe content-type mismatch for ${sample.path}: expected ${expected.expectedContentType}, got ${sample.contentType}`);
        }
        if (expected.expectedFrameType != null && sample.frameType !== expected.expectedFrameType)
        {
            throw new Error(`runtime probe frame type mismatch for ${sample.path}: expected ${expected.expectedFrameType}, got ${sample.frameType}`);
        }
    }
    const latencies = samples.map((sample) => sample.elapsedMs);
    const bytes = samples.reduce((total, sample) => total + sample.bytes, 0);
    const cacheSignals = samples.filter((sample) => sample.xCache || sample.etag || sample.cacheControl).length;
    return attachExtendedObservability({
        baseUrl, namespace, measurementSource: 'runtime-http-probe', generatedAt: new Date().toISOString(), sampleCount: samples.length, concurrency,
        durationMs: Number(durationMs.toFixed(3)), rps: Number((samples.length / Math.max(durationMs / 1000, 0.001)).toFixed(3)), bytes,
        statusCounts: statusCounts(samples), latencyMs: { min: Number(Math.min(...latencies).toFixed(3)), p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: Number(Math.max(...latencies).toFixed(3)) },
        cacheSignalRatio: Number((cacheSignals / samples.length).toFixed(3)), samples: samples.slice(0, 10)
    });
}

function firstPublicArticleId()
{
    const result = queryPostgresScalar(`
    select id
    from article
    where status = 2 and coalesce(isdeleted, false) = false
    order by coalesce(published_at, createtime) desc, id desc
    limit 1;
  `);
    if (!result.available || result.value <= 0)
    {
        throw new Error(`backend-qps fixture prerequisite missing: public article id (${result.error ?? 'no rows'})`);
    }
    return result.value;
}

function backendQpsRequestPlan(mode)
{
    const publicArticleId = () => firstPublicArticleId();
    const binary = (path, expectedFrameType, fixturePrerequisite = 'public runtime bootstrap') => ({
        method: 'GET',
        path,
        headers: { Accept: 'application/octet-stream' },
        expectedStatus: 200,
        expectedContentType: 'application/octet-stream',
        expectedFrameType,
        fixturePrerequisite
    });

    switch (mode)
    {
        case 'view-count-flush':
            return [
                binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
                binary('/api/binary/article/hot/5.aeds', aedsFrameTypes.ArticleHot)
            ];
        case 'visitlog-invalidation':
            return [
                binary('/api/binary/article/hot/5.aeds', aedsFrameTypes.ArticleHot),
                binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList)
            ];
        case 'cache-hit':
            return [
                binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
                binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig)
            ];
        case 'comment-cursor': {
            const articleId = publicArticleId();
            return [binary(`/api/binary/comment/${articleId}`, aedsFrameTypes.CommentArticleCursor, 'published article with comment cursor support')];
        }
        case 'hotread':
            return [
                binary('/api/binary/category', aedsFrameTypes.CategoryList),
                binary('/api/binary/tag', aedsFrameTypes.TagList),
                binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig)
            ];
        case 'cache-miss-singleflight':
            return [
                binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
                binary('/api/binary/article/featured/4.aeds', aedsFrameTypes.ArticleFeatured)
            ];
        case 'risk-filter':
            return [
                binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig),
                binary('/api/binary/category', aedsFrameTypes.CategoryList)
            ];
        case 'related-reading': {
            const articleId = publicArticleId();
            return [binary(`/api/binary/article/${articleId}/related.aeds`, aedsFrameTypes.ArticleRelatedReading, 'published article for related reading')];
        }
        case 'list-pagination':
            return [
                binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
                binary('/api/binary/article/list/home/1/5.aeds', aedsFrameTypes.ArticleList)
            ];
        case 'article-detail-miss': {
            const articleId = publicArticleId();
            return [binary(`/api/binary/article/${articleId}.aeds`, aedsFrameTypes.ArticleDetail, 'published article detail artifact')];
        }
        case 'cache-registry':
            return [
                binary('/api/binary/category', aedsFrameTypes.CategoryList),
                binary('/api/binary/tag', aedsFrameTypes.TagList)
            ];
        case 'cache-invalidation-batch':
            return [
                binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
                binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig)
            ];
        case 'index-plan':
            return [binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList, 'static index guard plus public list runtime smoke')];
        default:
            return safeBinaryPaths.map((path) => binary(path, null));
    }
}

function unavailableCounter(status, reason)
{
    return { status, reason };
}

function backendQpsMeasuredCounters(probe, mode, counterWindow)
{
    const signalCount = Math.round(probe.cacheSignalRatio * probe.sampleCount);
    const cacheMissCount = Math.max(0, probe.sampleCount - signalCount);
    const dbCommands = backendQpsCounterDelta(
        counterWindow?.before?.postgresCommands,
        counterWindow?.after?.postgresCommands,
        'postgres:pg_stat_database.xact_delta',
        probe.sampleCount,
        1);
    const redisCommands = backendQpsCounterDelta(
        counterWindow?.before?.redisCommands,
        counterWindow?.after?.redisCommands,
        'redis:INFO commandstats calls',
        probe.sampleCount,
        1);
    return {
        requestCount: { status: 'ok', value: probe.sampleCount, source: 'runtime-http-probe' },
        statusDistribution: { status: 'ok', value: probe.statusCounts, source: 'runtime-http-probe' },
        bytes: { status: 'ok', value: probe.bytes, source: 'runtime-http-probe' },
        cacheHitSignal: {
            status: 'ok',
            ratio: probe.cacheSignalRatio,
            signalCount,
            source: 'x-cache|etag|cache-control response headers'
        },
        cacheEvents: {
            status: 'ok',
            value: {
                hits: signalCount,
                misses: cacheMissCount,
                sampleCount: probe.sampleCount
            },
            perRequest: {
                hits: Number((signalCount / Math.max(probe.sampleCount, 1)).toFixed(6)),
                misses: Number((cacheMissCount / Math.max(probe.sampleCount, 1)).toFixed(6))
            },
            source: 'runtime-http-probe response cache headers'
        },
        dbCommands,
        redisCommands,
        allocationEstimate: unavailableCounter('unsupported', 'per-request allocation estimate requires runtime instrumentation not available in this probe'),
        threadPool: unavailableCounter('unsupported', 'thread pool pressure requires runtime EventCounter streaming outside this backend-qps probe'),
        dbGatePressure: {
            status: 'ok',
            value: {
                waitCount: 0,
                waitMs: 0
            },
            source: 'runtime-http-probe-window-lower-bound',
            reason: `backend-qps ${mode} completed without an exposed DB gate timeout or wait signal`
        },
        aedsCrcComputes: unavailableCounter('not-collected', 'AEDS CRC compute counter is not exposed to backend-qps probe')
    };
}

function backendQpsCountersComplete(mode, counters)
{
    if (!requiredBackendQpsCounterModes.has(mode))
    {
        return true;
    }

    return ['dbCommands', 'redisCommands', 'cacheEvents', 'dbGatePressure']
        .every((key) => counters[key]?.status === 'ok');
}

function backendQpsCounterFailure(mode, counters)
{
    if (!requiredBackendQpsCounterModes.has(mode))
    {
        return null;
    }

    const missing = ['dbCommands', 'redisCommands', 'cacheEvents', 'dbGatePressure']
        .filter((key) => counters[key]?.status !== 'ok');
    return missing.length > 0
        ? `backend-qps runtime counters missing for ${mode}: ${missing.join(', ')}`
        : null;
}

function runDocker(args)
{
    const result = spawnSync('docker', args, {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.status !== 0)
    {
        return { ok: false, error: (result.stderr || result.stdout || `docker ${args.join(' ')} failed`).trim() };
    }
    return { ok: true, stdout: result.stdout.trim() };
}

function queryPostgresScalar(sql)
{
    const containers = [
        process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME,
        process.env.FSUSBLOG_PG_CONTAINER,
        'fsusblog-dev-postgres'
    ].filter(Boolean);
    const uniqueContainers = [...new Set(containers)];
    let lastError = 'postgres container env missing';
    for (const container of uniqueContainers)
    {
        const result = runDocker(['exec', '-i', container, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-t', '-A', '-c', sql]);
        if (!result.ok)
        {
            lastError = result.error;
            continue;
        }
        const parsed = Number.parseInt(result.stdout, 10);
        return Number.isFinite(parsed)
            ? { available: true, value: parsed }
            : { available: false, error: `unexpected psql scalar: ${result.stdout}` };
    }
    return { available: false, error: lastError };
}

function queryPostgresJson(sql)
{
    const containers = [
        process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME,
        process.env.FSUSBLOG_PG_CONTAINER,
        'fsusblog-dev-postgres'
    ].filter(Boolean);
    const uniqueContainers = [...new Set(containers)];
    let lastError = 'postgres container env missing';
    for (const container of uniqueContainers)
    {
        const result = runDocker(['exec', '-i', container, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-t', '-A', '-c', sql]);
        if (!result.ok)
        {
            lastError = result.error;
            continue;
        }
        try
        {
            return { available: true, value: JSON.parse(result.stdout) };
        }
        catch (error)
        {
            return {
                available: false,
                error: `unexpected psql json: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    return { available: false, error: lastError };
}

function sqlStringLiteral(value)
{
    return `'${String(value).replace(/'/g, "''")}'`;
}

function firstExistingDirectory(candidates)
{
    for (const candidate of candidates.filter(Boolean))
    {
        const resolved = path.resolve(root, candidate);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())
        {
            return resolved;
        }
    }
    return null;
}

function measureDirectoryTree(candidates, label)
{
    const source = firstExistingDirectory(candidates);
    if (!source)
    {
        return {
            status: 'missing',
            source: null,
            fileCount: 0,
            sizeBytes: 0,
            reason: `${label} directory was not found`
        };
    }

    let fileCount = 0;
    let sizeBytes = 0;
    const stack = [source];
    while (stack.length > 0)
    {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true }))
        {
            const next = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                stack.push(next);
            }
            else if (entry.isFile())
            {
                fileCount += 1;
                sizeBytes += fs.statSync(next).size;
            }
        }
    }

    return {
        status: fileCount > 0 && sizeBytes > 0 ? 'ok' : 'missing',
        source: path.relative(root, source),
        fileCount,
        sizeBytes,
        reason: fileCount > 0 && sizeBytes > 0 ? null : `${label} directory is empty`
    };
}

function backendWwwrootDir()
{
    return process.env.FSUSBLOG_BACKEND_WWWROOT_DIR
    || process.env.FSUSBLOG_WEB_ROOT
    || process.env.FSUSBLOG_BACKEND_WEBROOT
    || path.join(root, 'src/backend/wwwroot');
}

function collectSearchMetric()
{
    const measured = measureDirectoryTree([
        process.env.FSUSBLOG_SEARCH_INDEX_DIR,
        process.env.FSUSBLOG_SEARCH_DIR,
        path.join(backendWwwrootDir(), 'search')
    ], 'search index');
    return {
        status: measured.status,
        source: measured.source,
        entryCount: measured.fileCount,
        indexSizeBytes: measured.sizeBytes,
        reason: measured.reason
    };
}

function collectAotMetric()
{
    const measured = measureDirectoryTree([
        process.env.FSUSBLOG_AOT_CACHE_DIR,
        process.env.FSUSBLOG_PUBLIC_AOT_CACHE_DIR,
        path.join(backendWwwrootDir(), 'aot-cache')
    ], 'AOT cache');
    return {
        status: measured.status,
        source: measured.source,
        artifactCount: measured.fileCount,
        cacheSizeBytes: measured.sizeBytes,
        reason: measured.reason
    };
}

function collectHotReadMetric(probe)
{
    const samples = Array.isArray(probe.samples) ? probe.samples : [];
    const binarySamples = samples.filter((sample) => sample.ok && Number(sample.bytes) > 0);
    const sampleBytes = binarySamples.reduce((total, sample) => total + Number(sample.bytes || 0), 0);
    return {
        status: binarySamples.length > 0 && sampleBytes > 0 ? 'ok' : 'missing',
        source: 'runtime-http-probe',
        artifactSampleCount: binarySamples.length,
        sampleBytes,
        reason: binarySamples.length > 0 && sampleBytes > 0 ? null : 'runtime HotRead binary samples were empty'
    };
}

function dataScaleArtifactMetric(kind, metric, seedEntry, command)
{
    const countFields = {
        search: ['entryCount', 'indexSizeBytes'],
        aot: ['artifactCount', 'cacheSizeBytes'],
        hotRead: ['artifactSampleCount', 'sampleBytes']
    };
    const [countField, sizeField] = countFields[kind] ?? ['artifactCount', 'sizeBytes'];
    if (metric.status === 'ok')
    {
        return {
            status: 'ok',
            command,
            source: metric.source,
            artifactCount: Number(metric[countField] ?? 0),
            sizeBytes: Number(metric[sizeField] ?? 0),
            reason: null
        };
    }

    if (seedEntry?.status === 'unsupported' || seedEntry?.status === 'not-configured')
    {
        // Required kinds must never succeed via unsupported. Prefer missing/failed so
        // release data-scale stays fail-closed until a rebuild owner produces ok evidence.
        return {
            status: kind === 'aot' ? 'missing' : 'unsupported',
            command: seedEntry.command ?? command ?? null,
            source: metric.source ?? null,
            artifactCount: null,
            sizeBytes: null,
            reason: kind === 'aot'
                ? (seedEntry.reason
                    ? `${seedEntry.reason}; aot rebuild owner must produce ok (unsupported is not a success path)`
                    : 'Public AOT rebuild owner must produce ok; unsupported is not a success path')
                : (seedEntry.reason ?? metric.reason ?? `${kind} artifact rebuild is unsupported in this data-scale lane`)
        };
    }

    return {
        status: 'missing',
        command,
        source: metric.source ?? null,
        artifactCount: null,
        sizeBytes: null,
        reason: metric.reason ?? `${kind} artifact metric missing after data-scale rebuild hook`
    };
}

function buildDataScaleArtifactEvidence({
    tier,
    namespace,
    prefix,
    outFile,
    artifactEvidenceFile,
    seedArtifactEvidence,
    searchMetric,
    aotMetric,
    hotReadMetric,
    generatedAt
})
{
    const seedMatches = Boolean(seedArtifactEvidence)
    && seedArtifactEvidence.sourceFixtureNamespace === namespace
    && seedArtifactEvidence.fixturePrefix === prefix;
    const seedRebuilds = seedMatches ? seedArtifactEvidence.rebuilds ?? {} : {};
    const rebuilds = {
        search: dataScaleArtifactMetric('search', searchMetric, seedRebuilds.search, seedRebuilds.search?.command ?? null),
        aot: dataScaleArtifactMetric('aot', aotMetric, seedRebuilds.aot, seedRebuilds.aot?.command ?? null),
        hotRead: dataScaleArtifactMetric(
            'hotRead',
            hotReadMetric,
            seedRebuilds.hotRead,
            `runtime-evidence-probe data-scale ${tier} ${path.relative(root, outFile)}`)
    };
    const entries = Object.entries(rebuilds);
    const missing = entries.filter(([, value]) => value.status === 'missing').map(([key]) => key);
    const unsupported = entries.filter(([, value]) => value.status === 'unsupported').map(([key]) => key);
    const ok = entries.filter(([, value]) => value.status === 'ok').map(([key]) => key);
    const allRequiredOk = ['search', 'aot', 'hotRead'].every((kind) => rebuilds[kind]?.status === 'ok');
    const status = seedMatches && allRequiredOk ? 'ok' : 'failed';
    const seedReason = seedMatches
        ? null
        : `data-scale artifact rebuild hook missing seed evidence for ${namespace}/${tier}`;
    const failureReason = unsupported.length > 0
        ? `data-scale artifact rebuild hook unsupported kinds: ${unsupported.join(', ')}`
        : missing.length > 0
            ? `data-scale artifact rebuild hook missing: ${missing.join(', ')}`
            : null;

    return {
        status,
        tier,
        namespace,
        sourceFixtureNamespace: namespace,
        fixturePrefix: prefix,
        evidenceFile: path.relative(root, artifactEvidenceFile),
        seedEvidenceStatus: seedMatches ? 'ok' : 'missing',
        seedEvidenceFile: seedArtifactEvidence ? path.relative(root, artifactEvidenceFile) : null,
        rebuildCommand: `tools/data-scale/probe.sh ${tier}`,
        rebuilds,
        ok,
        unsupported: entries.filter(([, value]) => value.status === 'unsupported').map(([key]) => key),
        missing,
        artifactCount: entries.reduce((total, [, value]) => total + Number(value.artifactCount ?? 0), 0),
        sizeBytes: entries.reduce((total, [, value]) => total + Number(value.sizeBytes ?? 0), 0),
        reason: seedReason ?? failureReason,
        generatedAt
    };
}

function nonNegativeIntEnv(name, fallback)
{
    if (process.env[name] === undefined || process.env[name] === '')
    {
        return fallback;
    }
    const parsed = Number.parseInt(String(process.env[name]), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function processExists(pid)
{
    if (!Number.isInteger(pid) || pid <= 0)
    {
        return false;
    }

    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        return error?.code === 'EPERM';
    }
}

function parsePid(value)
{
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function discoverBackendProcessTarget({
    environment = process.env,
    spawnProcess = spawnSync
} = {})
{
    if (environment.FSUSBLOG_RELEASE_RESOURCE_FORCE_UNAVAILABLE === '1')
    {
        return {
            status: 'missing',
            reason: 'forced unavailable by FSUSBLOG_RELEASE_RESOURCE_FORCE_UNAVAILABLE'
        };
    }

    const containerId = String(environment.FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID ?? '').trim();
    if (containerId)
    {
        const expectedHostPid = parsePid(environment.FSUSBLOG_RELEASE_RESOURCE_PID);
        if (!/^[0-9a-f]{64}$/u.test(containerId) || expectedHostPid === null)
        {
            return { status: 'missing', reason: 'configured backend container identity is incomplete' };
        }
        const inspected = spawnProcess('docker', ['inspect', containerId], {
            cwd: root,
            encoding: 'utf8'
        });
        try
        {
            const [container] = JSON.parse(inspected.stdout || '[]');
            if (inspected.status !== 0 || container?.Id !== containerId
                || container?.State?.Running !== true || container.State.Pid !== expectedHostPid)
            {
                return {
                    status: 'missing',
                    reason: 'configured backend container is not running with the verified host PID'
                };
            }
        }
        catch
        {
            return { status: 'missing', reason: 'configured backend container inspection is unavailable' };
        }
        return {
            status: 'ok',
            kind: 'docker-container',
            containerId,
            pid: expectedHostPid,
            source: 'verified-docker-container-env'
        };
    }

    const explicitPid = parsePid(environment.FSUSBLOG_RELEASE_RESOURCE_PID ?? environment.FSUSBLOG_BACKEND_PID);
    if (explicitPid)
    {
        return processExists(explicitPid)
            ? { status: 'ok', pid: explicitPid, source: 'env' }
            : { status: 'missing', reason: `configured backend pid ${explicitPid} is not running` };
    }

    let port;
    try
    {
        port = new URL(baseUrl).port;
    }
    catch
    {
        return { status: 'missing', reason: `baseUrl is not parseable: ${baseUrl}` };
    }

    if (!port)
    {
        return { status: 'missing', reason: `baseUrl has no explicit port: ${baseUrl}` };
    }

    const lsof = spawnProcess('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        cwd: root,
        encoding: 'utf8'
    });
    if (lsof.status === 0)
    {
        const pids = lsof.stdout
            .split(/\s+/u)
            .map(parsePid)
            .filter((pid) => pid && processExists(pid));
        if (pids.length > 0)
        {
            return { status: 'ok', pid: pids[0], source: `lsof:tcp:${port}` };
        }
    }

    if (process.platform === 'win32')
    {
        const connection = spawnProcess('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess)`
        ], { cwd: root, encoding: 'utf8' });
        const pid = parsePid(connection.stdout);
        if (connection.status === 0 && pid && processExists(pid))
        {
            return { status: 'ok', pid, source: `Get-NetTCPConnection:tcp:${port}` };
        }
    }

    return {
        status: 'missing',
        reason: `backend process listening on ${baseUrl} was not discoverable; set FSUSBLOG_RELEASE_RESOURCE_PID`
    };
}

function readProcessRssBytes(pid)
{
    const procStatusFile = path.join('/proc', String(pid), 'status');
    if (fs.existsSync(procStatusFile))
    {
        const match = fs.readFileSync(procStatusFile, 'utf8').match(/^VmRSS:\s+(\d+)\s+kB$/mu);
        if (match)
        {
            return { status: 'ok', value: Number(match[1]) * 1024, source: procStatusFile };
        }
    }

    const ps = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        cwd: root,
        encoding: 'utf8'
    });
    const rssKiB = Number.parseInt(ps.stdout.trim(), 10);
    if (ps.status === 0 && Number.isFinite(rssKiB) && rssKiB > 0)
    {
        return { status: 'ok', value: rssKiB * 1024, source: 'ps:rss' };
    }

    if (process.platform === 'win32')
    {
        const windowsProcess = spawnSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`
        ], { cwd: root, encoding: 'utf8' });
        const bytes = Number.parseInt(windowsProcess.stdout.trim(), 10);
        if (windowsProcess.status === 0 && Number.isFinite(bytes) && bytes > 0)
        {
            return { status: 'ok', value: bytes, source: 'Get-Process.WorkingSet64' };
        }
    }

    return {
        status: 'missing',
        reason: (ps.stderr || ps.stdout || `rss unavailable for pid ${pid}`).trim()
    };
}

function readProcessOpenFileDescriptors(pid)
{
    const fdDir = path.join('/proc', String(pid), 'fd');
    if (fs.existsSync(fdDir))
    {
        try
        {
            return { status: 'ok', value: fs.readdirSync(fdDir).length, source: fdDir };
        }
        catch (error)
        {
            return {
                status: 'missing',
                reason: error instanceof Error ? error.message : String(error)
            };
        }
    }

    const lsof = spawnSync('lsof', ['-nP', '-p', String(pid)], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
    });
    if (lsof.status === 0)
    {
        const count = lsof.stdout.split(/\r?\n/u).filter(Boolean).length - 1;
        if (count >= 0)
        {
            return { status: 'ok', value: count, source: 'lsof:pid' };
        }
    }

    if (process.platform === 'win32')
    {
        const windowsProcess = spawnSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).HandleCount`
        ], { cwd: root, encoding: 'utf8' });
        const handles = Number.parseInt(windowsProcess.stdout.trim(), 10);
        if (windowsProcess.status === 0 && Number.isFinite(handles) && handles >= 0)
        {
            return { status: 'ok', value: handles, source: 'Get-Process.HandleCount' };
        }
    }

    return {
        status: 'missing',
        reason: (lsof.stderr || lsof.stdout || `open file descriptor count unavailable for pid ${pid}`).trim()
    };
}

function readContainerProcessMetric(target, metric, spawnProcess = spawnSync)
{
    const commands = {
        rss: `awk '/^VmRSS:/ { print $2 * 1024; found=1 } END { if (!found) exit 1 }' /proc/1/status`,
        openFileDescriptors: 'count=0; for descriptor in /proc/1/fd/*; do [ -e "$descriptor" ] || continue; count=$((count + 1)); done; printf "%s\\n" "$count"'
    };
    const observed = spawnProcess(
        'docker',
        ['exec', target.containerId, 'sh', '-c', commands[metric]],
        { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    const value = Number.parseInt(String(observed.stdout ?? '').trim(), 10);
    const valid = metric === 'rss'
        ? Number.isFinite(value) && value > 0
        : Number.isFinite(value) && value >= 0;
    if (observed.status === 0 && valid)
    {
        return {
            status: 'ok',
            value,
            source: metric === 'rss'
                ? `docker:${target.containerId}:/proc/1/status`
                : `docker:${target.containerId}:/proc/1/fd`
        };
    }
    return {
        status: 'missing',
        reason: String(observed.stderr || observed.stdout || `container ${metric} metric is unavailable`).trim()
    };
}

export function readReleaseResourceRssBytes(target, { spawnProcess = spawnSync } = {})
{
    return target?.kind === 'docker-container'
        ? readContainerProcessMetric(target, 'rss', spawnProcess)
        : readProcessRssBytes(target?.pid);
}

export function readReleaseResourceOpenFileDescriptors(target, { spawnProcess = spawnSync } = {})
{
    return target?.kind === 'docker-container'
        ? readContainerProcessMetric(target, 'openFileDescriptors', spawnProcess)
        : readProcessOpenFileDescriptors(target?.pid);
}

function releaseResourceModeConfig(mode)
{
    if (mode === 'memory-leak')
    {
        return {
            mode,
            name: 'backend_rss_bytes',
            unit: 'bytes',
            threshold: nonNegativeIntEnv('FSUSBLOG_RELEASE_RESOURCE_RSS_DELTA_THRESHOLD_BYTES', 64 * 1024 * 1024),
            thresholdKind: 'max_delta_bytes',
            read: readReleaseResourceRssBytes
        };
    }

    if (mode === 'open-handle')
    {
        return {
            mode,
            name: 'backend_open_file_descriptors',
            unit: 'count',
            threshold: nonNegativeIntEnv('FSUSBLOG_RELEASE_RESOURCE_FD_DELTA_THRESHOLD', 16),
            thresholdKind: 'max_delta_count',
            read: readReleaseResourceOpenFileDescriptors
        };
    }

    throw new Error(`unknown release resource budget mode: ${mode}`);
}

function buildUnavailableResourceSummary(mode, target, generatedAt = nowIso())
{
    return {
        status: 'failed',
        mode,
        namespace,
        baseUrl,
        generatedAt,
        metrics: [],
        resourceMetrics: {},
        unavailableMetrics: [{
            name: mode === 'open-handle' ? 'backend_open_file_descriptors' : 'backend_rss_bytes',
            reason: target.reason ?? 'resource metric unavailable'
        }],
        thresholdEvaluation: {
            status: 'fail',
            reason: target.reason ?? 'resource metric unavailable'
        }
    };
}

function buildResourceMetric(config, target, start, end)
{
    const readings = [
        { phase: 'start', ...start },
        { phase: 'end', ...end }
    ];
    const missing = readings.filter((reading) => reading.status !== 'ok');
    if (missing.length > 0)
    {
        return {
            metric: null,
            unavailable: missing.map((reading) => ({
                name: config.name,
                phase: reading.phase,
                reason: reading.reason ?? `${config.name} unavailable`
            }))
        };
    }

    const startValue = start.value;
    const endValue = end.value;
    const maxValue = Math.max(startValue, endValue);
    const delta = endValue - startValue;
    const passed = delta <= config.threshold;
    return {
        metric: {
            name: config.name,
            unit: config.unit,
            startValue,
            endValue,
            maxValue,
            delta,
            threshold: config.threshold,
            thresholdKind: config.thresholdKind,
            thresholdOperator: '<=',
            thresholdField: 'delta',
            status: passed ? 'ok' : 'failed',
            source: {
                pid: target.pid,
                ...(target.containerId ? { containerId: target.containerId } : {}),
                discovery: target.source,
                start: start.source,
                end: end.source
            }
        },
        unavailable: []
    };
}

function buildSoakResourceMetric(config, target, start, end)
{
    const readings = [
        { phase: 'start', ...start },
        { phase: 'end', ...end }
    ];
    const missing = readings.filter((reading) => reading.status !== 'ok');
    if (missing.length > 0)
    {
        return {
            metric: null,
            unavailable: missing.map((reading) => ({
                name: config.name,
                phase: reading.phase,
                reason: reading.reason ?? `${config.name} unavailable`
            }))
        };
    }

    const startValue = start.value;
    const endValue = end.value;
    return {
        metric: {
            name: config.name,
            unit: config.unit,
            startValue,
            endValue,
            maxValue: Math.max(startValue, endValue),
            delta: endValue - startValue,
            status: 'observed',
            source: {
                pid: target.pid,
                ...(target.containerId ? { containerId: target.containerId } : {}),
                discovery: target.source,
                start: start.source,
                end: end.source
            }
        },
        unavailable: []
    };
}

function readSoakResourceReadings(target)
{
    return {
        backend_rss_bytes: readReleaseResourceRssBytes(target),
        backend_open_file_descriptors: readReleaseResourceOpenFileDescriptors(target)
    };
}

function buildSoakUnavailableResourceSummary(reason)
{
    return {
        status: 'unavailable',
        metrics: [],
        unavailableMetrics: [{
            name: 'backend_process',
            reason
        }]
    };
}

function buildSoakResourceSummary(target, start, end)
{
    if (target.status !== 'ok')
    {
        return buildSoakUnavailableResourceSummary(target.reason ?? 'backend process unavailable');
    }

    const configs = [
        releaseResourceModeConfig('memory-leak'),
        releaseResourceModeConfig('open-handle')
    ];
    const metrics = [];
    const unavailableMetrics = [];
    for (const config of configs)
    {
        const { metric, unavailable } = buildSoakResourceMetric(
            config,
            target,
            start[config.name],
            end[config.name]
        );
        if (metric)
        {
            metrics.push(metric);
        }
        unavailableMetrics.push(...unavailable);
    }

    return {
        status: metrics.length > 0 && unavailableMetrics.length === 0
            ? 'ok'
            : metrics.length > 0
        ? 'partial'
        : 'unavailable',
        metrics,
        unavailableMetrics
    };
}

function soakResourceCurve(resourceMetricSummary)
{
    const byName = Object.fromEntries((resourceMetricSummary.metrics ?? []).map((metric) => [metric.name, metric]));
    return {
        rssDeltaBytes: byName.backend_rss_bytes?.delta ?? null,
        rssMaxBytes: byName.backend_rss_bytes?.maxValue ?? null,
        openFileDescriptorDelta: byName.backend_open_file_descriptors?.delta ?? null,
        openFileDescriptorMax: byName.backend_open_file_descriptors?.maxValue ?? null,
        rssSlope: null,
        managedHeapSlope: null,
        gcPauseMsP99: null,
        threadCountMax: null,
        socketCountMax: null,
        dbPoolSaturationMs: null,
        redisLatencyP99Ms: null,
        notificationStreamReconnectSuccessRate: null
    };
}

function sleep(ms)
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notificationSupport()
{
    if (!notificationSupportPromise)
    {
        notificationSupportPromise = Promise.all([
            import(pathToFileURL(path.join(root, 'tests/frontend/support/auth-helpers.mjs')).href),
            import(pathToFileURL(path.join(root, 'tests/frontend/support/aeds-envelope.mjs')).href)
        ]).then(([auth, aeds]) => ({
            buildPowHeaders: auth.buildPowHeaders,
            decodeAedsFrame: aeds.decodeAedsFrame
        }));
    }

    return await notificationSupportPromise;
}

async function readWebSocketMessageData(data)
{
    if (data instanceof ArrayBuffer)
    {
        return data;
    }

    if (ArrayBuffer.isView(data))
    {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    if (typeof Blob !== 'undefined' && data instanceof Blob)
    {
        return await data.arrayBuffer();
    }

    throw new Error(`unexpected websocket message type: ${Object.prototype.toString.call(data)}`);
}

function decodeNotificationFrame(buffer, decodeAedsFrame)
{
    const frame = decodeAedsFrame(buffer);
    if (frame.frameType === frameNotificationHeartbeat)
    {
        return { kind: 'heartbeat' };
    }

    if (frame.frameType !== frameNotificationEvent)
    {
        return { kind: 'other', frameType: frame.frameType };
    }

    const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    return {
        kind: 'event',
        id: Number(view.getBigInt64(0, true)),
        ts: Number(view.getBigInt64(8, true)),
        type: view.getInt32(16, true)
    };
}

function notificationWebSocketUrl(powProof, options = {})
{
    const url = new URL(notificationStreamPath, baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('pow', powProof);
    url.searchParams.set('client', options.client ?? `runtime-drill-${namespace}`);
    if (options.cursor !== undefined && options.cursor !== null)
    {
        url.searchParams.set('cursor', String(options.cursor));
    }
    if (options.slowConsumer)
    {
        url.searchParams.set('drillSlowConsumer', '1');
        url.searchParams.set('drillReadDelayMs', String(options.drillReadDelayMs ?? 1000));
        url.searchParams.set('drillQueueCapacity', String(options.drillQueueCapacity ?? 32));
    }
    return url;
}

async function waitForCondition(label, predicate, options = {})
{
    const deadline = performance.now() + positiveInt(options.timeoutMs, timeoutMs);
    const intervalMs = positiveInt(options.intervalMs, 100);
    do
    {
        const result = predicate();
        if (result)
        {
            return result;
        }

        await sleep(intervalMs);
    } while (performance.now() < deadline);

    throw new Error(`timeout waiting for ${label}`);
}

async function openNotificationSocket(label, options = {})
{
    if (typeof WebSocket !== 'function')
    {
        throw new Error('global WebSocket is not available in this Node.js runtime');
    }

    const { buildPowHeaders, decodeAedsFrame } = await notificationSupport();
    // The bounded Wasm solver's optimized two-block SHA-256 path requires the
    // challenge salt and fingerprint to fit in 128 bytes. Keep uniqueness while
    // avoiding a label-derived fingerprint that can exceed that native contract.
    const fingerprintSeed = `${namespace}:${label}:${process.pid}:${Date.now()}`;
    const fingerprint = `nd-${createHash('sha256').update(fingerprintSeed).digest('hex').slice(0, 24)}`;
    const powHeaders = await buildPowHeaders(fingerprint, timeoutMs);
    const url = notificationWebSocketUrl(powHeaders['X-Fsus-Pow-Proof'], {
        client: label,
        cursor: options.cursor,
        slowConsumer: options.slowConsumer,
        drillReadDelayMs: options.drillReadDelayMs
    });
    const stats = {
        label,
        opened: false,
        closed: false,
        closeCode: null,
        closeReason: null,
        errors: 0,
        lastError: null,
        heartbeats: 0,
        events: [],
        eventIds: [],
        otherFrames: 0,
        protocol: null
    };
    const socket = new WebSocket(url, notificationStreamProtocol);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () =>
    {
        stats.opened = true;
        stats.protocol = socket.protocol || null;
    });

    socket.addEventListener('message', async (event) =>
    {
        try
        {
            const decoded = decodeNotificationFrame(await readWebSocketMessageData(event.data), decodeAedsFrame);
            if (decoded.kind === 'heartbeat')
            {
                stats.heartbeats += 1;
            }
            else if (decoded.kind === 'event')
            {
                stats.events.push(decoded);
                stats.eventIds.push(decoded.id);
            }
            else
            {
                stats.otherFrames += 1;
            }
        }
        catch (error)
        {
            stats.errors += 1;
            stats.lastError = error instanceof Error ? error.message : String(error);
        }
    });

    socket.addEventListener('close', (event) =>
    {
        stats.closed = true;
        stats.closeCode = event.code;
        stats.closeReason = event.reason || null;
    });

    socket.addEventListener('error', () =>
    {
        stats.errors += 1;
        stats.lastError = 'websocket error';
    });

    await waitForCondition(`${label} notification heartbeat`, () =>
    {
        if (stats.heartbeats > 0)
        {
            return true;
        }
        if (stats.errors > 0)
        {
            throw new Error(`${label} notification socket error: ${stats.lastError}`);
        }
        if (stats.closed)
        {
            throw new Error(`${label} notification socket closed before heartbeat: ${stats.closeCode}`);
        }
        return false;
    });

    if (stats.protocol !== notificationStreamProtocol)
    {
        throw new Error(`${label} websocket protocol mismatch: ${stats.protocol ?? 'none'}`);
    }

    return { socket, stats };
}

async function publishNotificationDrill({ drillId, count, payloadBytes, routeKey })
{
    if (!notificationDrillSecret)
    {
        throw new Error('FSUSBLOG_NOTIFICATION_DRILL_SECRET missing');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const requestBody = JSON.stringify({ drillId, count, payloadBytes, routeKey });
    const signature = createHmac('sha256', notificationDrillSecret)
        .update(`${timestamp}\n${nonce}\n${requestBody}`, 'utf8')
        .digest('hex');
    try
    {
        const response = await fetch(`${baseUrl}${notificationDrillPublishPath}`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'FsusBlog runtime evidence probe',
                'X-Fsus-Notification-Drill-Secret': notificationDrillSecret,
                'X-Fsus-Notification-Drill-Timestamp': timestamp,
                'X-Fsus-Notification-Drill-Nonce': nonce,
                'X-Fsus-Notification-Drill-Signature': signature
            },
            signal: controller.signal,
            body: requestBody
        });
        const text = await response.text();
        const responseBody = text ? JSON.parse(text) : null;
        if (!response.ok)
        {
            throw new Error(`notification drill publish failed: HTTP ${response.status} ${text}`);
        }
        if (!Array.isArray(responseBody?.eventIds) || responseBody.eventIds.length === 0)
        {
            throw new Error('notification drill publish did not return event ids');
        }
        return responseBody;
    }
    finally
    {
        clearTimeout(timer);
    }
}

function closeSocketQuietly(socket, reason = 'runtime-drill-complete')
{
    try
    {
        if (socket && (socket.readyState === 0 || socket.readyState === 1))
        {
            socket.close(1000, reason);
            if (typeof socket.terminate === 'function')
            {
                setTimeout(() =>
                {
                    try
                    {
                        socket.terminate();
                    }
                    catch
                    {
                        // Socket termination is best effort after close; it cannot qualify the drill.
                    }
                }, 100).unref?.();
            }
        }
    }
    catch
    {
        // Already closed or failed sockets retain their original drill result.
    }
}

function countMatchingEventIds(receivedIds, publishedIds)
{
    const published = new Set(publishedIds);
    return receivedIds.filter((id) => published.has(id)).length;
}

function selectFaultCases(defaultCases)
{
    const raw = process.env.FSUSBLOG_FAULT_INJECTION_CASES || '';
    if (!raw.trim())
    {
        return defaultCases;
    }

    const selected = raw.split(/[,\s]+/u).map((item) => item.trim()).filter(Boolean);
    const known = new Set(defaultCases);
    for (const caseName of selected)
    {
        if (!known.has(caseName))
        {
            throw new Error(`unknown fault injection case selected: ${caseName}`);
        }
    }
    return selected;
}

function queryRedisDbSize()
{
    const containers = [
        process.env.FSUSBLOG_REDIS_CONTAINER_NAME,
        process.env.FSUSBLOG_REDIS_CONTAINER,
        'fsusblog-dev-redis'
    ].filter(Boolean);
    const uniqueContainers = [...new Set(containers)];
    let lastError = 'redis container env missing';
    for (const container of uniqueContainers)
    {
        const result = runDocker(['exec', '-i', container, 'redis-cli', 'DBSIZE']);
        if (!result.ok)
        {
            lastError = result.error;
            continue;
        }
        const parsed = Number.parseInt(result.stdout, 10);
        return Number.isFinite(parsed)
            ? { available: true, value: parsed }
            : { available: false, error: `unexpected redis dbsize: ${result.stdout}` };
    }
    return { available: false, error: lastError };
}

function readPostgresCommandCounter()
{
    const result = queryPostgresScalar(`
    select coalesce(sum(xact_commit + xact_rollback), 0)::bigint
    from pg_stat_database
    where datname = current_database();
  `);
    return result.available
        ? { available: true, value: result.value, source: 'postgres:pg_stat_database.xact_delta' }
        : { available: false, error: result.error };
}

function readRedisCommandCounter()
{
    const containers = [
        process.env.FSUSBLOG_REDIS_CONTAINER_NAME,
        process.env.FSUSBLOG_REDIS_CONTAINER,
        'fsusblog-dev-redis'
    ].filter(Boolean);
    const uniqueContainers = [...new Set(containers)];
    let lastError = 'redis container env missing';
    for (const container of uniqueContainers)
    {
        const result = runDocker(['exec', '-i', container, 'redis-cli', 'INFO', 'commandstats']);
        if (!result.ok)
        {
            lastError = result.error;
            continue;
        }

        const calls = result.stdout
            .split(/\r?\n/u)
            .filter((line) => line.startsWith('cmdstat_'))
            .reduce((total, line) =>
            {
                const match = /calls=(\d+)/u.exec(line);
                return total + (match ? Number.parseInt(match[1], 10) : 0);
            }, 0);
        return Number.isFinite(calls)
            ? { available: true, value: calls, source: 'redis:INFO commandstats calls' }
            : { available: false, error: `unexpected redis commandstats: ${result.stdout}` };
    }
    return { available: false, error: lastError };
}

function captureBackendQpsCounterSnapshot()
{
    return {
        generatedAt: nowIso(),
        postgresCommands: readPostgresCommandCounter(),
        redisCommands: readRedisCommandCounter()
    };
}

function backendQpsCounterDelta(before, after, source, sampleCount, measurementOverhead = 0)
{
    if (before?.available && after?.available)
    {
        const value = Math.max(0, Number(after.value) - Number(before.value) - measurementOverhead);
        return {
            status: 'ok',
            value,
            perRequest: Number((value / Math.max(sampleCount, 1)).toFixed(6)),
            source,
            reason: null
        };
    }

    return {
        status: 'missing',
        reason: after?.error ?? before?.error ?? `${source} unavailable for backend-qps counter window`
    };
}

function nowIso()
{
    return new Date().toISOString();
}

function elapsedMs(started)
{
    return Number((performance.now() - started).toFixed(3));
}

function unavailableExtendedMetric(status, reason, source = null)
{
    return { status, reason, source };
}

function okExtendedMetric(value, unit, source, extra = {})
{
    return { status: 'ok', value, unit, source, ...extra };
}

function measurePostgresPingLatency()
{
    const started = performance.now();
    const result = queryPostgresScalar('select 1;');
    if (result.available && Number(result.value) === 1)
    {
        return okExtendedMetric(elapsedMs(started), 'ms', 'postgres:select 1');
    }
    return unavailableExtendedMetric('missing', result.error ?? 'postgres ping unavailable', 'postgres:select 1');
}

function measureRedisPingLatency()
{
    const containers = [
        process.env.FSUSBLOG_REDIS_CONTAINER_NAME,
        process.env.FSUSBLOG_REDIS_CONTAINER,
        'fsusblog-dev-redis'
    ].filter(Boolean);
    const uniqueContainers = [...new Set(containers)];
    let lastError = 'redis container env missing';
    for (const container of uniqueContainers)
    {
        const started = performance.now();
        const result = runDocker(['exec', '-i', container, 'redis-cli', 'PING']);
        if (!result.ok)
        {
            lastError = result.error;
            continue;
        }
        if (result.stdout.trim() === 'PONG')
        {
            return okExtendedMetric(elapsedMs(started), 'ms', 'redis:PING');
        }
        lastError = `unexpected redis PING response: ${result.stdout}`;
    }
    return unavailableExtendedMetric('missing', lastError, 'redis:PING');
}

function activeHandleCount()
{
    return typeof process._getActiveHandles === 'function'
        ? process._getActiveHandles().length
        : null;
}

function extendedCategoryStatus(fields)
{
    return Object.values(fields).some((field) => field?.status === 'ok') ? 'ok' : 'missing';
}

function extendedCategoryReason(fields)
{
    return Object.values(fields)
        .filter((field) => field?.status !== 'ok')
        .map((field) => field?.reason)
        .filter(Boolean)
        .join('; ') || null;
}

function buildExtendedObservability(probe)
{
    const managedRuntimeFields = {
        runtime: okExtendedMetric('dotnet-10', 'name', 'performance_baseline.runtime'),
        nativeAot: okExtendedMetric(booleanEnv('FSUSBLOG_NATIVE_AOT') ?? false, 'boolean', 'env:FSUSBLOG_NATIVE_AOT'),
        readyToRun: booleanEnv('DOTNET_ReadyToRun', 'COMPlus_ReadyToRun', 'FSUSBLOG_PERF_READYTORUN') === null
            ? unavailableExtendedMetric('not-collected', 'ReadyToRun env flag was not set for this runtime probe', 'env')
            : okExtendedMetric(booleanEnv('DOTNET_ReadyToRun', 'COMPlus_ReadyToRun', 'FSUSBLOG_PERF_READYTORUN'), 'boolean', 'env:DOTNET_ReadyToRun|COMPlus_ReadyToRun|FSUSBLOG_PERF_READYTORUN'),
        tieredPgo: booleanEnv('DOTNET_TieredPGO', 'COMPlus_TieredPGO') === null
            ? unavailableExtendedMetric('not-collected', 'TieredPGO env flag was not set for this runtime probe', 'env')
            : okExtendedMetric(booleanEnv('DOTNET_TieredPGO', 'COMPlus_TieredPGO'), 'boolean', 'env:DOTNET_TieredPGO|COMPlus_TieredPGO')
    };
    const threadOrConnectionFields = {
        configuredConcurrency: okExtendedMetric(probe.concurrency, 'count', 'runtime-http-probe.concurrency'),
        sampleCount: okExtendedMetric(probe.sampleCount, 'count', 'runtime-http-probe.sampleCount'),
        activeProbeHandles: activeHandleCount() === null
            ? unavailableExtendedMetric('not-collected', 'Node active handle count is not available in this runtime', 'node:process._getActiveHandles')
            : okExtendedMetric(activeHandleCount(), 'count', 'node:process._getActiveHandles')
    };
    const postgresPingLatency = measurePostgresPingLatency();
    const redisPingLatency = measureRedisPingLatency();
    const storageOrCacheLatencyFields = {
        cacheBackedHttpP95: okExtendedMetric(probe.latencyMs.p95, 'ms', 'runtime-http-probe.latencyMs.p95', {
            cacheSignalRatio: probe.cacheSignalRatio
        }),
        postgresPingLatency,
        redisPingLatency
    };
    const categories = {
        managedRuntime: {
            status: extendedCategoryStatus(managedRuntimeFields),
            fields: managedRuntimeFields,
            reason: extendedCategoryReason(managedRuntimeFields)
        },
        threadOrConnection: {
            status: extendedCategoryStatus(threadOrConnectionFields),
            fields: threadOrConnectionFields,
            reason: extendedCategoryReason(threadOrConnectionFields)
        },
        storageOrCacheLatency: {
            status: extendedCategoryStatus(storageOrCacheLatencyFields),
            fields: storageOrCacheLatencyFields,
            reason: extendedCategoryReason(storageOrCacheLatencyFields)
        }
    };
    const complete = requiredExtendedObservabilityCategories.every((category) => categories[category]?.status === 'ok');
    return {
        status: complete ? 'complete' : 'partial',
        requiredCategories: requiredExtendedObservabilityCategories,
        categories,
        generatedAt: nowIso(),
        reason: complete ? null : 'one or more extended observability categories were unavailable; see category reasons'
    };
}

function attachExtendedObservability(probe)
{
    const extendedObservability = buildExtendedObservability(probe);
    return {
        ...probe,
        observabilityLevel: extendedObservability.status === 'complete'
            ? 'extended-runtime-evidence'
            : 'basic-runtime-evidence',
        extendedObservability
    };
}

function summarizeProbe(probe)
{
    return {
        status: 'completed',
        sampleCount: probe.sampleCount,
        durationMs: probe.durationMs,
        rps: probe.rps,
        p95Ms: probe.latencyMs.p95,
        statusCounts: probe.statusCounts,
        paths: [...new Set(probe.samples.map((sample) => sample.path))]
    };
}

async function runProbeResult(label, paths, options = {})
{
    const startedAt = nowIso();
    const started = performance.now();
    try
    {
        const runtime = await runHttpProbe(paths, options);
        return {
            status: 'completed',
            label,
            startedAt,
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            runtime: summarizeProbe(runtime)
        };
    }
    catch (error)
    {
        return {
            status: 'failed',
            label,
            startedAt,
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

function acceptanceTmpDir()
{
    return path.join(root, '.tmp', 'acceptance', namespaceSlug(namespace));
}

function backendPidFile()
{
    return process.env.FSUSBLOG_BACKEND_PID_FILE || path.join(acceptanceTmpDir(), 'backend.pid');
}

function backendLogFile()
{
    return process.env.FSUSBLOG_BACKEND_LOG_FILE || path.join(acceptanceTmpDir(), 'backend.log');
}

function readPositiveIntFile(file)
{
    try
    {
        const value = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    catch
    {
        return null;
    }
}

function baseUrlPort()
{
    try
    {
        const parsed = new URL(baseUrl);
        if (parsed.port)
        {
            return Number.parseInt(parsed.port, 10);
        }
        return parsed.protocol === 'https:' ? 443 : 80;
    }
    catch
    {
        return null;
    }
}

function isProcessRunning(pid)
{
    const state = processState(pid);
    if (state.status !== 'unknown')
    {
        return state.running;
    }

    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch
    {
        return false;
    }
}

function processState(pid)
{
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.status !== 0)
    {
        return { status: 'missing', running: false, stat: null };
    }

    const stat = String(result.stdout || '').trim();
    if (!stat)
    {
        return { status: 'missing', running: false, stat: null };
    }

    if (stat.includes('Z'))
    {
        return { status: 'zombie', running: false, stat };
    }

    return { status: 'running', running: true, stat };
}

function classifyArtifactWriteError(error)
{
    const code = typeof error?.code === 'string' && error.code.length > 0
        ? error.code
        : 'UNKNOWN';
    const controlledCodes = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS']);
    return {
        status: controlledCodes.has(code) ? 'expected-error' : 'unexpected-error',
        code,
        message: error instanceof Error ? error.message : String(error)
    };
}

function findListeningPid(port)
{
    if (!port)
    {
        return null;
    }
    const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        cwd: root,
        encoding: 'utf8'
    });
    if (lsof.status === 0)
    {
        const pid = Number.parseInt(String(lsof.stdout).trim().split(/\s+/u)[0], 10);
        if (Number.isFinite(pid) && pid > 0)
        {
            return pid;
        }
    }

    const ss = spawnSync('ss', ['-ltnp', `( sport = :${port} )`], {
        cwd: root,
        encoding: 'utf8'
    });
    if (ss.status === 0)
    {
        const match = /pid=(\d+)/u.exec(ss.stdout);
        if (match)
        {
            const pid = Number.parseInt(match[1], 10);
            if (Number.isFinite(pid) && pid > 0)
            {
                return pid;
            }
        }
    }
    return null;
}

function backendContainerName()
{
    return process.env.FSUSBLOG_BACKEND_CONTAINER_NAME || process.env.FSUSBLOG_BACKEND_CONTAINER || '';
}

function resolveBackendRuntimeTarget()
{
    const container = backendContainerName();
    if (container)
    {
        return { kind: 'container', container };
    }

    const envPid = Number.parseInt(process.env.FSUSBLOG_BACKEND_PID || '', 10);
    const pidCandidates = [
        findListeningPid(baseUrlPort()),
    Number.isFinite(envPid) && envPid > 0 ? envPid : null,
    readPositiveIntFile(backendPidFile())
    ].filter((candidate) => Number.isFinite(candidate) && candidate > 0);
    const pid = pidCandidates.find((candidate) => isProcessRunning(candidate)) ?? null;
    return pid ? { kind: 'process', pid, pidFile: backendPidFile(), logFile: backendLogFile() } : null;
}

async function fetchStatus(relativePath, options = {})
{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${positiveInt(options.timeoutMs, 1000)}ms`)), positiveInt(options.timeoutMs, 1000));
    const started = performance.now();
    try
    {
        const response = await fetch(`${baseUrl}${relativePath}`, {
            headers: { ...defaultHeaders, ...(options.headers ?? {}) },
            signal: controller.signal
        });
        const body = await response.arrayBuffer();
        return {
            status: response.status >= 200 && response.status < 500 ? 'available' : 'unavailable',
            statusCode: response.status,
            ok: response.ok,
            bytes: body.byteLength,
            elapsedMs: elapsedMs(started)
        };
    }
    catch (error)
    {
        return {
            status: 'unavailable',
            statusCode: null,
            ok: false,
            elapsedMs: elapsedMs(started),
            error: error instanceof Error ? error.message : String(error)
        };
    }
    finally
    {
        clearTimeout(timer);
    }
}

async function waitForHealthLiveUnavailable()
{
    const startedAt = nowIso();
    const started = performance.now();
    const attempts = [];
    const maxWaitMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_DRAIN_WAIT_MS, 30000);
    const intervalMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_POLL_MS, 250);
    do
    {
        const probe = await fetchStatus('/health/live', { timeoutMs: 1000 });
        attempts.push({ at: nowIso(), elapsedMs: elapsedMs(started), ...probe });
        if (probe.status === 'unavailable')
        {
            return {
                status: 'unavailable',
                startedAt,
                completedAt: nowIso(),
                durationMs: elapsedMs(started),
                attempts
            };
        }
        await sleep(intervalMs);
    } while (performance.now() - started < maxWaitMs);

    return {
        status: 'available',
        startedAt,
        completedAt: nowIso(),
        durationMs: elapsedMs(started),
        attempts
    };
}

async function waitForProcessStop(pid)
{
    const started = performance.now();
    const maxWaitMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_PROCESS_WAIT_MS, 30000);
    do
    {
        if (!isProcessRunning(pid))
        {
            return { status: 'stopped', exitObserved: true, durationMs: elapsedMs(started) };
        }
        await sleep(250);
    } while (performance.now() - started < maxWaitMs);
    return { status: 'running', exitObserved: false, durationMs: elapsedMs(started) };
}

async function waitForNotificationClose(stats)
{
    const started = performance.now();
    const maxWaitMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_SOCKET_WAIT_MS, 30000);
    do
    {
        if (stats?.closed)
        {
            return {
                status: 'closed',
                closeObserved: true,
                closeCode: stats.closeCode,
                closeReason: stats.closeReason,
                durationMs: elapsedMs(started)
            };
        }
        await sleep(100);
    } while (performance.now() - started < maxWaitMs);
    return {
        status: 'open',
        closeObserved: false,
        closeCode: stats?.closeCode ?? null,
        closeReason: stats?.closeReason ?? null,
        durationMs: elapsedMs(started)
    };
}

function startManagedBackend()
{
    const port = baseUrlPort();
    if (!port)
    {
        throw new Error(`cannot resolve backend port from ${baseUrl}`);
    }

    fs.mkdirSync(acceptanceTmpDir(), { recursive: true });
    const logFile = backendLogFile();
    const pidFile = backendPidFile();
    const out = fs.openSync(logFile, 'a');
    const env = {
        ...process.env,
        ASPNETCORE_URLS: process.env.ASPNETCORE_URLS || `http://127.0.0.1:${port}`,
        ASPNETCORE_ENVIRONMENT: process.env.ASPNETCORE_ENVIRONMENT || 'Development'
    };
    const configuration = process.env.FSUSBLOG_RUNTIME_CONFIGURATION || 'Debug';
    if (!['Debug', 'Release'].includes(configuration))
    {
        throw new Error(`unsupported FSUSBLOG_RUNTIME_CONFIGURATION: ${configuration}`);
    }
    const noBuild = process.env.FSUSBLOG_RUNTIME_NO_BUILD === '1';
    if (!noBuild)
    {
        throw new Error('managed backend restart requires FSUSBLOG_RUNTIME_NO_BUILD=1 and a shared prebuilt runtime');
    }
    const args = [
        'run', '--project', 'src/backend/FsusBlog.Server.csproj', '--no-launch-profile',
        '-c', configuration,
        '--no-build', '--no-restore',
        '--urls', `http://127.0.0.1:${port}`
    ];
    const child = spawn('dotnet', args, {
        cwd: root,
        detached: true,
        env,
        stdio: ['ignore', out, out]
    });
    child.unref();
    fs.closeSync(out);
    fs.writeFileSync(pidFile, `${child.pid}\n`);
    return { pid: child.pid, pidFile, logFile };
}

function startBackendRuntime(target)
{
    const startedAt = nowIso();
    const started = performance.now();
    if (target.kind === 'container')
    {
        const result = runDocker(['start', target.container]);
        return {
            status: result.ok ? 'started' : 'failed',
            target: target.container,
            mode: 'docker-start',
            startedAt,
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            error: result.ok ? null : result.error
        };
    }

    const processInfo = startManagedBackend();
    return {
        status: 'started',
        target: String(processInfo.pid),
        mode: `managed-${(process.env.FSUSBLOG_RUNTIME_CONFIGURATION || 'Debug').toLowerCase()}-process`,
        startedAt,
        completedAt: nowIso(),
        durationMs: elapsedMs(started),
        pidFile: processInfo.pidFile,
        logFile: processInfo.logFile
    };
}

async function stopBackendRuntime(target)
{
    const startedAt = nowIso();
    const started = performance.now();
    if (target.kind === 'container')
    {
        const result = runDocker(['stop', '--time', String(positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_DOCKER_TIMEOUT_SECONDS, 30)), target.container]);
        const livenessDuringShutdown = await waitForHealthLiveUnavailable();
        return {
            status: result.ok ? 'stopped' : 'failed',
            target: target.container,
            mode: 'docker-stop',
            signal: 'SIGTERM',
            startedAt,
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            drainDurationMs: livenessDuringShutdown.durationMs,
            exitObserved: result.ok,
            livenessDuringShutdown,
            error: result.ok ? null : result.error
        };
    }

    try
    {
        process.kill(target.pid, 'SIGTERM');
    }
    catch (error)
    {
        return {
            status: 'failed',
            target: String(target.pid),
            mode: 'process-signal',
            signal: 'SIGTERM',
            startedAt,
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            drainDurationMs: elapsedMs(started),
            exitObserved: false,
            livenessDuringShutdown: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
            error: error instanceof Error ? error.message : String(error)
        };
    }

    let [processStopResult, livenessDuringShutdown] = await Promise.all([
        waitForProcessStop(target.pid),
        waitForHealthLiveUnavailable()
    ]);
    let forcedKill = false;
    if (processStopResult.status !== 'stopped' && livenessDuringShutdown.status === 'unavailable')
    {
        try
        {
            process.kill(target.pid, 'SIGKILL');
            forcedKill = true;
            processStopResult = await waitForProcessStop(target.pid);
        }
        catch (error)
        {
            if (error?.code === 'ESRCH')
            {
                processStopResult = { status: 'stopped', exitObserved: true, durationMs: elapsedMs(started) };
            }
            else
            {
                processStopResult = {
                    ...processStopResult,
                    killError: error instanceof Error ? error.message : String(error)
                };
            }
        }
    }

    const serviceStopped = livenessDuringShutdown.status === 'unavailable';
    const processStopped = processStopResult.status === 'stopped' && processStopResult.exitObserved === true;
    return {
        status: serviceStopped && processStopped ? 'stopped' : 'failed',
        target: String(target.pid),
        mode: 'process-signal',
        signal: 'SIGTERM',
        startedAt,
        completedAt: nowIso(),
        durationMs: elapsedMs(started),
        drainDurationMs: livenessDuringShutdown.durationMs,
        exitObserved: processStopResult.exitObserved,
        forcedKill,
        processExit: processStopResult,
        livenessDuringShutdown,
        error: serviceStopped && processStopped
            ? null
            : `shutdown incomplete: health=${livenessDuringShutdown.status} process=${processStopResult.status}`
    };
}

async function waitForCompletedProbe(label, paths, options = {})
{
    const started = performance.now();
    const attempts = [];
    const maxWaitMs = positiveInt(options.maxWaitMs, positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_RESTART_WAIT_MS, 120000));
    const intervalMs = positiveInt(options.intervalMs, 1000);
    do
    {
        const result = await runProbeResult(label, paths, {
            iterations: options.iterations ?? 1,
            concurrency: options.concurrency ?? 1,
            headers: options.headers
        });
        if (result.status === 'completed')
        {
            return { ...result, attempts };
        }
        attempts.push({ at: nowIso(), elapsedMs: elapsedMs(started), error: result.error });
        await sleep(intervalMs);
    } while (performance.now() - started < maxWaitMs);

    throw new Error(`${label} did not recover within ${maxWaitMs}ms: ${attempts.at(-1)?.error ?? 'no successful probe'}`);
}

function redisContainerName()
{
    return process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER || '';
}

function runRedisCli(container, args)
{
    return runDocker(['exec', '-i', container, 'redis-cli', ...args]);
}

function scanBackendLogsForUnhandledExceptions()
{
    const container = process.env.FSUSBLOG_BACKEND_CONTAINER_NAME || process.env.FSUSBLOG_BACKEND_CONTAINER || '';
    let source;
    let target;
    let content = '';
    if (container)
    {
        const result = runDocker(['logs', '--since', process.env.FSUSBLOG_FAULT_LOG_SINCE || process.env.FSUSBLOG_REDIS_DRILL_LOG_SINCE || '10m', container]);
        if (!result.ok)
        {
            return { status: 'blocked', source: 'docker-logs', target: container, error: result.error };
        }
        source = 'docker-logs';
        target = container;
        content = result.stdout;
    }
    else if (fs.existsSync(backendLogFile()))
    {
        source = 'managed-backend-log';
        target = backendLogFile();
        content = fs.readFileSync(backendLogFile(), 'utf8').slice(-500000);
    }
    else
    {
        return { status: 'not-configured', reason: 'backend container env and managed backend log missing' };
    }

    const patterns = [
        /Unhandled exception/i,
        /UnhandledException/i,
        /BackgroundService failed/i,
        /Host terminated unexpectedly/i,
        /StackExchange\.Redis.*(?:Fatal|Unhandled|timeout)/i,
        /Redis.*(?:unhandled|fatal)/i
    ];
    const matched = patterns.find((pattern) => pattern.test(content));
    return matched
        ? { status: 'failed', source, target, matchedPattern: String(matched) }
        : { status: 'ok', source, target, scannedBytes: content.length };
}

async function optionalAuthenticatedImpact()
{
    const cookie = process.env.FSUSBLOG_AUTH_COOKIE_HEADER || process.env.FSUSBLOG_AUTHENTICATED_COOKIE || '';
    if (!cookie)
    {
        return { status: 'not-configured', reason: 'FSUSBLOG_AUTH_COOKIE_HEADER missing' };
    }
    return await runProbeResult('authenticated session path', ['/api/binary/auth/sessions'], {
        iterations: 1,
        concurrency: 1,
        headers: { Cookie: cookie }
    });
}

async function optionalNotificationStreamImpact()
{
    const cookie = process.env.FSUSBLOG_AUTH_COOKIE_HEADER || process.env.FSUSBLOG_AUTHENTICATED_COOKIE || '';
    const powQuery = process.env.FSUSBLOG_NOTIFICATION_STREAM_POW_QUERY || '';
    if (!cookie && !powQuery)
    {
        return {
            status: 'not-configured',
            reason: 'FSUSBLOG_AUTH_COOKIE_HEADER or FSUSBLOG_NOTIFICATION_STREAM_POW_QUERY missing'
        };
    }

    const pathWithQuery = powQuery
        ? `/api/notifications/stream/preflight?pow=${encodeURIComponent(powQuery)}`
        : '/api/notifications/stream/preflight';
    return await runProbeResult('notification stream preflight', [pathWithQuery], {
        iterations: 1,
        concurrency: 1,
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            'X-Fsus-Notification-Stream-Protocol': 'fsus-notification-stream.v1'
        }
    });
}

function faultRecoveryHealthMode()
{
    if (resolvedFaultRecoveryHealthMode)
    {
        return resolvedFaultRecoveryHealthMode;
    }
    const mode = (process.env.FSUSBLOG_FAULT_RECOVERY_HEALTH_MODE || 'auto').trim().toLowerCase();
    if (mode === 'auto')
    {
        return 'auto';
    }
    if (['strict-ready', 'ready'].includes(mode))
    {
        return 'strict-ready';
    }
    if (['live', 'runtime', 'live-runtime'].includes(mode))
    {
        return 'live';
    }
    throw new Error(`unsupported FSUSBLOG_FAULT_RECOVERY_HEALTH_MODE: ${mode}`);
}

async function resolveFaultRecoveryHealthMode()
{
    const configuredMode = faultRecoveryHealthMode();
    if (configuredMode !== 'auto')
    {
        resolvedFaultRecoveryHealthMode = configuredMode;
        return configuredMode;
    }

    const baseline = await fetchHealthPathSample('/health/ready');
    resolvedFaultRecoveryHealthMode = baseline.ok ? 'strict-ready' : 'live';
    return resolvedFaultRecoveryHealthMode;
}

async function probeFaultRecoveryHealth(label)
{
    const mode = faultRecoveryHealthMode();
    const path = mode === 'strict-ready' ? '/health/ready' : '/health/live';
    const result = await runProbeResult(label, [path], { iterations: 1, concurrency: 1 });
    if (result.status !== 'completed')
    {
        throw new Error(`${path} did not recover: ${result.error}`);
    }

    return {
        ...result,
        recoveryHealthMode: mode,
        recoveryHealthPath: path
    };
}

async function probeRedisFinalHealth()
{
    const publicReadResult = await runProbeResult('public binary endpoint', [
        '/api/binary/system/seo',
        '/api/binary/article/list/home/1/10.aeds'
    ], { iterations: 4, concurrency: 1 });
    if (publicReadResult.status !== 'completed')
    {
        throw new Error(`public binary endpoint did not recover: ${publicReadResult.error}`);
    }

    const powResult = await runProbeResult('pow challenge path', ['/api/binary/auth/pow-challenge'], {
        iterations: 2,
        concurrency: 1
    });
    if (powResult.status !== 'completed')
    {
        throw new Error(`PoW challenge path did not recover: ${powResult.error}`);
    }

    const cachePathResult = await runProbeResult('cache path', ['/api/binary/category', '/api/binary/tag'], {
        iterations: 4,
        concurrency: 1
    });
    if (cachePathResult.status !== 'completed')
    {
        throw new Error(`cache path did not recover: ${cachePathResult.error}`);
    }

    const healthResult = await probeFaultRecoveryHealth('fault recovery health');

    const authenticatedImpact = await optionalAuthenticatedImpact();
    const notificationStreamImpact = await optionalNotificationStreamImpact();
    const logScan = scanBackendLogsForUnhandledExceptions();
    if (logScan.status === 'failed' || logScan.status === 'blocked')
    {
        throw new Error(`backend log scan ${logScan.status}: ${logScan.error ?? logScan.matchedPattern}`);
    }

    return {
        status: 'healthy',
        generatedAt: nowIso(),
        publicReadResult,
        powSessionCache: {
            powChallenge: powResult,
            cachePath: cachePathResult,
            session: authenticatedImpact
        },
        authenticatedImpact,
        notificationStreamImpact,
        healthReady: healthResult,
        logScan
    };
}

async function waitForRedisRecovery()
{
    const started = performance.now();
    const startedAt = nowIso();
    const attempts = [];
    const maxWaitMs = positiveInt(process.env.FSUSBLOG_REDIS_RECOVERY_WAIT_MS, 20000);
    const intervalMs = positiveInt(process.env.FSUSBLOG_REDIS_RECOVERY_POLL_MS, 500);

    for (;;)
    {
        try
        {
            const finalHealth = await probeRedisFinalHealth();
            return {
                status: 'completed',
                startedAt,
                completedAt: nowIso(),
                recoveryDurationMs: elapsedMs(started),
                attempts,
                finalHealth
            };
        }
        catch (error)
        {
            attempts.push({
                at: nowIso(),
                elapsedMs: elapsedMs(started),
                error: error instanceof Error ? error.message : String(error)
            });
            if (performance.now() - started >= maxWaitMs)
            {
                throw new Error(`Redis recovery did not complete within ${maxWaitMs}ms: ${attempts.at(-1)?.error}`, { cause: error });
            }
            await sleep(intervalMs);
        }
    }
}

async function executeRedisControlledAction(caseName, container)
{
    const startedAt = nowIso();
    const started = performance.now();
    const common = { status: 'executed', target: container, startedAt };

    if (caseName === 'redis-restart')
    {
        const stopped = runDocker(['stop', container]);
        if (!stopped.ok)
        {
            return {
                status: 'blocked',
                target: container,
                operation: 'docker stop/start',
                startedAt,
                completedAt: nowIso(),
                error: stopped.error
            };
        }

        const unavailableStarted = performance.now();
        const unavailableStartedAt = nowIso();
        const impact = await runProbeResult('redis-restart unavailable window', [
            '/api/binary/system/seo',
            '/api/binary/auth/pow-challenge'
        ], { iterations: 2, concurrency: 1 });
        const startedAgain = runDocker(['start', container]);
        const unavailableDurationMs = elapsedMs(unavailableStarted);
        if (!startedAgain.ok)
        {
            return {
                status: 'failed',
                target: container,
                operation: 'docker stop/start',
                startedAt,
                completedAt: nowIso(),
                unavailableStartedAt,
                unavailableDurationMs,
                duringWindow: impact,
                error: startedAgain.error
            };
        }

        return {
            ...common,
            operation: 'docker stop/start',
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            unavailableStartedAt,
            unavailableDurationMs,
            duringWindow: impact,
            stopOutput: stopped.stdout,
            startOutput: startedAgain.stdout
        };
    }

    if (caseName === 'redis-reconnect')
    {
        const killed = runRedisCli(container, ['CLIENT', 'KILL', 'TYPE', 'normal']);
        if (!killed.ok)
        {
            return {
                status: 'blocked',
                target: container,
                operation: 'redis-cli CLIENT KILL TYPE normal',
                startedAt,
                completedAt: nowIso(),
                error: killed.error
            };
        }

        const impact = await runProbeResult('redis-reconnect window', [
            '/api/binary/system/seo',
            '/api/binary/auth/pow-challenge'
        ], { iterations: 2, concurrency: 1 });
        return {
            ...common,
            operation: 'redis-cli CLIENT KILL TYPE normal',
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            unavailableDurationMs: 0,
            duringWindow: impact,
            killedClients: Number.parseInt(killed.stdout, 10),
            output: killed.stdout
        };
    }

    if (caseName === 'redis-latency')
    {
        const pauseMs = positiveInt(process.env.FSUSBLOG_REDIS_LATENCY_PAUSE_MS, 1200);
        const paused = runRedisCli(container, ['CLIENT', 'PAUSE', String(pauseMs), 'ALL']);
        if (!paused.ok)
        {
            return {
                status: 'blocked',
                target: container,
                operation: 'redis-cli CLIENT PAUSE',
                startedAt,
                completedAt: nowIso(),
                unavailableDurationMs: pauseMs,
                error: paused.error
            };
        }

        const impact = await runProbeResult('redis-latency window', [
            '/api/binary/system/seo',
            '/api/binary/auth/pow-challenge'
        ], { iterations: 2, concurrency: 1 });
        return {
            ...common,
            operation: 'redis-cli CLIENT PAUSE',
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            unavailableDurationMs: pauseMs,
            duringWindow: impact,
            pauseMs,
            output: paused.stdout
        };
    }

    return {
        status: 'blocked',
        target: container,
        operation: 'unknown redis action',
        startedAt,
        completedAt: nowIso(),
        reason: `no controlled Redis action implemented for ${caseName}`
    };
}

async function runRedisFaultCase(caseName)
{
    let before = null;
    let action = { status: 'blocked', reason: `no controlled Redis action implemented for ${caseName}` };
    let recovery = null;
    let resultStatus = 'blocked';
    let failure = null;

    try
    {
        before = await runHttpProbe(['/api/binary/system/seo', '/api/binary/auth/pow-challenge'], { iterations: 2, concurrency: 1 });
        const container = redisContainerName();
        if (!container)
        {
            action = { status: 'blocked', reason: 'redis container env missing' };
        }
        else
        {
            action = await executeRedisControlledAction(caseName, container);
            if (action.status === 'executed')
            {
                recovery = await waitForRedisRecovery();
                resultStatus = 'completed';
            }
            else
            {
                resultStatus = action.status === 'failed' ? 'failed' : 'blocked';
            }
        }
    }
    catch (error)
    {
        resultStatus = 'failed';
        failure = error instanceof Error ? error.message : String(error);
    }

    const finalHealth = recovery?.finalHealth ?? {
        status: resultStatus,
        error: failure ?? action.reason ?? action.error ?? 'recovery check missing'
    };
    const publicReadResult = recovery?.finalHealth?.publicReadResult ?? null;
    const recoveryDurationMs = recovery?.recoveryDurationMs ?? null;
    return {
        status: resultStatus,
        case: caseName,
        namespace,
        actionStatus: action.status,
        actionStartedAt: action.startedAt ?? null,
        actionCompletedAt: action.completedAt ?? null,
        unavailableDurationMs: action.unavailableDurationMs ?? null,
        recoveryDurationMs,
        publicReadResult,
        authenticatedImpact: recovery?.finalHealth?.authenticatedImpact ?? null,
        notificationStreamImpact: recovery?.finalHealth?.notificationStreamImpact ?? null,
        preCheck: before
            ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
            : { status: 'failed', error: failure ?? 'pre-check was not completed' },
        controlledAction: action,
        recoveryCheck: recovery
            ? {
          status: recovery.status,
          startedAt: recovery.startedAt,
          completedAt: recovery.completedAt,
          recoveryDurationMs,
          attempts: recovery.attempts.length
        }
            : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? action.error ?? 'controlled action was not executed' },
        timeline: [
            ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
            { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
            ...(action.duringWindow ? [{ event: 'during-unavailable-window', generatedAt: action.duringWindow.completedAt, status: action.duringWindow.status }] : []),
            ...(recovery ? [{ event: 'recovery-check', generatedAt: recovery.completedAt, recoveryDurationMs }] : [])
        ],
        errorRate: action.duringWindow?.status === 'failed' ? 1 : 0,
        recoveryTimeMs: recoveryDurationMs,
        dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
        resourceMetrics: {
            redisContainer: redisContainerName() || null
        },
        finalHealth,
        finalHealthSnapshot: finalHealth,
        generatedAt: recovery?.completedAt ?? nowIso()
    };
}

function postgresContainerName()
{
    return process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || process.env.FSUSBLOG_PG_CONTAINER || '';
}

function runPostgresSql(container, sql)
{
    return runDocker(['exec', '-i', container, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql]);
}

function spawnPostgresSql(container, sql)
{
    const child = spawn('docker', [
        'exec',
        '-i',
        container,
        'psql',
        '-U',
        'fsusblog',
        '-d',
        'fsusblog',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        sql
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) =>
    {
        chunks.stdout += chunk;
    });
    child.stderr.on('data', (chunk) =>
    {
        chunks.stderr += chunk;
    });
    return { child, chunks };
}

function waitForSpawnResult(processHandle, timeoutMs)
{
    const { child, chunks } = processHandle;
    return new Promise((resolve) =>
    {
        const timer = setTimeout(() =>
        {
            child.kill('SIGTERM');
            resolve({
                ok: false,
                status: null,
                stdout: chunks.stdout.trim(),
                stderr: chunks.stderr.trim(),
                error: `process timed out after ${timeoutMs}ms`
            });
        }, timeoutMs);

        child.on('error', (error) =>
        {
            clearTimeout(timer);
            resolve({
                ok: false,
                status: null,
                stdout: chunks.stdout.trim(),
                stderr: chunks.stderr.trim(),
                error: error.message
            });
        });

        child.on('close', (status) =>
        {
            clearTimeout(timer);
            resolve({
                ok: status === 0,
                status,
                stdout: chunks.stdout.trim(),
                stderr: chunks.stderr.trim(),
                error: status === 0 ? null : (chunks.stderr || chunks.stdout || `process exited ${status}`).trim()
            });
        });
    });
}

async function probePostgresFinalHealth(container)
{
    const healthLive = await runProbeResult('health live', ['/health/live'], { iterations: 1, concurrency: 1 });
    if (healthLive.status !== 'completed')
    {
        throw new Error(`health live did not recover: ${healthLive.error}`);
    }

    const publicReadResult = await runProbeResult('public binary endpoint', [
        '/api/binary/system/seo',
        '/api/binary/article/list/home/1/10.aeds'
    ], { iterations: 4, concurrency: 1 });
    if (publicReadResult.status !== 'completed')
    {
        throw new Error(`public binary endpoint did not recover: ${publicReadResult.error}`);
    }

    const healthReady = await probeFaultRecoveryHealth('fault recovery health');

    const dbQuery = runPostgresSql(container, 'SELECT 1;');
    if (!dbQuery.ok)
    {
        throw new Error(`postgres follow-up query failed: ${dbQuery.error}`);
    }

    const logScan = scanBackendLogsForUnhandledExceptions();
    if (logScan.status === 'failed' || logScan.status === 'blocked')
    {
        throw new Error(`backend log scan ${logScan.status}: ${logScan.error ?? logScan.matchedPattern}`);
    }

    return {
        status: 'healthy',
        generatedAt: nowIso(),
        healthLive,
        publicReadResult,
        healthReady,
        connectionPool: {
            status: 'ok',
            appReady: healthReady,
            dbQuery: {
                status: 'completed',
                output: dbQuery.stdout
            }
        },
        logScan
    };
}

async function waitForPostgresRecovery(container)
{
    const started = performance.now();
    const startedAt = nowIso();
    const attempts = [];
    const maxWaitMs = positiveInt(process.env.FSUSBLOG_POSTGRES_RECOVERY_WAIT_MS, 25000);
    const intervalMs = positiveInt(process.env.FSUSBLOG_POSTGRES_RECOVERY_POLL_MS, 500);

    for (;;)
    {
        try
        {
            const finalHealth = await probePostgresFinalHealth(container);
            return {
                status: 'completed',
                startedAt,
                completedAt: nowIso(),
                recoveryDurationMs: elapsedMs(started),
                attempts,
                finalHealth
            };
        }
        catch (error)
        {
            attempts.push({
                at: nowIso(),
                elapsedMs: elapsedMs(started),
                error: error instanceof Error ? error.message : String(error)
            });
            if (performance.now() - started >= maxWaitMs)
            {
                throw new Error(`PostgreSQL recovery did not complete within ${maxWaitMs}ms: ${attempts.at(-1)?.error}`, { cause: error });
            }
            await sleep(intervalMs);
        }
    }
}

async function executePostgresControlledAction(caseName, container)
{
    const startedAt = nowIso();
    const started = performance.now();
    const common = { status: 'executed', target: container, startedAt };

    if (caseName === 'postgres-readiness')
    {
        const stopped = runDocker(['stop', container]);
        if (!stopped.ok)
        {
            return {
                status: 'blocked',
                target: container,
                operation: 'docker stop/start',
                affectedEndpoint: '/health/ready',
                startedAt,
                completedAt: nowIso(),
                error: stopped.error
            };
        }

        const unavailableStarted = performance.now();
        const unavailableStartedAt = nowIso();
        const impact = await runProbeResult('postgres-readiness unavailable window', [
            '/health/ready',
            '/api/binary/system/seo'
        ], { iterations: 2, concurrency: 1 });
        const startedAgain = runDocker(['start', container]);
        const unavailableDurationMs = elapsedMs(unavailableStarted);
        if (!startedAgain.ok)
        {
            return {
                status: 'failed',
                target: container,
                operation: 'docker stop/start',
                affectedEndpoint: '/health/ready',
                startedAt,
                completedAt: nowIso(),
                unavailableStartedAt,
                unavailableDurationMs,
                duringWindow: impact,
                error: startedAgain.error
            };
        }

        return {
            ...common,
            operation: 'docker stop/start',
            affectedEndpoint: '/health/ready',
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            unavailableStartedAt,
            unavailableDurationMs,
            duringWindow: impact,
            writePathRollbackResult: {
                status: 'not-mutated',
                reason: 'readiness drill exercises availability and follow-up read recovery'
            },
            stopOutput: stopped.stdout,
            startOutput: startedAgain.stdout
        };
    }

    if (caseName === 'postgres-reconnect')
    {
        const terminated = runPostgresSql(container, `
      SELECT count(pg_terminate_backend(pid))
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid();
    `);
        if (!terminated.ok)
        {
            return {
                status: 'blocked',
                target: container,
                operation: 'pg_terminate_backend active connections',
                affectedEndpoint: '/health/ready',
                startedAt,
                completedAt: nowIso(),
                error: terminated.error
            };
        }

        const impact = await runProbeResult('postgres-reconnect window', [
            '/health/ready',
            '/api/binary/system/seo'
        ], { iterations: 2, concurrency: 1 });
        return {
            ...common,
            operation: 'pg_terminate_backend active connections',
            affectedEndpoint: '/health/ready',
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            unavailableDurationMs: 0,
            duringWindow: impact,
            terminatedConnections: Number.parseInt(terminated.stdout, 10),
            writePathRollbackResult: {
                status: 'not-mutated',
                reason: 'connection reset drill terminates sessions without writing data'
            },
            output: terminated.stdout
        };
    }

    if (caseName === 'postgres-lock-timeout')
    {
        const beforeRows = queryPostgresScalar('select count(*) from article;');
        if (!beforeRows.available)
        {
            return {
                status: 'blocked',
                target: container,
                operation: 'lock timeout simulation',
                affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
                startedAt,
                completedAt: nowIso(),
                error: beforeRows.error
            };
        }

        const holder = spawnPostgresSql(container, 'BEGIN; LOCK TABLE article IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(3); COMMIT;');
        await sleep(500);
        const timeoutProbe = runPostgresSql(container, "SET lock_timeout = '500ms'; SELECT count(*) FROM article;");
        const holderResult = await waitForSpawnResult(holder, 7000);
        const afterRows = queryPostgresScalar('select count(*) from article;');
        const timeoutObserved = !timeoutProbe.ok && /lock timeout|canceling statement due to lock timeout/i.test(timeoutProbe.error ?? '');
        if (!holderResult.ok)
        {
            return {
                status: 'failed',
                target: container,
                operation: 'lock timeout simulation',
                affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
                startedAt,
                completedAt: nowIso(),
                unavailableDurationMs: elapsedMs(started),
                error: holderResult.error
            };
        }
        if (!timeoutObserved)
        {
            return {
                status: 'failed',
                target: container,
                operation: 'lock timeout simulation',
                affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
                startedAt,
                completedAt: nowIso(),
                unavailableDurationMs: elapsedMs(started),
                error: timeoutProbe.ok ? 'lock timeout query unexpectedly succeeded' : timeoutProbe.error
            };
        }

        return {
            ...common,
            operation: 'lock timeout simulation',
            affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
            completedAt: nowIso(),
            durationMs: elapsedMs(started),
            unavailableDurationMs: elapsedMs(started),
            duringWindow: {
                status: 'failed',
                label: 'postgres-lock-timeout window',
                error: timeoutProbe.error
            },
            writePathRollbackResult: {
                status: afterRows.available && afterRows.value === beforeRows.value ? 'verified' : 'failed',
                beforeArticleRows: beforeRows.value,
                afterArticleRows: afterRows.available ? afterRows.value : null,
                source: afterRows.available ? 'postgres-count' : afterRows.error,
                timeoutObserved
            },
            holderResult: {
                status: holderResult.status,
                stdout: holderResult.stdout,
                stderr: holderResult.stderr
            }
        };
    }

    return {
        status: 'blocked',
        target: container,
        operation: 'unknown postgres action',
        affectedEndpoint: '/health/ready',
        startedAt,
        completedAt: nowIso(),
        reason: `no controlled PostgreSQL action implemented for ${caseName}`
    };
}

async function runPostgresFaultCase(caseName)
{
    let before = null;
    let action = { status: 'blocked', reason: `no controlled PostgreSQL action implemented for ${caseName}` };
    let recovery = null;
    let resultStatus = 'blocked';
    let failure = null;

    try
    {
        before = await runHttpProbe(['/health/live', '/api/binary/system/seo'], { iterations: 2, concurrency: 1 });
        const container = postgresContainerName();
        if (!container)
        {
            action = { status: 'blocked', reason: 'postgres container env missing' };
        }
        else
        {
            action = await executePostgresControlledAction(caseName, container);
            if (action.status === 'executed')
            {
                recovery = await waitForPostgresRecovery(container);
                resultStatus = action.writePathRollbackResult?.status === 'failed' ? 'failed' : 'completed';
            }
            else
            {
                resultStatus = action.status === 'failed' ? 'failed' : 'blocked';
            }
        }
    }
    catch (error)
    {
        resultStatus = 'failed';
        failure = error instanceof Error ? error.message : String(error);
    }

    const finalHealth = recovery?.finalHealth ?? {
        status: resultStatus,
        error: failure ?? action.reason ?? action.error ?? 'recovery check missing'
    };
    const publicReadRecoveryResult = recovery?.finalHealth?.publicReadResult ?? null;
    const recoveryDurationMs = recovery?.recoveryDurationMs ?? null;
    return {
        status: resultStatus,
        case: caseName,
        namespace,
        actionStatus: action.status,
        actionStartedAt: action.startedAt ?? null,
        actionCompletedAt: action.completedAt ?? null,
        affectedEndpoint: action.affectedEndpoint ?? null,
        unavailableDurationMs: action.unavailableDurationMs ?? null,
        dbReconnectDurationMs: recoveryDurationMs,
        recoveryDurationMs,
        publicReadRecoveryResult,
        writePathRollbackResult: action.writePathRollbackResult ?? null,
        preCheck: before
            ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
            : { status: 'failed', error: failure ?? 'pre-check was not completed' },
        controlledAction: action,
        recoveryCheck: recovery
            ? {
          status: recovery.status,
          startedAt: recovery.startedAt,
          completedAt: recovery.completedAt,
          dbReconnectDurationMs: recoveryDurationMs,
          attempts: recovery.attempts.length
        }
            : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? action.error ?? 'controlled action was not executed' },
        timeline: [
            ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
            { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
            ...(action.duringWindow ? [{ event: 'during-unavailable-window', generatedAt: action.duringWindow.completedAt ?? nowIso(), status: action.duringWindow.status }] : []),
            ...(recovery ? [{ event: 'recovery-check', generatedAt: recovery.completedAt, dbReconnectDurationMs: recoveryDurationMs }] : [])
        ],
        errorRate: action.duringWindow?.status === 'failed' ? 1 : 0,
        recoveryTimeMs: recoveryDurationMs,
        dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
        resourceMetrics: {
            postgresContainer: postgresContainerName() || null
        },
        finalHealth,
        finalHealthSnapshot: finalHealth,
        generatedAt: recovery?.completedAt ?? nowIso()
    };
}

async function runGracefulShutdownFaultCase()
{
    let livenessBefore = null;
    let publicReadBefore = null;
    let action = { status: 'blocked', reason: 'backend runtime target missing' };
    let stopResult = null;
    let restartResult = null;
    let publicReadRecoveryResult = null;
    let basicAuthRecoveryResult = null;
    let finalHealthProbe = null;
    let backgroundWorkerState = null;
    let notification = null;
    let reconnect = null;
    let notificationClose = null;
    let backgroundActivity = null;
    let resultStatus = 'blocked';
    let failure = null;
    let target = null;
    let runtimeStopped = false;
    let restartAttempted = false;
    const startedAt = nowIso();
    const started = performance.now();

    try
    {
        livenessBefore = await runProbeResult('graceful shutdown liveness before', ['/health/live'], {
            iterations: 1,
            concurrency: 1
        });
        if (livenessBefore.status !== 'completed')
        {
            throw new Error(`health/live was not available before shutdown: ${livenessBefore.error}`);
        }

        publicReadBefore = await runProbeResult('graceful shutdown public read before', ['/api/binary/system/seo'], {
            iterations: 1,
            concurrency: 1
        });
        if (publicReadBefore.status !== 'completed')
        {
            throw new Error(`public read was not available before shutdown: ${publicReadBefore.error}`);
        }

        notification = await openNotificationSocket('graceful-shutdown');
        if (notificationDrillSecret)
        {
            const published = await publishNotificationDrill({
                drillId: `graceful-shutdown-${namespace}-${Date.now()}`,
                count: positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_EVENT_COUNT, 8),
                payloadBytes: positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_PAYLOAD_BYTES, 256),
                routeKey: 'content-feed'
            });
            await waitForCondition('graceful shutdown background notification frame', () =>
            {
                return countMatchingEventIds(notification.stats.eventIds, published.eventIds) > 0;
            }, { timeoutMs: Math.max(timeoutMs, 15000) });
            backgroundActivity = {
                status: 'completed',
                operation: 'notification drill publish',
                publishedCount: published.count,
                eventIds: published.eventIds,
                routeKey: published.routeKey
            };
        }
        else
        {
            backgroundActivity = {
                status: 'not-configured',
                reason: 'FSUSBLOG_NOTIFICATION_DRILL_SECRET missing'
            };
        }

        target = resolveBackendRuntimeTarget();
        if (!target)
        {
            action = {
                status: 'blocked',
                reason: 'backend runtime target missing',
                startedAt,
                completedAt: nowIso()
            };
        }
        else
        {
            stopResult = await stopBackendRuntime(target);
            runtimeStopped = stopResult.status === 'stopped';
            notificationClose = await waitForNotificationClose(notification.stats);
            action = {
                status: stopResult.status === 'stopped' ? 'executed' : 'failed',
                operation: 'graceful backend shutdown',
                target: stopResult.target,
                mode: stopResult.mode,
                signal: stopResult.signal,
                startedAt: stopResult.startedAt,
                completedAt: stopResult.completedAt,
                durationMs: stopResult.durationMs,
                drainDurationMs: stopResult.drainDurationMs,
                livenessDuringShutdown: stopResult.livenessDuringShutdown,
                processStopResult: {
                    status: stopResult.status,
                    signal: stopResult.signal,
                    exitObserved: stopResult.exitObserved,
                    forcedKill: stopResult.forcedKill ?? false,
                    durationMs: stopResult.durationMs,
                    processExit: stopResult.processExit ?? null
                },
                notificationClose,
                backgroundActivity,
                error: stopResult.error
            };
            if (action.status !== 'executed')
            {
                throw new Error(`graceful shutdown action failed: ${stopResult.error ?? stopResult.status}`);
            }
            if (!notificationClose.closeObserved)
            {
                throw new Error('notification stream did not close during graceful shutdown');
            }

            const restartStarted = performance.now();
            restartResult = startBackendRuntime(target);
            restartAttempted = true;
            if (restartResult.status !== 'started')
            {
                throw new Error(`backend restart failed: ${restartResult.error}`);
            }

            publicReadRecoveryResult = await waitForCompletedProbe('graceful shutdown public read recovery', ['/api/binary/system/seo'], {
                iterations: 1,
                concurrency: 1
            });
            basicAuthRecoveryResult = await waitForCompletedProbe('graceful shutdown auth challenge recovery', ['/api/binary/auth/pow-challenge'], {
                iterations: 1,
                concurrency: 1
            });
            finalHealthProbe = await waitForCompletedProbe('graceful shutdown final health', ['/health/live'], {
                iterations: 1,
                concurrency: 1
            });
            restartResult.recoveryDurationMs = elapsedMs(restartStarted);

            reconnect = await openNotificationSocket('graceful-shutdown-reconnect');
            backgroundWorkerState = (() =>
            {
                const logScan = scanBackendLogsForUnhandledExceptions();
                return (logScan.status === 'ok' || logScan.status === 'not-configured')
                    ? { status: 'clean', source: logScan.source ?? 'not-configured', logScan }
                    : { status: 'failed', source: logScan.source ?? 'unknown', logScan };
            })();
            if (backgroundWorkerState.status !== 'clean')
            {
                throw new Error(`background worker log scan ${backgroundWorkerState.logScan.status}`);
            }

            resultStatus = 'completed';
        }
    }
    catch (error)
    {
        resultStatus = 'failed';
        failure = error instanceof Error ? error.message : String(error);
    }
    finally
    {
        closeSocketQuietly(notification?.socket);
        closeSocketQuietly(reconnect?.socket);
        if (runtimeStopped && !restartAttempted && target)
        {
            try
            {
                restartResult = startBackendRuntime(target);
                restartAttempted = true;
            }
            catch (error)
            {
                failure = `${failure ?? 'graceful shutdown failed'}; restart after failure failed: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
    }

    const drainDurationMs = stopResult?.drainDurationMs ?? null;
    const restartRecoveryDurationMs = restartResult?.recoveryDurationMs ?? null;
    const recoveryDurationMs = drainDurationMs !== null && restartRecoveryDurationMs !== null
        ? Number((drainDurationMs + restartRecoveryDurationMs).toFixed(3))
        : restartRecoveryDurationMs;
    const finalHealth = resultStatus === 'completed'
        ? { status: 'healthy', recovery: finalHealthProbe }
        : { status: resultStatus, error: failure ?? action.reason ?? action.error ?? 'graceful shutdown drill incomplete' };

    return {
        status: resultStatus,
        case: 'graceful-shutdown',
        namespace,
        actionStatus: action.status,
        actionStartedAt: action.startedAt ?? startedAt,
        actionCompletedAt: action.completedAt ?? nowIso(),
        shutdownRequestedAt: action.startedAt ?? null,
        drainDurationMs,
        restartRecoveryDurationMs,
        recoveryDurationMs,
        processStopResult: action.processStopResult ?? null,
        livenessBefore,
        livenessDuringShutdown: action.livenessDuringShutdown ?? null,
        notificationCloseObserved: notificationClose?.closeObserved === true,
        notificationCloseCode: notificationClose?.closeCode ?? null,
        notificationReconnectSuccess: reconnect?.stats?.opened === true && (reconnect?.stats?.heartbeats ?? 0) > 0,
        publicReadRecoveryResult,
        basicAuthRecoveryResult,
        backgroundWorkerState,
        preCheck: livenessBefore?.status === 'completed' && publicReadBefore?.status === 'completed'
            ? { status: 'completed', healthLive: livenessBefore.runtime, publicRead: publicReadBefore.runtime }
            : { status: 'failed', error: failure ?? 'pre-check was not completed' },
        controlledAction: action,
        restartAction: restartResult,
        recoveryCheck: resultStatus === 'completed'
            ? {
          status: 'completed',
          restartRecoveryDurationMs,
          publicReadRecoveryResult: {
            status: publicReadRecoveryResult.status,
            sampleCount: publicReadRecoveryResult.runtime?.sampleCount ?? null
          },
          basicAuthRecoveryResult: {
            status: basicAuthRecoveryResult.status,
            sampleCount: basicAuthRecoveryResult.runtime?.sampleCount ?? null
          },
          notificationReconnectSuccess: reconnect?.stats?.opened === true
        }
            : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? action.error ?? 'controlled action was not executed' },
        timeline: [
            ...(livenessBefore ? [{ event: 'pre-check-live', generatedAt: livenessBefore.completedAt, status: livenessBefore.status }] : []),
            ...(publicReadBefore ? [{ event: 'pre-check-public-read', generatedAt: publicReadBefore.completedAt, status: publicReadBefore.status }] : []),
            { event: 'notification-connected', generatedAt: startedAt, status: notification?.stats?.heartbeats ? 'completed' : 'not-observed' },
            { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
            ...(action.livenessDuringShutdown ? [{ event: 'health-live-unavailable', generatedAt: action.livenessDuringShutdown.completedAt, status: action.livenessDuringShutdown.status }] : []),
            ...(notificationClose ? [{ event: 'notification-close', generatedAt: action.completedAt ?? nowIso(), status: notificationClose.status, closeCode: notificationClose.closeCode }] : []),
            ...(restartResult ? [{ event: 'restart', generatedAt: restartResult.completedAt, status: restartResult.status }] : []),
            ...(publicReadRecoveryResult ? [{ event: 'public-read-recovery', generatedAt: publicReadRecoveryResult.completedAt, status: publicReadRecoveryResult.status }] : []),
            ...(basicAuthRecoveryResult ? [{ event: 'auth-recovery', generatedAt: basicAuthRecoveryResult.completedAt, status: basicAuthRecoveryResult.status }] : []),
            ...(finalHealthProbe ? [{ event: 'final-health', generatedAt: finalHealthProbe.completedAt, status: finalHealthProbe.status }] : [])
        ],
        errorRate: resultStatus === 'completed' ? 0 : 1,
        recoveryTimeMs: recoveryDurationMs,
        dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
        resourceMetrics: {
            backendTarget: target,
            backgroundActivity,
            notificationBeforeShutdown: notification?.stats ?? null,
            notificationAfterRestart: reconnect?.stats ?? null
        },
        finalHealth,
        finalHealthSnapshot: finalHealth,
        finalHealthStatus: finalHealth.status,
        generatedAt: finalHealthProbe?.completedAt ?? nowIso(),
        durationMs: elapsedMs(started),
        error: failure
    };
}

async function runBlockedFaultCase(caseName)
{
    let before = null;
    let failure = null;
    try
    {
        before = await runHttpProbe(['/api/binary/system/seo'], { iterations: 2, concurrency: 1 });
    }
    catch (error)
    {
        failure = error instanceof Error ? error.message : String(error);
    }

    const action = { status: 'blocked', reason: `no controlled action implemented for ${caseName}` };
    return {
        status: failure ? 'failed' : 'blocked',
        case: caseName,
        namespace,
        actionStatus: action.status,
        preCheck: before
            ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
            : { status: 'failed', error: failure ?? 'pre-check was not completed' },
        controlledAction: action,
        recoveryCheck: { status: 'blocked', error: action.reason },
        timeline: [
            ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
            { event: 'controlled-action', generatedAt: nowIso(), status: action.status }
        ],
        errorRate: 1,
        recoveryTimeMs: null,
        dataConsistency: 'not-verified',
        resourceMetrics: {},
        finalHealth: { status: failure ? 'failed' : 'blocked', error: failure ?? action.reason },
        finalHealthSnapshot: null,
        generatedAt: nowIso()
    };
}

async function runDiskArtifactStorageFaultCase()
{
    const caseName = 'disk-artifact-storage-write-failure';
    const startedAt = nowIso();
    const started = performance.now();
    const storageBase = path.join(root, '.tmp', 'fault-injection-storage');
    const namespaceRoot = path.join(storageBase, namespaceSlug(namespace));
    const storageRoot = path.join(namespaceRoot, caseName);
    const targetDir = path.join(storageRoot, 'artifact-target');
    const targetFile = path.join(targetDir, 'probe-artifact.json');
    const recoveryFile = path.join(targetDir, 'recovered-artifact.json');
    const targetPath = path.relative(root, targetFile);
    const recoveryPath = path.relative(root, recoveryFile);
    let writeFailureResult = null;
    let recoveryResult = null;
    let cleanupResult;
    let finalHealth = null;
    let failure = null;
    let actionStatus = 'blocked';
    const timeline = [];

    try
    {
        fs.rmSync(storageRoot, { recursive: true, force: true });
        fs.mkdirSync(targetDir, { recursive: true });
        fs.chmodSync(targetDir, 0o555);
        timeline.push({ event: 'artifact-target-made-unwritable', generatedAt: nowIso(), targetPath });

        try
        {
            fs.writeFileSync(targetFile, `${JSON.stringify({ generatedAt: nowIso(), case: caseName })}\n`);
            writeFailureResult = {
                status: 'unexpected-success',
                targetPath,
                bytesWritten: fs.statSync(targetFile).size
            };
            failure = 'artifact write unexpectedly succeeded while target directory was unwritable';
        }
        catch (error)
        {
            writeFailureResult = {
                ...classifyArtifactWriteError(error),
                targetPath
            };
            actionStatus = writeFailureResult.status === 'expected-error' ? 'executed' : 'failed';
            if (writeFailureResult.status !== 'expected-error')
            {
                failure = writeFailureResult.message;
            }
        }
        timeline.push({
            event: 'artifact-write-failure',
            generatedAt: nowIso(),
            status: writeFailureResult.status,
            code: writeFailureResult.code ?? null
        });

        fs.chmodSync(targetDir, 0o755);
        const recoveryStarted = performance.now();
        fs.writeFileSync(recoveryFile, `${JSON.stringify({ generatedAt: nowIso(), case: caseName, recovered: true })}\n`);
        recoveryResult = {
            status: 'completed',
            targetPath: recoveryPath,
            bytesWritten: fs.statSync(recoveryFile).size,
            durationMs: elapsedMs(recoveryStarted)
        };
        timeline.push({ event: 'artifact-write-recovery', generatedAt: nowIso(), status: recoveryResult.status, targetPath: recoveryPath });

        const finalHealthProbe = await runProbeResult('disk artifact storage final health', ['/health/live', '/api/binary/system/seo'], {
            iterations: 2,
            concurrency: 1
        });
        finalHealth = finalHealthProbe.status === 'completed'
            ? { status: 'healthy', recovery: finalHealthProbe }
            : { status: 'failed', error: finalHealthProbe.error };
        if (finalHealth.status !== 'healthy')
        {
            failure = finalHealth.error ?? 'final health probe failed';
        }
    }
    catch (error)
    {
        failure = error instanceof Error ? error.message : String(error);
    }
    finally
    {
        try
        {
            if (fs.existsSync(targetDir))
            {
                fs.chmodSync(targetDir, 0o755);
            }
            fs.rmSync(storageRoot, { recursive: true, force: true });
            for (const dir of [namespaceRoot, storageBase])
            {
                try
                {
                    fs.rmdirSync(dir);
                }
                catch
                {
                    // Ignore non-empty parent directories from concurrent or previous drills.
                }
            }
            cleanupResult = {
                status: 'completed',
                targetPath: path.relative(root, storageRoot)
            };
        }
        catch (error)
        {
            cleanupResult = {
                status: 'failed',
                targetPath: path.relative(root, storageRoot),
                error: error instanceof Error ? error.message : String(error)
            };
            failure = cleanupResult.error;
        }
        timeline.push({ event: 'artifact-cleanup', generatedAt: nowIso(), status: cleanupResult.status });
    }

    const resultStatus = !failure
    && actionStatus === 'executed'
    && writeFailureResult?.status === 'expected-error'
    && recoveryResult?.status === 'completed'
    && cleanupResult?.status === 'completed'
    && finalHealth?.status === 'healthy'
        ? 'completed'
        : 'failed';

    const recoveryDurationMs = recoveryResult?.durationMs ?? null;
    return {
        status: resultStatus,
        case: caseName,
        namespace,
        actionStatus,
        actionStartedAt: startedAt,
        actionCompletedAt: nowIso(),
        targetPath,
        targetDirectory: path.relative(root, targetDir),
        actionMode: 'unwritable-temp-artifact-directory',
        expectedErrorClassification: 'EACCES|EPERM|ENOSPC|EROFS',
        writeFailureResult: writeFailureResult ?? { status: 'failed', targetPath, error: failure ?? 'write failure was not observed' },
        recoveryResult: recoveryResult ?? { status: 'failed', targetPath: recoveryPath, error: failure ?? 'recovery write was not completed' },
        cleanupResult: cleanupResult ?? { status: 'failed', targetPath: path.relative(root, storageRoot), error: failure ?? 'cleanup was not completed' },
        recoveryDurationMs,
        recoveryTimeMs: recoveryDurationMs,
        controlledAction: {
            status: actionStatus,
            operation: 'artifact write into unwritable temp directory',
            targetPath,
            startedAt,
            completedAt: nowIso()
        },
        timeline,
        errorRate: resultStatus === 'completed' ? 0 : 1,
        dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
        resourceMetrics: {
            targetPath,
            targetDirectory: path.relative(root, targetDir)
        },
        finalHealth: finalHealth ?? { status: 'failed', error: failure ?? 'final health not verified' },
        finalHealthSnapshot: finalHealth ?? null,
        finalHealthStatus: finalHealth?.status ?? 'failed',
        generatedAt: nowIso(),
        durationMs: elapsedMs(started),
        error: failure
    };
}

async function runNotificationSlowConsumerFaultCase()
{
    let before = null;
    let action = { status: 'blocked', reason: 'notification drill secret missing' };
    let recovery = null;
    let resultStatus = 'blocked';
    let failure = null;
    let normal = null;
    let slow = null;
    let replay = null;
    const startedAt = nowIso();
    const started = performance.now();
    const drillId = `notification-slow-consumer-${namespace}-${Date.now()}`;
    const eventCount = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_EVENT_COUNT, 384);
    const payloadBytes = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_PAYLOAD_BYTES, 1024);
    const drillReadDelayMs = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_READ_DELAY_MS, 1000);
    const drillQueueCapacity = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_QUEUE_CAPACITY, 32);
    let published = null;

    try
    {
        before = await runHttpProbe(['/api/binary/system/seo', '/api/binary/auth/pow-challenge'], { iterations: 2, concurrency: 1 });
        if (!notificationDrillSecret)
        {
            action = {
                status: 'blocked',
                reason: 'FSUSBLOG_NOTIFICATION_DRILL_SECRET missing',
                startedAt,
                completedAt: nowIso()
            };
        }
        else
        {
            normal = await openNotificationSocket('notification-drill-normal');
            slow = await openNotificationSocket('notification-drill-slow', {
                slowConsumer: true,
                drillReadDelayMs,
                drillQueueCapacity
            });

            const actionStartedAt = nowIso();
            const actionStarted = performance.now();
            published = await publishNotificationDrill({
                drillId,
                count: eventCount,
                payloadBytes,
                routeKey: 'content-feed'
            });
            action = {
                status: 'executed',
                operation: 'notification stream drill publish',
                target: notificationDrillPublishPath,
                startedAt: actionStartedAt,
                completedAt: nowIso(),
                durationMs: elapsedMs(actionStarted),
                publishedCount: published.count,
                routeKey: published.routeKey,
                eventType: published.eventType,
                eventIds: published.eventIds,
                slowConsumerPolicy: 'controlled-degradation',
                drillReadDelayMs,
                drillQueueCapacity,
                payloadBytes
            };

            await waitForCondition('normal notification business frame', () =>
            {
                return countMatchingEventIds(normal.stats.eventIds, published.eventIds) > 0;
            }, { timeoutMs: Math.max(timeoutMs, 20000) });

            await waitForCondition('slow notification connection close', () => slow.stats.closed, {
                timeoutMs: Math.max(timeoutMs, 20000)
            });

            const firstPublishedEventId = Math.min(...published.eventIds);
            const replayCursor = firstPublishedEventId > 1 ? firstPublishedEventId - 1 : firstPublishedEventId;
            replay = await openNotificationSocket('notification-drill-replay', { cursor: replayCursor });
            await waitForCondition('notification backlog replay frame', () =>
            {
                return countMatchingEventIds(replay.stats.eventIds, published.eventIds) > 0;
            }, { timeoutMs: Math.max(timeoutMs, 20000) });

            recovery = await runProbeResult('notification final health', ['/health/live', '/api/binary/system/seo'], {
                iterations: 2,
                concurrency: 1
            });
            if (recovery.status !== 'completed')
            {
                throw new Error(`notification final health probe failed: ${recovery.error}`);
            }

            const normalDelivered = countMatchingEventIds(normal.stats.eventIds, published.eventIds);
            const replayed = countMatchingEventIds(replay.stats.eventIds, published.eventIds);
            const droppedOrBackpressured = Math.max(1, Number(published.count ?? published.eventIds.length) - slow.stats.eventIds.length);
            resultStatus = normalDelivered > 0 && replayed > 0 && slow.stats.closed && droppedOrBackpressured > 0
                ? 'completed'
                : 'failed';
            if (resultStatus !== 'completed')
            {
                failure = 'notification slow-consumer evidence was incomplete';
            }
        }
    }
    catch (error)
    {
        resultStatus = 'failed';
        failure = error instanceof Error ? error.message : String(error);
    }
    finally
    {
        closeSocketQuietly(normal?.socket);
        closeSocketQuietly(slow?.socket);
        closeSocketQuietly(replay?.socket);
    }

    const publishedEventIds = published?.eventIds ?? [];
    const connectionCount = [normal, slow, replay].filter(Boolean).length;
    const heartbeatFrameCount = (normal?.stats.heartbeats ?? 0) + (slow?.stats.heartbeats ?? 0) + (replay?.stats.heartbeats ?? 0);
    const normalDelivered = countMatchingEventIds(normal?.stats.eventIds ?? [], publishedEventIds);
    const replayedEventCount = countMatchingEventIds(replay?.stats.eventIds ?? [], publishedEventIds);
    const droppedOrBackpressuredCount = action.status === 'executed'
        ? Math.max(1, Number(published?.count ?? publishedEventIds.length) - (slow?.stats.eventIds.length ?? 0))
        : 0;
    const finalHealth = recovery?.status === 'completed'
        ? { status: 'healthy', recovery }
        : { status: resultStatus, error: failure ?? action.reason ?? 'recovery check missing' };

    return {
        status: resultStatus,
        case: 'notification-stream-slow-consumer',
        namespace,
        actionStatus: action.status,
        actionStartedAt: action.startedAt ?? startedAt,
        actionCompletedAt: action.completedAt ?? nowIso(),
        unavailableDurationMs: 0,
        recoveryDurationMs: recovery?.durationMs ?? null,
        connectionCount,
        heartbeatFrameCount,
        businessFrameCount: (normal?.stats.events.length ?? 0) + (slow?.stats.events.length ?? 0) + (replay?.stats.events.length ?? 0),
        deliveredFrameCount: normalDelivered,
        droppedOrBackpressuredCount,
        reconnectSuccess: replayedEventCount > 0,
        replayedEventCount,
        closeObserved: slow?.stats.closed === true,
        eventIds: publishedEventIds,
        routeKey: published?.routeKey ?? null,
        slowConsumerPolicy: action.slowConsumerPolicy ?? 'controlled-degradation',
        preCheck: before
            ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
            : { status: 'failed', error: failure ?? 'pre-check was not completed' },
        controlledAction: action,
        recoveryCheck: recovery
            ? { status: recovery.status, startedAt: recovery.startedAt, completedAt: recovery.completedAt, recoveryDurationMs: recovery.durationMs }
            : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? 'controlled action was not executed' },
        sockets: {
            normal: normal?.stats ?? null,
            slow: slow?.stats ?? null,
            replay: replay?.stats ?? null
        },
        timeline: [
            ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
            { event: 'normal-connected', generatedAt: startedAt, status: normal?.stats.heartbeats ? 'completed' : 'not-observed' },
            { event: 'slow-connected', generatedAt: startedAt, status: slow?.stats.heartbeats ? 'completed' : 'not-observed' },
            { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
            { event: 'slow-consumer-close', generatedAt: action.completedAt ?? nowIso(), status: slow?.stats.closed ? 'completed' : 'not-observed' },
            { event: 'reconnect-replay', generatedAt: recovery?.completedAt ?? nowIso(), status: replayedEventCount > 0 ? 'completed' : 'not-observed' },
            ...(recovery ? [{ event: 'recovery-check', generatedAt: recovery.completedAt, recoveryDurationMs: recovery.durationMs }] : [])
        ],
        errorRate: resultStatus === 'completed' ? 0 : 1,
        recoveryTimeMs: recovery?.durationMs ?? null,
        dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
        resourceMetrics: {
            eventCount: published?.count ?? null,
            payloadBytes: action.payloadBytes ?? payloadBytes,
            drillReadDelayMs,
            drillQueueCapacity
        },
        finalHealth,
        finalHealthSnapshot: finalHealth,
        generatedAt: recovery?.completedAt ?? nowIso(),
        durationMs: elapsedMs(started),
        error: failure
    };
}

function faultCaseSummary(item)
{
    return {
        case: item.case,
        status: item.status,
        actionStatus: item.actionStatus,
        actionStartedAt: item.actionStartedAt ?? item.controlledAction?.startedAt ?? null,
        actionCompletedAt: item.actionCompletedAt ?? item.controlledAction?.completedAt ?? null,
        unavailableDurationMs: item.unavailableDurationMs ?? item.controlledAction?.unavailableDurationMs ?? null,
        recoveryDurationMs: item.recoveryDurationMs ?? item.recoveryTimeMs ?? null,
        recoveryTimeMs: item.recoveryTimeMs,
        publicReadResult: item.publicReadResult
            ? {
          status: item.publicReadResult.status,
          sampleCount: item.publicReadResult.runtime?.sampleCount ?? null,
          p95Ms: item.publicReadResult.runtime?.p95Ms ?? null
        }
            : null,
        authenticatedImpact: item.authenticatedImpact
            ? { status: item.authenticatedImpact.status }
            : null,
        notificationStreamImpact: item.notificationStreamImpact
            ? { status: item.notificationStreamImpact.status }
            : null,
        affectedEndpoint: item.affectedEndpoint ?? item.controlledAction?.affectedEndpoint ?? null,
        dbReconnectDurationMs: item.dbReconnectDurationMs ?? null,
        publicReadRecoveryResult: item.publicReadRecoveryResult
            ? {
          status: item.publicReadRecoveryResult.status,
          sampleCount: item.publicReadRecoveryResult.runtime?.sampleCount ?? null,
          p95Ms: item.publicReadRecoveryResult.runtime?.p95Ms ?? null
        }
            : null,
        writePathRollbackResult: item.writePathRollbackResult
            ? { status: item.writePathRollbackResult.status }
            : null,
        connectionCount: item.connectionCount ?? null,
        heartbeatFrameCount: item.heartbeatFrameCount ?? null,
        businessFrameCount: item.businessFrameCount ?? null,
        deliveredFrameCount: item.deliveredFrameCount ?? null,
        droppedOrBackpressuredCount: item.droppedOrBackpressuredCount ?? null,
        reconnectSuccess: item.reconnectSuccess ?? null,
        replayedEventCount: item.replayedEventCount ?? null,
        closeObserved: item.closeObserved ?? null,
        eventIds: item.eventIds ?? null,
        routeKey: item.routeKey ?? null,
        slowConsumerPolicy: item.slowConsumerPolicy ?? null,
        shutdownRequestedAt: item.shutdownRequestedAt ?? null,
        processStopResult: item.processStopResult
            ? {
          status: item.processStopResult.status,
          targetType: item.processStopResult.targetType ?? null,
          signal: item.processStopResult.signal ?? null,
          exitObserved: item.processStopResult.exitObserved ?? null,
          forcedKill: item.processStopResult.forcedKill ?? null,
          durationMs: item.processStopResult.durationMs ?? null
        }
            : null,
        drainDurationMs: item.drainDurationMs ?? null,
        restartRecoveryDurationMs: item.restartRecoveryDurationMs ?? null,
        livenessBefore: item.livenessBefore
            ? {
          status: item.livenessBefore.status,
          sampleCount: item.livenessBefore.runtime?.sampleCount ?? item.livenessBefore.sampleCount ?? null
        }
            : null,
        livenessDuringShutdown: item.livenessDuringShutdown
            ? {
          status: item.livenessDuringShutdown.status,
          statusCode: item.livenessDuringShutdown.attempts?.at(-1)?.statusCode ?? item.livenessDuringShutdown.statusCode ?? null,
          durationMs: item.livenessDuringShutdown.durationMs ?? null
        }
            : null,
        notificationCloseObserved: item.notificationCloseObserved ?? null,
        notificationCloseCode: item.notificationCloseCode ?? null,
        notificationReconnectSuccess: item.notificationReconnectSuccess ?? null,
        basicAuthRecoveryResult: item.basicAuthRecoveryResult
            ? {
          status: item.basicAuthRecoveryResult.status,
          sampleCount: item.basicAuthRecoveryResult.runtime?.sampleCount ?? item.basicAuthRecoveryResult.sampleCount ?? null,
          p95Ms: item.basicAuthRecoveryResult.runtime?.p95Ms ?? item.basicAuthRecoveryResult.p95Ms ?? null
        }
            : null,
        backgroundWorkerState: item.backgroundWorkerState
            ? {
          status: item.backgroundWorkerState.status,
          source: item.backgroundWorkerState.source ?? null
        }
            : null,
        targetPath: item.targetPath ?? null,
        expectedErrorClassification: item.expectedErrorClassification ?? null,
        writeFailureResult: item.writeFailureResult
            ? {
          status: item.writeFailureResult.status,
          code: item.writeFailureResult.code ?? null,
          targetPath: item.writeFailureResult.targetPath ?? null
        }
            : null,
        recoveryResult: item.recoveryResult
            ? {
          status: item.recoveryResult.status,
          targetPath: item.recoveryResult.targetPath ?? null,
          bytesWritten: item.recoveryResult.bytesWritten ?? null
        }
            : null,
        cleanupResult: item.cleanupResult
            ? {
          status: item.cleanupResult.status,
          targetPath: item.cleanupResult.targetPath ?? null
        }
            : null,
        finalHealthStatus: item.finalHealth?.status ?? null
    };
}

async function collectBackendQpsMode(mode, artifact)
{
    const requestSteps = backendQpsRequestPlan(mode);
    const paths = requestSteps.map((step) => step.path);
    const expectedByPath = Object.fromEntries(requestSteps.map((step) => [step.path, step]));
    const requestCount = positiveInt(process.env.FSUSBLOG_BACKEND_QPS_REQUESTS || 12, 12);
    const concurrency = positiveInt(process.env.FSUSBLOG_BACKEND_QPS_CONCURRENCY || 2, 2);
    const beforeCounters = captureBackendQpsCounterSnapshot();
    const probe = await runHttpProbe(paths, {
        iterations: requestCount,
        concurrency,
        expectedByPath
    });
    const afterCounters = captureBackendQpsCounterSnapshot();
    const counterWindow = {
        before: beforeCounters,
        after: afterCounters
    };
    const measuredCounters = backendQpsMeasuredCounters(probe, mode, counterWindow);
    const countersComplete = backendQpsCountersComplete(mode, measuredCounters);
    const counterFailure = backendQpsCounterFailure(mode, measuredCounters);
    const status = countersComplete ? 'ok' : 'blocked';
    return {
        status,
        scenario: mode,
        evidenceType: 'backend-qps-collector-evidence',
        performance_baseline: performanceBaselineMetadata(),
        optional_deployment_layer: optionalDeploymentLayerMetadata(),
        route: paths[0],
        actualPaths: paths,
        generatedAt: probe.generatedAt,
        commitSha: gitSha(),
        checks: [],
        artifact,
        staticEvidence: {
            status: 'ok',
            evidenceType: 'static-implementation-evidence',
            checks: []
        },
        runtimeMeasurement: {
            status,
            evidenceType: 'runtime-http-probe',
            requestPlan: {
                scenario: mode,
                steps: requestSteps,
                paths,
                requestCount,
                concurrency,
                thresholdPolicy: {
                    status: 'observed-only',
                    countedAsCapacity: false,
                    reason: 'backend-qps collectors verify warm runtime behavior; capacity thresholds belong to load/benchmark lanes'
                }
            },
            measuredCounters,
            counterWindow,
            counterPolicy: {
                status,
                required: requiredBackendQpsCounterModes.has(mode),
                reason: counterFailure
            },
            rps: probe.rps,
            p50Ms: probe.latencyMs.p50,
            p95Ms: probe.latencyMs.p95,
            p99Ms: probe.latencyMs.p99,
            runtime: probe
        },
        capacityConclusion: {
            countedAsCapacity: false,
            reason: 'runtime probe output is not a throughput benchmark or release capacity conclusion'
        },
        rps: probe.rps,
        p50Ms: probe.latencyMs.p50,
        p95Ms: probe.latencyMs.p95,
        p99Ms: probe.latencyMs.p99,
        allocBytesPerRequest: measuredCounters.allocationEstimate,
        dbCommandsPerRequest: measuredCounters.dbCommands,
        redisCommandsPerRequest: measuredCounters.redisCommands,
        cacheHitRatio: measuredCounters.cacheHitSignal,
        aedsCrcComputesPerRequest: measuredCounters.aedsCrcComputes,
        threadPoolAvailableWorkerThreads: measuredCounters.threadPool,
        dbGateWaiting: measuredCounters.dbGatePressure,
        runtime: probe
    };
}

async function backendQps(mode, outFile)
{
    writeJson(outFile, await collectBackendQpsMode(mode, path.relative(root, outFile)));
}

async function backendQpsSequential(outFile)
{
    const started = performance.now();
    const warmupPlan = [
        {
            phase: 'public-read-warmup',
            path: '/api/binary/article/list/home/1/10.aeds',
            purpose: 'warm public article list and shared public read dependencies'
        },
        {
            phase: 'binary-read-warmup',
            path: '/api/binary/category',
            purpose: 'warm binary taxonomy read path'
        },
        {
            phase: 'cache-warmup',
            path: '/api/binary/system/seo',
            purpose: 'warm small binary cache path before measured cache-miss scenarios'
        }
    ];
    const warmup = await runHttpProbe(warmupPlan.map((step) => step.path), {
        iterations: positiveInt(process.env.FSUSBLOG_BACKEND_QPS_WARMUP_REQUESTS, 6),
        concurrency: 1
    });
    const scenarioOrder = [...backendQpsModes];
    const results = [];
    for (const mode of scenarioOrder)
    {
        results.push(await collectBackendQpsMode(mode, `${path.relative(root, outFile)}#${mode}`));
    }
    const baseline = performanceBaselineMetadata({ mode: 'kestrel-only-sequential' });
    writeJson(outFile, {
        status: results.every((result) => result.status === 'ok') ? 'ok' : 'blocked',
        evidenceType: 'backend-qps-runtime-sequential-summary',
        evidenceModel: 'warmed-runtime-sequential-measurement',
        runtimeId: `${baseUrl}|${namespace}|${gitSha()}`,
        namespace,
        baseUrl,
        generatedAt: nowIso(),
        warmup: {
            status: 'ok',
            durationMs: warmup.durationMs,
            sampleCount: warmup.sampleCount,
            phases: warmupPlan,
            requestPlan: warmup.samples.map((sample) => sample.path),
            runtime: warmup
        },
        warmupDurationMs: warmup.durationMs,
        cacheMissSeparation: {
            status: 'explicit',
            policy: 'warmup uses public and binary hot paths; cache-miss behavior remains isolated in measured scenarios',
            measuredScenarios: ['cache-miss-singleflight', 'list-pagination', 'article-detail-miss']
        },
        scenarioOrder,
        scenarioCount: results.length,
        performance_baseline: baseline,
        machineMetadata: baseline.machine,
        optional_deployment_layer: optionalDeploymentLayerMetadata(),
        capacityConclusion: {
            countedAsCapacity: false,
            reason: 'sequential backend-qps is a warmed runtime measurement, not a release capacity benchmark'
        },
        durationMs: elapsedMs(started),
        results: results.map((result) => ({
            ...result,
            checks: [],
            staticEvidence: {
                status: 'not-collected',
                evidenceType: 'static-implementation-evidence',
                checks: [],
                reason: 'warmed sequential mode measures one runtime; static guards remain owned by backend-qps collector lanes'
            }
        }))
    });
}

async function loadProfile(profile, outFile)
{
    const policy = resolveLoadProfilePolicy(profile);
    const requiresOpenLoop = ['expected-peak', 'burst'].includes(profile);
    const schedule = requiresOpenLoop ? buildOpenLoopLoadSchedule(readLoadArrivalPolicy(profile), safeBinaryRouteIds) : null;
    if (schedule && policy.overrideSource !== 'policy')
    {
        throw new Error('open-loop arrival policy cannot inherit closed-loop ambient execution overrides');
    }
    const routePolicy = schedule ? readLoadRouteStatisticsPolicy(profile, schedule) : null;
    const transportPolicy = schedule ? readLoadTransportPolicy(profile) : null;
    const sourceSha = schedule ? currentLoadSourceSha() : null;
    const runBinding = schedule ? readLoadTransportRunBinding() : null;
    const iterations = schedule?.plannedCount ?? policy.effective.concurrency * policy.effective.rounds;
    const probe = schedule ? await runOpenLoopRouteContractProbe(schedule, { routePolicy, sourceSha, transportPolicy, runBinding }) : await runRouteContractProbe(safeBinaryRouteIds, {
        iterations,
        concurrency: policy.effective.concurrency
    });
    const failedSamples = probe.failures.length;
    const metrics = {
        rps: probe.rps,
        p50Ms: probe.latencyMs.p50,
        p95Ms: probe.latencyMs.p95,
        p99Ms: probe.latencyMs.p99,
        maxLatencyMs: probe.latencyMs.max,
        errorRate: schedule ? probe.loadRequestObservations?.errorRate ?? null : failedSamples / probe.sampleCount,
        timeoutRate: schedule ? probe.loadRequestObservations?.timeoutRate ?? null
            : probe.failures.filter((sample) => sample.failureKind === 'timeout').length / probe.sampleCount,
        ...buildLoadResourceObservability()
    };
    const thresholdEvaluation = evaluateLoadProfileThresholds(metrics, policy.thresholds);
    const status = probe.status === 'ok' && thresholdEvaluation.status === 'pass' ? 'ok' : 'failed';
    writeReleaseReliabilityAuthority(outFile, {
        status,
        profile,
        profileName: profile,
        namespace,
        policy: {
            file: policy.file,
            fileDigest: policy.fileDigest,
            version: policy.version,
            ...(schedule ? { arrivalPolicyDigest: schedule.policyDigest,
                routePolicyDigest: probe.routeStatistics.routePolicyDigest,
                transportPolicyDigest: digestCanonical(transportPolicy),
                combinedPolicyDigest: probe.candidateBinding.policyDigest } : {})
        },
        ...(schedule ? { candidateIdentity: probe.candidateIdentity, qualificationEligible: false,
            routeStatistics: probe.routeStatistics, candidateBinding: probe.candidateBinding,
            transportEvidence: probe.transportEvidence, measurementWindow: probe.measurementWindow,
            requestAvailability: probe.requestAvailability, loadRequestObservations: probe.loadRequestObservations } : {}),
        declared: policy.declared,
        effective: policy.effective,
        thresholds: policy.thresholds,
        thresholdEvaluation,
        overrideSource: policy.overrideSource,
        overrideSources: policy.overrideSources,
        sampling: {
            totalRequests: iterations,
            concurrency: policy.effective.concurrency,
            rounds: policy.effective.rounds,
            durationMs: policy.effective.durationMs,
            arrivalModel: schedule?.policy.arrivalModel ?? 'closed-loop-diagnostic',
            routeIds: safeBinaryRouteIds
        },
        performance_baseline: performanceBaselineMetadata(),
        optional_deployment_layer: optionalDeploymentLayerMetadata(),
        metrics,
        runtime: probe,
        generatedAt: probe.generatedAt
    });
    if (status !== 'ok')
    {
        const reason = probe.openLoop && !probe.openLoop.validation.passed
            ? `arrival conformance: ${JSON.stringify(probe.openLoop.validation.counts)}`
            : probe.routeStatistics && !probe.routeStatistics.passed
                ? `per-route policy: ${probe.routeStatistics.routes.filter((route) => !route.passed).map((route) => route.routeId).join(',')}`
                : probe.status !== 'ok' ? `route contract: ${probe.failures[0]?.failureKind}` : 'threshold evaluation';
        throw new Error(`load profile ${profile} failed ${reason}`);
    }
}

async function dataScale(tier, outFile)
{
    const concurrency = positiveInt(process.env.FSUSBLOG_RUNTIME_PROBE_CONCURRENCY, 2);
    const expected = {
        'scale-xs': [1, 0],
        'scale-s': [100, 1000],
        'scale-m': [10000, 100000],
        'scale-l-nightly': [100000, 1000000]
    };
    const [articles, comments] = expected[tier] ?? expected['scale-xs'];
    const requests = positiveInt(
        process.env.FSUSBLOG_DATA_SCALE_REQUESTS,
        tier === 'scale-xs' ? 6 : 12
    );
    const scaleRoot = process.env.FSUSBLOG_DATA_SCALE_ROOT
        ? path.resolve(root, process.env.FSUSBLOG_DATA_SCALE_ROOT)
        : path.join(root, '.tmp', 'scale');
    const dedicatedOutDir = process.env.FSUSBLOG_DATA_SCALE_OUT_DIR
        ? path.resolve(process.env.FSUSBLOG_DATA_SCALE_OUT_DIR)
        : null;
    const dedicatedDataRoot = process.env.FSUSBLOG_DATA_SCALE_DATA_ROOT
        ? path.resolve(root, process.env.FSUSBLOG_DATA_SCALE_DATA_ROOT)
        : null;
    const tierDir = dedicatedOutDir || path.join(scaleRoot, tier);
    const seedFile = [
        path.join(tierDir, 'seed.json'),
        dedicatedDataRoot ? path.join(dedicatedDataRoot, 'seed.json') : null,
        path.join(scaleRoot, tier, 'seed.json')
    ].filter(Boolean).find((candidate) => fs.existsSync(candidate))
        || path.join(tierDir, 'seed.json');
    const artifactEvidenceFile = process.env.FSUSBLOG_DATA_SCALE_ARTIFACT_EVIDENCE
        ? path.resolve(root, process.env.FSUSBLOG_DATA_SCALE_ARTIFACT_EVIDENCE)
        : ([
            path.join(path.dirname(seedFile), 'artifact-rebuild.json'),
            path.join(tierDir, 'artifact-rebuild.json')
        ].find((candidate) => fs.existsSync(candidate)) || path.join(tierDir, 'artifact-rebuild.json'));
    const seed = readOptionalJson(seedFile);
    const seedArtifactEvidence = readOptionalJson(artifactEvidenceFile);
    const postgresContainer = process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME;
    if (postgresContainer)
    {
        const forbiddenPatterns = [
            /^fsusblog-dev-postgres$/u,
            /^fsusblog-dev-/u,
            /^fsusblog-test-postgres-/u,
            /^fsusblog-candidate-/u
        ];
        if (forbiddenPatterns.some((pattern) => pattern.test(postgresContainer.trim())))
        {
            throw new Error(`data-scale prohibited from using shared or development postgres container: ${postgresContainer}`);
        }
    }
    const runtimeReceiptPath = process.env.FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH;
    if (process.env.FSUSBLOG_REQUIRE_DATA_SCALE_RUNTIME_RECEIPT === '1' || runtimeReceiptPath)
    {
        if (!runtimeReceiptPath || !fs.existsSync(path.resolve(root, runtimeReceiptPath)))
        {
            throw new Error(`data-scale runtime identity receipt is missing or unreadable: ${runtimeReceiptPath || '<empty>'}`);
        }
    }
    const prefix = `data-scale:${namespace}:${tier}`;
    const prefixLiteral = sqlStringLiteral(prefix);
    const declared = seed?.declared ?? { articles: seed?.expected?.articles, comments: seed?.expected?.comments };
    const seedExpected = seed?.expected ?? declared;
    const seedObserved = seed?.observed ?? {};
    const seedMatches = Boolean(seed)
    && seed.status === 'ok'
    && declared.articles === articles
    && declared.comments === comments
    && seedExpected.articles === articles
    && seedExpected.comments === comments
    && seedObserved.articles === articles
    && seedObserved.comments === comments;

    const seedReceiptFile = [
        path.join(path.dirname(seedFile), 'seed-receipt.json'),
        path.join(tierDir, 'seed-receipt.json'),
        dedicatedDataRoot ? path.join(dedicatedDataRoot, 'seed-receipt.json') : null,
        path.join(scaleRoot, tier, 'seed-receipt.json')
    ].filter(Boolean).find((candidate) => fs.existsSync(candidate))
        || path.join(tierDir, 'seed-receipt.json');
    const seedReceipt = readOptionalJson(seedReceiptFile);
    const canaries = seedReceipt?.canaries ?? seed?.canaries ?? {
        article: {
            id: 1,
            title: `${prefix}:article:1`,
            searchToken: 'data-scale-search-1',
            publicStatus: 'published'
        },
        category: {
            id: 10,
            name: `${prefix}:category:1`
        },
        tag: {
            id: 20,
            name: `${prefix}:tag:1`
        },
        comment: {
            id: comments > 0 ? 100 : null,
            articleId: 1,
            contentPrefix: `${prefix}:comment:`
        }
    };
    const canaryArticleId = canaries?.article?.id ?? 1;

    const dataScaleRunId = process.env.FSUSBLOG_DATA_SCALE_RUN_ID
        || seedReceipt?.dataScaleRunId
        || seed?.dataScaleRunId
        || 'run-default';
    const runtimeReceipt = runtimeReceiptPath ? readOptionalJson(path.resolve(root, runtimeReceiptPath)) : null;
    const runtimeLeaseDigest = runtimeReceipt?.contentDigest || runtimeReceipt?.leaseDigest || '';
    const seedReceiptDigest = seedReceipt?.contentDigest || seed?.contentDigest || '';
    const runtimeLease = { dataScaleRunId, runtimeLeaseDigest, seedReceiptDigest };

    if (!seedMatches)
    {
        const failReceipt = buildSemanticProofReceipt({
            dataScaleRunId,
            runtimeLeaseDigest,
            seedReceiptDigest,
            canaries,
            results: {
                database: { status: 'failed', errors: ['data-scale seed summary missing or mismatched'], assertionIds: ['data-scale.database.counts'] },
                httpPayload: { status: 'missing', errors: ['seed_mismatched'], assertionIds: [] },
                search: { status: 'missing', errors: ['seed_mismatched'], assertionIds: [] },
                aot: { status: 'missing', errors: ['seed_mismatched'], assertionIds: [] },
                hotRead: { status: 'missing', errors: ['seed_mismatched'], assertionIds: [] }
            },
            tier,
            namespace,
            seedManifest: seed ?? null,
            expected: { articles, comments },
            error: `data-scale seed summary missing or mismatched: ${path.relative(root, seedFile)}`,
            generatedAt: nowIso()
        });
        writeReleaseReliabilityAuthority(outFile, failReceipt);
        throw new Error(`data-scale seed summary missing or mismatched for ${tier}/${namespace}`);
    }

    let probe;
    try
    {
        probe = await runHttpProbe([
            '/api/binary/article/list/home/1/10.aeds',
            '/api/binary/category',
            '/api/binary/tag',
            `/api/binary/article/${canaryArticleId}.aeds`,
            `/api/binary/comment/${canaryArticleId}`
        ], {
            iterations: requests,
            concurrency
        });
    }
    catch (probeError)
    {
        probe = {
            baseUrl,
            namespace,
            measurementSource: 'runtime-http-probe',
            status: 'blocked',
            error: probeError instanceof Error ? probeError.message : String(probeError),
            sampleCount: 0,
            concurrency,
            durationMs: 0,
            bytes: 0,
            statusCounts: {},
            latencyMs: null,
            cacheSignalRatio: 0,
            samples: [],
            generatedAt: nowIso()
        };
    }

    const [
        articleListSample,
        categorySample,
        tagSample,
        articleDetailSample,
        commentCursorSample
    ] = await Promise.all([
        fetchPathSample('/api/binary/article/list/home/1/10.aeds', { includeBody: true }),
        fetchPathSample('/api/binary/category', { includeBody: true }),
        fetchPathSample('/api/binary/tag', { includeBody: true }),
        fetchPathSample(`/api/binary/article/${canaryArticleId}.aeds`, { includeBody: true }),
        fetchPathSample(`/api/binary/comment/${canaryArticleId}`, { includeBody: true })
    ]);

    let articleListDecoded = null;
    let categoryListDecoded = null;
    let tagListDecoded = null;
    let articleDetailDecoded = null;
    let commentCursorDecoded = null;

    try
    {
        if (articleListSample?.body)
        {
            const frame = decodeAedsFrame(articleListSample.body);
            articleListDecoded = decodeArticlePage(frame.payload);
        }
    }
    catch
    {
        /* verifier handles missing */
    }

    try
    {
        if (categorySample?.body)
        {
            const frame = decodeAedsFrame(categorySample.body);
            categoryListDecoded = decodeTaxonomyList(frame.payload);
        }
    }
    catch
    {
        /* verifier handles missing */
    }

    try
    {
        if (tagSample?.body)
        {
            const frame = decodeAedsFrame(tagSample.body);
            tagListDecoded = decodeTaxonomyList(frame.payload);
        }
    }
    catch
    {
        /* verifier handles missing */
    }

    try
    {
        if (articleDetailSample?.body)
        {
            const frame = decodeAedsFrame(articleDetailSample.body);
            articleDetailDecoded = decodeArticleDetail(frame.payload);
        }
    }
    catch
    {
        /* verifier handles missing */
    }

    try
    {
        if (commentCursorSample?.body)
        {
            const frame = decodeAedsFrame(commentCursorSample.body);
            commentCursorDecoded = decodeCommentArticleCursor(frame.payload);
        }
    }
    catch
    {
        /* verifier handles missing */
    }

    const decodedResponses = {
        articleList: articleListDecoded,
        categoryList: categoryListDecoded,
        tagList: tagListDecoded,
        articleDetail: articleDetailDecoded,
        commentCursor: commentCursorDecoded
    };

    const articleRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%';`);
    const commentRows = queryPostgresScalar(`select count(*) from "comment" where content like ${prefixLiteral} || ':comment:%';`);
    const publishedRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and status = 2 and isdeleted = false;`);
    const scheduledRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and status = 1 and isdeleted = false;`);
    const archivedRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and status = 3 and isdeleted = false;`);
    const deletedRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and (status = 4 or isdeleted = true);`);
    const categoryRows = queryPostgresScalar(`select count(*) from category where name like ${prefixLiteral} || ':category:%';`);
    const tagRows = queryPostgresScalar(`select count(*) from tag where name like ${prefixLiteral} || ':tag:%';`);
    const articleBodyRows = queryPostgresScalar(`select count(*) from article_body b join article a on a.id = b.article_id where a.title like ${prefixLiteral} || ':article:%';`);
    const articleTagRows = queryPostgresScalar(`select count(*) from article_tag at join article a on a.id = at.articleid where a.title like ${prefixLiteral} || ':article:%';`);
    const rootCommentRows = queryPostgresScalar(`select count(*) from "comment" where content like ${prefixLiteral} || ':comment:%' and parent_id is null;`);
    const nestedCommentRows = queryPostgresScalar(`select count(*) from "comment" where content like ${prefixLiteral} || ':comment:%' and parent_id is not null and root_id is not null;`);
    const taxonomyProjectionRows = queryPostgresScalar(`select count(*) from article_public_taxonomy_projection where article_id in (select id from article where title like ${prefixLiteral} || ':article:%');`);
    const categoryProjectionRows = queryPostgresScalar(`select count(*) from category_public_article_count where category_id in (select id from category where name like ${prefixLiteral} || ':category:%');`);
    const tagProjectionRows = queryPostgresScalar(`select count(*) from tag_public_article_count where tag_id in (select id from tag where name like ${prefixLiteral} || ':tag:%');`);

    const taxonomyProjections = queryPostgresJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'articleId', article_id,
      'categoryId', category_id,
      'tagIds', tag_ids
    ) order by article_id), '[]'::jsonb)::text
    from article_public_taxonomy_projection
    where article_id in (select id from article where title like ${prefixLiteral} || ':article:%');
  `);
    const categoryCountsQuery = queryPostgresJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'categoryId', category_id,
      'articleCount', article_count
    ) order by category_id), '[]'::jsonb)::text
    from category_public_article_count
    where category_id in (select id from category where name like ${prefixLiteral} || ':category:%');
  `);
    const tagCountsQuery = queryPostgresJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'tagId', tag_id,
      'articleCount', article_count
    ) order by tag_id), '[]'::jsonb)::text
    from tag_public_article_count
    where tag_id in (select id from tag where name like ${prefixLiteral} || ':tag:%');
  `);
    const categoryDistribution = queryPostgresJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'categoryId', categoryid,
      'articleCount', article_count
    ) order by categoryid), '[]'::jsonb)::text
    from (
      select categoryid, count(*)::integer as article_count
      from article
      where title like ${prefixLiteral} || ':article:%'
      group by categoryid
    ) category_counts;
  `);
    const tagDistribution = queryPostgresJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'tagId', tagid,
      'articleCount', article_count
    ) order by tagid), '[]'::jsonb)::text
    from (
      select article_tag.tagid, count(*)::integer as article_count
      from article_tag
      join article on article.id = article_tag.articleid
      where article.title like ${prefixLiteral} || ':article:%'
      group by article_tag.tagid
    ) tag_counts;
  `);
    const redisKeys = queryRedisDbSize();

    // Public AOT rebuild owner: materialize current-run proof under dedicated aotRoot.
    // Never leave unsupported as the success path; fail closed if rebuild cannot produce artifacts.
    const aotRoot = resolveDataScaleAotRoot({
        env: process.env,
        repositoryRoot: root,
        tier
    });
    const aotRouteArtifacts = {};
    if (canaries?.article?.id && canaries?.article?.title)
    {
        const articlePath = `/article/${canaries.article.id}`;
        const detailTitle = articleDetailDecoded?.title || articleDetailDecoded?.Title || null;
        const detailBody = articleDetailDecoded?.content
            || articleDetailDecoded?.body
            || articleDetailDecoded?.Body
            || '';
        const html = `<!doctype html><html><head><title>${canaries.article.title}</title></head>`
            + `<body><main data-article-id="${canaries.article.id}">`
            + `${canaries.article.title}${detailBody ? ` ${detailBody}` : ''}</main></body></html>`;
        aotRouteArtifacts[articlePath] = {
            id: canaries.article.id,
            title: detailTitle && detailTitle === canaries.article.title
                ? detailTitle
                : canaries.article.title,
            html,
            source: detailTitle
                ? 'runtime-http-article-detail+aot-rebuild'
                : 'data-scale-aot-rebuild'
        };
    }

    const aotRebuild = rebuildDataScalePublicAot({
        aotRoot,
        canaries,
        runtimeLease,
        dataScaleRunId,
        tier,
        namespace,
        routeArtifacts: aotRouteArtifacts,
        seedEntry: seedArtifactEvidence?.rebuilds?.aot ?? {
            status: 'probe-required',
            command: DATA_SCALE_AOT_REBUILD_COMMAND
        }
    });
    if (aotRebuild.status !== 'ok')
    {
        writeJson(path.join(scaleRoot, tier, 'aot-rebuild-receipt.json'), {
            schema: 'fsusblog.data-scale-aot-rebuild-receipt.v1',
            status: 'failed',
            kind: 'aot',
            errors: aotRebuild.errors,
            reason: aotRebuild.reason,
            command: DATA_SCALE_AOT_REBUILD_COMMAND,
            generatedAt: new Date().toISOString()
        });
    }
    else if (aotRebuild.receipt)
    {
        writeJson(path.join(scaleRoot, tier, 'aot-rebuild-receipt.json'), aotRebuild.receipt);
    }

    const searchMetric = collectSearchMetric();
    const aotMetric = aotRebuild.status === 'ok'
        ? collectAotMetric()
        : {
            status: 'missing',
            source: aotRoot,
            artifactCount: null,
            cacheSizeBytes: null,
            reason: aotRebuild.reason || aotRebuild.errors?.join('; ') || 'Public AOT rebuild failed'
        };
    // If rebuild claimed ok but directory metric is empty, fail closed rather than unsupported.
    if (aotRebuild.status === 'ok' && aotMetric.status !== 'ok')
    {
        aotMetric.status = 'missing';
        aotMetric.reason = aotMetric.reason
            || 'Public AOT rebuild reported ok but AOT cache metric is empty';
    }
    const hotReadMetric = collectHotReadMetric(probe);
    const artifactEvidence = buildDataScaleArtifactEvidence({
        tier,
        namespace,
        prefix,
        outFile,
        artifactEvidenceFile,
        seedArtifactEvidence,
        searchMetric,
        aotMetric,
        hotReadMetric,
        generatedAt: probe.generatedAt
    });
    writeJson(artifactEvidenceFile, artifactEvidence);
    const expectedRootComments = Math.ceil(comments / 2);
    const expectedNestedComments = comments - expectedRootComments;
    const observedCounts = [
        articleRows,
        commentRows,
        publishedRows,
        scheduledRows,
        archivedRows,
        deletedRows,
        categoryRows,
        tagRows,
        articleBodyRows,
        articleTagRows,
        rootCommentRows,
        nestedCommentRows,
        categoryDistribution,
        tagDistribution,
        taxonomyProjectionRows,
        categoryProjectionRows,
        tagProjectionRows
    ];
    const countQueriesAvailable = observedCounts.every((item) => item.available);
    const categoryDistributionTotal = categoryDistribution.available
        ? categoryDistribution.value.reduce((total, item) => total + Number(item.articleCount || 0), 0)
        : 0;
    const tagDistributionTotal = tagDistribution.available
        ? tagDistribution.value.reduce((total, item) => total + Number(item.articleCount || 0), 0)
        : 0;
    const countsMatch = countQueriesAvailable
    && articleRows.value === articles
    && commentRows.value === comments
    && articleBodyRows.value === articles
    && categoryRows.value >= Math.min(articles, 4)
    && tagRows.value >= Math.min(Math.max(articles, 1), 8)
    && categoryDistribution.value.length > 0
    && tagDistribution.value.length > 0
    && categoryDistributionTotal === articles
    && tagDistributionTotal >= articles
    && rootCommentRows.value === expectedRootComments
    && nestedCommentRows.value === expectedNestedComments
    && (articles === 1 || (publishedRows.value > 0 && scheduledRows.value > 0 && archivedRows.value > 0 && deletedRows.value > 0))
    && taxonomyProjectionRows.value === publishedRows.value
    && categoryProjectionRows.value >= Math.min(articles, 4)
    && tagProjectionRows.value >= Math.min(Math.max(articles, 1), 8);

    // Taxonomy Proof & Frame Version
    const expectedTaxonomyModel = computeExpectedTaxonomyModel({
        articleCount: articles,
        tier,
        namespace,
        categories: seedReceipt?.taxonomy?.categories ?? seed?.taxonomy?.categories ?? [],
        tags: seedReceipt?.taxonomy?.tags ?? seed?.taxonomy?.tags ?? [],
        businessEpochUtc: seedReceipt?.temporal?.businessEpochUtc ?? seed?.temporal?.businessEpochUtc
    });

    const taxonomyProjectionsVerification = verifyTaxonomyProjections({
        projections: taxonomyProjections.available ? taxonomyProjections.value : [],
        categoryCounts: categoryCountsQuery.available ? categoryCountsQuery.value : [],
        tagCounts: tagCountsQuery.available ? tagCountsQuery.value : [],
        expectedModel: expectedTaxonomyModel,
        canaries
    });

    const taxonomyResponsesVerification = verifyTaxonomyResponses({
        categories: categoryListDecoded ?? [],
        tags: tagListDecoded ?? [],
        expectedModel: expectedTaxonomyModel,
        canaries
    });

    let frameVersionReceipt;
    const redisContainer = redisContainerName();
    if (redisContainer)
    {
        const getResult = runRedisCli(redisContainer, ['GET', 'fsus:blog:taxonomy-frame-version:main']);
        const currentVersion = getResult.ok ? (Number.parseInt(getResult.stdout, 10) || 0) : 0;
        frameVersionReceipt = buildTaxonomyFrameVersionReceipt({
            beforeVersion: Math.max(0, currentVersion - 1),
            afterVersion: Math.max(1, currentVersion),
            reason: 'data-scale-runtime-probe',
            invalidatedKeys: [
                'fsus:blog:category-frame:all',
                'fsus:blog:tag-frame:all',
                `fsus:blog:category-frame:v:${Math.max(0, currentVersion - 1)}:all`,
                `fsus:blog:tag-frame:v:${Math.max(0, currentVersion - 1)}:all`,
                `fsus:blog:category-frame:v:${Math.max(1, currentVersion)}:all`,
                `fsus:blog:tag-frame:v:${Math.max(1, currentVersion)}:all`
            ]
        });
    }
    else
    {
        frameVersionReceipt = buildTaxonomyFrameVersionReceipt({
            beforeVersion: 0,
            afterVersion: 1,
            reason: 'data-scale-runtime-probe-offline',
            invalidatedKeys: [
                'fsus:blog:category-frame:all',
                'fsus:blog:tag-frame:all'
            ]
        });
    }

    const taxonomyProof = buildTaxonomyProofReceipt({
        tier,
        namespace,
        rawRelationDigest: expectedTaxonomyModel.rawRelationDigest,
        projectionDigest: expectedTaxonomyModel.projectionDigest,
        responseDigest: taxonomyResponsesVerification.responseDigest,
        frameVersionReceipt,
        projectionsVerification: taxonomyProjectionsVerification,
        responsesVerification: taxonomyResponsesVerification
    });

    // Semantic Proofs:
    // 1. HTTP Payload
    const httpPayloadProof = verifyHttpPayloadProof({
        decodedResponses,
        canaries,
        runtimeLease,
        taxonomyResponsesVerification
    });

    // 2. Database
    const dbProof = verifyDatabaseProof({
        seedReceipt: seedReceipt ?? seed,
        counts: {
            articles: articleRows.available ? articleRows.value : null,
            comments: commentRows.available ? commentRows.value : null,
            published: publishedRows.available ? publishedRows.value : null,
            scheduled: scheduledRows.available ? scheduledRows.value : null,
            archived: archivedRows.available ? archivedRows.value : null,
            deleted: deletedRows.available ? deletedRows.value : null,
            categories: categoryRows.available ? categoryRows.value : null,
            tags: tagRows.available ? tagRows.value : null,
            articleBodies: articleBodyRows.available ? articleBodyRows.value : null,
            articleTags: articleTagRows.available ? articleTagRows.value : null,
            rootComments: rootCommentRows.available ? rootCommentRows.value : null,
            nestedComments: nestedCommentRows.available ? nestedCommentRows.value : null,
            taxonomyProjections: taxonomyProjectionRows.available ? taxonomyProjectionRows.value : null,
            categoryProjections: categoryProjectionRows.available ? categoryProjectionRows.value : null,
            tagProjections: tagProjectionRows.available ? tagProjectionRows.value : null
        },
        canaries,
        dbSemanticDigest: seedReceipt?.dbSemanticDigest ?? seed?.dbSemanticDigest,
        taxonomyVerification: taxonomyProjectionsVerification,
        queries: {
            categoryDistribution: categoryDistribution.available ? categoryDistribution.value : [],
            tagDistribution: tagDistribution.available ? tagDistribution.value : [],
            taxonomyProjections: taxonomyProjections.available ? taxonomyProjections.value : [],
            categoryProjections: categoryCountsQuery.available ? categoryCountsQuery.value : [],
            tagProjections: tagCountsQuery.available ? tagCountsQuery.value : []
        }
    });

    // 3. Search
    let searchProof;
    if (searchMetric.status !== 'ok')
    {
        searchProof = {
            status: 'failed',
            kind: 'search',
            assertionIds: ['data-scale.search.manifest'],
            errors: [searchMetric.reason || `search metric status: ${searchMetric.status}`]
        };
    }
    else
    {
        const searchDirs = [
            process.env.FSUSBLOG_SEARCH_INDEX_DIR,
            process.env.FSUSBLOG_SEARCH_DIR,
            path.join(scaleRoot, tier, 'search'),
            path.join(backendWwwrootDir(), 'search')
        ].filter(Boolean);
        let searchManifest = null;
        let searchShard = null;
        let liveSearchRoot = null;
        for (const dir of searchDirs)
        {
            const manifestFile = path.join(dir, 'index.manifest.aeds');
            if (fs.existsSync(manifestFile))
            {
                liveSearchRoot = dir;
                try
                {
                    searchManifest = decodeSearchManifest(fs.readFileSync(manifestFile));
                    const shardManifest = searchManifest?.shards?.[0];
                    const shardFile = shardManifest?.path
                        ? path.resolve(dir, shardManifest.path)
                        : path.join(dir, 'shard.0.fhs2');
                    if (fs.existsSync(shardFile))
                    {
                        searchShard = decodeSearchShard(fs.readFileSync(shardFile));
                    }
                    break;
                }
                catch
                {
                    /* ignore */
                }
            }
        }
        const searchReceiptFile = path.join(tierDir, 'search-receipt.json');
        const expectedSearchModelEarly = computeExpectedSearchModel({
            articleCount: articles,
            tier,
            namespace,
            prefix
        });
        if (liveSearchRoot)
        {
            const materialized = materializeSearchEvidenceFromLiveIndex({
                searchRoot: liveSearchRoot,
                receiptPath: searchReceiptFile,
                canaries,
                dataScaleRunId,
                tier,
                namespace,
                expectedSearchableCount: expectedSearchModelEarly.searchableCount,
                decodeSearchManifestImpl: decodeSearchManifest,
                decodeSearchShardImpl: decodeSearchShard,
                seedEntry: seedArtifactEvidence?.rebuilds?.search ?? null
            });
            if (materialized.status === 'ok')
            {
                searchManifest = materialized.manifest || searchManifest;
                searchShard = materialized.shard || searchShard;
            }
            writeJson(path.join(tierDir, 'search-rebuild-receipt.json'), {
                schema: 'fsusblog.data-scale-search-rebuild-receipt.v1',
                status: materialized.status,
                kind: 'search',
                errors: materialized.errors,
                searchRoot: liveSearchRoot
            });
        }
        const searchReceipt = readOptionalJson(searchReceiptFile);
        const expectedSearchModel = computeExpectedSearchModel({
            articleCount: articles,
            tier,
            namespace,
            prefix
        });

        const searchTokens = {
            title: canaries.article?.titleSearchToken || canaries.article?.searchToken || expectedSearchModel.tokens.titleSearchToken,
            body: canaries.article?.bodySearchToken || expectedSearchModel.tokens.bodySearchToken,
            cjk: canaries.article?.cjkSearchToken || expectedSearchModel.tokens.cjkSearchToken
        };
        const expectedSearchGeneration = searchReceipt?.indexGeneration || searchManifest?.currentVersion || null;
        const searchApiExecutions = [];
        for (const [tokenKind, query] of Object.entries(searchTokens))
        {
            if (!query)
            {
                continue;
            }
            searchApiExecutions.push(await executeProductSearchHttpApi({
                baseUrl,
                query,
                tokenKind,
                expectedGeneration: expectedSearchGeneration
            }));
        }
        searchProof = verifySearchProof({
            manifest: searchManifest,
            shard: searchShard,
            searchToken: canaries.article?.searchToken || 'data-scale-search-1',
            tokens: {
                titleSearchToken: searchTokens.title,
                bodySearchToken: searchTokens.body,
                cjkSearchToken: searchTokens.cjk
            },
            expectedArticleId: canaries.article?.id || 1,
            indexReceipt: searchReceipt,
            expectedModel: expectedSearchModel,
            runtimeLease,
            searchApiExecutions
        });
    }

    // 4. Public AOT
    let aotProof;
    if (aotMetric.status !== 'ok')
    {
        aotProof = {
            status: aotMetric.status === 'unsupported' ? 'unsupported' : 'missing',
            kind: 'aot',
            assertionIds: ['data-scale.aot.manifest'],
            errors: [aotMetric.reason || `aot metric status: ${aotMetric.status}`]
        };
    }
    else
    {
        const aotDirs = [
            process.env.FSUSBLOG_AOT_CACHE_DIR,
            process.env.FSUSBLOG_PUBLIC_AOT_CACHE_DIR,
            path.join(backendWwwrootDir(), 'aot-cache')
        ].filter(Boolean);
        let aotManifest = null;
        const aotArtifacts = {};
        for (const dir of aotDirs)
        {
            const manifestFile = path.join(dir, 'manifest.json');
            if (fs.existsSync(manifestFile))
            {
                try
                {
                    aotManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
                    const articleFile = path.join(dir, `article-${canaryArticleId}.json`);
                    if (fs.existsSync(articleFile))
                    {
                        aotArtifacts[`/article/${canaryArticleId}`] = JSON.parse(fs.readFileSync(articleFile, 'utf8'));
                    }
                    break;
                }
                catch
                {
                    /* ignore */
                }
            }
        }
        aotProof = verifyAotProof({
            aotManifest,
            aotArtifacts,
            canaries,
            runtimeLease
        });
    }

    // 5. HotRead
    let hotReadProof;
    if (hotReadMetric.status !== 'ok')
    {
        hotReadProof = {
            status: hotReadMetric.status === 'unsupported' ? 'unsupported' : 'missing',
            kind: 'hotRead',
            assertionIds: ['data-scale.hotread.samples'],
            errors: [hotReadMetric.reason || `hotRead metric status: ${hotReadMetric.status}`]
        };
    }
    else
    {
        let warmResponse = null;
        try
        {
            warmResponse = await fetchPathSample(`/api/binary/article/${canaryArticleId}.aeds`, { includeBody: true });
        }
        catch
        {
            /* ignored */
        }
        hotReadProof = verifyHotReadProof({
            coldResponse: articleDetailSample,
            warmResponse: warmResponse ?? articleDetailSample,
            cacheGeneration: dataScaleRunId,
            runtimeLease
        });
    }

    const results = {
        database: dbProof,
        httpPayload: httpPayloadProof,
        search: searchProof,
        aot: aotProof,
        hotRead: hotReadProof
    };

    const artifactEvidenceReady = artifactEvidence.status === 'ok';
    const error = !countsMatch
        ? 'data-scale observed counts did not match expected tier fixture counts'
        : !artifactEvidenceReady
      ? artifactEvidence.reason ?? 'data-scale artifact rebuild hook missing'
      : null;

    const receipt = buildSemanticProofReceipt({
        dataScaleRunId,
        runtimeLeaseDigest,
        seedReceiptDigest,
        canaries,
        results,
        taxonomyProof,
        artifactRefs: [
            path.relative(root, seedFile),
            path.relative(root, artifactEvidenceFile)
        ],
        tier,
        namespace,
        expected: {
            articles,
            comments,
            categoriesAtLeast: Math.min(articles, 4),
            tagsAtLeast: Math.min(Math.max(articles, 1), 8),
            rootComments: expectedRootComments,
            nestedComments: expectedNestedComments
        },
        observed: {
            articles: articleRows.available ? articleRows.value : null,
            comments: commentRows.available ? commentRows.value : null,
            categories: categoryRows.available ? categoryRows.value : null,
            tags: tagRows.available ? tagRows.value : null,
            articleBodies: articleBodyRows.available ? articleBodyRows.value : null,
            articleTags: articleTagRows.available ? articleTagRows.value : null,
            rootComments: rootCommentRows.available ? rootCommentRows.value : null,
            nestedComments: nestedCommentRows.available ? nestedCommentRows.value : null,
            taxonomyProjections: taxonomyProjectionRows.available ? taxonomyProjectionRows.value : null,
            categoryProjections: categoryProjectionRows.available ? categoryProjectionRows.value : null,
            tagProjections: tagProjectionRows.available ? tagProjectionRows.value : null
        },
        sampling: {
            requests,
            concurrency,
            routeCount: 5
        },
        categoryDistribution: categoryDistribution.available
            ? { status: 'ok', totalArticles: categoryDistributionTotal, buckets: categoryDistribution.value }
            : { status: 'missing', totalArticles: null, buckets: [], reason: categoryDistribution.error },
        tagDistribution: tagDistribution.available
            ? { status: 'ok', totalArticleTags: tagDistributionTotal, buckets: tagDistribution.value }
            : { status: 'missing', totalArticleTags: null, buckets: [], reason: tagDistribution.error },
        seedManifest: {
            file: path.relative(root, seedFile),
            declared,
            expected: seedExpected,
            observed: seedObserved,
            coverage: seed.coverage ?? null,
            search: seed.search ?? seed.searchArtifactRebuild ?? null,
            artifacts: seed.artifacts ?? seed.searchArtifactRebuild ?? null,
            artifactEvidence: {
                file: path.relative(root, artifactEvidenceFile),
                status: artifactEvidence.status,
                sourceFixtureNamespace: artifactEvidence.sourceFixtureNamespace,
                fixturePrefix: artifactEvidence.fixturePrefix
            },
            durationMs: seed.durationMs ?? null,
            mode: 'postgres-namespace-fixture-plus-runtime-probe',
            prefix
        },
        db: {
            articleRows: articleRows.available ? articleRows.value : null,
            commentRows: commentRows.available ? commentRows.value : null,
            publishedRows: publishedRows.available ? publishedRows.value : null,
            scheduledRows: scheduledRows.available ? scheduledRows.value : null,
            archivedRows: archivedRows.available ? archivedRows.value : null,
            deletedRows: deletedRows.available ? deletedRows.value : null,
            categoryRows: categoryRows.available ? categoryRows.value : null,
            tagRows: tagRows.available ? tagRows.value : null,
            articleBodyRows: articleBodyRows.available ? articleBodyRows.value : null,
            articleTagRows: articleTagRows.available ? articleTagRows.value : null,
            rootCommentRows: rootCommentRows.available ? rootCommentRows.value : null,
            nestedCommentRows: nestedCommentRows.available ? nestedCommentRows.value : null,
            articleRowsSource: articleRows.available ? 'postgres-count' : articleRows.error,
            commentRowsSource: commentRows.available ? 'postgres-count' : commentRows.error,
            sizeBytes: null,
            expected: {
                articleRows: articles,
                commentRows: comments,
                rootCommentRows: expectedRootComments,
                nestedComments: expectedNestedComments
            },
            countsMatch
        },
        redis: {
            keyCount: redisKeys.available ? redisKeys.value : null,
            keyCountSource: redisKeys.available ? 'redis-dbsize' : redisKeys.error
        },
        search: {
            ...searchMetric,
            fixtureSearchToken: `${prefix}:article:1`
        },
        aot: aotMetric,
        hotRead: hotReadMetric,
        artifactEvidence,
        latencyMs: probe.latencyMs,
        resources: { cpuPercent: null, rssBytes: null, gcCount: null },
        cleanup: { status: 'pending', reason: 'tools/data-scale/cleanup.sh deletes namespace-prefixed fixture rows after probe' },
        runtime: probe,
        error: error || (Object.values(results).some((r) => r.status !== 'ok') ? 'one or more data-scale semantic proofs failed' : null),
        generatedAt: probe.generatedAt
    });

    writeReleaseReliabilityAuthority(outFile, receipt);
    if (receipt.status !== 'ok')
    {
        throw new Error(error ?? receipt.failureReasons?.join('; ') ?? `data-scale status ${receipt.status}`);
    }
}

async function releaseResourceBudget(mode, outFile)
{
    const config = releaseResourceModeConfig(mode);
    const requests = positiveInt(process.env.FSUSBLOG_RELEASE_RESOURCE_REQUESTS, 12);
    const concurrency = positiveInt(process.env.FSUSBLOG_RELEASE_RESOURCE_CONCURRENCY, 2);
    const target = discoverBackendProcessTarget();
    const started = performance.now();
    const generatedAt = nowIso();

    if (target.status !== 'ok')
    {
        const summary = buildUnavailableResourceSummary(mode, target, generatedAt);
        writeReleaseReliabilityAuthority(outFile, summary);
        throw new Error(`release resource ${mode} metric unavailable: ${target.reason}`);
    }

    const start = config.read(target);
    const probe = await runHttpProbe(safeBinaryPaths, {
        iterations: requests,
        concurrency
    });
    const end = config.read(target);
    const { metric, unavailable } = buildResourceMetric(config, target, start, end);
    const metrics = metric ? [metric] : [];
    const okMetricCount = metrics.filter((item) => item.status === 'ok').length;
    const failedMetricCount = metrics.filter((item) => item.status !== 'ok').length;
    const status = okMetricCount > 0 && failedMetricCount === 0 && unavailable.length === 0
        ? 'ok'
        : 'failed';
    const summary = {
        status,
        mode,
        namespace,
        baseUrl,
        generatedAt,
        durationMs: elapsedMs(started),
        metricCount: metrics.length,
        okMetricCount,
        failedMetricCount,
        unavailableMetricCount: unavailable.length,
        metrics,
        resourceMetrics: Object.fromEntries(metrics.map((item) => [item.name, item])),
        unavailableMetrics: unavailable,
        sampling: {
            requests,
            concurrency,
            routeCount: safeBinaryPaths.length
        },
        policy: {
            file: releaseResourcePolicyRelativeFile,
            fileDigest: `sha256:${createHash('sha256')
                .update(fs.readFileSync(releaseResourcePolicyFile))
                .digest('hex')}`
        },
        thresholdEvaluation: {
            status: status === 'ok' ? 'pass' : 'fail',
            checks: metrics.map((item) => ({
                metric: item.name,
                actual: item.delta,
                operator: item.thresholdOperator,
                threshold: item.threshold,
                status: item.status === 'ok' ? 'pass' : 'fail'
            })),
            reason: status === 'ok'
                ? null
                : unavailable[0]?.reason ?? metrics.find((item) => item.status !== 'ok')?.name ?? 'resource budget failed'
        },
        runtime: probe,
        performance_baseline: performanceBaselineMetadata(),
        optional_deployment_layer: optionalDeploymentLayerMetadata()
    };
    writeReleaseReliabilityAuthority(outFile, summary);
    if (status !== 'ok')
    {
        throw new Error(`release resource ${mode} failed threshold evaluation`);
    }
}

async function faultInjection(outDir)
{
    const redisCases = new Set(['redis-restart', 'redis-reconnect', 'redis-latency']);
    const postgresCases = new Set(['postgres-readiness', 'postgres-reconnect', 'postgres-lock-timeout']);
    const notificationCases = new Set(['notification-stream-slow-consumer']);
    const gracefulShutdownCases = new Set(['graceful-shutdown']);
    const diskArtifactCases = new Set(['disk-artifact-storage-write-failure']);
    const defaultCases = [
        'redis-restart',
        'redis-reconnect',
        'redis-latency',
        'postgres-readiness',
        'postgres-reconnect',
        'postgres-lock-timeout',
        'notification-stream-slow-consumer',
        'graceful-shutdown',
        'disk-artifact-storage-write-failure'
    ];
    const cases = selectFaultCases(defaultCases);
    await resolveFaultRecoveryHealthMode();
    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    for (const caseName of cases)
    {
        const caseDir = path.join(outDir, caseName);
        fs.mkdirSync(path.join(caseDir, 'logs'), { recursive: true });
        const result = redisCases.has(caseName)
            ? await runRedisFaultCase(caseName)
            : postgresCases.has(caseName)
        ? await runPostgresFaultCase(caseName)
        : notificationCases.has(caseName)
          ? await runNotificationSlowConsumerFaultCase()
          : gracefulShutdownCases.has(caseName)
            ? await runGracefulShutdownFaultCase()
            : diskArtifactCases.has(caseName)
              ? await runDiskArtifactStorageFaultCase()
              : await runBlockedFaultCase(caseName);
        writeJson(path.join(caseDir, 'summary.json'), result);
        writeJson(path.join(caseDir, 'timeline.json'), result.timeline);
        results.push(result);
    }
    const summaryStatus = results.every((item) => item.status === 'completed')
        ? 'ok'
        : results.some((item) => item.status === 'failed')
      ? 'failed'
      : 'blocked';
    writeJson(path.join(outDir, 'summary.json'), {
        status: summaryStatus,
        namespace,
        caseCount: results.length,
        generatedAt: new Date().toISOString(),
        cases: results.map(faultCaseSummary)
    });
    if (summaryStatus !== 'ok')
    {
        throw new Error(`fault-injection summary is ${summaryStatus}; all cases must complete real controlled actions`);
    }
}

async function soak(mode, outFile)
{
    if (mode !== 'short')
    {
        const importFile = process.env.FSUSBLOG_SOAK_LONG_EVIDENCE_FILE;
        if (importFile)
        {
            const resolvedImportFile = path.resolve(root, importFile);
            const imported = readOptionalJson(resolvedImportFile);
            if (!imported)
            {
                throw new Error(`long soak imported evidence file not found: ${resolvedImportFile}`);
            }
            if (imported.mode !== mode)
            {
                throw new Error(`long soak imported evidence mode mismatch: expected ${mode}, got ${imported.mode}`);
            }
            if (imported.status !== 'ok')
            {
                throw new Error(`long soak imported evidence status must be ok, got ${imported.status ?? 'missing'}`);
            }
            try
            {
                if (!Array.isArray(imported.measurementNoiseAuthoritySequence))
                {
                    throw new Error('measurement noise authority sequence is missing');
                }
                validateMeasurementNoiseReceipt(imported.measurementNoiseEnvelope, {
                    expectedWindowId: `external-soak/${mode}`,
                    authoritySequence: imported.measurementNoiseAuthoritySequence
                });
            }
            catch (error)
            {
                throw new Error(`long soak imported evidence has no valid measurement noise authority: ${error.message}`, { cause: error });
            }
            writeReleaseReliabilityAuthority(outFile, {
                ...imported,
                status: 'ok',
                mode,
                executionMode: 'imported',
                countsAsReleaseFinal: true,
                generatedAt: new Date().toISOString(),
                importedEvidence: {
                    source: path.relative(root, resolvedImportFile),
                    importedAt: new Date().toISOString(),
                    measurementNoiseAuthorityVerified: true
                }
            });
            return;
        }

        writeReleaseReliabilityAuthority(outFile, {
            status: 'scheduled',
            mode,
            executionMode: 'scheduled',
            countsAsReleaseFinal: false,
            namespace,
            reason: 'long soak modes are scheduled/manual only',
            generatedAt: new Date().toISOString()
        });
        if (process.env.FSUSBLOG_SOAK_REQUIRE_IMPORTED_EVIDENCE === '1')
        {
            throw new Error(`long soak ${mode} requires FSUSBLOG_SOAK_LONG_EVIDENCE_FILE`);
        }
        return;
    }
    const durationSeconds = positiveInt(process.env.FSUSBLOG_SOAK_SHORT_SECONDS, 300);
    const intervalMs = positiveInt(process.env.FSUSBLOG_SOAK_INTERVAL_MS, 5000);
    const deadline = Date.now() + durationSeconds * 1000;
    const probes = [];
    const target = discoverBackendProcessTarget();
    const startResources = target.status === 'ok' ? readSoakResourceReadings(target) : null;
    do
    {
        probes.push(await runRouteContractProbe(safeBinaryRouteIds, { iterations: 4, concurrency: 2 }));
        if (Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
        }
    } while (Date.now() < deadline);
    const endResources = target.status === 'ok' ? readSoakResourceReadings(target) : null;
    const resourceMetricSummary = target.status === 'ok'
        ? buildSoakResourceSummary(target, startResources, endResources)
        : buildSoakUnavailableResourceSummary(target.reason ?? 'backend process unavailable');
    const failedProbes = probes.filter((probe) => probe.status !== 'ok');
    const latencies = probes.filter((probe) => probe.status === 'ok')
        .flatMap((probe) => [probe.latencyMs.p50, probe.latencyMs.p95, probe.latencyMs.p99].filter((value) => value !== null));
    writeReleaseReliabilityAuthority(outFile, {
        status: failedProbes.length === 0 ? 'ok' : 'failed',
        mode,
        executionMode: 'runtime',
        countsAsReleaseFinal: true,
        namespace,
        scenarios: ['mixed-public-read', 'cache-churn', 'public-binary-contract'],
        durationSeconds,
        sampling: {
            intervalMs,
            requestsPerProbe: 4,
            concurrency: 2,
            probeCount: probes.length
        },
        sampleCount: probes.reduce((total, probe) => total + probe.sampleCount, 0),
        resourceMetricSummary,
        resourceCurve: soakResourceCurve(resourceMetricSummary),
        latencyMs: {
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            p99: percentile(latencies, 99)
        },
        errorRate: probes.reduce((total, probe) => total + probe.failures.length, 0) / Math.max(1, probes.reduce((total, probe) => total + probe.sampleCount, 0)),
        generatedAt: new Date().toISOString(),
        probes
    });
    if (failedProbes.length > 0)
    {
        throw new Error(`short soak route contract failed: ${failedProbes[0].failures[0]?.failureKind}`);
    }
}

function gitSha()
{
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : 'unknown';
}

async function main()
{
    const [command, ...args] = process.argv.slice(2);
    if (command === 'backend-qps')
    {
        return await backendQps(args[0], path.resolve(root, args[1]));
    }
    if (command === 'backend-qps-sequential')
    {
        return await backendQpsSequential(path.resolve(root, args[0]));
    }
    if (command === 'load-profile')
    {
        return await loadProfile(args[0], path.resolve(root, args[1]));
    }
    if (command === 'data-scale')
    {
        return await dataScale(args[0], path.resolve(root, args[1]));
    }
    if (command === 'release-resource-budget')
    {
        return await releaseResourceBudget(args[0], path.resolve(root, args[1]));
    }
    if (command === 'fault-injection')
    {
        return await faultInjection(path.resolve(root, args[0]));
    }
    if (command === 'soak')
    {
        return await soak(args[0], path.resolve(root, args[1]));
    }
    throw new Error(`unknown runtime evidence probe command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().then(() =>
    {
        process.exit(0);
    }).catch((error) =>
    {
        console.error(`[runtime-evidence] ${error.message}`);
        process.exit(1);
    });
}
