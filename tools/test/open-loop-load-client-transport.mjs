import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import { isIP, Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { canonicalJson } from './attempt-provenance.mjs';
import { fetchRouteSample, routeContract } from './lanes/runtime-http-route-contract.mjs';

const policyKeys = ['transportId', 'nodeVersion', 'clientLibrary', 'clientVersion', 'httpVersion', 'allowH2',
    'maxConnectionsPerOrigin', 'maxPipelining', 'keepAliveTimeoutMs', 'connectTimeoutMs', 'headersTimeoutMs',
    'bodyTimeoutMs', 'connectionReusePolicy', 'dnsMode', 'dnsResult', 'proxyMode', 'tlsPolicy'];
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY'];
const controlErrors = new WeakMap();
const deadlineStages = new Set(['connect-timeout', 'headers-timeout', 'body-timeout', 'request-timeout']);
const networkCodes = new Map([
    ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['EAI_FAIL', 'dns'],
    ['ECONNREFUSED', 'connect'], ['EHOSTUNREACH', 'connect'], ['ENETUNREACH', 'connect'], ['EADDRNOTAVAIL', 'connect'],
    ['ETIMEDOUT', 'connect'],
    ['ECONNRESET', 'reset'], ['EPIPE', 'reset'], ['ERR_STREAM_PREMATURE_CLOSE', 'reset'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'], ['CERT_HAS_EXPIRED', 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'], ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'], ['ERR_TLS_HANDSHAKE_TIMEOUT', 'tls'],
    ['HPE_INVALID_CONSTANT', 'http-protocol'], ['HPE_INVALID_VERSION', 'http-protocol']
]);

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
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function exactObject(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    {
        throw new Error(`${label} requires every explicit field and no extra fields`);
    }
}

function loopback(address)
{
    return address === '::1' || (isIP(address) === 4 && address.split('.')[0] === '127');
}

function origin(value)
{
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password || url.origin !== value)
    {
        throw new Error('transport endpoint requires a canonical HTTP origin; TLS is unsupported');
    }
    return url;
}

function dnsRecords(records)
{
    if (!Array.isArray(records) || records.length === 0 || records.length > 16)
    {
        throw new Error('DNS seal requires a bounded non-empty result');
    }
    const result = records.map((record) =>
    {
        exactObject(record, ['address', 'family'], 'DNS result');
        if (!loopback(record.address) || isIP(record.address) !== record.family)
        {
            throw new Error('transport supports task-owned loopback DNS results only');
        }
        return { address: record.address, family: record.family };
    }).sort((a, b) => a.family - b.family || a.address.localeCompare(b.address));
    if (new Set(result.map((record) => record.address)).size !== result.length)
    {
        throw new Error('DNS seal contains duplicate addresses');
    }
    return result;
}

function rejectAmbientProxy()
{
    if (proxyKeys.some((key) => process.env[key]?.trim()))
    {
        throw new Error('ambient proxy configuration is forbidden for correctness transport');
    }
}

function transportError(stage)
{
    const error = new Error(`transport ${stage}`);
    error.transportStage = stage;
    controlErrors.set(error, deadlineStages.has(stage) ? 'deadline' : 'control');
    return error;
}

function errorFacts(error, depth = 0)
{
    return freeze({ name: typeof error?.name === 'string' ? error.name : null,
        code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : null,
        syscall: typeof error?.syscall === 'string' ? error.syscall : null,
        cause: error?.cause && depth < 3 ? errorFacts(error.cause, depth + 1) : null });
}

function validateErrorFacts(error, depth = 0)
{
    exactObject(error, ['name', 'code', 'syscall', 'cause'], 'typed transport error');
    if ((error.name !== null && (typeof error.name !== 'string' || !error.name))
        || (error.code !== null && !(typeof error.code === 'string' && error.code) && !Number.isSafeInteger(error.code))
        || (error.syscall !== null && (typeof error.syscall !== 'string' || !error.syscall))
        || (error.cause !== null && depth >= 3))
    {
        throw new Error('invalid typed transport error facts');
    }
    if (error.cause !== null)
    {
        validateErrorFacts(error.cause, depth + 1);
    }
}

