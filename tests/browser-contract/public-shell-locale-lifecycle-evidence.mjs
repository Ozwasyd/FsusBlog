/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createPublicShellLocaleResourceBarrier } from './public-shell-locale-harness.mjs';
import { mutatePublicShellLocaleDomainResource, readPublicShellLocaleForeignBuildResource } from './public-shell-locale-runtime-bindings.mjs';
import { readPublicShellLocaleDom } from './public-shell-locale-scene-driver.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const publicShellLocaleInertDigestSuffix = '\n/* fsusblog: resource-boundary content-digest mutation */\n';

function observedUrl(raw, bindings)
{
    if (raw === bindings.preferenceUrl || bindings.resources.some((resource) => resource.url === raw))
    {
        return raw;
    }
    const url = new URL(raw);
    // Unknown request query values/credentials never enter the raw evidence bundle.
    return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
}

function immutable(value)
{
    const copy = structuredClone(value);
    const freeze = (item) =>
    {
        if (item && typeof item === 'object')
        {
            Object.values(item).forEach(freeze);
            Object.freeze(item);
        }
        return item;
    };
    return freeze(copy);
}

function originalHeaders(values)
{
    const result = {};
    for (const { name, value } of values)
    {
        const key = name.toLowerCase();
        result[key] = result[key] === undefined ? value : `${result[key]}, ${value}`;
    }
    return result;
}

// Retained evidence bounds, not product limits or preallocation bounds on Playwright.body().
export const originalCaptureLimits = Object.freeze({ bodyBytes: 65536, documentBytes: 4194304,
    totalBytes: 16777216, leaves: 256, pending: 256, records: 4096,
    headerBytes: 65536, headers: 128, stringBytes: 8192 });
// Existing browser recorder policy, shared with its serialized installer and raw consumer.
export const originalBrowserRecordLimits = Object.freeze({ frames: 2048, records: originalCaptureLimits.records,
    recordBytes: originalCaptureLimits.headerBytes, totalBytes: originalCaptureLimits.totalBytes });
const originalCaptures = new WeakSet();

/** Pure validation shared by the collector and its existing private evidence sink. */
export function validatePublicShellLocaleOriginalCaptureLimits(overrides)
{
    const limits = { ...originalCaptureLimits };
    for (const [key, value] of Object.entries(overrides ?? {}))
    {
        assert.ok(Object.hasOwn(limits, key) && Number.isSafeInteger(value) && value > 0 && value <= limits[key],
            'original capture limit invalid');
        limits[key] = value;
    }
    return Object.freeze(limits);
}

function createOriginalCapture(context, bindings, scene, overrides)
{
    assert.ok(bindings.identity && typeof scene.id === 'string', 'original capture admission required');
    const identity = immutable(bindings.identity);
    const limits = validatePublicShellLocaleOriginalCaptureLimits(overrides);
    const preferenceUrl = bindings.preferenceUrl;
    const resources = immutable(bindings.resources);
    const admittedResource = (url) => resources.find((resource) => resource.url === url) ?? null;
    const originals = [];
    const failures = [];
    const pending = new Map();
    const requests = new WeakMap();
    const apiResponses = new Map();
    let sequence = 0;
    let apiOrdinal = 0;
    let retainedBytes = 0;
    let stopped = false;
    let firstError;
    let failureOverflowAt = null;
    const fail = (reason, at = sequence, error) =>
    {
        firstError ??= new Error(`original capture incomplete: ${reason}`);
        if (failures.length < limits.records)
        {
            failures.push({ sequence: at, reason, name: error?.name ?? 'Error' });
        }
        else
        {
            failureOverflowAt ??= at;
        }
        return firstError;
    };
    const begin = () =>
    {
        assert.equal(stopped, false, 'original capture already disposed');
        sequence += 1;
        return sequence;
    };
    const boundedText = (value, at = sequence) =>
    {
        if (typeof value !== 'string' || Buffer.byteLength(value) > limits.stringBytes)
        {
            throw fail('string-overflow-or-missing', at);
        }
        return value;
    };
    const leaf = (at, metadata) =>
    {
        if (originals.length >= limits.leaves)
        {
            throw fail('leaf-overflow', at);
        }
        const item = { sequence: at, ...metadata, captureState: 'pending' };
        originals.push(item);
        return item;
    };
    const body = (item, bytes, maximum) =>
    {
        assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'original body missing');
        if (bytes.byteLength > maximum || retainedBytes + bytes.byteLength > limits.totalBytes)
        {
            item.captureState = 'overflow';
            throw fail('body-overflow', item.sequence);
        }
        const copied = Buffer.from(bytes);
        retainedBytes += copied.length;
        item.bodyEncoding = 'base64';
        item.byteLength = copied.length;
        item.byteSha256 = sha256(copied);
        item.bodyBase64 = copied.toString('base64');
        return copied;
    };
    const retainHeaders = (item, values) =>
    {
        assert.ok(Array.isArray(values), 'actual header array missing');
        if (values.length > limits.headers)
        {
            throw fail('header-count-overflow', item.sequence);
        }
        let bytes = 0;
        const copied = values.map(({ name, value }) =>
        {
            boundedText(name, item.sequence);
            boundedText(value, item.sequence);
            bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
            if (bytes > limits.headerBytes)
            {
                throw fail('header-bytes-overflow', item.sequence);
            }
            return { name, value };
        });
        item.headersArray = copied;
    };
    const headers = async (item, source) =>
    {
        assert.equal(typeof source.headersArray, 'function', 'actual header array unavailable');
        retainHeaders(item, await source.headersArray());
    };
    const bodyMaximum = (url, document, at) =>
    {
        if (url === preferenceUrl)
        {
            return limits.bodyBytes;
        }
        if (admittedResource(url))
        {
            // Resources use only the remaining original scene budget, never expected build bytes.
            return limits.totalBytes - retainedBytes;
        }
        if (document)
        {
            return limits.documentBytes;
        }
        throw fail('resource-url-not-admitted', at);
    };
    const track = (at, operation) =>
    {
        if (pending.size >= limits.pending)
        {
            fail('pending-overflow', at);
            return Promise.resolve();
        }
        const { promise: work, resolve: complete } = Promise.withResolvers();
        // Nested observations cannot consume a slot before their parent admission is counted.
        pending.set(work, at);
        void (async () =>
        {
            try
            {
                await operation();
            }
            catch (error)
            {
                fail('read-or-validation-failed', at, error);
            }
            finally
            {
                complete();
            }
        })();
        void work.then(() => pending.delete(work));
        return work;
    };
    const requireContext = (actualContext, actualBindings) =>
    {
        assert.ok(actualContext === context, 'original capture belongs to another context');
        assert.deepEqual(actualBindings.identity, identity, 'original capture belongs to another admission');
        assert.equal(stopped, false, 'original capture already disposed');
    };
    const requestData = (request) =>
    {
        const data = requests.get(request);
        if (!data)
        {
            throw fail('request-correlation-missing');
        }
        return data;
    };
    const validateCut = (cut) => assert.ok(Number.isSafeInteger(cut) && cut >= 0 && cut <= sequence,
        'original capture cut invalid');
    const capture = Object.freeze({
        limits, sceneId: scene.id, begin, fail, track, requireContext, requestData, admittedResource,
        cut: () => sequence,
        observeRequest(request, ordinal, at)
        {
            if (requests.has(request))
            {
                fail('duplicate-request-observation', at);
                return;
            }
            const data = { requestOrdinal: ordinal, commandBytes: null };
            requests.set(request, data);
            const url = request.url();
            if (url !== bindings.preferenceUrl && request.resourceType() !== 'document')
            {
                return;
            }
            let item;
            try
            {
                item = leaf(at, { kind: 'request', source: 'browser', requestOrdinal: ordinal,
                    method: request.method(), url: boundedText(url), representation: 'request-post-data' });
                if (url === bindings.preferenceUrl && request.method() === 'PUT')
                {
                    data.commandBytes = body(item, request.postDataBuffer(), limits.bodyBytes);
                }
                else
                {
                    item.bodyApplicable = false;
                }
            }
            catch (error)
            {
                if (item)
                {
                    item.captureState = item.captureState === 'overflow' ? 'overflow' : 'missing';
                }
                fail('request-body-unavailable', at, error);
            }
            if (item)
            {
                track(at, async () =>
                {
                    await headers(item, request);
                    if (item.captureState === 'pending')
                    {
                        item.captureState = 'observed';
                    }
                });
            }
        },
        async response(response, { at = begin(), source, requestOrdinal = null, parentRequestOrdinal = null, invocationOrdinal = null,
            method, url, bytes, document = false })
        {
            let item;
            let result;
            if (invocationOrdinal === null && (source === 'api-request' || source === 'route-fetch'))
            {
                invocationOrdinal = ++apiOrdinal;
            }
            await track(at, async () =>
            {
                bodyMaximum(url, document, at);
                item = leaf(at, { kind: 'response', source, requestOrdinal, parentRequestOrdinal, invocationOrdinal,
                    method, url: boundedText(url), status: response.status(), representation: 'playwright-response-body' });
                // Store a completed body even if reading headers fails, and vice versa.
                const observations = await Promise.allSettled([
                    (async () =>
                    {
                        result = body(item, bytes ?? await response.body(), bodyMaximum(url, document, at));
                    })(), headers(item, response)
                ]);
                const failed = observations.find((observation) => observation.status === 'rejected');
                if (failed)
                {
                    item.captureState = item.captureState === 'overflow' ? 'overflow' : 'read-failed';
                    throw failed.reason;
                }
                item.captureState = 'observed';
            });
            if (!item || item.captureState !== 'observed')
            {
                throw firstError;
            }
            return { bytes: result, headersArray: immutable(item.headersArray), sequence: at, invocationOrdinal };
        },
        async exchange(operation, metadata)
        {
            const at = begin();
            const invocationOrdinal = ++apiOrdinal;
            let result;
            let firstFailure;
            await track(at, async () =>
            {
                const item = leaf(at, { kind: 'invocation', ...metadata, invocationOrdinal });
                try
                {
                    const response = await operation();
                    apiResponses.set(response, invocationOrdinal);
                    const captured = await this.response(response, { ...metadata, at, invocationOrdinal });
                    result = { response, ...captured };
                    item.captureState = 'observed';
                }
                catch (error)
                {
                    item.captureState = 'read-failed';
                    firstFailure = error;
                    throw error;
                }
            });
            if (!result)
            {
                throw firstFailure ?? firstError;
            }
            return result;
        },
        supplied(bytes, { requestOrdinal, purpose, url = preferenceUrl, headersArray })
        {
            const at = begin();
            let item;
            try
            {
                assert.ok(purpose !== 'resource-replacement-input' || admittedResource(url),
                    'resource replacement URL not admitted');
                const maximum = bodyMaximum(url, false, at);
                item = leaf(at, { kind: 'supplied-body', source: 'route-input', requestOrdinal,
                    purpose, representation: 'route-supplied-body' });
                body(item, bytes, maximum);
                if (url !== preferenceUrl)
                {
                    item.url = boundedText(url, at);
                    retainHeaders(item, headersArray);
                    item.headerRepresentation = 'route-supplied-headers';
                }
                item.captureState = 'observed';
                return at;
            }
            catch (error)
            {
                if (item && item.captureState === 'pending')
                {
                    item.captureState = 'read-failed';
                }
                throw fail('supplied-body-unavailable', at, error);
            }
        },
        async drain(cut = sequence)
        {
            validateCut(cut);
            const work = [...pending].filter(([, at]) => at <= cut).map(([promise]) => promise);
            try
            {
                await waitForPublicShellLocaleResourceEntry(Promise.all(work));
            }
            catch (error)
            {
                fail('drain-incomplete', cut, error);
                throw error;
            }
        },
        async releaseResponses()
        {
            let firstFailure;
            for (const response of apiResponses.keys())
            {
                try
                {
                    assert.equal(typeof response.dispose, 'function', 'actual APIResponse disposal unavailable');
                    await waitForPublicShellLocaleResourceEntry(response.dispose());
                    apiResponses.delete(response);
                }
                catch (error)
                {
                    firstFailure ??= error;
                    fail('api-response-disposal-failed', sequence, error);
                }
            }
            if (firstFailure)
            {
                throw firstFailure;
            }
        },
        assertComplete(cut = sequence)
        {
            validateCut(cut);
            if ((failureOverflowAt !== null && failureOverflowAt <= cut) || failures.some((failure) => failure.sequence <= cut)
                || originals.some((item) => item.sequence <= cut && item.captureState !== 'observed'))
            {
                throw firstError ?? fail('body-or-headers-pending', cut);
            }
        },
        snapshot(cut = sequence)
        {
            validateCut(cut);
            return immutable({ binding: { identity, sceneId: scene.id }, limits,
                captureCut: cut, originals: originals.filter((item) => item.sequence <= cut),
                failures: failures.filter((item) => item.sequence <= cut),
                overflow: (failureOverflowAt !== null && failureOverflowAt <= cut)
                    || failures.some((failure) => failure.sequence <= cut && failure.reason.includes('overflow')) });
        },
        stop: () =>
        {
            stopped = true;
        }
    });
    originalCaptures.add(capture);
    return capture;
}

