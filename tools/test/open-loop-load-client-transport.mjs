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
    return error;
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

    async function execute(arrival, { signal, requestTimeoutMs })
    {
        if (closed)
        {
            throw new Error('transport is closed');
        }
        if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000)
        {
            throw new Error('transport requires a bounded schedule request timeout');
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
        const combined = AbortSignal.any([scope.signal, lifecycle.signal, ...(signal ? [signal] : [])]);
        const totalTimer = setTimeout(() => scope.abort(transportError('request-timeout')), requestTimeoutMs);
        let transport = null;
        let failureStage = null;
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
                    reject(combined.reason);
                    return;
                }
                if (target !== requestUrl.href || options.method !== contract.method || options.redirect !== 'manual')
                {
                    reject(new Error('route sampler changed request transport semantics'));
                    return;
                }
                const requestSignal = AbortSignal.any([combined, options.signal]);
                const pinned = policy.dnsResult[0];
                let timer;
                let settled = false;
                let response;
                const request = http.request(requestUrl, { method: contract.method, headers: requestHeaders, agent,
                    family: pinned.family, autoSelectFamily: false,
                    lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family) });
                function finish(error, value)
                {
                    if (settled)
                    {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    requestSignal.removeEventListener('abort', abort);
                    if (error)
                    {
                        failureStage = error.transportStage ?? (requestSignal.aborted ? 'aborted' : 'request-failed');
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
                        reject(error);
                    }
                    else
                    {
                        resolve(value);
                    }
                }
                function stageTimeout(stage, timeoutMs)
                {
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(transportError(`${stage}-timeout`)), timeoutMs);
                }
                function abort()
                {
                    finish(requestSignal.reason ?? transportError('aborted'));
                }
                request.on('error', (error) => finish(error));
                request.once('socket', (socket) =>
                {
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
                            stageTimeout('headers', policy.headersTimeoutMs);
                            observe('socket-assigned', { sampleId: arrival.sampleId, transport });
                        }
                        catch (error)
                        {
                            finish(error);
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
                    try
                    {
                        transport = freeze({ ...transport, httpVersion: incoming.httpVersion });
                        verifyLoadTransportObservation(identity, transport);
                        observe('response-headers', { sampleId: arrival.sampleId, transport });
                    }
                    catch (error)
                    {
                        finish(error);
                        return;
                    }
                    stageTimeout('body', policy.bodyTimeoutMs);
                    const chunks = [];
                    let bytes = 0;
                    incoming.on('data', (chunk) =>
                    {
                        bytes += chunk.length;
                        if (bytes > contract.maximumBodyBytes)
                        {
                            finish(transportError('body-size-out-of-bounds'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    incoming.on('error', (error) => finish(error));
                    incoming.once('aborted', () => finish(transportError('response-aborted')));
                    incoming.once('end', () =>
                    {
                        try
                        {
                            const body = Buffer.concat(chunks);
                            finish(null, { status: incoming.statusCode, headers: new Headers(incoming.headers),
                                arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
                        }
                        catch (error)
                        {
                            finish(error);
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
            observe('request-completed', { sampleId: arrival.sampleId, transport, failureStage, ok: sample.ok });
            return { ...sample, transport, transportFailureStage: failureStage };
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