/**
 * Classify only captured typed facts and the first failing control-flow event.
 * External merged signals require independent caller/deadline signal ports; an
 * AbortError/TimeoutError name or a timeout-shaped message never establishes origin.
 * TLS codes are understood for consumers, but this HTTP-only adapter does not run TLS.
 * The result contains no inferred worker, dispatcher timestamp origin, or run receipt.
 */
export function classifyLoadTransportFailure(facts)
{
    exactObject(facts, ['stage', 'event', 'error', 'cancellation'], 'transport failure facts');
    if (!['dns', 'pool', 'connect', 'headers', 'body', 'request'].includes(facts.stage)
        || !['native-error', 'control-error', 'deadline', 'signal-abort'].includes(facts.event))
    {
        throw new Error('missing or unsupported transport failure stage/event');
    }
    validateErrorFacts(facts.error);
    exactObject(facts.cancellation, ['origin', 'abortedSignals'], 'cancellation provenance');
    const { origin: cancellationOrigin, abortedSignals } = facts.cancellation;
    const signalNames = ['request-budget', 'transport-close', 'caller', 'dispatcher-deadline', 'merged', 'route-oracle'];
    if (!Array.isArray(abortedSignals) || new Set(abortedSignals).size !== abortedSignals.length
        || abortedSignals.some((name) => !signalNames.includes(name)))
    {
        throw new Error('invalid cancellation signal facts');
    }
    let outcome;
    let errorKind;
    let errorCode = facts.error.code;
    if (facts.event === 'deadline')
    {
        if (cancellationOrigin !== 'transport-stage-deadline' || abortedSignals.length !== 0
            || facts.error.name !== 'Error' || facts.error.code !== null
            || facts.error.syscall !== null || facts.error.cause !== null)
        {
            throw new Error('deadline requires actual owned timer control flow');
        }
        outcome = 'timeout';
        errorKind = `${facts.stage}-deadline`;
    }
    else if (facts.event === 'signal-abort')
    {
        const originSignal = new Map([['transport-request-deadline', 'request-budget'],
            ['route-oracle-deadline', 'route-oracle'], ['dispatcher-deadline', 'dispatcher-deadline'],
            ['caller', 'caller'], ['transport-close', 'transport-close']]);
        const requiredSignal = originSignal.get(cancellationOrigin);
        const explicit = abortedSignals.filter((name) => name !== 'merged');
        if (!requiredSignal || explicit.length !== 1 || explicit[0] !== requiredSignal)
        {
            throw new Error('missing or ambiguous cancellation provenance');
        }
        outcome = ['caller', 'transport-close'].includes(cancellationOrigin) ? 'cancelled' : 'timeout';
        errorKind = cancellationOrigin;
    }
    else
    {
        if (facts.event !== 'native-error' || cancellationOrigin !== 'none' || abortedSignals.length !== 0)
        {
            throw new Error('transport failure lacks classifiable native error provenance');
        }
        const codes = [];
        for (let error = facts.error; error !== null; error = error.cause)
        {
            if (networkCodes.has(error.code))
            {
                codes.push(error.code);
            }
        }
        const kinds = new Set(codes.map((code) => networkCodes.get(code)));
        if (kinds.size !== 1 || !facts.error.name)
        {
            throw new Error('missing or ambiguous typed network error code');
        }
        outcome = 'network-error';
        [errorKind] = kinds;
        [errorCode] = codes;
    }
    return freeze({ outcome, errorKind, errorCode, errorDigest: digest(facts) });
}