/** Read-only recorder: production performance marks and painted DOM, never invented phase names. */
export function installPublicShellLocaleLifecycleRecorder(readDom, recordLimits)
{
    const state = { frames: [], marks: [], events: [], errors: [], overflow: false };
    let retainedRecorderBytes = 0;
    const retain = (records, item, maximum = recordLimits.records) =>
    {
        const byteLength = new window.TextEncoder().encode(JSON.stringify(item)).length;
        if (records.length >= maximum || byteLength > recordLimits.recordBytes || retainedRecorderBytes + byteLength > recordLimits.totalBytes)
        {
            state.overflow = true;
            return false;
        }
        retainedRecorderBytes += byteLength;
        records.push(item);
        return true;
    };
    let running = true;
    let previous = null;
    let frame;
    const capture = () =>
    {
        if (!window.document.querySelector('#fsus-aot-shell'))
        {
            return null;
        }
        return { observedAt: window.performance.now(), dom: readDom() };
    };
    const sample = () =>
    {
        if (!running)
        {
            return;
        }
        try
        {
            const snapshot = capture();
            if (snapshot)
            {
                const signature = JSON.stringify(snapshot.dom);
                if (signature !== previous)
                {
                    if (state.frames.length >= recordLimits.frames)
                    {
                        state.overflow = true;
                        running = false;
                        return;
                    }
                    retain(state.frames, snapshot, recordLimits.frames);
                    previous = signature;
                }
            }
        }
        catch (error)
        {
            retain(state.errors, { name: error.name, message: error.message });
            running = false;
        }
        frame = window.requestAnimationFrame(sample);
    };
    const telemetry = (event) =>
    {
        const payload = event.detail;
        if (['locale_runtime_phase', 'locale_runtime_committed', 'locale_runtime_failed'].includes(payload?.name))
        {
            if (state.events.length >= recordLimits.records)
            {
                state.overflow = true;
                return;
            }
            retain(state.events, { name: payload.name, generation: payload.detail?.generation,
                locale: payload.detail?.locale ?? payload.detail?.target, level: payload.level,
                from: payload.detail?.from ?? null, to: payload.detail?.to ?? null });
        }
    };
    window.addEventListener('fsus:telemetry', telemetry);
    const observer = new window.PerformanceObserver((list) =>
    {
        for (const mark of list.getEntries())
        {
            if (mark.name.startsWith('fsus:start:public-hydrate:'))
            {
                if (state.marks.length >= recordLimits.records)
                {
                    state.overflow = true;
                    return;
                }
                retain(state.marks, { name: mark.name, startTime: mark.startTime, snapshot: capture() });
            }
        }
    });
    observer.observe({ type: 'mark', buffered: true });
    frame = window.requestAnimationFrame(sample);
    const nodeIdentities = new WeakMap();
    let nodeSequence = 0;
    window.__fsusblogLocaleLifecycleEvidence = {
        state,
        identityFor(node)
        {
            if (!nodeIdentities.has(node))
            {
                nodeSequence += 1;
                nodeIdentities.set(node, nodeSequence);
            }
            return nodeIdentities.get(node);
        },
        dispose()
        {
            running = false;
            window.cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener('fsus:telemetry', telemetry);
        }
    };
}

