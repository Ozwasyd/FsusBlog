#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { ROLLOUT_STAGES, readRolloutState, validateRolloutState } from './release-rollout-lib.mjs';

const SCHEMA = 'fsusblog.release-traffic-evidence.v1';
const SCENARIO_SCHEMA = 'fsusblog.release-traffic-scenario.v1';
const REQUIRED_CATEGORIES = Object.freeze([
    'home', 'archive', 'article', 'binary', 'search', 'static',
    'login', 'refresh', 'protected-read', 'write', 'upload', 'admin-health'
]);
const MAX_LATENCY_SAMPLES = 100_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const SAFE_EVIDENCE_HEADERS = new Set([
    'cache-control',
    'content-encoding',
    'content-type',
    'etag',
    'retry-after',
    'x-fsus-error-class',
    'x-fsus-frame-encoding',
    'x-fsus-release-id',
    'x-fsus-release-slot'
]);
const BASELINE_STAGES = new Set([
    'status:planned',
    'manifest-validate',
    'capacity-preflight',
    'backup-restore-gate',
    'current-schema-admission',
    'asset-materialize'
]);
const OVERLAP_STAGES = new Set([
    'candidate-start',
    'candidate-readiness',
    'candidate-smoke',
    'compatibility-smoke',
    'gateway-switch',
    'active-fence',
    'public-verify',
    'source-drain'
]);
const RELEASE_POLICY_STAGES = Object.freeze([
    'status:planned',
    ...ROLLOUT_STAGES,
    'status:completed'
]);