async function bounded(operation, timeoutMs, signal)
{
    const scope = new AbortController();
    const combined = AbortSignal.any([scope.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => scope.abort(transportError('connect-timeout')), timeoutMs);
    let onAbort;
    try
    {
        combined.throwIfAborted();
        return await Promise.race([operation(), new Promise((_, reject) =>
        {
            onAbort = () => reject(combined.reason);
            combined.addEventListener('abort', onAbort, { once: true });
        })]);
    }
    finally
    {
        clearTimeout(timer);
        combined.removeEventListener('abort', onAbort);
    }
}

/** Resolve before measurement. The caller must declare this exact result in its policy. */
export async function resolveLoadTransportDns(endpoint, { resolver = lookup, timeoutMs = 1000, signal } = {})
{
    if (typeof resolver !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    {
        throw new Error('DNS resolution requires a resolver and bounded timeout');
    }
    const hostname = origin(endpoint).hostname.replace(/^\[|\]$/gu, '');
    return freeze(dnsRecords(isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
        : await bounded(() => resolver(hostname, { all: true, verbatim: true }), timeoutMs, signal)));
}

/** Node core HTTP/1.1 only. Idle TTL is distinct from TCP keep-alive probing. */
export function validateLoadTransportPolicy(candidate)
{
    exactObject(candidate, policyKeys, 'transport policy');
    if (typeof candidate.transportId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(candidate.transportId)
        || candidate.nodeVersion !== process.versions.node || candidate.clientLibrary !== 'node:http'
        || candidate.clientVersion !== process.versions.node || candidate.httpVersion !== '1.1'
        || candidate.allowH2 !== false || candidate.maxPipelining !== 1
        || candidate.proxyMode !== 'direct-no-ambient' || candidate.tlsPolicy !== 'disabled-http'
        || !['keep-alive', 'close'].includes(candidate.connectionReusePolicy)
        || !['literal', 'sealed-lookup'].includes(candidate.dnsMode))
    {
        throw new Error('unsupported transport mode or actual Node/client version mismatch');
    }
    for (const key of ['maxConnectionsPerOrigin', 'keepAliveTimeoutMs', 'connectTimeoutMs', 'headersTimeoutMs', 'bodyTimeoutMs'])
    {
        const minimum = key === 'keepAliveTimeoutMs' && candidate.connectionReusePolicy === 'close' ? 0 : 1;
        const maximum = key === 'maxConnectionsPerOrigin' ? 256 : 60_000;
        if (!Number.isSafeInteger(candidate[key]) || candidate[key] < minimum || candidate[key] > maximum)
        {
            throw new Error(`invalid transport bound: ${key}`);
        }
    }
    if (candidate.connectionReusePolicy === 'close' && candidate.keepAliveTimeoutMs !== 0)
    {
        throw new Error('closed connections require zero idle keep-alive timeout');
    }
    return freeze({ ...candidate, dnsResult: dnsRecords(candidate.dnsResult) });
}

function verifyIdentity(identity)
{
    exactObject(identity, ['schema', 'policy', 'runBinding', 'endpoint', 'agent', 'contentDigest'], 'transport identity');
    const { contentDigest, ...content } = identity;
    validateLoadTransportPolicy(identity.policy);
    exactObject(identity.runBinding, ['runId', 'invocationId', 'attemptId', 'backendOrigin'], 'run binding');
    if (Object.values(identity.runBinding).some((value) => typeof value !== 'string' || !value.trim())
        || identity.schema !== 'fsusblog.load-client-transport.v1' || digest(content) !== contentDigest
        || identity.endpoint !== identity.runBinding.backendOrigin)
    {
        throw new Error('transport identity or caller-owned run binding differs');
    }
    origin(identity.endpoint);
    const expected = { type: 'node:http.Agent', global: false, keepAlive: identity.policy.connectionReusePolicy === 'keep-alive',
        maxSockets: identity.policy.maxConnectionsPerOrigin, maxTotalSockets: identity.policy.maxConnectionsPerOrigin,
        maxFreeSockets: identity.policy.maxConnectionsPerOrigin, scheduling: 'fifo' };
    if (canonicalJson(identity.agent) !== canonicalJson(expected))
    {
        throw new Error('explicit Agent configuration differs from policy');
    }
    return identity;
}

/** Verify observed socket facts. This is source telemetry, never a production run receipt. */
export function verifyLoadTransportObservation(identity, observation)
{
    verifyIdentity(identity);
    if (!observation || observation.identityDigest !== identity.contentDigest
        || observation.transportId !== identity.policy.transportId || observation.agentType !== 'node:http.Agent'
        || observation.globalAgent !== false || observation.nodeVersion !== process.versions.node
        || observation.clientLibrary !== 'node:http' || observation.clientVersion !== process.versions.node
        || observation.httpVersion !== identity.policy.httpVersion || observation.endpoint !== identity.endpoint
        || observation.dnsDigest !== digest(identity.policy.dnsResult)
        || !identity.policy.dnsResult.some((record) => record.address === observation.remoteAddress)
        || observation.remotePort !== Number(origin(identity.endpoint).port || 80)
        || typeof observation.connectionId !== 'string' || !observation.connectionId
        || !loopback(observation.localAddress) || !Number.isInteger(observation.localPort) || observation.localPort < 1
        || typeof observation.reusedSocket !== 'boolean' || typeof observation.nodeReusedSocket !== 'boolean'
        || !Number.isSafeInteger(observation.connectionRequestCount)
        || observation.connectionRequestCount < 1 || observation.reusedSocket !== (observation.connectionRequestCount > 1)
        || (identity.policy.connectionReusePolicy === 'close' && observation.reusedSocket))
    {
        throw new Error('actual transport observation differs or connection reuse metrics are missing');
    }
    return observation;
}

/** Consumers must partition before comparing cohorts or calculating combined percentiles. */
export function assertLoadTransportCohort(identity, observations)
{
    verifyIdentity(identity);
    if (!Array.isArray(observations) || observations.length === 0)
    {
        throw new Error('transport cohort requires actual observations');
    }
    observations.forEach((observation) => verifyLoadTransportObservation(identity, observation));
    return identity.contentDigest;
}

/**
 * Consume dispatchOpenLoopLoadSchedule's request port without owning a runner.
 * runBinding comes from the original runtime owner; loopback never proves that identity.
 * onObservation is synchronous and fail-closed, with real pool/lifecycle counters for a collector.
 * DNS rechecks are recorded, while socket lookup uses only the immutable sealed address.
 * reusedSocket counts actual assignments; nodeReusedSocket preserves Node's separate flag,
 * which is false when a queued request directly receives a previously used socket.
 * connectTimeoutMs covers DNS verification, pool wait and TCP connect separately; the
 * schedule's requestTimeoutMs also bounds the complete operation including response body.
 * request-error.failureFacts preserves typed errors before the route oracle catches them.
 * Optional request callerSignal/deadlineSignal identify distinct dispatcher origins;
 * the legacy merged signal alone cannot prove cancellation versus dispatcher deadline.
 * Failure provenance stays in onObservation, preserving the returned route sample shape.
 * responseFacts accompanies headers/error/completion events with explicit availability.
 * bytesReceived counts de-framed body data delivered by IncomingMessage, not wire bytes;
 * it is zero before headers, without implying an observed HTTP status or content type.
 * bodyState is complete only after the body end event; first terminal facts are frozen.
 * close() destroys owned sockets and waits for outstanding request cleanup.
 */
export async function createOpenLoopLoadClientTransport({ policy: candidate, endpoint, runBinding,
    resolver = lookup, onObservation = () =>
    {}, requestPaths = {}, headers = {} })
{
    rejectAmbientProxy();
    const policy = validateLoadTransportPolicy(candidate);
    const url = origin(endpoint);
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    if ((isIP(hostname) ? 'literal' : 'sealed-lookup') !== policy.dnsMode)
    {
        throw new Error('DNS mode differs from endpoint');
    }
    if (typeof resolver !== 'function' || typeof onObservation !== 'function')
    {
        throw new Error('transport requires resolver and observation function ports');
    }
    const resolved = await resolveLoadTransportDns(endpoint, { resolver, timeoutMs: policy.connectTimeoutMs });
    if (canonicalJson(resolved) !== canonicalJson(policy.dnsResult))
    {
        throw new Error('DNS result differs from premeasurement seal');
    }
    const agentConfig = { type: 'node:http.Agent', global: false, keepAlive: policy.connectionReusePolicy === 'keep-alive',
        maxSockets: policy.maxConnectionsPerOrigin, maxTotalSockets: policy.maxConnectionsPerOrigin,
        maxFreeSockets: policy.maxConnectionsPerOrigin, scheduling: 'fifo' };
    const content = { schema: 'fsusblog.load-client-transport.v1', policy,
        runBinding: { ...runBinding }, endpoint, agent: agentConfig };
    const identity = freeze({ ...content, contentDigest: digest(content) });
    verifyIdentity(identity);
    const agent = new http.Agent({ keepAlive: agentConfig.keepAlive, maxSockets: agentConfig.maxSockets,
        maxTotalSockets: agentConfig.maxTotalSockets, maxFreeSockets: agentConfig.maxFreeSockets,
        scheduling: agentConfig.scheduling });
    const sockets = new Map();
    const active = new Set();
    const lifecycle = new AbortController();
    let closed = false;
    let sequence = 0;

    function snapshot()
    {
        return freeze({ activeRequests: active.size, socketCount: sockets.size,
            freeSocketCount: Object.values(agent.freeSockets).reduce((sum, rows) => sum + rows.length, 0),
            queuedRequests: Object.values(agent.requests).reduce((sum, rows) => sum + rows.length, 0), closed });
    }
    function observe(type, facts = {})
    {
        onObservation(freeze({ type, atMs: performance.now(), identityDigest: identity.contentDigest, ...snapshot(), ...facts }));
    }
    const createConnection = agent.createConnection.bind(agent);
    agent.createConnection = (options, callback) =>
    {
        // Agent can assign a queued request while another socket's close event drains.
        // Once the owner closes, those assignments receive an unconnected dead socket.
        const socket = closed ? new Socket() : createConnection(options, callback);
        const state = { connectionId: `socket-${sequence++}`, count: 0, idleTimer: null };
        sockets.set(socket, state);
        socket.once('close', () =>
        {
            clearTimeout(state.idleTimer);
            sockets.delete(socket);
        });
        if (closed)
        {
            socket.destroy();
        }
        return socket;
    };
    agent.on('free', (socket) =>
    {
        const state = sockets.get(socket);
        if (state && agentConfig.keepAlive)
        {
            clearTimeout(state.idleTimer);
            state.idleTimer = setTimeout(() => socket.destroy(), policy.keepAliveTimeoutMs);
            state.idleTimer.unref();
        }
    });

    async function execute(arrival, { signal, requestTimeoutMs, callerSignal, deadlineSignal })
    {
        if (closed)
        {
            throw new Error('transport is closed');
        }
        if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000)
        {
            throw new Error('transport requires a bounded schedule request timeout');
        }
        if ([signal, callerSignal, deadlineSignal].some((value) => value !== undefined && !(value instanceof AbortSignal)))
        {
            throw new Error('transport cancellation ports must be actual AbortSignals');
        }
        rejectAmbientProxy();
        const contract = routeContract(arrival.routeId);
        const requestPath = requestPaths[arrival.routeId] ?? contract.pathTemplate;
        const requestUrl = new URL(`${endpoint}${requestPath}`);
        if (requestUrl.origin !== endpoint || !requestPath.startsWith('/') || requestPath.startsWith('//')
            || requestUrl.hash || requestUrl.username || requestUrl.password)
        {
            throw new Error('route target cannot change transport authority');
        }
        const requestHeaders = { ...headers };
        if (Object.keys(requestHeaders).some((key) => ['host', 'connection', 'proxy-authorization', 'upgrade', 'transfer-encoding'].includes(key.toLowerCase())))
        {
            throw new Error('headers cannot override transport authority or connection policy');
        }
        const scope = new AbortController();
        const combined = AbortSignal.any([scope.signal, lifecycle.signal,
            ...[signal, callerSignal, deadlineSignal].filter((value) => value !== undefined)]);
        const totalTimer = setTimeout(() => scope.abort(transportError('request-timeout')), requestTimeoutMs);
        let transport = null;
        let failureStage = null;
        let phase = 'dns';
        let failureRecorded = false;
        let responseHeaders = null;
        let receivedBodyBytes = 0;
        let responseBodyEnded = false;
        let terminalResponseFacts = null;

        function responseFacts()
        {
            function headerFact(value, source, missingReason)
            {
                return value !== null ? { status: 'ok', value, source }
                    : { status: 'unavailable', value: null, reason: missingReason, source };
            }
            return freeze({ httpStatus: headerFact(responseHeaders?.httpStatus ?? null,
                'node:http.IncomingMessage.statusCode', 'response-headers-not-received'),
            contentType: headerFact(responseHeaders?.contentType ?? null,
                'node:http.IncomingMessage.headers.content-type',
                responseHeaders === null ? 'response-headers-not-received' : 'content-type-header-absent'),
            bytesReceived: { status: 'ok', value: receivedBodyBytes, unit: 'bytes', source: 'node:http.IncomingMessage.data' },
            bodyState: responseHeaders === null ? 'not-started' : responseBodyEnded ? 'complete' : 'partial' });
        }

        function recordFailure(error, event, oracleSignal)
        {
            if (failureRecorded)
            {
                return;
            }
            failureRecorded = true;
            const ports = [['request-budget', scope.signal], ['transport-close', lifecycle.signal],
                ['caller', callerSignal], ['dispatcher-deadline', deadlineSignal], ['merged', signal], ['route-oracle', oracleSignal]];
            const aborted = ports.filter(([, port]) => port?.aborted);
            const explicit = aborted.filter(([name]) => name !== 'merged');
            let cancellationOrigin = 'none';
            if (event === 'deadline')
            {
                cancellationOrigin = 'transport-stage-deadline';
            }
            else if (event === 'signal-abort')
            {
                const origins = new Map([['request-budget', 'transport-request-deadline'],
                    ['transport-close', 'transport-close'], ['caller', 'caller'],
                    ['dispatcher-deadline', 'dispatcher-deadline'], ['route-oracle', 'route-oracle-deadline']]);
                const merged = aborted.find(([name]) => name === 'merged');
                cancellationOrigin = explicit.length > 1 ? 'ambiguous' : explicit.length === 0 ? 'unattributed'
                    : merged && merged[1].reason !== explicit[0][1].reason ? 'ambiguous' : origins.get(explicit[0][0]);
            }
            else if (aborted.length > 0)
            {
                cancellationOrigin = 'ambiguous';
            }
            const failureFacts = freeze({ stage: phase, event, error: errorFacts(error),
                cancellation: { origin: cancellationOrigin,
                    abortedSignals: event === 'deadline' ? [] : aborted.map(([name]) => name) } });
            observe('request-error', { sampleId: arrival.sampleId, sequence: arrival.sequence,
                routeId: arrival.routeId, transport, failureFacts,
                responseFacts: terminalResponseFacts ?? responseFacts() });
        }
        try
        {
            const currentDns = await resolveLoadTransportDns(endpoint, { resolver, timeoutMs: policy.connectTimeoutMs, signal: combined });
            observe('dns-verified', { sampleId: arrival.sampleId, dnsResult: currentDns });
            if (canonicalJson(currentDns) !== canonicalJson(policy.dnsResult))
            {
                throw new Error('DNS drift during measurement');
            }
            const actualAgent = { ...agentConfig, keepAlive: agent.keepAlive, maxSockets: agent.maxSockets,
                maxTotalSockets: agent.maxTotalSockets, maxFreeSockets: agent.maxFreeSockets, scheduling: agent.scheduling };
            if (agent === http.globalAgent || canonicalJson(actualAgent) !== canonicalJson(agentConfig))
            {
                throw new Error('explicit Agent configuration drift');
            }
            const fetchImpl = (target, options) => new Promise((resolve, reject) =>
            {
                if (combined.aborted)
                {
                    failureStage = combined.reason?.transportStage ?? 'aborted';
                    recordFailure(combined.reason, 'signal-abort');
                    reject(combined.reason);
                    return;
                }
                if (target !== requestUrl.href || options.method !== contract.method || options.redirect !== 'manual')
                {
                    const error = new Error('route sampler changed request transport semantics');
                    recordFailure(error, 'control-error');
                    reject(error);
                    return;
                }
                const requestSignal = AbortSignal.any([combined, options.signal]);
                const pinned = policy.dnsResult[0];
                let timer;
                let settled = false;
                let response;
                phase = 'pool';
                let request;
                try
                {
                    request = http.request(requestUrl, { method: contract.method, headers: requestHeaders, agent,
                        family: pinned.family, autoSelectFamily: false,
                        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family) });
                }
                catch (error)
                {
                    failureStage = 'request-failed';
                    recordFailure(error, 'native-error', options.signal);
                    reject(error);
                    return;
                }
                function finish(error, value, event = 'native-error')
                {
                    if (settled)
                    {
                        return;
                    }
                    settled = true;
                    terminalResponseFacts = responseFacts();
                    clearTimeout(timer);
                    requestSignal.removeEventListener('abort', abort);
                    if (error !== null && error !== undefined)
                    {
                        failureStage = error.transportStage ?? (requestSignal.aborted ? 'aborted' : 'request-failed');
                        let observationError;
                        try
                        {
                            recordFailure(error, event, options.signal);
                        }
                        catch (observerError)
                        {
                            observationError = observerError;
                        }
                        // Node leaves destroyed queued requests until a socket becomes free.
                        // Remove this owned request before destroying sockets during close.
                        for (const [key, queued] of Object.entries(agent.requests))
                        {
                            const index = queued.indexOf(request);
                            if (index >= 0)
                            {
                                queued.splice(index, 1);
                                if (queued.length === 0)
                                {
                                    delete agent.requests[key];
                                }
                            }
                        }
                        response?.destroy();
                        request.destroy();
                        reject(observationError ?? error);
                    }
                    else
                    {
                        resolve(value);
                    }
                }
                function stageTimeout(stage, timeoutMs)
                {
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(transportError(`${stage}-timeout`), null, 'deadline'), timeoutMs);
                }
                function abort()
                {
                    finish(requestSignal.reason ?? transportError('aborted'), null, 'signal-abort');
                }
                request.on('error', (error) => finish(error));
                request.once('socket', (socket) =>
                {
                    phase = socket.connecting ? 'connect' : 'headers';
                    const state = sockets.get(socket);
                    clearTimeout(state?.idleTimer);
                    function connected()
                    {
                        if (settled)
                        {
                            return;
                        }
                        try
                        {
                            if (!state)
                            {
                                throw new Error('unowned socket or global dispatcher');
                            }
                            state.count += 1;
                            transport = { identityDigest: identity.contentDigest, transportId: policy.transportId,
                                nodeVersion: process.versions.node, clientLibrary: 'node:http', clientVersion: process.versions.node,
                                agentType: 'node:http.Agent', globalAgent: false, httpVersion: null, endpoint,
                                dnsDigest: digest(policy.dnsResult), connectionId: state.connectionId,
                                connectionRequestCount: state.count, reusedSocket: state.count > 1,
                                nodeReusedSocket: request.reusedSocket,
                                remoteAddress: socket.remoteAddress, remotePort: socket.remotePort,
                                localAddress: socket.localAddress, localPort: socket.localPort };
                            if (!policy.dnsResult.some((record) => record.address === socket.remoteAddress)
                                || socket.remotePort !== Number(url.port || 80))
                            {
                                throw new Error('actual remote endpoint differs from current-run backend');
                            }
                            phase = 'headers';
                            stageTimeout('headers', policy.headersTimeoutMs);
                            observe('socket-assigned', { sampleId: arrival.sampleId, transport });
                        }
                        catch (error)
                        {
                            finish(error, null, 'control-error');
                        }
                    }
                    if (socket.connecting)
                    {
                        socket.once('connect', connected);
                    }
                    else
                    {
                        connected();
                    }
                });
                request.once('response', (incoming) =>
                {
                    response = incoming;
                    responseHeaders = { httpStatus: incoming.statusCode ?? null,
                        contentType: incoming.headers['content-type'] === undefined ? null
                            : String(incoming.headers['content-type']).split(';', 1)[0].trim().toLowerCase() };
                    try
                    {
                        transport = freeze({ ...transport, httpVersion: incoming.httpVersion });
                        verifyLoadTransportObservation(identity, transport);
                        observe('response-headers', { sampleId: arrival.sampleId, transport, responseFacts: responseFacts() });
                    }
                    catch (error)
                    {
                        finish(error, null, 'control-error');
                        return;
                    }
                    phase = 'body';
                    stageTimeout('body', policy.bodyTimeoutMs);
                    const chunks = [];
                    incoming.on('data', (chunk) =>
                    {
                        if (settled)
                        {
                            return;
                        }
                        receivedBodyBytes += chunk.length;
                        if (receivedBodyBytes > contract.maximumBodyBytes)
                        {
                            finish(transportError('body-size-out-of-bounds'), null, 'control-error');
                            return;
                        }
                        chunks.push(chunk);
                    });
                    incoming.on('error', (error) => finish(error));
                    // IncomingMessage emits aborted before its typed ECONNRESET error.
                    // Preserve that native error; close supplies a code-less fallback only.
                    incoming.once('close', () =>
                    {
                        if (!incoming.complete)
                        {
                            finish(transportError('response-aborted'), null, 'control-error');
                        }
                    });
                    incoming.once('end', () =>
                    {
                        if (settled)
                        {
                            return;
                        }
                        responseBodyEnded = true;
                        try
                        {
                            const body = Buffer.concat(chunks);
                            finish(null, { status: incoming.statusCode, headers: new Headers(incoming.headers),
                                arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
                        }
                        catch (error)
                        {
                            finish(error, null, 'control-error');
                        }
                    });
                });
                requestSignal.addEventListener('abort', abort, { once: true });
                stageTimeout('connect', policy.connectTimeoutMs);
                if (requestSignal.aborted)
                {
                    abort();
                }
                else
                {
                    request.end();
                }
            });
            const sample = await fetchRouteSample({ routeId: arrival.routeId, baseUrl: endpoint,
                requestPath, headers: requestHeaders, timeoutMs: requestTimeoutMs, fetchImpl });
            if (failureStage)
            {
                sample.failureKind = failureStage.endsWith('-timeout') ? 'timeout'
                    : combined.aborted ? 'cancelled' : failureStage;
                sample.ok = false;
            }
            observe('request-completed', { sampleId: arrival.sampleId, transport, failureStage, ok: sample.ok,
                responseFacts: terminalResponseFacts ?? responseFacts() });
            return { ...sample, transport, transportFailureStage: failureStage };
        }
        catch (error)
        {
            const event = combined.aborted && combined.reason === error ? 'signal-abort'
                : controlErrors.get(error) === 'deadline' ? 'deadline'
                    : typeof error?.code === 'string' || typeof error?.code === 'number' ? 'native-error' : 'control-error';
            recordFailure(error, event);
            throw error;
        }
        finally
        {
            clearTimeout(totalTimer);
        }
    }

    function request(arrival, options)
    {
        const task = Promise.resolve().then(() => execute(arrival, options));
        active.add(task);
        return task.finally(() => active.delete(task));
    }
    async function close()
    {
        closed = true;
        lifecycle.abort(transportError('closed'));
        for (const state of sockets.values())
        {
            clearTimeout(state.idleTimer);
        }
        agent.destroy();
        await Promise.allSettled([...active]);
        while (sockets.size > 0)
        {
            const closing = [...sockets.keys()].map((socket) => new Promise((resolve) => socket.once('close', resolve)));
            agent.destroy();
            await Promise.all(closing);
        }
        observe('transport-closed');
    }
    return Object.freeze({ identity, request, snapshot, close });
}