/** The admitted context's real cookie jar and formal GET endpoint; no test-session/security bypass. */
export async function readPublicShellLocalePreference(context, bindings, { rawCapture, parentRequestOrdinal = null } = {})
{
    assert.ok(originalCaptures.has(rawCapture), 'original capture capability required');
    rawCapture.requireContext(context, bindings);
    const { response, bytes: body, headersArray, invocationOrdinal } = await rawCapture.exchange(() => context.request.get(bindings.preferenceUrl,
        { headers: { Accept: bindings.preference.mediaType }, failOnStatusCode: false }),
    { source: 'api-request', parentRequestOrdinal, method: 'GET', url: bindings.preferenceUrl });
    assert.equal(response.status(), bindings.preference.operations[0].successStatus, 'formal preference GET failed');
    const headers = originalHeaders(headersArray);
    assert.ok(headers['content-type']?.split(';')[0].trim() === bindings.preference.mediaType, 'preference response media type');
    assert.ok(headers['cache-control']?.includes('no-store'), 'preference GET must be no-store');
    const snapshot = bindings.preference.decodeResponse(body);
    const cookies = (await context.cookies(bindings.preferenceUrl))
        .filter((cookie) => cookie.name === 'fsusblog.locale')
        .map((cookie) => ({ locale: cookie.value, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite }));
    assert.ok(cookies.length <= 1, 'ambiguous locale cookie');
    assert.ok(cookies.every((cookie) => bindings.preference.locales.some((locale) => locale.code === cookie.locale)),
        'locale cookie is not an enabled canonical locale');
    return { snapshot, cookies, response: { status: response.status(), bodyDigest: sha256(body), method: 'GET', invocationOrdinal } };
}

/** Check actual account/device semantics, rather than asserting an invented revision increment. */
export function assertPublicShellLocalePreferenceOutcome({ scene, before, after, writes, outcome })
{
    assert.ok(['commit', 'rollback'].includes(outcome), 'preference outcome required');
    for (const revision of [before.snapshot.revision, after.snapshot.revision])
    {
        assert.ok(Number.isSafeInteger(revision) && revision >= 0, 'preference revision must be an exact nonnegative integer');
    }
    const successes = writes.filter((write) => write.status === 200);
    if (outcome === 'rollback')
    {
        assert.deepEqual(after.snapshot, before.snapshot, 'rollback changed authoritative preference');
        assert.deepEqual(after.cookies, before.cookies, 'rollback changed device cookie');
        assert.equal(successes.length, 0, 'failed transaction wrote preference');
        return;
    }
    assert.equal(successes.length, 1, 'exactly one preference PUT receipt required');
    const write = successes[0];
    assert.ok(write.command && write.preference && !write.observationError, 'PUT command/response were not observed');
    for (const revision of [write.command.expectedRevision, write.preference.revision])
    {
        assert.ok(Number.isSafeInteger(revision) && revision >= 0, 'preference PUT revision must be an exact nonnegative integer');
    }
    assert.equal(write.command.mode, 'fixed', 'selector must issue a fixed preference');
    assert.equal(write.command.fixedLocale, scene.locale, 'PUT target differs from clicked target');
    assert.equal(write.command.expectedRevision, before.snapshot.revision, 'PUT used a stale revision');
    assert.equal(write.preference.mode, 'fixed', 'PUT response mode');
    assert.equal(write.preference.fixedLocale, scene.locale, 'PUT response target');
    for (const key of ['mode', 'fixedLocale', 'revision'])
    {
        assert.equal(after.snapshot[key], write.preference[key], 'GET disagrees with real PUT receipt');
    }
    if (scene.authActionContext !== 'anonymous')
    {
        assert.equal(after.snapshot.updatedAt, write.preference.updatedAt, 'account preference timestamp drift');
    }
    const expectedRevision = scene.authActionContext === 'anonymous' ? 0 : before.snapshot.revision + 1;
    assert.equal(after.snapshot.revision, expectedRevision, 'account/device revision semantics');
    assert.equal(after.cookies.length, 1, 'committed device cookie missing');
    assert.equal(after.cookies[0].locale, scene.locale, 'committed cookie target');
    assert.equal(after.cookies[0].httpOnly, true, 'locale cookie must remain HttpOnly');
}