let options;
let state;
try
{
    options = parseArgs(process.argv.slice(2));
    state = createProbeState(options);
    await runProbe(state, options);
}
catch (error)
{
    process.stderr.write(`[release-traffic-probe] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    if (options?.out)
    {
        try
        {
            writeJsonAtomic(path.resolve(options.out), {
                schema: SCHEMA,
                status: 'fail',
                completedAtUtc: new Date().toISOString(),
                errors: [error instanceof Error ? error.message : String(error)]
            });
        }
        catch
        {
        }
    }
    process.exitCode = 1;
}

function parseArgs(argv)
{
    const parsed = {
        concurrency: 8,
        intervalMs: 25,
        timeoutMs: 10_000,
        snapshotIntervalMs: 1_000,
        rounds: 0,
        expectReleases: 'both'
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        const key = name.slice(2);
        parsed[key] = value;
        index += 1;
    }
    for (const name of ['base-url', 'scenario', 'rollout-state', 'snapshot', 'out', 'stop-file'])
    {
        if (!parsed[name])
        {
            throw new Error(`--${name} is required`);
        }
    }
    parsed.concurrency = boundedInteger(parsed.concurrency, 1, 128, 'concurrency');
    parsed.intervalMs = boundedInteger(parsed['interval-ms'] ?? parsed.intervalMs, 0, 60_000, 'interval-ms');
    parsed.timeoutMs = boundedInteger(parsed['timeout-ms'] ?? parsed.timeoutMs, 100, 120_000, 'timeout-ms');
    parsed.snapshotIntervalMs = boundedInteger(parsed['snapshot-interval-ms'] ?? parsed.snapshotIntervalMs, 100, 60_000, 'snapshot-interval-ms');
    parsed.rounds = boundedInteger(parsed.rounds, 0, 10_000, 'rounds');
    parsed.expectReleases = parsed['expect-releases'] ?? parsed.expectReleases;
    if (!['both', 'source', 'target'].includes(parsed.expectReleases))
    {
        throw new Error('--expect-releases must be both, source or target');
    }
    parsed.probeMode = parsed['probe-mode'] ?? 'public-rollout';
    if (!['public-rollout', 'candidate-direct'].includes(parsed.probeMode))
    {
        throw new Error('--probe-mode must be public-rollout or candidate-direct');
    }
    if (parsed.probeMode === 'candidate-direct' && parsed.expectReleases !== 'target')
    {
        throw new Error('--probe-mode candidate-direct requires --expect-releases target');
    }
    parsed.baseUrl = normalizeBaseUrl(parsed['base-url']);
    parsed.scenario = path.resolve(parsed.scenario);
    parsed.rolloutState = path.resolve(parsed['rollout-state']);
    parsed.snapshot = path.resolve(parsed.snapshot);
    parsed.out = path.resolve(parsed.out);
    parsed.stopFile = path.resolve(parsed['stop-file']);
    parsed.bindingKeyFile = parsed['binding-key-file'] === undefined
        ? null
        : path.resolve(parsed['binding-key-file']);
    return parsed;
}

function createProbeState(options)
{
    const scenario = JSON.parse(fs.readFileSync(options.scenario, 'utf8'));
    validateScenario(scenario);
    const rollout = readRolloutState(options.rolloutState);
    const sessionPlan = buildSessionPlan(scenario);
    const bindingKey = readBindingKey(options.bindingKeyFile, scenario.finalBinding?.required === true);
    const releaseIdentityPolicy = compileReleaseIdentityPolicy(scenario.releaseIdentityPolicy);
    return {
        scenario,
        scenarioSha256: hashFile(options.scenario),
        initialRolloutStateSha256: hashFile(options.rolloutState),
        releaseIdentityPolicy,
        regularRequests: scenario.requests.filter(request => !sessionPlan.requestIds.has(request.id)),
        sessionChains: sessionPlan.chains,
        sessions: new Map(),
        sessionChainEvidence: new Map(),
        bindingKey,
        probeMode: options.probeMode,
        rolloutId: rollout.rolloutId,
        source: releaseIdentity(rollout.source),
        target: releaseIdentity(rollout.target),
        sourceReleaseId: rollout.source.releaseId,
        targetReleaseId: rollout.target.releaseId,
        startedAtUtc: new Date().toISOString(),
        stoppedAtUtc: null,
        stopReason: null,
        stopping: false,
        totalRequests: 0,
        successfulRequests: 0,
        unexpectedResponseCount: 0,
        connectionErrorCount: 0,
        gatewayErrorCount: 0,
        unhandled5xxCount: 0,
        business5xxCount: 0,
        inFlightAbortedCount: 0,
        inFlight: new Map(),
        maxInFlightRequestCount: 0,
        inFlightStartedCount: 0,
        gatewaySwitchHolds: new Map(scenario.requests
            .filter(request => request.holdAcrossGatewaySwitch !== undefined)
            .map(request => [request.id, {
                required: true,
                attempts: 0,
                passCount: 0,
                failCount: 0,
                observations: []
            }])),
        releaseIdentityViolationCount: 0,
        releasePolicyCoverage: new Map(releaseIdentityPolicy === null
            ? []
            : [...releaseIdentityPolicy.keys()].map(key => [key.replace('\0', '/'), 0])),
        responseObservations: new Map(),
        observationCount: 0,
        observationDigests: [],
        observationHashChain: sha256('fsusblog.release-traffic-observation-chain.v1'),
        statusCodes: new Map(),
        releaseIds: new Map(),
        releaseSlots: new Map(),
        requestCounts: new Map(),
        categoryCounts: new Map(),
        stageCounts: new Map(),
        stageFailures: new Map(),
        latencySamples: [],
        latencySamplesByPhase: {
            baseline: [],
            overlap: [],
            targetOnly: [],
            unclassified: []
        },
        errors: [],
        nextRequestIndex: 0,
        nextRequestSequence: 0,
        snapshotTimer: null
    };
}

async function runProbe(probe, options)
{
    fs.rmSync(options.stopFile, { force: true });
    const stop = reason =>
    {
        if (!probe.stopping)
        {
            probe.stopping = true;
            probe.stopReason = reason;
        }
    };
    process.once('SIGINT', () => stop('signal:SIGINT'));
    process.once('SIGTERM', () => stop('signal:SIGTERM'));
    process.once('SIGHUP', () => stop('signal:SIGHUP'));
    probe.snapshotTimer = setInterval(() =>
    {
        if (fs.existsSync(options.stopFile))
        {
            stop('stop-file');
        }
        writeSnapshot(probe, options.snapshot, 'running');
    }, options.snapshotIntervalMs);
    probe.snapshotTimer.unref?.();
    writeSnapshot(probe, options.snapshot, 'running');

    const regularWorkers = probe.regularRequests.length === 0
        ? []
        : Array.from({ length: options.concurrency }, (_, worker) => workerLoop(probe, options, worker));
    const sessionWorkers = probe.sessionChains.map((chain, index) => sessionChainLoop(probe, options, chain, index));
    await Promise.all([...regularWorkers, ...sessionWorkers]);
    clearInterval(probe.snapshotTimer);
    probe.stoppedAtUtc = new Date().toISOString();
    const unsignedFinal = buildReport(probe, finalStatus(probe));
    const final = sealFinalReport(probe, options, unsignedFinal);
    writeJsonAtomic(options.out, final);
    writeJsonAtomic(options.snapshot, final);
    process.stdout.write(`${JSON.stringify(final)}\n`);
    if (final.status !== 'pass')
    {
        process.exitCode = 1;
    }
}

async function workerLoop(probe, options, worker)
{
    while (!probe.stopping)
    {
        if (fs.existsSync(options.stopFile))
        {
            probe.stopping = true;
            probe.stopReason = 'stop-file';
            break;
        }
        const index = probe.nextRequestIndex++ % probe.regularRequests.length;
        const request = probe.regularRequests[index];
        if (request.holdAcrossGatewaySwitch !== undefined
      && (probe.gatewaySwitchHolds.get(request.id)?.passCount ?? 0) > 0)
        {
            await delay(Math.max(options.intervalMs, 10));
            continue;
        }
        if (request.once === true && (probe.requestCounts.get(request.id) ?? 0) > 0)
        {
            await delay(Math.max(options.intervalMs, 10));
            continue;
        }
        await executeRequest(probe, options, request, worker, null);
        if (options.rounds > 0 && probe.scenario.requests.every(item => (probe.requestCounts.get(item.id) ?? 0) >= options.rounds))
        {
            probe.stopping = true;
            probe.stopReason = `rounds:${options.rounds}`;
        }
        if (options.intervalMs > 0)
        {
            await delay(options.intervalMs);
        }
    }
}

async function sessionChainLoop(probe, options, chain, worker)
{
    const session = createSessionRuntime(chain, worker);
    probe.sessions.set(chain.id, session);
    while (!probe.stopping)
    {
        if (fs.existsSync(options.stopFile))
        {
            probe.stopping = true;
            probe.stopReason = 'stop-file';
            break;
        }
        if (chain.resetBeforeEachCycle)
        {
            session.jar.clear();
        }
        const cycle = ++session.cycle;
        let passed = true;
        for (let step = 0; step < chain.requestIds.length; step += 1)
        {
            const request = probe.scenario.requests.find(item => item.id === chain.requestIds[step]);
            const result = await executeRequest(probe, options, request, `session-${worker}`, {
                chainId: chain.id,
                cycle,
                step,
                jar: session.jar
            });
            passed = result.ok && passed;
        }
        session.completedCycles += 1;
        if (!passed)
        {
            session.failedCycles += 1;
        }
        updateSessionChainEvidence(probe, chain, session);
        if (options.rounds > 0 && probe.scenario.requests.every(item => (probe.requestCounts.get(item.id) ?? 0) >= options.rounds))
        {
            probe.stopping = true;
            probe.stopReason = `rounds:${options.rounds}`;
        }
        if (options.intervalMs > 0)
        {
            await delay(options.intervalMs);
        }
    }
}

async function executeRequest(probe, options, request, worker, sessionContext)
{
    const sequence = ++probe.nextRequestSequence;
    const requestKey = `${worker}:${sequence}`;
    const startContext = currentRolloutContext(options.rolloutState);
    const stage = startContext.stage;
    const started = performance.now();
    const startedAtUtc = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('request-timeout'), request.timeoutMs ?? options.timeoutMs);
    probe.inFlight.set(requestKey, {
        id: request.id,
        category: request.category,
        stage,
        startedAtUtc,
        holdAcrossGatewaySwitch: request.holdAcrossGatewaySwitch !== undefined,
        session: sessionContext === null
            ? null
            : { chainId: sessionContext.chainId, cycle: sessionContext.cycle, step: sessionContext.step }
    });
    probe.inFlightStartedCount += 1;
    probe.maxInFlightRequestCount = Math.max(probe.maxInFlightRequestCount, probe.inFlight.size);
    let response;
    let requestSucceeded = false;
    try
    {
        const headers = loadHeaders(request.headers, request.headersFile);
        const requestCookies = sessionContext === null
            ? []
            : applyCookieJar(headers, sessionContext.jar, new URL(request.path, options.baseUrl));
        const body = loadBody(request.bodyFile);
        const requestUrl = new URL(request.path, options.baseUrl);
        response = await fetch(requestUrl, {
            method: request.method ?? 'GET',
            headers,
            body,
            redirect: request.redirect ?? 'manual',
            signal: controller.signal
        });
        const responseBytes = await readResponseBytes(response);
        const latencyMs = performance.now() - started;
        const completedContext = currentRolloutContext(options.rolloutState);
        const setCookies = getSetCookieHeaders(response.headers);
        const responseCookies = sessionContext === null
            ? cookieResponseEvidence(setCookies, requestUrl)
            : storeResponseCookies(sessionContext.jar, setCookies, requestUrl);
        const assertionResult = evaluateResponseAssertions(
            response,
            responseBytes,
            request,
            requestCookies,
            responseCookies);
        const releaseId = response.headers.get('x-fsus-release-id') ?? 'missing';
        const releaseSlot = response.headers.get('x-fsus-release-slot') ?? 'missing';
        const releaseResult = evaluateReleaseIdentity(
            probe,
            stage,
            request.category,
            releaseId,
            releaseSlot);
        const holdResult = evaluateGatewaySwitchHold(
            probe,
            request,
            startContext,
            completedContext,
            releaseResult,
            latencyMs,
            responseBytes);
        const observation = responseObservation({
            request,
            sessionContext,
            stage,
            startContext,
            completedContext,
            response,
            responseBytes,
            latencyMs,
            releaseId,
            releaseSlot,
            releaseResult,
            requestCookies,
            responseCookies,
            assertionResult,
            holdResult,
            startedAtUtc,
            completedAtUtc: new Date().toISOString()
        });
        recordResponseObservation(probe, observation);
        addLatency(probe, latencyMs, stage);
        increment(probe.statusCodes, String(response.status));
        increment(probe.requestCounts, request.id);
        increment(probe.categoryCounts, request.category);
        increment(probe.stageCounts, stage);
        probe.totalRequests += 1;
        increment(probe.releaseIds, releaseId);
        increment(probe.releaseSlots, releaseSlot);

        const expected = request.expectedStatus.includes(response.status);
        const gatewayFailure = [502, 503, 504].includes(response.status);
        let business5xx = false;
        if (response.status >= 500 && !gatewayFailure)
        {
            business5xx = isDeclaredBusinessFailure(response, request, responseBytes);
        }
        for (const code of assertionResult.errors)
        {
            recordStageFailure(probe, stage, request.id, code);
        }
        for (const code of releaseResult.errors)
        {
            recordStageFailure(probe, stage, request.id, code);
        }
        for (const code of holdResult.errors)
        {
            recordStageFailure(probe, stage, request.id, code);
        }
        const semanticFailure = assertionResult.errors.length > 0
      || releaseResult.errors.length > 0
      || holdResult.errors.length > 0;
        if (gatewayFailure)
        {
            probe.gatewayErrorCount += 1;
            recordStageFailure(probe, stage, request.id, `http_${response.status}`);
        }
        else if (response.status >= 500 && !business5xx)
        {
            probe.unhandled5xxCount += 1;
            recordStageFailure(probe, stage, request.id, `http_${response.status}`);
        }
        else if (business5xx)
        {
            probe.business5xxCount += 1;
            if (!expected || semanticFailure)
            {
                probe.unexpectedResponseCount += 1;
            }
            else
            {
                requestSucceeded = true;
            }
        }
        else if (!expected)
        {
            probe.unexpectedResponseCount += 1;
            recordStageFailure(probe, stage, request.id, `unexpected_http_${response.status}`);
        }
        else if (semanticFailure)
        {
            probe.unexpectedResponseCount += 1;
        }
        else
        {
            probe.successfulRequests += 1;
            requestSucceeded = true;
        }
    }
    catch (error)
    {
        probe.totalRequests += 1;
        probe.connectionErrorCount += 1;
        if (controller.signal.aborted)
        {
            probe.inFlightAbortedCount += 1;
        }
        increment(probe.requestCounts, request.id);
        increment(probe.categoryCounts, request.category);
        increment(probe.stageCounts, stage);
        const code = error instanceof Error ? `${error.name}:${error.message}` : String(error);
        recordStageFailure(probe, stage, request.id, code);
    }
    finally
    {
        clearTimeout(timeout);
        probe.inFlight.delete(requestKey);
    }
    return { ok: requestSucceeded };
}

function isDeclaredBusinessFailure(response, request, bytes)
{
    const marker = response.headers.get('x-fsus-error-class');
    if (marker !== 'business' || !Array.isArray(request.allowedBusinessErrorCodes) || request.allowedBusinessErrorCodes.length === 0)
    {
        return false;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json'))
    {
        return false;
    }
    let payload;
    try
    {
        payload = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch
    {
        return false;
    }
    const code = payload?.code ?? payload?.errorCode ?? payload?.error?.code;
    return typeof code === 'string' && request.allowedBusinessErrorCodes.includes(code);
}

function validateScenario(scenario)
{
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario) || scenario.schema !== SCENARIO_SCHEMA)
    {
        throw new Error(`traffic scenario schema must be ${SCENARIO_SCHEMA}`);
    }
    if (!Array.isArray(scenario.requests) || scenario.requests.length === 0)
    {
        throw new Error('traffic scenario requests are required');
    }
    const errors = [];
    const ids = new Set();
    const categories = new Set();
    for (let index = 0; index < scenario.requests.length; index += 1)
    {
        const request = scenario.requests[index];
        if (!request || typeof request !== 'object' || Array.isArray(request))
        {
            errors.push(`request[${index}] must be an object`);
            continue;
        }
        if (!/^[a-z][a-z0-9._-]{2,63}$/u.test(String(request.id ?? '')) || ids.has(request.id))
        {
            errors.push(`invalid/duplicate request id: ${request.id}`);
            continue;
        }
        ids.add(request.id);
        if (!REQUIRED_CATEGORIES.includes(request.category))
        {
            errors.push(`invalid request category: ${request.category}`);
        }
        else
        {
            categories.add(request.category);
        }
        if (!/^\/(?!\/)/u.test(String(request.path ?? '')) || String(request.path).includes('\\'))
        {
            errors.push(`${request.id}: path must be origin-relative`);
        }
        if (!Array.isArray(request.expectedStatus) || request.expectedStatus.some(code => !Number.isInteger(code) || code < 100 || code > 599))
        {
            errors.push(`${request.id}: expectedStatus is invalid`);
        }
        else if (request.expectedStatus.some(code => code >= 500)
      && (!Array.isArray(request.allowedBusinessErrorCodes) || request.allowedBusinessErrorCodes.length === 0))
        {
            errors.push(`${request.id}: expected 5xx requires explicit business error codes and runtime marker`);
        }
        errors.push(...validateResponseAssertions(request));
        errors.push(...validateCookieAssertions(request));
        errors.push(...validateGatewayHold(request));
    }
    const missing = REQUIRED_CATEGORIES.filter(category => !categories.has(category));
    if (missing.length > 0)
    {
        errors.push(`traffic scenario misses required categories: ${missing.join(', ')}`);
    }
    errors.push(...validateSessionChains(scenario, ids));
    errors.push(...validateReleaseIdentityPolicy(scenario.releaseIdentityPolicy));
    errors.push(...validateFinalBindingPlan(scenario.finalBinding));
    if (errors.length > 0)
    {
        throw new Error([...new Set(errors)].join('; '));
    }
}

function validateResponseAssertions(request)
{
    const value = request.responseAssertions;
    if (value === undefined)
    {
        return [];
    }
    const label = `${request.id}: responseAssertions`;
    if (!isObject(value))
    {
        return [`${label} must be an object`];
    }
    const errors = [];
    if (value.headers !== undefined)
    {
        if (!Array.isArray(value.headers) || value.headers.length > 32)
        {
            errors.push(`${label}.headers must be an array with at most 32 entries`);
        }
        else
        {
            for (let index = 0; index < value.headers.length; index += 1)
            {
                const assertion = value.headers[index];
                const itemLabel = `${label}.headers[${index}]`;
                if (!isObject(assertion))
                {
                    errors.push(`${itemLabel} must be an object`);
                    continue;
                }
                const name = String(assertion.name ?? '').toLowerCase();
                if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name) || name === 'set-cookie')
                {
                    errors.push(`${itemLabel}.name is invalid or secret-bearing`);
                }
                if (!['present', 'absent', 'equals', 'contains'].includes(assertion.operator))
                {
                    errors.push(`${itemLabel}.operator is invalid`);
                }
                if (['equals', 'contains'].includes(assertion.operator)
          && (typeof assertion.value !== 'string' || assertion.value.length > 2048))
                {
                    errors.push(`${itemLabel}.value is required and must be at most 2048 characters`);
                }
            }
        }
    }
    if (value.body !== undefined)
    {
        if (!isObject(value.body))
        {
            errors.push(`${label}.body must be an object`);
        }
        else
        {
            const body = value.body;
            if (body.sha256 !== undefined && !SHA256.test(String(body.sha256)))
            {
                errors.push(`${label}.body.sha256 is invalid`);
            }
            for (const field of ['minBytes', 'maxBytes'])
            {
                if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 0 || body[field] > MAX_RESPONSE_BYTES))
                {
                    errors.push(`${label}.body.${field} must be 0..${MAX_RESPONSE_BYTES}`);
                }
            }
            if (Number.isSafeInteger(body.minBytes) && Number.isSafeInteger(body.maxBytes) && body.minBytes > body.maxBytes)
            {
                errors.push(`${label}.body minBytes exceeds maxBytes`);
            }
            if (body.utf8Contains !== undefined
        && (!Array.isArray(body.utf8Contains)
          || body.utf8Contains.length > 32
          || body.utf8Contains.some(item => typeof item !== 'string' || item.length === 0 || item.length > 2048)))
            {
                errors.push(`${label}.body.utf8Contains is invalid`);
            }
            if (body.json !== undefined)
            {
                if (!Array.isArray(body.json) || body.json.length > 32)
                {
                    errors.push(`${label}.body.json must be an array with at most 32 entries`);
                }
                else
                {
                    for (let index = 0; index < body.json.length; index += 1)
                    {
                        const assertion = body.json[index];
                        if (!isObject(assertion) || !validJsonPointer(assertion.pointer) || !Object.hasOwn(assertion, 'equals'))
                        {
                            errors.push(`${label}.body.json[${index}] is invalid`);
                        }
                    }
                }
            }
        }
    }
    if (value.aeds !== undefined)
    {
        if (!isObject(value.aeds))
        {
            errors.push(`${label}.aeds must be an object`);
        }
        else
        {
            const aeds = value.aeds;
            if (!Array.isArray(aeds.frameTypes)
        || aeds.frameTypes.length === 0
        || aeds.frameTypes.some(item => !Number.isSafeInteger(item) || item < 0 || item > 0xffff))
            {
                errors.push(`${label}.aeds.frameTypes is invalid`);
            }
            if (aeds.flags !== undefined && aeds.flags !== 0)
            {
                errors.push(`${label}.aeds.flags must be zero for the production v2 protocol`);
            }
            if (aeds.payloadSha256 !== undefined && !SHA256.test(String(aeds.payloadSha256)))
            {
                errors.push(`${label}.aeds.payloadSha256 is invalid`);
            }
            for (const field of ['minPayloadBytes', 'maxPayloadBytes'])
            {
                if (aeds[field] !== undefined && (!Number.isSafeInteger(aeds[field]) || aeds[field] < 0 || aeds[field] > MAX_RESPONSE_BYTES))
                {
                    errors.push(`${label}.aeds.${field} must be 0..${MAX_RESPONSE_BYTES}`);
                }
            }
            if (Number.isSafeInteger(aeds.minPayloadBytes)
        && Number.isSafeInteger(aeds.maxPayloadBytes)
        && aeds.minPayloadBytes > aeds.maxPayloadBytes)
            {
                errors.push(`${label}.aeds minPayloadBytes exceeds maxPayloadBytes`);
            }
        }
    }
    return errors;
}

function validateCookieAssertions(request)
{
    const value = request.cookieAssertions;
    if (value === undefined)
    {
        return [];
    }
    if (!isObject(value))
    {
        return [`${request.id}: cookieAssertions must be an object`];
    }
    const errors = [];
    for (const field of ['requestPresent', 'requestAbsent', 'responseSet', 'responseDeleted'])
    {
        if (value[field] === undefined)
        {
            continue;
        }
        if (!Array.isArray(value[field])
      || new Set(value[field]).size !== value[field].length
      || value[field].some(item => !SAFE_COOKIE_NAME.test(String(item))))
        {
            errors.push(`${request.id}: cookieAssertions.${field} is invalid`);
        }
    }
    return errors;
}

function validateGatewayHold(request)
{
    const value = request.holdAcrossGatewaySwitch;
    if (value === undefined)
    {
        return [];
    }
    if (!isObject(value))
    {
        return [`${request.id}: holdAcrossGatewaySwitch must be an object`];
    }
    const errors = [];
    if (value.minimumDurationMs !== undefined
    && (!Number.isSafeInteger(value.minimumDurationMs) || value.minimumDurationMs < 0 || value.minimumDurationMs > 120_000))
    {
        errors.push(`${request.id}: holdAcrossGatewaySwitch.minimumDurationMs is invalid`);
    }
    if (value.requireTargetResponse !== undefined && value.requireTargetResponse !== true)
    {
        errors.push(`${request.id}: holdAcrossGatewaySwitch.requireTargetResponse may only be true`);
    }
    return errors;
}

function validateSessionChains(scenario, requestIds)
{
    if (scenario.sessionChains === undefined)
    {
        const orphanAssertions = scenario.requests.filter(request => request.cookieAssertions !== undefined).map(request => request.id);
        return orphanAssertions.length === 0
            ? []
            : [`cookie assertions require sessionChains: ${orphanAssertions.join(', ')}`];
    }
    if (!Array.isArray(scenario.sessionChains) || scenario.sessionChains.length === 0 || scenario.sessionChains.length > 16)
    {
        return ['sessionChains must be an array with 1..16 entries'];
    }
    const errors = [];
    const chainIds = new Set();
    const assigned = new Set();
    for (let index = 0; index < scenario.sessionChains.length; index += 1)
    {
        const chain = scenario.sessionChains[index];
        const label = `sessionChains[${index}]`;
        if (!isObject(chain))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (!/^[a-z][a-z0-9._-]{2,63}$/u.test(String(chain.id ?? '')) || chainIds.has(chain.id))
        {
            errors.push(`${label}.id is invalid or duplicate`);
        }
        chainIds.add(chain.id);
        if (!Array.isArray(chain.requestIds)
      || chain.requestIds.length < 2
      || new Set(chain.requestIds).size !== chain.requestIds.length)
        {
            errors.push(`${label}.requestIds must contain at least two unique requests`);
            continue;
        }
        for (const requestId of chain.requestIds)
        {
            if (!requestIds.has(requestId))
            {
                errors.push(`${label} references unknown request ${requestId}`);
            }
            if (assigned.has(requestId))
            {
                errors.push(`${label} reuses request ${requestId} from another chain`);
            }
            assigned.add(requestId);
            const request = scenario.requests.find(item => item.id === requestId);
            if (request?.once === true)
            {
                errors.push(`${label} request ${requestId} cannot use once=true`);
            }
        }
        if (chain.resetBeforeEachCycle !== undefined && typeof chain.resetBeforeEachCycle !== 'boolean')
        {
            errors.push(`${label}.resetBeforeEachCycle must be boolean`);
        }
    }
    for (const request of scenario.requests)
    {
        if (request.cookieAssertions !== undefined && !assigned.has(request.id))
        {
            errors.push(`${request.id}: cookieAssertions require membership in a session chain`);
        }
    }
    return errors;
}

function validateReleaseIdentityPolicy(value)
{
    if (value === undefined)
    {
        return [];
    }
    if (!isObject(value))
    {
        return ['releaseIdentityPolicy must be an object'];
    }
    const errors = [];
    if (value.schema !== 'fsusblog.release-traffic-release-policy.v1')
    {
        errors.push('releaseIdentityPolicy schema is invalid');
    }
    if (value.required !== true)
    {
        errors.push('releaseIdentityPolicy.required must be true');
    }
    if (!Array.isArray(value.rules) || value.rules.length === 0)
    {
        return [...errors, 'releaseIdentityPolicy.rules are required'];
    }
    const pairs = new Map();
    for (let index = 0; index < value.rules.length; index += 1)
    {
        const rule = value.rules[index];
        const label = `releaseIdentityPolicy.rules[${index}]`;
        if (!isObject(rule))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (!Array.isArray(rule.stages) || rule.stages.length === 0 || rule.stages.some(stage => !RELEASE_POLICY_STAGES.includes(stage)))
        {
            errors.push(`${label}.stages is invalid`);
            continue;
        }
        if (new Set(rule.stages).size !== rule.stages.length)
        {
            errors.push(`${label}.stages contains duplicates`);
        }
        if (!Array.isArray(rule.categories) || rule.categories.length === 0 || rule.categories.some(category => !REQUIRED_CATEGORIES.includes(category)))
        {
            errors.push(`${label}.categories is invalid`);
            continue;
        }
        if (new Set(rule.categories).size !== rule.categories.length)
        {
            errors.push(`${label}.categories contains duplicates`);
        }
        if (!Array.isArray(rule.allowed)
      || rule.allowed.length === 0
      || new Set(rule.allowed).size !== rule.allowed.length
      || rule.allowed.some(role => !['source', 'target'].includes(role)))
        {
            errors.push(`${label}.allowed is invalid`);
            continue;
        }
        for (const stage of new Set(rule.stages))
        {
            for (const category of new Set(rule.categories))
            {
                const key = `${stage}\0${category}`;
                if (pairs.has(key))
                {
                    errors.push(`${label} duplicates ${stage}/${category}`);
                }
                else
                {
                    pairs.set(key, rule.allowed);
                }
            }
        }
    }
    for (const stage of RELEASE_POLICY_STAGES)
    {
        const missing = REQUIRED_CATEGORIES.filter(category => !pairs.has(`${stage}\0${category}`));
        if (missing.length > 0)
        {
            errors.push(`releaseIdentityPolicy misses ${stage}: ${missing.join(', ')}`);
        }
    }
    return errors;
}

function validateFinalBindingPlan(value)
{
    if (value === undefined)
    {
        return [];
    }
    if (!isObject(value))
    {
        return ['finalBinding must be an object'];
    }
    const errors = [];
    if (value.schema !== 'fsusblog.release-traffic-final-binding-plan.v1')
    {
        errors.push('finalBinding schema is invalid');
    }
    if (value.required !== true)
    {
        errors.push('finalBinding.required must be true');
    }
    if (value.algorithm !== 'hmac-sha256')
    {
        errors.push('finalBinding.algorithm must be hmac-sha256');
    }
    return errors;
}

function finalStatus(probe)
{
    const sourceSeen = probe.releaseIds.get(probe.sourceReleaseId) ?? 0;
    const targetSeen = probe.releaseIds.get(probe.targetReleaseId) ?? 0;
    const categoriesCovered = REQUIRED_CATEGORIES.every(category => (probe.categoryCounts.get(category) ?? 0) > 0);
    const releasesSeen = optionsReleaseExpectation(probe, sourceSeen, targetSeen);
    return probe.totalRequests > 0
    && releasesSeen
    && categoriesCovered
    && deploymentFailureCount(probe) === 0
    && probe.unexpectedResponseCount === 0
    && probe.inFlightAbortedCount === 0
    && probe.inFlight.size === 0
    && gatewayHoldsPass(probe)
    && sessionChainsPass(probe)
        ? 'pass'
        : 'fail';
}

function optionsReleaseExpectation(probe, sourceSeen, targetSeen)
{
    if (options.expectReleases === 'source')
    {
        return sourceSeen > 0;
    }
    if (options.expectReleases === 'target')
    {
        return targetSeen > 0;
    }
    return sourceSeen > 0 && targetSeen > 0;
}

function buildReport(probe, status)
{
    const latencies = [...probe.latencySamples].sort((left, right) => left - right);
    const phaseLatencyMs = Object.fromEntries(Object.entries(probe.latencySamplesByPhase).map(([phase, samples]) =>
    {
        const sorted = [...samples].sort((left, right) => left - right);
        return [phase, latencySummary(sorted)];
    }));
    const baselineP95 = phaseLatencyMs.baseline.p95;
    const baselineP99 = phaseLatencyMs.baseline.p99;
    const overlapP95 = phaseLatencyMs.overlap.p95;
    const overlapP99 = phaseLatencyMs.overlap.p99;
    return {
        schema: SCHEMA,
        status,
        probeMode: probe.probeMode,
        rolloutId: probe.rolloutId,
        startedAtUtc: probe.startedAtUtc,
        completedAtUtc: probe.stoppedAtUtc,
        stopReason: probe.stopReason,
        totalRequests: probe.totalRequests,
        successfulRequests: probe.successfulRequests,
        unexpectedResponseCount: probe.unexpectedResponseCount,
        deploymentFailureCount: deploymentFailureCount(probe),
        connectionErrorCount: probe.connectionErrorCount,
        gatewayErrorCount: probe.gatewayErrorCount,
        unhandled5xxCount: probe.unhandled5xxCount,
        business5xxCount: probe.business5xxCount,
        inFlightAbortedCount: probe.inFlightAbortedCount,
        inFlightRequestCount: probe.inFlight.size,
        inFlightStartedCount: probe.inFlightStartedCount,
        maxInFlightRequestCount: probe.maxInFlightRequestCount,
        inFlightRequests: [...probe.inFlight.values()],
        source: probe.source,
        target: probe.target,
        releaseDistribution: {
            source: probe.releaseIds.get(probe.sourceReleaseId) ?? 0,
            target: probe.releaseIds.get(probe.targetReleaseId) ?? 0,
            byReleaseId: Object.fromEntries(probe.releaseIds),
            bySlot: Object.fromEntries(probe.releaseSlots)
        },
        releaseIdentityPolicy: {
            required: probe.probeMode === 'public-rollout' && probe.releaseIdentityPolicy !== null,
            scenarioRequired: probe.releaseIdentityPolicy !== null,
            mode: probe.probeMode,
            violationCount: probe.releaseIdentityViolationCount,
            coverage: Object.fromEntries(probe.releasePolicyCoverage)
        },
        sessionChains: Object.fromEntries(probe.sessionChainEvidence),
        gatewaySwitchHolds: Object.fromEntries(probe.gatewaySwitchHolds),
        responseObservations: serializeResponseObservations(probe.responseObservations),
        observationBinding: {
            schema: 'fsusblog.release-traffic-observation-chain.v1',
            algorithm: 'sha256-chain',
            observationCount: probe.observationCount,
            observationSha256: [...probe.observationDigests],
            chainHeadSha256: probe.observationHashChain,
            scenarioSha256: probe.scenarioSha256,
            initialRolloutStateSha256: probe.initialRolloutStateSha256
        },
        statusCodes: Object.fromEntries(probe.statusCodes),
        requestCounts: Object.fromEntries(probe.requestCounts),
        categoryCounts: Object.fromEntries(probe.categoryCounts),
        stageCounts: Object.fromEntries(probe.stageCounts),
        stageFailures: Object.fromEntries(probe.stageFailures),
        latencyMs: {
            samples: latencies.length,
            p50: percentile(latencies, 0.50),
            p95: percentile(latencies, 0.95),
            p99: percentile(latencies, 0.99),
            max: latencies.at(-1) ?? null
        },
        phaseLatencyMs,
        impactPercent: {
            p95: latencyImpactPercent(baselineP95, overlapP95),
            p99: latencyImpactPercent(baselineP99, overlapP99)
        },
        requiredCategories: REQUIRED_CATEGORIES,
        errors: probe.errors
    };
}

function writeSnapshot(probe, file, status)
{
    writeJsonAtomic(file, buildReport(probe, status));
}

function deploymentFailureCount(probe)
{
    return probe.connectionErrorCount
    + probe.gatewayErrorCount
    + probe.unhandled5xxCount
    + probe.releaseIdentityViolationCount;
}

function currentRolloutContext(file)
{
    try
    {
        const bytes = fs.readFileSync(file);
        const rollout = JSON.parse(bytes.toString('utf8'));
        validateRolloutState(rollout);
        let stage = rollout.currentStage;
        if (stage === null && rollout.status === 'running' && rollout.completedStages.length > 0)
        {
            stage = rollout.completedStages.at(-1);
        }
        stage ??= `status:${rollout.status}`;
        return {
            stage,
            status: rollout.status,
            switchCommitted: rollout.switchCommitted,
            gatewayGeneration: rollout.gatewayGeneration,
            updatedAtUtc: rollout.updatedAtUtc,
            stateSha256: sha256(bytes)
        };
    }
    catch
    {
        return {
            stage: 'state-unavailable',
            status: 'unavailable',
            switchCommitted: null,
            gatewayGeneration: null,
            updatedAtUtc: null,
            stateSha256: null
        };
    }
}

function loadHeaders(inline, file)
{
    const headers = new Headers();
    if (inline !== undefined)
    {
        if (!inline || typeof inline !== 'object' || Array.isArray(inline))
        {
            throw new Error('inline headers must be an object');
        }
        for (const [name, value] of Object.entries(inline))
        {
            headers.set(name, String(value));
        }
    }
    if (file)
    {
        const resolved = path.resolve(file);
        const stat = fs.statSync(resolved);
        if (![0o400, 0o600].includes(stat.mode & 0o777))
        {
            throw new Error(`header file must have mode 0400 or 0600: ${resolved}`);
        }
        const values = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        if (!values || typeof values !== 'object' || Array.isArray(values))
        {
            throw new Error('header file must contain a JSON object');
        }
        for (const [name, value] of Object.entries(values))
        {
            headers.set(name, String(value));
        }
    }
    headers.set('User-Agent', 'FsusBlog zero-downtime release probe');
    return headers;
}

function loadBody(file)
{
    return file ? fs.readFileSync(path.resolve(file)) : undefined;
}

function buildSessionPlan(scenario)
{
    const chains = (scenario.sessionChains ?? []).map(chain => ({
        id: chain.id,
        requestIds: [...chain.requestIds],
        resetBeforeEachCycle: chain.resetBeforeEachCycle === true
    }));
    return {
        chains,
        requestIds: new Set(chains.flatMap(chain => chain.requestIds))
    };
}

function createSessionRuntime(chain, worker)
{
    return {
        chainId: chain.id,
        worker,
        jar: new Map(),
        cycle: 0,
        completedCycles: 0,
        failedCycles: 0
    };
}

function updateSessionChainEvidence(probe, chain, session)
{
    probe.sessionChainEvidence.set(chain.id, {
        requestIds: [...chain.requestIds],
        resetBeforeEachCycle: chain.resetBeforeEachCycle,
        completedCycles: session.completedCycles,
        failedCycles: session.failedCycles,
        cookieJar: [...session.jar.values()]
            .filter(cookie => !cookieExpired(cookie))
            .sort((left, right) => `${left.name}\0${left.path}`.localeCompare(`${right.name}\0${right.path}`))
            .map(cookie => cookieEvidence(cookie))
    });
}

function applyCookieJar(headers, jar, requestUrl)
{
    if (headers.has('cookie'))
    {
        throw new Error('session chain request cannot provide a manual Cookie header');
    }
    removeExpiredCookies(jar);
    const selected = [...jar.values()]
        .filter(cookie => cookieMatchesRequest(cookie, requestUrl))
        .sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name));
    if (selected.length > 0)
    {
        headers.set('Cookie', selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
    }
    return selected.map(cookie => cookieEvidence(cookie));
}

function storeResponseCookies(jar, values, requestUrl)
{
    const evidence = [];
    for (const value of values)
    {
        const cookie = parseSetCookie(value, requestUrl);
        if (cookie === null)
        {
            continue;
        }
        const key = cookieKey(cookie);
        if (cookie.deleted)
        {
            jar.delete(key);
        }
        else
        {
            jar.set(key, cookie);
        }
        evidence.push(cookieEvidence(cookie));
    }
    return evidence;
}

function cookieResponseEvidence(values, requestUrl)
{
    return values.map(value => parseSetCookie(value, requestUrl)).filter(Boolean).map(cookie => cookieEvidence(cookie));
}

function parseSetCookie(value, requestUrl)
{
    const parts = String(value).split(';').map(part => part.trim());
    const separator = parts[0]?.indexOf('=') ?? -1;
    if (separator <= 0)
    {
        return null;
    }
    const name = parts[0].slice(0, separator).trim();
    const cookieValue = parts[0].slice(separator + 1);
    if (!SAFE_COOKIE_NAME.test(name) || /[\u0000-\u001f\u007f;]/u.test(cookieValue))
    {
        return null;
    }
    const cookie = {
        name,
        value: cookieValue,
        domain: requestUrl.hostname.toLowerCase(),
        hostOnly: true,
        path: defaultCookiePath(requestUrl.pathname),
        secure: false,
        httpOnly: false,
        sameSite: null,
        expiresAt: null,
        deleted: false
    };
    for (const attribute of parts.slice(1))
    {
        const attributeSeparator = attribute.indexOf('=');
        const rawName = (attributeSeparator < 0 ? attribute : attribute.slice(0, attributeSeparator)).trim().toLowerCase();
        const rawValue = attributeSeparator < 0 ? '' : attribute.slice(attributeSeparator + 1).trim();
        if (rawName === 'domain')
        {
            const domain = rawValue.replace(/^\./u, '').toLowerCase();
            if (!domainMatches(requestUrl.hostname.toLowerCase(), domain))
            {
                return null;
            }
            cookie.domain = domain;
            cookie.hostOnly = false;
        }
        else if (rawName === 'path' && rawValue.startsWith('/'))
        {
            cookie.path = rawValue;
        }
        else if (rawName === 'secure')
        {
            cookie.secure = true;
        }
        else if (rawName === 'httponly')
        {
            cookie.httpOnly = true;
        }
        else if (rawName === 'samesite' && ['lax', 'strict', 'none'].includes(rawValue.toLowerCase()))
        {
            cookie.sameSite = rawValue.toLowerCase();
        }
        else if (rawName === 'max-age' && /^-?\d+$/u.test(rawValue))
        {
            const seconds = Number(rawValue);
            cookie.expiresAt = Number.isSafeInteger(seconds) ? Date.now() + seconds * 1000 : null;
            if (seconds <= 0)
            {
                cookie.deleted = true;
            }
        }
        else if (rawName === 'expires' && cookie.expiresAt === null)
        {
            const expiresAt = Date.parse(rawValue);
            if (Number.isFinite(expiresAt))
            {
                cookie.expiresAt = expiresAt;
            }
        }
    }
    if (cookie.name.startsWith('__Secure-') && !cookie.secure)
    {
        return null;
    }
    if (cookie.name.startsWith('__Host-') && (!cookie.secure || !cookie.hostOnly || cookie.path !== '/'))
    {
        return null;
    }
    if (cookie.sameSite === 'none' && !cookie.secure)
    {
        return null;
    }
    if (cookie.value === '' || cookieExpired(cookie))
    {
        cookie.deleted = true;
    }
    return cookie;
}

function getSetCookieHeaders(headers)
{
    if (typeof headers.getSetCookie === 'function')
    {
        return headers.getSetCookie();
    }
    const value = headers.get('set-cookie');
    return value === null ? [] : splitCombinedSetCookie(value);
}

function splitCombinedSetCookie(value)
{
    return String(value).split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/u).map(item => item.trim()).filter(Boolean);
}

function defaultCookiePath(pathname)
{
    if (!pathname.startsWith('/') || pathname === '/')
    {
        return '/';
    }
    const lastSlash = pathname.lastIndexOf('/');
    return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function domainMatches(hostname, domain)
{
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

function cookieMatchesRequest(cookie, url)
{
    const hostname = url.hostname.toLowerCase();
    const domainMatch = cookie.hostOnly ? hostname === cookie.domain : domainMatches(hostname, cookie.domain);
    const pathMatch = url.pathname === cookie.path
    || (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
    return !cookieExpired(cookie) && domainMatch && pathMatch && (!cookie.secure || url.protocol === 'https:');
}

function cookieExpired(cookie)
{
    return Number.isFinite(cookie.expiresAt) && cookie.expiresAt <= Date.now();
}

function removeExpiredCookies(jar)
{
    for (const [key, cookie] of jar)
    {
        if (cookieExpired(cookie))
        {
            jar.delete(key);
        }
    }
}

function cookieKey(cookie)
{
    return `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
}

function cookieEvidence(cookie)
{
    return {
        name: cookie.name,
        domain: cookie.domain,
        hostOnly: cookie.hostOnly,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        deleted: cookie.deleted,
        valueSha256: sha256(cookie.value)
    };
}

async function readResponseBytes(response)
{
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES)
    {
        throw new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    return bytes;
}

function evaluateResponseAssertions(response, bytes, request, requestCookies, responseCookies)
{
    const errors = [];
    const assertions = request.responseAssertions ?? {};
    const headerResults = [];
    for (let index = 0; index < (assertions.headers ?? []).length; index += 1)
    {
        const assertion = assertions.headers[index];
        const name = assertion.name.toLowerCase();
        const actual = response.headers.get(name);
        let pass = false;
        if (assertion.operator === 'present')
        {
            pass = actual !== null;
        }
        else if (assertion.operator === 'absent')
        {
            pass = actual === null;
        }
        else if (assertion.operator === 'equals')
        {
            pass = actual === assertion.value;
        }
        else if (assertion.operator === 'contains')
        {
            pass = actual?.includes(assertion.value) === true;
        }
        if (!pass)
        {
            errors.push(`header_assertion_${index}_${safeCode(name)}_${assertion.operator}`);
        }
        headerResults.push({
            name,
            operator: assertion.operator,
            expectedSha256: assertion.value === undefined ? null : sha256(assertion.value),
            actualSha256: actual === null ? null : sha256(actual),
            actual: SAFE_EVIDENCE_HEADERS.has(name) ? actual : null,
            pass
        });
    }
    const bodyResult = evaluateBodyAssertions(assertions.body, bytes);
    errors.push(...bodyResult.errors);
    const aedsResult = assertions.aeds === undefined ? null : evaluateAedsAssertions(assertions.aeds, response, bytes);
    if (aedsResult !== null)
    {
        errors.push(...aedsResult.errors);
    }
    const cookieResult = evaluateCookieAssertions(request.cookieAssertions, requestCookies, responseCookies);
    errors.push(...cookieResult.errors);
    return {
        errors: [...new Set(errors)],
        headers: headerResults,
        selectedHeaders: selectResponseHeaders(response.headers),
        body: bodyResult.evidence,
        aeds: aedsResult?.evidence ?? null,
        cookies: cookieResult.evidence
    };
}

function evaluateBodyAssertions(plan, bytes)
{
    const errors = [];
    const digest = sha256(bytes);
    const checks = [];
    if (plan?.sha256 !== undefined)
    {
        checks.push(check('sha256', digest === plan.sha256, plan.sha256, digest));
    }
    if (plan?.minBytes !== undefined)
    {
        checks.push(check('minBytes', bytes.length >= plan.minBytes, plan.minBytes, bytes.length));
    }
    if (plan?.maxBytes !== undefined)
    {
        checks.push(check('maxBytes', bytes.length <= plan.maxBytes, plan.maxBytes, bytes.length));
    }
    let text = null;
    for (let index = 0; index < (plan?.utf8Contains ?? []).length; index += 1)
    {
        const expected = plan.utf8Contains[index];
        text ??= bytes.toString('utf8');
        checks.push(check(`utf8Contains:${index}`, text.includes(expected), sha256(expected), null));
    }
    let json = null;
    let jsonError = null;
    if ((plan?.json?.length ?? 0) > 0)
    {
        try
        {
            json = JSON.parse(bytes.toString('utf8'));
        }
        catch (error)
        {
            jsonError = message(error);
        }
    }
    for (let index = 0; index < (plan?.json ?? []).length; index += 1)
    {
        const assertion = plan.json[index];
        const actual = jsonError === null ? jsonPointer(json, assertion.pointer) : undefined;
        checks.push(check(
            `json:${index}:${assertion.pointer}`,
            jsonError === null && canonicalJson(actual) === canonicalJson(assertion.equals),
            sha256(canonicalJson(assertion.equals)),
      actual === undefined ? null : sha256(canonicalJson(actual))));
    }
    for (const item of checks)
    {
        if (!item.pass)
        {
            errors.push(`body_assertion_${safeCode(item.kind)}`);
        }
    }
    if (jsonError !== null)
    {
        errors.push('body_assertion_json_parse');
    }
    return {
        errors: [...new Set(errors)],
        evidence: { bytes: bytes.length, sha256: digest, checks, jsonParseError: jsonError }
    };
}

function evaluateAedsAssertions(plan, response, bytes)
{
    const errors = [];
    const evidence = {
        contentType: response.headers.get('content-type'),
        magic: null,
        version: null,
        headerLength: null,
        flags: null,
        frameType: null,
        payloadBytes: null,
        payloadSha256: null,
        payloadCrc16: null,
        computedPayloadCrc16: null,
        checks: []
    };
    if (!(evidence.contentType ?? '').toLowerCase().includes('application/octet-stream'))
    {
        errors.push('aeds_content_type');
    }
    if (bytes.length < 16)
    {
        errors.push('aeds_frame_too_short');
        return { errors, evidence };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    evidence.magic = view.getUint32(0, true);
    evidence.version = view.getUint8(4);
    evidence.headerLength = view.getUint8(5);
    evidence.flags = view.getUint16(6, true);
    evidence.frameType = view.getUint16(8, true);
    evidence.payloadBytes = view.getUint32(10, true);
    evidence.payloadCrc16 = view.getUint16(14, true);
    const payload = bytes.subarray(16);
    evidence.payloadSha256 = sha256(payload);
    evidence.computedPayloadCrc16 = crc16(payload);
    const checks = [
        check('magic', evidence.magic === 0x53444541, 0x53444541, evidence.magic),
        check('version', evidence.version === 2, 2, evidence.version),
        check('headerLength', evidence.headerLength === 16, 16, evidence.headerLength),
        check('flags', evidence.flags === (plan.flags ?? 0), plan.flags ?? 0, evidence.flags),
        check('frameType', plan.frameTypes.includes(evidence.frameType), plan.frameTypes, evidence.frameType),
        check('payloadLength', evidence.payloadBytes === payload.length, evidence.payloadBytes, payload.length),
        check('payloadCrc16', evidence.payloadCrc16 === evidence.computedPayloadCrc16, evidence.payloadCrc16, evidence.computedPayloadCrc16)
    ];
    if (plan.payloadSha256 !== undefined)
    {
        checks.push(check('payloadSha256', evidence.payloadSha256 === plan.payloadSha256, plan.payloadSha256, evidence.payloadSha256));
    }
    if (plan.minPayloadBytes !== undefined)
    {
        checks.push(check('minPayloadBytes', payload.length >= plan.minPayloadBytes, plan.minPayloadBytes, payload.length));
    }
    if (plan.maxPayloadBytes !== undefined)
    {
        checks.push(check('maxPayloadBytes', payload.length <= plan.maxPayloadBytes, plan.maxPayloadBytes, payload.length));
    }
    evidence.checks = checks;
    for (const item of checks)
    {
        if (!item.pass)
        {
            errors.push(`aeds_${safeCode(item.kind)}`);
        }
    }
    return { errors, evidence };
}

function evaluateCookieAssertions(plan, requestCookies, responseCookies)
{
    const requestNames = new Set(requestCookies.map(cookie => cookie.name));
    const responseSetNames = new Set(responseCookies.filter(cookie => !cookie.deleted).map(cookie => cookie.name));
    const responseDeletedNames = new Set(responseCookies.filter(cookie => cookie.deleted).map(cookie => cookie.name));
    const errors = [];
    for (const name of plan?.requestPresent ?? [])
    {
        if (!requestNames.has(name))
        {
            errors.push(`cookie_request_missing_${safeCode(name)}`);
        }
    }
    for (const name of plan?.requestAbsent ?? [])
    {
        if (requestNames.has(name))
        {
            errors.push(`cookie_request_unexpected_${safeCode(name)}`);
        }
    }
    for (const name of plan?.responseSet ?? [])
    {
        if (!responseSetNames.has(name))
        {
            errors.push(`cookie_response_set_missing_${safeCode(name)}`);
        }
    }
    for (const name of plan?.responseDeleted ?? [])
    {
        if (!responseDeletedNames.has(name))
        {
            errors.push(`cookie_response_delete_missing_${safeCode(name)}`);
        }
    }
    return {
        errors,
        evidence: {
            request: requestCookies,
            response: responseCookies,
            checks: {
                requestPresent: [...(plan?.requestPresent ?? [])],
                requestAbsent: [...(plan?.requestAbsent ?? [])],
                responseSet: [...(plan?.responseSet ?? [])],
                responseDeleted: [...(plan?.responseDeleted ?? [])]
            }
        }
    };
}

function selectResponseHeaders(headers)
{
    const selected = {};
    for (const name of SAFE_EVIDENCE_HEADERS)
    {
        const value = headers.get(name);
        if (value !== null)
        {
            selected[name] = { value, sha256: sha256(value) };
        }
    }
    const setCookies = getSetCookieHeaders(headers).map(value =>
    {
        const first = String(value).split(';', 1)[0];
        const separator = first.indexOf('=');
        return separator <= 0
            ? null
            : { name: first.slice(0, separator).trim(), valueSha256: sha256(first.slice(separator + 1)) };
    }).filter(Boolean);
    if (setCookies.length > 0)
    {
        selected['set-cookie'] = setCookies;
    }
    return selected;
}

function evaluateReleaseIdentity(probe, stage, category, releaseId, releaseSlot)
{
    let role = null;
    if (releaseId === probe.source.releaseId && releaseSlot === probe.source.slot)
    {
        role = 'source';
    }
    if (releaseId === probe.target.releaseId && releaseSlot === probe.target.slot)
    {
        role = 'target';
    }
    const errors = [];
    let allowed = ['source', 'target'];
    if (probe.probeMode === 'candidate-direct')
    {
        allowed = ['target'];
    }
    else if (probe.releaseIdentityPolicy !== null)
    {
        const key = `${stage}\0${category}`;
        allowed = probe.releaseIdentityPolicy.get(key) ?? [];
        const coverageKey = `${stage}/${category}`;
        increment(probe.releasePolicyCoverage, coverageKey);
        if (allowed.length === 0)
        {
            errors.push(`release_policy_missing_${safeCode(stage)}_${safeCode(category)}`);
        }
    }
    if (role === null)
    {
        errors.push('release_identity_unknown_or_mismatched');
    }
    else if (!allowed.includes(role))
    {
        errors.push(`release_identity_${role}_not_allowed`);
    }
    if (errors.length > 0)
    {
        probe.releaseIdentityViolationCount += 1;
    }
    return {
        role,
        identity: role === null ? null : probe[role],
        allowed: [...allowed],
        errors
    };
}

function evaluateGatewaySwitchHold(probe, request, startContext, completedContext, releaseResult, latencyMs, bytes)
{
    const plan = request.holdAcrossGatewaySwitch;
    if (plan === undefined)
    {
        return { required: false, pass: true, errors: [] };
    }
    if (probe.probeMode === 'candidate-direct')
    {
        return { required: false, pass: true, skippedReason: 'candidate-direct', errors: [] };
    }
    const errors = [];
    const startIndex = ROLLOUT_STAGES.indexOf(startContext.stage);
    const gatewayIndex = ROLLOUT_STAGES.indexOf('gateway-switch');
    if (startContext.switchCommitted !== false || startIndex < 0 || startIndex > gatewayIndex)
    {
        errors.push('gateway_hold_did_not_start_before_commit');
    }
    if (completedContext.switchCommitted !== true || !Number.isSafeInteger(completedContext.gatewayGeneration))
    {
        errors.push('gateway_hold_did_not_complete_after_commit');
    }
    if ((plan.requireTargetResponse ?? true) && releaseResult.role !== 'target')
    {
        errors.push('gateway_hold_response_not_from_target');
    }
    if (latencyMs < (plan.minimumDurationMs ?? 0))
    {
        errors.push('gateway_hold_duration_too_short');
    }
    const pass = errors.length === 0;
    const record = probe.gatewaySwitchHolds.get(request.id) ?? {
        required: true,
        attempts: 0,
        passCount: 0,
        failCount: 0,
        observations: []
    };
    const observation = {
        startedAt: startContext,
        completedAt: completedContext,
        latencyMs,
        releaseRole: releaseResult.role,
        responseBodySha256: sha256(bytes),
        pass,
        errors,
        bindingSha256: null
    };
    observation.bindingSha256 = sha256(canonicalJson({ ...observation, bindingSha256: undefined }));
    record.attempts += 1;
    if (pass)
    {
        record.passCount += 1;
    }
    else
    {
        record.failCount += 1;
    }
    record.observations.push(observation);
    probe.gatewaySwitchHolds.set(request.id, record);
    return { required: true, pass, errors, bindingSha256: observation.bindingSha256 };
}

function responseObservation(input)
{
    return {
        schema: 'fsusblog.release-traffic-response-observation.v1',
        requestId: input.request.id,
        category: input.request.category,
        session: input.sessionContext === null
            ? null
            : { chainId: input.sessionContext.chainId, cycle: input.sessionContext.cycle, step: input.sessionContext.step },
        startedAtUtc: input.startedAtUtc,
        completedAtUtc: input.completedAtUtc,
        startContext: input.startContext,
        completedContext: input.completedContext,
        httpStatus: input.response.status,
        latencyMs: input.latencyMs,
        release: {
            releaseId: input.releaseId,
            slot: input.releaseSlot,
            role: input.releaseResult.role,
            resolvedIdentity: input.releaseResult.identity,
            allowedRoles: input.releaseResult.allowed,
            errors: input.releaseResult.errors
        },
        selectedHeaders: input.assertionResult.selectedHeaders,
        headerAssertions: input.assertionResult.headers,
        body: input.assertionResult.body,
        aeds: input.assertionResult.aeds,
        cookies: input.assertionResult.cookies,
        gatewaySwitchHold: input.holdResult,
        errors: [...new Set([
            ...input.assertionResult.errors,
            ...input.releaseResult.errors,
            ...input.holdResult.errors
        ])]
    };
}

function recordResponseObservation(probe, observation)
{
    const observationSha256 = sha256(canonicalJson(observation));
    probe.observationDigests.push(observationSha256);
    probe.observationHashChain = sha256(`${probe.observationHashChain}\0${observationSha256}`);
    probe.observationCount += 1;
    const key = `${observation.startContext.stage}/${observation.requestId}`;
    const record = probe.responseObservations.get(key) ?? {
        stage: observation.startContext.stage,
        requestId: observation.requestId,
        category: observation.category,
        count: 0,
        statusCodes: new Map(),
        releaseRoles: new Map(),
        bodySha256: new Map(),
        firstObservedAtUtc: observation.completedAtUtc,
        lastObservedAtUtc: null,
        lastObservation: null
    };
    record.count += 1;
    increment(record.statusCodes, String(observation.httpStatus));
    increment(record.releaseRoles, observation.release.role ?? 'invalid');
    increment(record.bodySha256, observation.body.sha256);
    record.lastObservedAtUtc = observation.completedAtUtc;
    record.lastObservation = { ...observation, observationSha256 };
    probe.responseObservations.set(key, record);
}

function serializeResponseObservations(value)
{
    return [...value.values()]
        .sort((left, right) => `${left.stage}/${left.requestId}`.localeCompare(`${right.stage}/${right.requestId}`))
        .map(record => ({
            stage: record.stage,
            requestId: record.requestId,
            category: record.category,
            count: record.count,
            statusCodes: Object.fromEntries(record.statusCodes),
            releaseRoles: Object.fromEntries(record.releaseRoles),
            bodySha256: Object.fromEntries(record.bodySha256),
            firstObservedAtUtc: record.firstObservedAtUtc,
            lastObservedAtUtc: record.lastObservedAtUtc,
            lastObservation: record.lastObservation
        }));
}

function gatewayHoldsPass(probe)
{
    if (probe.probeMode === 'candidate-direct')
    {
        return true;
    }
    const required = probe.scenario.requests.filter(request => request.holdAcrossGatewaySwitch !== undefined);
    return required.every(request => (probe.gatewaySwitchHolds.get(request.id)?.passCount ?? 0) > 0);
}

function sessionChainsPass(probe)
{
    return probe.sessionChains.every(chain =>
    {
        const evidence = probe.sessionChainEvidence.get(chain.id);
        return evidence !== undefined && evidence.completedCycles > 0 && evidence.failedCycles === 0;
    });
}

function compileReleaseIdentityPolicy(value)
{
    if (value === undefined)
    {
        return null;
    }
    const result = new Map();
    for (const rule of value.rules)
    {
        for (const stage of rule.stages)
        {
            for (const category of rule.categories)
            {
                result.set(`${stage}\0${category}`, [...rule.allowed]);
            }
        }
    }
    return result;
}

function releaseIdentity(value)
{
    return {
        releaseId: value.releaseId,
        imageDigest: value.imageDigest,
        slot: value.slot,
        generation: value.runtimeGeneration
    };
}

function readBindingKey(file, required)
{
    if (file === null)
    {
        if (required)
        {
            throw new Error('--binding-key-file is required by the traffic scenario');
        }
        return null;
    }
    const resolved = canonicalPrivateFile(file, 'binding key file');
    const key = fs.readFileSync(resolved);
    if (key.length < 32 || key.length > 4096)
    {
        throw new Error('binding key file must contain 32..4096 bytes');
    }
    return key;
}

function sealFinalReport(probe, options, report)
{
    if (probe.bindingKey === null)
    {
        return report;
    }
    const finalRolloutStateSha256 = hashFile(options.rolloutState);
    const payloadSha256 = sha256(canonicalJson(report));
    const binding = {
        schema: 'fsusblog.release-traffic-final-binding.v1',
        algorithm: 'hmac-sha256',
        keyId: hmacSha256(probe.bindingKey, 'fsusblog.release-traffic-binding-key-id.v1'),
        rolloutId: probe.rolloutId,
        scenarioSha256: probe.scenarioSha256,
        initialRolloutStateSha256: probe.initialRolloutStateSha256,
        finalRolloutStateSha256,
        observationCount: probe.observationCount,
        observationHashChain: probe.observationHashChain,
        payloadSha256,
        signature: null
    };
    binding.signature = hmacSha256(probe.bindingKey, canonicalJson({ ...binding, signature: undefined }));
    probe.bindingKey.fill(0);
    probe.bindingKey = null;
    return { ...report, finalBinding: binding };
}

function canonicalPrivateFile(file, label)
{
    const resolved = path.resolve(file);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    if (![0o400, 0o600].includes(stat.mode & 0o777))
    {
        throw new Error(`${label} must have mode 0400 or 0600`);
    }
    return fs.realpathSync(resolved);
}

function hashFile(file)
{
    return sha256(fs.readFileSync(path.resolve(file)));
}

function hmacSha256(key, value)
{
    return `hmac-sha256:${crypto.createHmac('sha256', key).update(value).digest('hex')}`;
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value)
{
    if (value === undefined)
    {
        return 'null';
    }
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(item => canonicalJson(item)).join(',')}]`;
    }
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function jsonPointer(value, pointer)
{
    return pointer.split('/').slice(1).reduce((current, segment) =>
    {
        if (current === undefined || current === null)
        {
            return undefined;
        }
        const key = segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
        return current[key];
    }, value);
}

function validJsonPointer(value)
{
    return typeof value === 'string'
    && value.startsWith('/')
    && !value.includes('\0')
    && value.split('/').slice(1).every(segment => !/~(?:[^01]|$)/u.test(segment));
}

function check(kind, pass, expected, actual)
{
    return { kind, pass, expected, actual };
}

function safeCode(value)
{
    return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 80) || 'unknown';
}

function crc16(bytes)
{
    let crc = 0xffff;
    for (let index = 0; index < bytes.length; index += 1)
    {
        crc ^= bytes[index];
        for (let bit = 0; bit < 8; bit += 1)
        {
            crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
        }
    }
    return crc & 0xffff;
}

function isObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function message(error)
{
    return error instanceof Error ? error.message : String(error);
}

function recordStageFailure(probe, stage, requestId, code)
{
    const key = `${stage}:${requestId}:${code}`.slice(0, 240);
    increment(probe.stageFailures, key);
    probe.errors.push({ stage, requestId, code, observedAtUtc: new Date().toISOString() });
}

function addLatency(probe, value, stage)
{
    if (probe.latencySamples.length < MAX_LATENCY_SAMPLES)
    {
        probe.latencySamples.push(value);
    }
    else
    {
        const index = probe.totalRequests % MAX_LATENCY_SAMPLES;
        probe.latencySamples[index] = value;
    }
    const phase = latencyPhase(stage);
    const phaseSamples = probe.latencySamplesByPhase[phase];
    if (phaseSamples.length < MAX_LATENCY_SAMPLES)
    {
        phaseSamples.push(value);
    }
    else
    {
        phaseSamples[probe.totalRequests % MAX_LATENCY_SAMPLES] = value;
    }
}

function latencyPhase(stage)
{
    if (BASELINE_STAGES.has(stage))
    {
        return 'baseline';
    }
    if (OVERLAP_STAGES.has(stage))
    {
        return 'overlap';
    }
    if (stage === 'source-stop' || stage === 'release-evidence' || stage === 'status:completed')
    {
        return 'targetOnly';
    }
    return 'unclassified';
}

function latencySummary(sorted)
{
    return {
        samples: sorted.length,
        p50: percentile(sorted, 0.50),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted.at(-1) ?? null
    };
}

function latencyImpactPercent(baseline, overlap)
{
    if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(overlap) || overlap < 0)
    {
        return null;
    }
    return Math.max(0, ((overlap - baseline) / baseline) * 100);
}

function increment(map, key)
{
    map.set(key, (map.get(key) ?? 0) + 1);
}

function percentile(values, quantile)
{
    if (values.length === 0)
    {
        return null;
    }
    return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))];
}

function normalizeBaseUrl(value)
{
    const url = new URL(value);
    const localHttp = process.env.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE === '1' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp)
    {
        throw new Error('--base-url must use HTTPS (local test HTTP requires FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE=1)');
    }
    if (url.username || url.password || url.search || url.hash)
    {
        throw new Error('--base-url must not contain credentials, query or fragment');
    }
    url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return url;
}

function writeJsonAtomic(file, value)
{
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, resolved);
}

function boundedInteger(value, minimum, maximum, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    {
        throw new Error(`--${label} must be ${minimum}..${maximum}`);
    }
    return parsed;
}

function delay(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