/** Attach before newPage/goto in the single canonical runner's createContext callback. */
export async function bindPublicShellLocaleContextEvidence({ context, bindings, scene, limits })
{
    assert.equal(typeof context.on, 'function', 'real browser context required');
    assert.equal(context.pages().length, 0, 'lifecycle observer must bind before the first page');
    const firstResponse = scene.issue === 2083 && scene.stage === 'first-response';
    const requests = [];
    const responses = [];
    const issues = [];
    const rawCapture = createOriginalCapture(context, bindings, scene, limits);
    const requestOrdinals = new WeakMap();
    let requestSequence = 0;
    let disposePromise;
    const append = (records, record, at) =>
    {
        if (records.length >= rawCapture.limits.records || Buffer.byteLength(JSON.stringify(record)) > rawCapture.limits.headerBytes)
        {
            rawCapture.fail('metadata-overflow', at);
            return;
        }
        records.push({ ...record, captureSequence: at });
    };
    const onRequest = (request) =>
    {
        const at = rawCapture.begin();
        const ordinal = requestSequence++;
        requestOrdinals.set(request, ordinal);
        append(requests, { url: observedUrl(request.url(), bindings), urlDigest: sha256(request.url()),
            method: request.method(), resourceType: request.resourceType(), requestOrdinal: ordinal }, at);
        rawCapture.observeRequest(request, ordinal, at);
    };
    const onResponse = (response) =>
    {
        const at = rawCapture.begin();
        void rawCapture.track(at, async () =>
        {
            const request = response.request();
            const rawUrl = response.url();
            const record = { url: observedUrl(rawUrl, bindings), urlDigest: sha256(rawUrl), method: request.method(), resourceType: request.resourceType(),
                status: response.status(), fromServiceWorker: response.fromServiceWorker(), requestOrdinal: requestOrdinals.get(request) };
            append(responses, record, at);
            const stored = responses.find((item) => item.captureSequence === at);
            try
            {
                assert.ok(Number.isSafeInteger(record.requestOrdinal), 'response has no actual request observation');
                const resource = rawCapture.admittedResource(rawUrl);
                record.resource = resource;
                // Business streams are counted, not consumed by this locale observer.
                if (!resource && rawUrl !== bindings.preferenceUrl && record.resourceType !== 'document')
                {
                    return;
                }
                const captured = await rawCapture.response(response, { at, source: 'browser', requestOrdinal: record.requestOrdinal,
                    method: record.method, url: rawUrl, document: record.resourceType === 'document' });
                const body = captured.bytes;
                record.contentDigest = sha256(body);
                if (rawUrl === bindings.preferenceUrl && record.method === 'PUT')
                {
                    const commandBytes = rawCapture.requestData(request).commandBytes;
                    assert.ok(commandBytes, 'original PUT command missing');
                    record.commandDigest = sha256(commandBytes);
                    record.command = bindings.preference.inspectRequest(commandBytes);
                    if (record.status === bindings.preference.operations[1].successStatus)
                    {
                        const headers = originalHeaders(captured.headersArray);
                        assert.ok(headers['content-type']?.split(';')[0].trim() === bindings.preference.mediaType, 'PUT media type');
                        assert.ok(headers['cache-control']?.includes('no-store'), 'PUT must be no-store');
                        record.preference = bindings.preference.decodeResponse(body);
                    }
                    else if (body.length > 0)
                    {
                        record.error = bindings.preference.decodeError(body);
                    }
                }
            }
            catch (error)
            {
                record.observationError = { name: error.name, digest: sha256(error.message) };
                rawCapture.fail('browser-response-invalid', at, error);
            }
            finally
            {
                if (stored)
                {
                    Object.assign(stored, record);
                }
            }
        });
    };
    const pageListeners = [];
    const onPage = (page) =>
    {
        const console = (message) =>
        {
            if (['warning', 'error'].includes(message.type()))
            {
                const location = message.location();
                const at = rawCapture.begin();
                append(issues, { kind: message.type(), digest: sha256(message.text()),
                    location: location.url ? { url: observedUrl(location.url, bindings), urlDigest: sha256(location.url),
                        lineNumber: location.lineNumber, columnNumber: location.columnNumber } : null }, at);
            }
        };
        const pageerror = (error) => append(issues, { kind: 'pageerror', digest: sha256(String(error)) }, rawCapture.begin());
        const requestfailed = (request) =>
        {
            const at = rawCapture.begin();
            const requestOrdinal = requestOrdinals.get(request);
            if (!Number.isSafeInteger(requestOrdinal))
            {
                rawCapture.fail('failed-request-correlation-missing', at);
            }
            append(issues, { kind: 'requestfailed', requestOrdinal, urlDigest: sha256(request.url()),
                failureDigest: sha256(request.failure()?.errorText ?? '') }, at);
        };
        if (pageListeners.length >= rawCapture.limits.records)
        {
            rawCapture.fail('page-listener-overflow');
            return;
        }
        page.on('console', console);
        page.on('pageerror', pageerror);
        page.on('requestfailed', requestfailed);
        pageListeners.push({ page, console, pageerror, requestfailed });
    };
    context.on('page', onPage);
    context.on('request', onRequest);
    context.on('response', onResponse);
    const detach = () =>
    {
        let firstError;
        const off = (target, event, listener) =>
        {
            try
            {
                target.off(event, listener);
            }
            catch (error)
            {
                firstError ??= error;
                rawCapture.fail('listener-detach-failed', rawCapture.cut(), error);
            }
        };
        off(context, 'page', onPage);
        off(context, 'request', onRequest);
        off(context, 'response', onResponse);
        for (const { page, console, pageerror, requestfailed } of pageListeners)
        {
            off(page, 'console', console);
            off(page, 'pageerror', pageerror);
            off(page, 'requestfailed', requestfailed);
        }
        if (firstError)
        {
            throw firstError;
        }
    };
    try
    {
        if (!firstResponse)
        {
            await context.addInitScript({ content: `(${installPublicShellLocaleLifecycleRecorder.toString()})(${readPublicShellLocaleDom.toString()},${JSON.stringify(originalBrowserRecordLimits)});` });
        }
    }
    catch (error)
    {
        try
        {
            detach();
        }
        catch (cleanupError)
        {
            error.cleanupFailure = { name: cleanupError.name, digest: sha256(cleanupError.message) };
        }
        finally
        {
            rawCapture.stop();
        }
        throw error;
    }
    return Object.freeze({
        rawCapture,
        /** JS-disabled first response: original HTTP only, no synthetic browser recorder. */
        async captureFirstResponse()
        {
            assert.ok(firstResponse, 'first-response scene required');
            rawCapture.requireContext(context, bindings);
            const captureCut = rawCapture.cut();
            let firstError;
            try
            {
                await rawCapture.drain(captureCut);
            }
            catch (error)
            {
                firstError = rawCapture.fail('capture-drain-incomplete', captureCut, error);
            }
            const select = (records) => records.filter((item) => item.captureSequence <= captureCut);
            const evidence = immutable({ identity: bindings.identity, sceneId: scene.id, captureCut,
                requests: select(requests), responses: select(responses), issues: select(issues) });
            try
            {
                if (firstError)
                {
                    throw firstError;
                }
                rawCapture.assertComplete(captureCut);
            }
            catch (error)
            {
                error.evidence = evidence;
                throw error;
            }
            return evidence;
        },
        async capture(page)
        {
            assert.equal(firstResponse, false, 'first-response scene requires original HTTP capture');
            rawCapture.requireContext(context, bindings);
            const captureCut = rawCapture.cut();
            let firstError;
            try
            {
                await rawCapture.drain(captureCut);
            }
            catch (error)
            {
                firstError = rawCapture.fail('capture-drain-incomplete', captureCut, error);
            }
            const browser = await page.evaluate((maximum) => ({
                recorder: window.__fsusblogLocaleLifecycleEvidence.state,
                recordOverflow: window.performance.getEntriesByType('resource').length > maximum
                    || window.document.querySelectorAll('link[rel="preload"],link[rel="modulepreload"]').length > maximum,
                performance: window.performance.getEntriesByType('resource').slice(0, maximum).map((entry) => ({
                    url: entry.name, initiatorType: entry.initiatorType, startTime: entry.startTime,
                    duration: entry.duration, transferSize: entry.transferSize,
                    encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize
                })),
                preloads: [...window.document.querySelectorAll('link[rel="preload"],link[rel="modulepreload"]')]
                    .slice(0, maximum)
                    .map((link) => ({ url: link.href, rel: link.rel, as: link.as }))
            }), rawCapture.limits.records);
            if (browser.recordOverflow || browser.performance.length > rawCapture.limits.records
                || browser.preloads.length > rawCapture.limits.records
                || Buffer.byteLength(JSON.stringify(browser)) > rawCapture.limits.totalBytes)
            {
                throw rawCapture.fail('browser-record-overflow', captureCut);
            }
            browser.performance = browser.performance.map((entry) => ({ ...entry,
                url: observedUrl(entry.url, bindings), urlDigest: sha256(entry.url) }));
            browser.preloads = browser.preloads.map((entry) => ({ ...entry,
                url: observedUrl(entry.url, bindings), urlDigest: sha256(entry.url) }));
            browser.recorder.errors = browser.recorder.errors.map((error) => ({ name: error.name, digest: sha256(error.message) }));
            const select = (records) => records.filter((item) => item.captureSequence <= captureCut);
            const evidence = immutable({ identity: bindings.identity, sceneId: scene.id, captureCut, browser,
                requests: select(requests), responses: select(responses), issues: select(issues) });
            try
            {
                if (firstError)
                {
                    throw firstError;
                }
                rawCapture.assertComplete(captureCut);
                assert.equal(browser.recorder.overflow, false, 'painted-frame recorder overflowed');
                assert.equal(browser.recorder.errors.length, 0, 'painted-frame observation failed');
            }
            catch (error)
            {
                error.evidence = evidence;
                throw error;
            }
            return evidence;
        },
        dispose()
        {
            disposePromise ??= (async () =>
            {
                let firstError;
                try
                {
                    for (const { page } of pageListeners)
                    {
                        try
                        {
                            if (!firstResponse && !page.isClosed())
                            {
                                await page.evaluate(() => window.__fsusblogLocaleLifecycleEvidence?.dispose());
                            }
                        }
                        catch (error)
                        {
                            firstError ??= error;
                            rawCapture.fail('recorder-dispose-failed', rawCapture.cut(), error);
                        }
                    }
                    try
                    {
                        await rawCapture.drain();
                        rawCapture.assertComplete();
                    }
                    catch (error)
                    {
                        firstError ??= error;
                    }
                    try
                    {
                        await rawCapture.releaseResponses();
                    }
                    catch (error)
                    {
                        firstError ??= error;
                    }
                }
                finally
                {
                    try
                    {
                        detach();
                    }
                    catch (error)
                    {
                        firstError ??= error;
                    }
                    finally
                    {
                        rawCapture.stop();
                    }
                }
                if (firstError)
                {
                    throw firstError;
                }
                return { privateOriginals: rawCapture.snapshot() };
            })();
            return disposePromise;
        }
    });
}

/** Observe loaded faces only; FontFaceSet.check never initiates a compensating font load. */
export async function observePublicShellLocaleFont(page, font)
{
    return await page.evaluate((expected) => ({
        status: window.document.fonts.status,
        checks: expected.weights.map((weight) => ({ weight,
            available: window.document.fonts.check(`${weight} 1em "${expected.family}"`, expected.representativeText) })),
        faces: [...window.document.fonts].map((face) => ({
            family: face.family, weight: face.weight, status: face.status, unicodeRange: face.unicodeRange
        }))
    }), font);
}

/** No outcome booleans: tie loaded faces to bytes observed from the sealed manifest inventory. */
export function assertPublicShellLocaleFontIdentity({ font, observation, responses })
{
    assert.equal(observation.status, 'loaded', 'fonts are not settled');
    assert.deepEqual(observation.checks.map((item) => item.weight), font.weights, 'font weight observation set');
    assert.ok(observation.checks.every((item) => item.available), 'required font glyphs missing');
    for (const weight of font.weights)
    {
        assert.ok(observation.faces.some((face) => face.family.replace(/^['"]|['"]$/gu, '') === font.family
            && Number(face.weight) === weight && face.status === 'loaded'), 'required loaded face missing');
    }
    const resources = responses.filter((record) => record.resource?.identities.some((identity) =>
        identity.kind === 'font' && identity.script === font.script && identity.locale === font.locale));
    assert.ok(resources.length > 0, 'no current-scene font response identity');
    for (const weight of font.weights)
    {
        assert.ok(resources.some((response) => response.resource.identities.some((identity) =>
            identity.kind === 'font' && identity.script === font.script && identity.weight === weight)),
        'required font weight has no observed artifact response');
    }
    for (const response of resources)
    {
        assert.equal(response.status, 200, 'font response failed');
        assert.equal(response.contentDigest, response.resource.digest, 'wrong font artifact bytes');
        assert.equal(response.observationError, undefined, 'font response was not observed');
    }
}

/** Mark callbacks may be late. Reject that loss rather than relabeling final DOM as hydration-start. */
export function assertPublicShellLocaleHydrationMark(evidence)
{
    const marks = evidence.browser.recorder.marks;
    const starts = marks.filter((mark) => mark.name === 'fsus:start:public-hydrate:hydrate:start');
    assert.equal(starts.length, 1, 'one observed production hydration-start mark required');
    assert.ok(starts[0].snapshot, 'hydration-start DOM was not observed');
    assert.equal(starts[0].snapshot.dom.hydrated, false, 'hydration-start callback arrived after hydration; stage not observed');
    return starts[0].snapshot;
}

/** A one-use injection at an admitted resource URL. Retry unbinds it and uses the real resource. */
export async function bindPublicShellLocaleFault({ context, bindings, url, action, scene, rawCapture })
{
    assert.ok(originalCaptures.has(rawCapture), 'original capture capability required');
    rawCapture.requireContext(context, bindings);
    if (scene)
    {
        assert.ok(scene.id === rawCapture.sceneId, 'original capture belongs to another scene');
    }
    assert.ok(url === bindings.preferenceUrl || rawCapture.admittedResource(url),
        'fault URL has no formal endpoint/artifact owner');
    const parsed = new URL(url);
    assert.ok(['http:', 'https:'].includes(parsed.protocol), 'HTTP resource required');
    assert.equal(parsed.username + parsed.password + parsed.hash, '', 'fault URL contains credentials/fragment');
    assert.equal(parsed.origin, new URL(bindings.preferenceUrl).origin, 'fault leaves the formal runtime');
    assert.ok(['abort', 'http-error', 'revision-conflict', 'resource-replacement', 'preference-response'].includes(action.kind), 'unknown HTTP fault action');
    const barrier = createPublicShellLocaleResourceBarrier();
    if (scene)
    {
        assertPublicShellLocaleFaultBinding({ bindings, scene, url, action });
        if (action.mutation?.recipe === 'sealed-module-ast')
        {
            const target = bindings.resources.find((resource) => resource.url === url);
            const identity = target.identities.find((owner) => owner.kind === 'domain' && owner.locale === scene.locale);
            const mutated = await mutatePublicShellLocaleDomainResource({ body: await bindings.readResource(url), identity,
                mode: scene.transition.failureMode, domains: bindings.domains });
            assert.deepEqual(action.mutation, mutated.mutation, 'domain mutation proof differs from sealed reconstruction');
            assert.equal(sha256(action.body), sha256(mutated.body), 'domain mutation bytes differ from sealed reconstruction');
        }
        else if (action.mutation?.replacement?.url)
        {
            assert.equal(sha256(action.body), sha256(await bindings.readResource(action.mutation.replacement.url)),
                'replacement changed before actual HTTP binding');
        }
        else if (action.mutation?.mode === 'late-resource')
        {
            assert.equal(sha256(action.body), sha256(await bindings.readResource(url)), 'late resource is not the sealed response');
        }
        if (scene.stage === 'artifact-invalid' && scene.transition.failureMode === 'cross-version')
        {
            const proof = action.mutation.replacement;
            const foreign = await readPublicShellLocaleForeignBuildResource({ foreignBuild: { receiptFile: proof.receiptFile,
                sourceState: proof.sourceState, receiptDigest: proof.buildDigest }, currentIdentity: bindings.identity,
            locale: proof.locale, domain: proof.domain });
            assert.equal(sha256(action.body), sha256(foreign.body), 'foreign artifact changed before HTTP binding');
            assert.deepEqual(proof, foreign.proof, 'foreign artifact proof changed before HTTP binding');
        }
    }
    const completed = Promise.withResolvers();
    const serverObserved = Promise.withResolvers();
    // An unentered fault can be disposed without an unhandled rejected promise.
    void completed.promise.catch(() =>
    {});
    void serverObserved.promise.catch(() =>
    {});
    const entered = Promise.race([barrier.entered, completed.promise.then(() => new Promise(() =>
    {}))]);
    void entered.catch(() =>
    {});
    const trace = [];
    const inFlight = new Set();
    let nativeIntercepted = false;
    let interceptedRequests = 0;
    let accepting = true;
    const matches = (candidate) => candidate.href === url;
    const execute = async (route) =>
    {
        const request = route.request();
        if (url === bindings.preferenceUrl && request.method() !== 'PUT')
        {
            await route.fallback();
            return;
        }
        if (action.kind === 'preference-response' && nativeIntercepted)
        {
            const data = rawCapture.requestData(request);
            const command = bindings.preference.inspectRequest(data.commandBytes);
            if (trace.length >= rawCapture.limits.records)
            {
                throw rawCapture.fail('fault-trace-overflow');
            }
            trace.push({ kind: 'pass-through-put', command, requestOrdinal: data.requestOrdinal, urlDigest: sha256(url) });
            await route.fallback();
            return;
        }
        nativeIntercepted = action.kind === 'preference-response';
        interceptedRequests += 1;
        try
        {
            const data = rawCapture.requestData(request);
            if (trace.length >= rawCapture.limits.records)
            {
                throw rawCapture.fail('fault-trace-overflow');
            }
            // Native preference success is acquired before the response barrier. The caller
            // supersedes the pending UI transaction; no clock/sleep simulates a late response.
            let native;
            const receipt = { mode: scene?.transition?.failureMode ?? null, urlDigest: sha256(url), kind: action.kind,
                interceptedRequestOrdinal: interceptedRequests, requestOrdinal: data.requestOrdinal, nativeRequests: [] };
            trace.push(receipt);
            if (action.kind === 'preference-response')
            {
                const command = bindings.preference.inspectRequest(data.commandBytes);
                const { response: beforeResponse, bytes: beforeBody, headersArray: beforeHeaders,
                    invocationOrdinal: beforeInvocation } = await rawCapture.exchange(
                    () => context.request.get(bindings.preferenceUrl,
                        { headers: { Accept: bindings.preference.mediaType }, failOnStatusCode: false }),
                    { source: 'api-request', parentRequestOrdinal: data.requestOrdinal, method: 'GET', url });
                const before = await readPublicShellLocalePreference(context, bindings,
                    { rawCapture, parentRequestOrdinal: data.requestOrdinal });
                receipt.nativeRequests.push({ method: 'GET', invocationOrdinal: beforeInvocation,
                    status: beforeResponse.status(), contentDigest: sha256(beforeBody) },
                { method: 'GET', invocationOrdinal: before.response.invocationOrdinal,
                    status: before.response.status, contentDigest: before.response.bodyDigest });
                assert.equal(beforeResponse.status(), 200, 'stale body must be a native successful GET');
                assert.ok(originalHeaders(beforeHeaders)['content-type']?.split(';')[0].trim() === bindings.preference.mediaType, 'native GET media type');
                const stale = bindings.preference.decodeResponse(beforeBody);
                assert.deepEqual(stale, before.snapshot, 'native GET changed before forwarding');
                assert.equal(before.snapshot.revision, action.currentRevision, 'preference revision changed before injection');
                assert.deepEqual(command, { mode: 'fixed', fixedLocale: action.targetLocale, expectedRevision: action.currentRevision },
                    'forward only the actual clicked, current production command');
                receipt.delivery = action.delivery;
                receipt.command = command;
                receipt.commandDigest = sha256(data.commandBytes);
                receipt.beforeInvocationOrdinal = beforeInvocation;
                receipt.preferenceBeforeDigest = sha256(beforeBody);
                receipt.before = before;
                const { response, bytes: body, headersArray, invocationOrdinal } = await rawCapture.exchange(
                    () => route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 }),
                    { source: 'route-fetch', parentRequestOrdinal: data.requestOrdinal, method: 'PUT', url });
                receipt.nativeInvocationOrdinal = invocationOrdinal;
                receipt.status = response.status();
                receipt.contentDigest = sha256(body);
                receipt.nativeRequests.push({ method: 'PUT', invocationOrdinal, status: receipt.status, contentDigest: receipt.contentDigest });
                if (response.status() !== 200)
                {
                    try
                    {
                        receipt.error = bindings.preference.decodeError(body);
                    }
                    catch (error)
                    {
                        receipt.errorObservation = { name: error.name, messageDigest: sha256(error.message) };
                    }
                }
                assert.equal(response.status(), 200, 'native PUT did not commit; do not label a 409/error as success loss');
                assert.ok(originalHeaders(headersArray)['content-type']?.split(';')[0].trim() === bindings.preference.mediaType, 'native PUT media type');
                assert.ok(originalHeaders(headersArray)['cache-control']?.includes('no-store'), 'native PUT must remain no-store');
                receipt.preference = bindings.preference.decodeResponse(body);
                assert.equal(receipt.preference.mode, 'fixed', 'native PUT mode');
                assert.equal(receipt.preference.fixedLocale, action.targetLocale, 'native PUT target');
                assert.equal(receipt.preference.revision, action.authActionContext === 'anonymous' ? 0 : command.expectedRevision + 1,
                    'native PUT revision semantics');
                receipt.authoritativeAfter = await readPublicShellLocalePreference(context, bindings,
                    { rawCapture, parentRequestOrdinal: data.requestOrdinal });
                receipt.nativeRequests.push({ method: 'GET', status: receipt.authoritativeAfter.response.status,
                    invocationOrdinal: receipt.authoritativeAfter.response.invocationOrdinal,
                    contentDigest: receipt.authoritativeAfter.response.bodyDigest });
                if (action.authActionContext !== 'anonymous')
                {
                    assert.deepEqual(receipt.authoritativeAfter.snapshot, receipt.preference, 'GET did not confirm server commit');
                }
                if (action.delivery === 'stale')
                {
                    assert.ok(stale.revision < receipt.preference.revision || stale.mode !== receipt.preference.mode
                        || stale.fixedLocale !== receipt.preference.fixedLocale, 'native GET body is not stale');
                    receipt.staleSemantics = stale.revision < receipt.preference.revision ? 'lower-account-revision' : 'older-device-state';
                }
                native = { response, beforeBody };
                serverObserved.resolve(structuredClone(receipt));
            }
            const released = await barrier.wait();
            if (released.kind === 'abort')
            {
                await route.abort('aborted');
                completed.resolve({ kind: 'disposed-before-release' });
                return;
            }
            if (action.kind === 'preference-response')
            {
                if (action.delivery === 'lost')
                {
                    // Server fact remains in the injection receipt, even if the browser never
                    // receives headers. Fetch cookie side effects are recorded, never repaired.
                    await route.abort('failed');
                    receipt.transport = 'failed-after-native-200';
                }
                else if (action.delivery === 'stale')
                {
                    receipt.suppliedBodySequence = rawCapture.supplied(native.beforeBody,
                        { requestOrdinal: data.requestOrdinal, purpose: 'stale-delivery-input' });
                    await route.fulfill({ response: native.response, body: Buffer.from(native.beforeBody) });
                    receipt.deliveredDigest = sha256(native.beforeBody);
                }
                else
                {
                    await route.fulfill({ response: native.response });
                    receipt.deliveredDigest = receipt.contentDigest;
                }
            }
            else if (action.kind === 'revision-conflict')
            {
                const command = bindings.preference.inspectRequest(data.commandBytes);
                const current = await readPublicShellLocalePreference(context, bindings,
                    { rawCapture, parentRequestOrdinal: data.requestOrdinal });
                receipt.nativeRequests.push({ method: 'GET', invocationOrdinal: current.response.invocationOrdinal,
                    status: current.response.status, contentDigest: current.response.bodyDigest });
                receipt.preferenceBeforeDigest = current.response.bodyDigest;
                assert.equal(command.mode, 'fixed', 'conflict must intercept a real fixed selector command');
                assert.equal(command.fixedLocale, action.targetLocale, 'conflict target differs from clicked target');
                assert.equal(current.snapshot.revision, action.currentRevision, 'preference changed before the injected conflict');
                assert.equal(command.expectedRevision, current.snapshot.revision, 'original product request already has a stale revision');
                const conflictRevision = current.snapshot.revision === 0 ? 1 : current.snapshot.revision - 1;
                receipt.originalRevision = command.expectedRevision;
                receipt.forwardedRevision = conflictRevision;
                const forwarded = bindings.preference.encodeRequest(command.mode, command.fixedLocale, conflictRevision);
                receipt.command = command;
                receipt.commandDigest = sha256(data.commandBytes);
                receipt.forwardedCommandDigest = sha256(forwarded);
                receipt.forwardedCommandSequence = rawCapture.supplied(forwarded,
                    { requestOrdinal: data.requestOrdinal, purpose: 'forwarded-command' });
                const { response, bytes: body, headersArray, invocationOrdinal } = await rawCapture.exchange(
                    () => route.fetch({ postData: Buffer.from(forwarded), maxRedirects: 0, maxRetries: 0, timeout: 15000 }),
                    { source: 'route-fetch', parentRequestOrdinal: data.requestOrdinal, method: 'PUT', url });
                receipt.status = response.status();
                receipt.nativeInvocationOrdinal = invocationOrdinal;
                receipt.contentDigest = sha256(body);
                receipt.nativeRequests.push({ method: 'PUT', invocationOrdinal, status: receipt.status, contentDigest: receipt.contentDigest });
                const error = bindings.preference.decodeError(body);
                assert.equal(response.status(), 409, 'formal backend did not reject the conflicting revision');
                assert.equal(error.kind, 'revision-conflict', 'formal backend did not return the canonical AEDS conflict');
                assert.ok(originalHeaders(headersArray)['content-type']?.split(';')[0].trim() === bindings.preference.mediaType, 'conflict media type');
                receipt.error = error;
                // Preserve the real server headers/body/status. No injected error POD or auth header.
                await route.fulfill({ response });
            }
            else if (action.kind === 'abort')
            {
                receipt.errorCode = action.errorCode ?? 'failed';
                assert.ok(['failed', 'timedout', 'aborted'].includes(receipt.errorCode), 'unsupported transport error');
                await route.abort(receipt.errorCode);
            }
            else if (action.kind === 'http-error')
            {
                receipt.status = action.status;
                await route.fulfill({ status: action.status, body: '' });
            }
            else
            {
                assert.equal(action.kind, 'resource-replacement', 'unknown HTTP fault action');
                const suppliedBody = Buffer.from(action.body);
                receipt.contentDigest = sha256(suppliedBody);
                receipt.mutation = action.mutation;
                receipt.suppliedBodySequence = rawCapture.supplied(suppliedBody, { requestOrdinal: data.requestOrdinal,
                    purpose: 'resource-replacement-input', url, headersArray: [{ name: 'Content-Type', value: action.contentType }] });
                await route.fulfill({ status: 200, contentType: action.contentType, body: suppliedBody });
            }
            completed.resolve(structuredClone(receipt));
        }
        catch (error)
        {
            if (trace.length)
            {
                trace[trace.length - 1].failure = { name: error.name, message: error.message };
            }
            completed.reject(error);
            serverObserved.reject(error);
            await route.abort('failed').catch(() =>
            {});
        }
    };
    const handler = (route) =>
    {
        if (!accepting)
        {
            rawCapture.fail('fault-handler-after-disposal');
            return route.abort('aborted');
        }
        if (inFlight.size >= rawCapture.limits.pending)
        {
            const error = rawCapture.fail('fault-pending-overflow');
            completed.reject(error);
            serverObserved.reject(error);
            return route.abort('failed');
        }
        const work = execute(route);
        inFlight.add(work);
        void work.then(() => inFlight.delete(work), () => inFlight.delete(work));
        return work;
    };
    await context.route(matches, handler);
    let disposePromise;
    return Object.freeze({
        entered,
        serverObserved: serverObserved.promise,
        completed: completed.promise,
        trace: () => structuredClone(trace),
        release: () => barrier.release({ kind: 'continue' }),
        dispose()
        {
            disposePromise ??= (async () =>
            {
                accepting = false;
                barrier.close();
                let firstError;
                try
                {
                    await context.unroute(matches, handler);
                }
                catch (error)
                {
                    firstError = error;
                    rawCapture.fail('fault-unroute-failed', rawCapture.cut(), error);
                }
                try
                {
                    await waitForPublicShellLocaleResourceEntry(Promise.all([...inFlight]));
                }
                catch (error)
                {
                    firstError ??= error;
                    rawCapture.fail('fault-drain-incomplete', rawCapture.cut(), error);
                }
                if (firstError)
                {
                    throw firstError;
                }
                return { trace: immutable(trace) };
            })();
            return disposePromise;
        }
    });
}

/** A deadline diagnoses a missing interception; it never advances or qualifies a scene. */
export async function waitForPublicShellLocaleResourceEntry(entered, timeoutMs = 15000)
{
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'positive observation deadline required');
    let timer;
    try
    {
        await Promise.race([entered, new Promise((_, reject) =>
        {
            timer = setTimeout(() => reject(new Error('formal resource interception was not observed')), timeoutMs);
        })]);
    }
    finally
    {
        clearTimeout(timer);
    }
}

/** Only these HTTP outcomes have an implemented, non-synthetic fault driver in this slice. */
export function assertPublicShellLocaleFaultBinding({ bindings, scene, url, action })
{
    const resource = bindings.resources.find((item) => item.url === url);
    const mode = scene.transition?.failureMode;
    if (scene.stage === 'superseded-failure')
    {
        const targets = scene.transition.rapidTargets;
        assert.ok(Array.isArray(targets) && targets.length >= 2 && targets.at(-1) === scene.locale, 'canonical rapid sequence required');
        if (mode === 'late-resource')
        {
            const owners = resource?.identities.filter((identity) => identity.kind === 'domain'
                && identity.locale === targets[0] && scene.requiredDomains.includes(identity.domain)) ?? [];
            assert.equal(owners.length, 1, 'late resource must belong to first superseded target');
            assert.equal(action.kind, 'resource-replacement');
            assert.equal(action.contentType, 'text/javascript');
            assert.equal(action.mutation?.recipe, 'hold-sealed-response');
            assert.equal(action.mutation.mode, mode);
            assert.equal(action.mutation.targetDigest, resource.digest);
            assert.equal(sha256(action.body), resource.digest, 'late resource must be actual sealed bytes');
            return;
        }
        assert.equal(mode, 'late-preference', 'unknown superseded injection');
    }
    if (action.kind === 'preference-response')
    {
        assert.equal(url, bindings.preferenceUrl, 'native response requires formal preference endpoint');
        const expected = scene.stage === 'superseded-failure' ? 'late'
            : scene.stage === 'revision-conflict' && mode === 'stale-response' ? 'stale'
                : scene.stage === 'preference-failure' && mode === 'network-failure' ? 'lost' : null;
        assert.ok(expected, 'native response delivery has no applicable scene');
        assert.equal(action.delivery, expected, 'native response mode does not implement this scene');
        assert.equal(action.targetLocale, expected === 'late' ? scene.transition.rapidTargets[0] : scene.locale);
        assert.equal(action.authActionContext, scene.authActionContext, 'native response actor mismatch');
        assert.ok(['anonymous', 'authenticated', 'admin'].includes(action.authActionContext), 'formal matrix actor required');
        assert.ok(Number.isSafeInteger(action.currentRevision) && action.currentRevision >= 0, 'observed pre-click revision required');
        return;
    }
    const preference = ['preference-failure', 'revision-conflict'].includes(scene.stage);
    if (preference)
    {
        assert.equal(url, bindings.preferenceUrl, 'preference fault must target the formal preference endpoint');
        if (scene.stage === 'revision-conflict')
        {
            assert.equal(mode, 'conflict', 'stale-response has no implemented semantic driver in this slice');
            assert.equal(action.kind, 'revision-conflict', 'conflict requires forwarding a real request to the backend');
            assert.equal(action.targetLocale, scene.locale, 'conflict target identity');
            assert.ok(Number.isSafeInteger(action.currentRevision) && action.currentRevision >= 0, 'observed current revision required');
            return;
        }
        if (mode === 'network-failure')
        {
            assert.equal(action.kind, 'abort', 'network failure requires an actual failed HTTP request');
            assert.equal(action.errorCode ?? 'failed', 'failed', 'network failure mislabeled as another transport outcome');
            return;
        }
        if (mode === 'cancel')
        {
            assert.equal(action.kind, 'abort', 'cancel requires a real request abort');
            assert.equal(action.errorCode, 'aborted', 'cancel transport outcome');
            return;
        }
    }
    else
    {
        if (scene.stage === 'font-failure')
        {
            assert.ok(resource?.identities.some((identity) => ['font', 'font-style'].includes(identity.kind)
                && identity.locale === scene.locale && identity.script === scene.requiredFont.script), 'font fault has the wrong catalog owner');
            if (mode === 'load-failure')
            {
                assert.equal(action.kind, 'abort', 'font load-failure requires a real request failure');
                assert.equal(action.errorCode, 'failed', 'font transport outcome');
                return;
            }
            if (['wrong-face', 'wrong-script'].includes(mode))
            {
                assert.equal(action.kind, 'resource-replacement', 'font identity injection requires actual font bytes');
                assert.equal(action.contentType, 'font/woff2');
                const target = resource.identities.filter((identity) => identity.kind === 'font' && identity.locale === scene.locale);
                assert.equal(target.length, 1, 'font binary owner must be unambiguous for this target');
                const replacement = bindings.resources.find((item) => item.url === action.mutation?.replacement?.url);
                assert.ok(replacement && replacement.digest === sha256(action.body), 'replacement font bytes are not sealed');
                assert.equal(action.mutation.mode, mode);
                assert.equal(action.mutation.targetDigest, resource.digest);
                assert.notEqual(replacement.digest, resource.digest, 'wrong font bytes unchanged');
                const owners = replacement.identities.filter((identity) => identity.kind === 'font');
                assert.ok(owners.length > 0 && owners.every((identity) => identity.weight === target[0].weight), 'wrong font weight would confound identity');
                if (mode === 'wrong-face')
                {
                    assert.ok(owners.every((identity) => identity.family !== target[0].family || identity.unicodeRange !== target[0].unicodeRange),
                        'wrong-face requires a genuinely distinct face/family/subset');
                }
                else
                {
                    assert.ok(owners.every((identity) => identity.script !== target[0].script), 'wrong-script retained same script');
                }
                return;
            }
        }
        else
        {
            assert.ok(['domain-failure', 'artifact-invalid', 'retry'].includes(scene.stage), 'failure stage has no implemented semantic driver in this slice');
            const targets = resource?.identities.filter((identity) => identity.kind === 'domain'
                && identity.locale === scene.locale && scene.requiredDomains.includes(identity.domain)) ?? [];
            assert.equal(targets.length, 1, 'domain fault must target the clicked locale and a required domain');
            if (scene.stage === 'retry')
            {
                assert.equal(mode, 'complete-preparation');
                assert.equal(action.kind, 'http-error');
                assert.equal(action.status, 503);
                return;
            }
            if (scene.stage === 'domain-failure' && ['invalid-content', 'invalid-schema', 'invalid-digest'].includes(mode))
            {
                assert.equal(action.kind, 'resource-replacement');
                assert.equal(action.contentType, 'text/javascript');
                assert.equal(action.mutation?.mode, mode);
                assert.equal(action.mutation.recipe, 'sealed-module-ast');
                assert.equal(action.mutation.targetDigest, resource.digest);
                assert.equal(action.mutation.schemaDigest, targets[0].schemaDigest);
                assert.notEqual(sha256(action.body), resource.digest, 'domain injection did not change actual bytes');
                if (mode === 'invalid-schema')
                {
                    assert.notEqual(action.mutation.mutatedSchemaDigest, action.mutation.schemaDigest);
                }
                if (mode === 'invalid-digest')
                {
                    assert.equal(action.mutation.mutatedSchemaDigest, action.mutation.schemaDigest, 'content mutation changed schema');
                }
                return;
            }
            if (scene.stage === 'artifact-invalid')
            {
                assert.equal(action.kind, 'resource-replacement', 'artifact fault requires real resource bytes');
                assert.equal(action.contentType, 'text/javascript', 'domain artifact media type');
                assert.ok(action.body instanceof Uint8Array && action.body.length > 0, 'actual artifact bytes required');
                const mutation = action.mutation;
                assert.equal(mutation?.mode, mode, 'artifact fault mode/proof mismatch');
                assert.equal(mutation.targetDigest, resource.digest, 'artifact target is not the sealed build resource');
                assert.notEqual(sha256(action.body), resource.digest, 'artifact fault did not change the actual bytes');
                if (mode === 'content-digest')
                {
                    assert.equal(mutation.recipe, 'append-inert-comment', 'content-digest recipe');
                    assert.ok(Number.isSafeInteger(mutation.originalLength) && mutation.originalLength > 0
                        && mutation.originalLength < action.body.length, 'sealed original byte length required');
                    assert.equal(Buffer.from(action.body.subarray(mutation.originalLength)).toString(), publicShellLocaleInertDigestSuffix,
                        'digest mutation changed executable semantics');
                    assert.equal(sha256(action.body.subarray(0, mutation.originalLength)), resource.digest, 'digest mutation lost sealed original bytes');
                }
                else if (mode === 'cross-version')
                {
                    const proof = mutation.replacement;
                    assert.equal(proof?.kind, 'foreign-build', 'cross-version requires an admitted foreign build');
                    assert.equal(proof.locale, targets[0].locale, 'cross-version locale changed');
                    assert.equal(proof.domain, targets[0].domain, 'cross-version domain changed');
                    assert.equal(sha256(action.body), proof.digest, 'cross-version body differs from its foreign build');
                    assert.ok(proof.receiptFile && proof.buildDigest && proof.manifestDigest, 'cross-version receipt refs missing');
                    assert.notEqual(proof.buildDigest, bindings.identity.buildDigest, 'cross-version reused the current build');
                    assert.ok(proof.sourceState.commit !== bindings.identity.sourceState.commit
                        || proof.sourceState.worktreeFingerprint !== bindings.identity.sourceState.worktreeFingerprint, 'cross-version reused the current source');
                }
                else
                {
                    assert.ok(['cross-locale', 'cross-domain'].includes(mode), 'unknown artifact fault mode');
                    const replacement = bindings.resources.find((item) => item.url === mutation.replacement?.url);
                    assert.ok(replacement && sha256(action.body) === replacement.digest, 'replacement bytes have no sealed current-build owner');
                    const owners = replacement.identities.filter((identity) => identity.kind === 'domain');
                    assert.equal(owners.length, 1, 'replacement domain owner ambiguous');
                    assert.equal(owners[0][mode === 'cross-locale' ? 'domain' : 'locale'], targets[0][mode === 'cross-locale' ? 'domain' : 'locale'],
                        'artifact fault changed both locale and domain');
                    assert.notEqual(owners[0][mode === 'cross-locale' ? 'locale' : 'domain'], targets[0][mode === 'cross-locale' ? 'locale' : 'domain'],
                        'artifact fault did not cross its declared identity');
                }
                return;
            }
        }
    }
    if (mode === 'timeout')
    {
        assert.equal(action.kind, 'abort', 'timeout requires a real transport timeout');
        assert.equal(action.errorCode, 'timedout', 'generic request failure is not a timeout');
        return;
    }
    assert.equal(mode, 'non-2xx', 'failure mode has no implemented semantic driver in this slice');
    assert.equal(action.kind, 'http-error', 'non-2xx requires an actual HTTP failure status');
    assert.ok(Number.isInteger(action.status) && action.status >= 400 && action.status <= 599, 'failure status required');
}

function operationFor(request, bindings)
{
    const url = new URL(request.url);
    assert.equal(url.origin, new URL(bindings.preferenceUrl).origin, 'request leaves the formal runtime');
    const segments = url.pathname.split('/');
    const exact = bindings.preference.apiOperations.filter((operation) => operation.method === request.method && operation.path === url.pathname);
    const matches = exact.length ? exact : bindings.preference.apiOperations.filter((operation) => operation.method === request.method
        && operation.path.split('/').length === segments.length
        && operation.path.split('/').every((part, index) => part === segments[index]
            || (/^\{[^/{}]+\}$/u.test(part) && segments[index].length > 0)));
    assert.equal(matches.length, 1, 'API request has no unique formal endpoint owner');
    return matches[0];
}

/** Initial-network contract uses manifest identities, not locale substrings in filenames.
 * Cache/preload observations are included without inventing cache status or body digests.
 */
export function assertPublicShellLocaleResourceWaterfall({ bindings, scene, evidence, fontObservation })
{
    assert.equal(scene.issue, 2085, 'initial-network scene required');
    assert.equal(scene.stage, 'initial-network', 'initial-network stage required');
    assert.deepEqual(evidence.identity, bindings.identity, 'waterfall admission identity mismatch');
    assert.equal(scene.networkPolicy.includeCacheAndPreload, true, 'cache/preload evidence required');
    assert.equal(evidence.issues.length, 0, 'browser issues cannot be filtered');
    const byUrl = new Map(bindings.resources.map((resource) => [resource.url, resource]));
    const observed = [...evidence.requests, ...evidence.browser.performance,
        ...evidence.browser.preloads.map((entry) => ({ ...entry, resourceType: 'preload' }))];
    const domains = new Set();
    const business = new Map();
    const domainRequests = new Map();
    for (const request of observed)
    {
        const resource = byUrl.get(request.url);
        if (!resource)
        {
            if (request.resourceType === 'document')
            {
                continue;
            }
            // Resource timing duplicates a real request; API classification uses that request's method.
            const real = request.method ? request : evidence.requests.find((item) => item.urlDigest === request.urlDigest);
            assert.ok(real?.method, 'unknown resource has no real request observation');
            operationFor(real, bindings);
            if (request.method && request.url !== bindings.preferenceUrl)
            {
                const key = `${request.method}:${request.urlDigest}`;
                const count = (business.get(key) ?? 0) + 1;
                business.set(key, count);
                assert.ok(count <= 1 + scene.networkPolicy.businessDataReRequests, 'route/article data re-request');
            }
            continue;
        }
        const domainIdentities = resource.identities.filter((identity) => identity.kind === 'domain');
        if (request.method && domainIdentities.length)
        {
            const count = (domainRequests.get(request.url) ?? 0) + 1;
            domainRequests.set(request.url, count);
            assert.equal(count, 1, 'duplicate initial locale/domain request');
        }
        for (const identity of domainIdentities)
        {
            assert.equal(identity.locale, scene.locale, 'initial network loaded another locale');
            assert.ok(scene.requiredDomains.includes(identity.domain), 'initial network loaded an unrelated domain');
            domains.add(identity.domain);
        }
        const fonts = resource.identities.filter((identity) => ['font', 'font-style'].includes(identity.kind));
        if (request.resourceType === 'font' || request.as === 'font')
        {
            assert.ok(fonts.some((identity) => identity.kind === 'font'), 'requested font has no catalog/CSS owner');
        }
        if (fonts.length)
        {
            assert.ok(fonts.some((identity) => identity.locale === scene.locale && identity.script === scene.requiredFont.script),
                'initial network loaded another font script/owner');
        }
    }
    for (const domain of scene.requiredDomains)
    {
        assert.ok(domains.has(domain), 'required domain has no request/cache/preload observation');
        assert.ok(evidence.responses.some((response) => response.status === 200 && !response.observationError
            && response.contentDigest === response.resource?.digest
            && response.resource.identities.some((identity) => identity.kind === 'domain'
                && identity.locale === scene.locale && identity.domain === domain)), 'required domain bytes were not observed');
    }
    assertPublicShellLocaleFontIdentity({ font: scene.requiredFont, observation: fontObservation, responses: evidence.responses });
    return { observedDomains: [...domains].sort(), requestCount: evidence.requests.length };
}

/** Cursor is the caller's actual before-click request offset, not an invented runtime phase. */
export function assertPublicShellLocaleNoBusinessRequests({ bindings, evidence, requestOffset })
{
    assert.ok(Number.isSafeInteger(requestOffset) && requestOffset >= 0 && requestOffset <= evidence.requests.length,
        'actual before-click request offset required');
    for (const request of evidence.requests.slice(requestOffset))
    {
        if (bindings.resources.some((resource) => resource.url === request.url))
        {
            continue;
        }
        assert.equal(request.url, bindings.preferenceUrl, 'locale transaction issued a business/unknown request');
        operationFor(request, bindings);
    }
}
