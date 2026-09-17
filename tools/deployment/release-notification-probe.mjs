#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readRolloutState } from './release-rollout-lib.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const NOTIFICATION_EVIDENCE_SCHEMA = 'fsusblog.release-notification-stream-evidence.v1';
export const NOTIFICATION_RESYNC_SCENARIO_SCHEMA = 'fsusblog.release-notification-resync-scenario.v1';
export const NOTIFICATION_PROTOCOL = 'fsus-aeds.v2';
export const NOTIFICATION_EVENT_FRAME_TYPE = 69;
export const NOTIFICATION_HEARTBEAT_FRAME_TYPE = 70;
export const SERVICE_RESTART_CLOSE_CODE = 1012;
export const SERVICE_RESTART_REASON = 'fsus_service_restart';
export const REPLAY_MISS_CLOSE_CODE = 4009;
export const REPLAY_MISS_REASON = 'fsus_replay_miss';

class NotificationProbeInputError extends Error
{
    constructor(errors)
    {
        const normalized = unique(errors.map(value => String(value)).filter(Boolean));
        super(normalized.join('; ') || 'notification probe input is invalid');
        this.name = 'NotificationProbeInputError';
        this.errors = normalized;
    }
}

export async function runNotificationProbe(options)
{
    if (fs.existsSync(options.out))
    {
        throw new NotificationProbeInputError([`output already exists: ${options.out}`]);
    }
    const rollout = readRolloutState(options.rolloutState);
    const adminHeader = readAdminHeader(options.adminHeaderFile);
    const scenario = readResyncScenario(options.resyncScenario);
    const inputBindings = {
        rolloutState: fileBinding(options.rolloutState, 'rollout state'),
        authStorageState: fileBinding(options.authStorageState, 'auth storage state'),
        resyncScenario: fileBinding(options.resyncScenario, 'resync scenario')
    };
    process.env.FSUSBLOG_BASE_URL = options.baseUrl.origin;
    const [{ chromium }, { buildPowHeaders }] = await Promise.all([
        import(pathToFileURL(options.playwrightModule).href),
        import(pathToFileURL(path.join(root, 'tests/frontend/support/auth-helpers.mjs')).href)
    ]);
    const browser = await chromium.launch({ headless: true });
    let guestContext;
    let authContext;
    try
    {
        const state = createState(rollout, scenario, inputBindings);
        fs.rmSync(options.stopFile, { force: true });
        guestContext = await browser.newContext({ serviceWorkers: 'block' });
        authContext = await browser.newContext({ storageState: options.authStorageState, serviceWorkers: 'block' });
        const guestPage = await guestContext.newPage();
        const authPage = await authContext.newPage();
        const slowPage = await guestContext.newPage();
        await Promise.all([
            guestPage.goto(options.baseUrl.origin),
            authPage.goto(options.baseUrl.origin),
            slowPage.goto(options.baseUrl.origin)
        ]);
        await installClient(guestPage, 'guest', state, async cursor =>
        {
            const fingerprint = `rollout-${rollout.rolloutId}-guest-${Date.now()}`;
            const pow = await buildPowHeaders(fingerprint, options.timeoutMs);
            return websocketUrl(options.baseUrl, cursor, pow['X-Fsus-Pow-Proof'], 'guest');
        }, { resync: scenario.modes.guest, target: rollout.target });
        await installClient(authPage, 'auth', state, async cursor => websocketUrl(options.baseUrl, cursor, null, 'auth'), {
            resync: scenario.modes.auth,
            target: rollout.target
        });
        state.clients.slow = emptyClient('slow', 'guest');
        await installClient(slowPage, 'slow', state, async cursor =>
        {
            const fingerprint = `rollout-${rollout.rolloutId}-slow-${Date.now()}`;
            const pow = await buildPowHeaders(fingerprint, options.timeoutMs);
            return websocketUrl(options.baseUrl, cursor, pow['X-Fsus-Pow-Proof'], 'slow');
        }, { resync: scenario.modes.guest, target: rollout.target });

        await waitFor(
            'guest/auth/slow notification streams to open',
            () => ['guest', 'auth', 'slow'].every(label => state.clients[label].openCount > 0),
            options.timeoutMs);
        state.expected.pre = expectedDrillEvents(
            await publishDrill(options.sourcePort, rollout.source, 'pre-switch', options.eventCount, adminHeader, options),
            'pre-switch');
        await waitFor(
            'pre-switch business events on guest/auth streams',
            () => deliveredToClients(state, state.expected.pre, ['guest', 'auth']),
            options.timeoutMs);
        writeSnapshot(state, options.snapshot, 'running');

        let stalePages = null;
        let finalSnapshotsCaptured = false;
        const deadline = Date.now() + options.maxDurationMs;
        while (Date.now() < deadline)
        {
            const stopRequested = fs.existsSync(options.stopFile);
            const current = readRolloutState(options.rolloutState);
            if (current.completedStages.includes('active-fence') && state.expected.post.length === 0)
            {
                state.expected.post = expectedDrillEvents(
                    await publishDrill(options.targetPort, rollout.target, 'post-switch', options.eventCount, adminHeader, options),
                    'post-switch');
            }
            const restartObserved = ['guest', 'auth'].every(label => hasClose(state.clients[label], SERVICE_RESTART_CLOSE_CODE, SERVICE_RESTART_REASON));
            if (restartObserved && state.expected.gap.length === 0)
            {
                state.expected.gap = expectedDrillEvents(
                    await publishDrill(options.targetPort, rollout.target, 'replay-gap', options.eventCount, adminHeader, options),
                    'replay-gap');
            }
            if (restartObserved && state.expected.gap.length > 0 && stalePages === null)
            {
                const staleGuestPage = await guestContext.newPage();
                const staleAuthPage = await authContext.newPage();
                await Promise.all([staleGuestPage.goto(options.baseUrl.origin), staleAuthPage.goto(options.baseUrl.origin)]);
                state.clients.staleGuest = emptyClient('staleGuest', 'guest');
                state.clients.staleAuth = emptyClient('staleAuth', 'auth');
                await installClient(staleGuestPage, 'staleGuest', state, async cursor =>
                {
                    const fingerprint = `rollout-${rollout.rolloutId}-stale-guest-${Date.now()}`;
                    const pow = await buildPowHeaders(fingerprint, options.timeoutMs);
                    return websocketUrl(options.baseUrl, cursor, pow['X-Fsus-Pow-Proof'], 'stale-guest');
                }, { initialCursor: 1, resync: scenario.modes.guest, target: rollout.target });
                await installClient(staleAuthPage, 'staleAuth', state, async cursor => websocketUrl(options.baseUrl, cursor, null, 'stale-auth'), {
                    initialCursor: 1,
                    resync: scenario.modes.auth,
                    target: rollout.target
                });
                stalePages = { staleGuest: staleGuestPage, staleAuth: staleAuthPage };
            }
            if (stalePages && replayMissResyncReady(state) && state.expected.afterResync.length === 0)
            {
                state.expected.afterResync = expectedDrillEvents(
                    await publishDrill(options.targetPort, rollout.target, 'after-resync', options.eventCount, adminHeader, options),
                    'after-resync');
            }
            const sourceDrainReady = drainGatePassed(options.drainEvidence);
            if (sourceDrainReady && stalePages && preFinalConditionsMet(state) && !finalSnapshotsCaptured)
            {
                await Promise.all(Object.entries(stalePages).map(async ([label, page]) =>
                {
                    const observation = await page.evaluate(async clientLabel =>
                    {
                        const capture = window[`__fsusNotificationResync_${clientLabel}`];
                        if (typeof capture !== 'function')
                        {
                            throw new Error(`full-state resync function missing for ${clientLabel}`);
                        }
                        return await capture('final');
                    }, label);
                    if (!observation || observation.phase !== 'final')
                    {
                        recordClientEvent(state, label, { type: 'error', message: 'final full-state resync returned an invalid observation' });
                    }
                }));
                finalSnapshotsCaptured = true;
            }
            writeSnapshot(state, options.snapshot, 'running');
            if (sourceDrainReady && finalSnapshotsCaptured && evidenceConditionsMet(state))
            {
                break;
            }
            if (stopRequested)
            {
                break;
            }
            await delay(100);
        }

        const report = finalizeNotificationEvidence(state, options);
        writeJsonExclusiveAtomic(options.out, report);
        writeJsonAtomic(options.snapshot, report);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (report.status !== 'pass')
        {
            process.exitCode = 1;
        }
        return report;
    }
    finally
    {
        await Promise.allSettled([guestContext?.close(), authContext?.close()]);
        await browser.close().catch(() =>
        {});
    }
}

export function parseNotificationProbeArgs(argv, environment = process.env)
{
    const parsed = {
        timeoutMs: 30_000,
        maxDurationMs: 300_000,
        eventCount: 4,
        playwrightModule: path.join(root, 'src/frontend/node_modules/playwright/index.mjs')
    };
    const allowed = new Set([
        'base-url', 'source-port', 'target-port', 'rollout-state', 'auth-storage-state',
        'admin-header-file', 'control-origin', 'snapshot', 'out', 'stop-file', 'drain-evidence',
        'resync-scenario', 'timeout-ms', 'max-duration-ms', 'event-count', 'playwright-module'
    ]);
    const errors = [];
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            errors.push(`invalid argument near ${name ?? '<end>'}`);
            continue;
        }
        const key = name.slice(2);
        if (!allowed.has(key))
        {
            errors.push(`unknown argument --${key}`);
        }
        else if (parsed[key] !== undefined)
        {
            errors.push(`duplicate argument --${key}`);
        }
        else
        {
            parsed[key] = value;
        }
    }
    parsed['resync-scenario'] ??= environment.FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO;
    const required = [
        'base-url', 'source-port', 'target-port', 'rollout-state', 'auth-storage-state',
        'admin-header-file', 'control-origin', 'snapshot', 'out', 'stop-file', 'drain-evidence', 'resync-scenario'
    ];
    for (const name of required)
    {
        if (!parsed[name])
        {
            errors.push(`--${name} is required`);
        }
    }
    let baseUrl;
    try
    {
        baseUrl = new URL(parsed['base-url'] ?? 'invalid:');
        if (baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash)
        {
            errors.push('--base-url must be an exact origin without credentials/path/query/fragment');
        }
        if (baseUrl.protocol !== 'https:'
      && !(environment.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE === '1' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(baseUrl.hostname)))
        {
            errors.push('--base-url must be HTTPS except explicit loopback rehearsal');
        }
    }
    catch (error)
    {
        errors.push(`--base-url is invalid: ${message(error)}`);
    }
    const boundedValue = (name, fallback, minimum, maximum) =>
    {
        try
        {
            return bounded(parsed[name] ?? fallback, minimum, maximum, name);
        }
        catch (error)
        {
            errors.push(message(error));
            return fallback;
        }
    };
    const result = {
        baseUrl,
        sourcePort: boundedValue('source-port', 0, 1, 65535),
        targetPort: boundedValue('target-port', 0, 1, 65535),
        rolloutState: resolveOptional(parsed['rollout-state']),
        authStorageState: resolveOptional(parsed['auth-storage-state']),
        adminHeaderFile: resolveOptional(parsed['admin-header-file']),
        controlOrigin: normalizeControlOrigin(parsed['control-origin'], environment, errors),
        snapshot: resolveOptional(parsed.snapshot),
        out: resolveOptional(parsed.out),
        stopFile: resolveOptional(parsed['stop-file']),
        drainEvidence: resolveOptional(parsed['drain-evidence']),
        resyncScenario: resolveOptional(parsed['resync-scenario']),
        timeoutMs: boundedValue('timeout-ms', parsed.timeoutMs, 1_000, 120_000),
        maxDurationMs: boundedValue('max-duration-ms', parsed.maxDurationMs, 10_000, 1_800_000),
        eventCount: boundedValue('event-count', parsed.eventCount, 1, 32),
        playwrightModule: resolveOptional(parsed['playwright-module'] ?? parsed.playwrightModule)
    };
    for (const [file, label, privateFile] of [
        [result.rolloutState, 'rollout state', false],
        [result.authStorageState, 'auth storage state', true],
        [result.adminHeaderFile, 'admin header', true],
        [result.resyncScenario, 'resync scenario', false],
        [result.playwrightModule, 'Playwright module', false]
    ])
    {
        if (!file)
        {
            continue;
        }
        try
        {
 privateFile ? requirePrivateFile(file, label) : requireRegularFile(file, label);
        }
        catch (error)
        {
            errors.push(message(error));
        }
    }
    if (errors.length > 0)
    {
        throw new NotificationProbeInputError(errors);
    }
    return result;
}

function normalizeControlOrigin(value, environment, errors)
{
    if (!value)
    {
        return null;
    }
    try
    {
        const origin = new URL(String(value));
        if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
        {
            errors.push('--control-origin must be an exact origin without credentials/path/query/fragment');
        }
        if (origin.protocol !== 'https:'
      && !(environment.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE === '1' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(origin.hostname)))
        {
            errors.push('--control-origin must be HTTPS except explicit loopback rehearsal');
        }
        return origin.origin;
    }
    catch (error)
    {
        errors.push(`--control-origin is invalid: ${message(error)}`);
        return null;
    }
}

export function normalizeResyncScenario(value)
{
    const errors = [];
    if (!isObject(value))
    {
        throw new NotificationProbeInputError(['resync scenario must be a JSON object']);
    }
    if (value.schema !== NOTIFICATION_RESYNC_SCENARIO_SCHEMA)
    {
        errors.push(`scenario.schema must be ${NOTIFICATION_RESYNC_SCENARIO_SCHEMA}`);
    }
    if (value.hashAlgorithm !== 'sha256-raw-body-v1')
    {
        errors.push('scenario.hashAlgorithm must be sha256-raw-body-v1');
    }
    if (value.stableContentHashRequired !== true)
    {
        errors.push('scenario.stableContentHashRequired must be true');
    }
    const reconnectDelayMs = normalizeReconnectWindow(value.reconnectDelayMs, errors);
    let slowClientDrainDeadlineMs = null;
    try
    {
        slowClientDrainDeadlineMs = bounded(value.slowClientDrainDeadlineMs, 1_000, 60_000, 'scenario.slowClientDrainDeadlineMs');
    }
    catch (error)
    {
        errors.push(message(error));
    }
    const modes = {};
    for (const mode of ['guest', 'auth'])
    {
        modes[mode] = normalizeSnapshotMode(value.modes?.[mode], mode, errors);
    }
    if (errors.length > 0)
    {
        throw new NotificationProbeInputError(errors);
    }
    return {
        schema: NOTIFICATION_RESYNC_SCENARIO_SCHEMA,
        hashAlgorithm: 'sha256-raw-body-v1',
        stableContentHashRequired: true,
        reconnectDelayMs,
        slowClientDrainDeadlineMs,
        modes
    };
}

function normalizeReconnectWindow(value, errors)
{
    if (!isObject(value))
    {
        errors.push('scenario.reconnectDelayMs must be an object');
        return { scheduled: 500, minimum: 250, maximum: 1250 };
    }
    const result = {};
    for (const [name, minimum, maximum] of [
        ['scheduled', 250, 5_000],
        ['minimum', 0, 5_000],
        ['maximum', 250, 10_000]
    ])
    {
        try
        {
            result[name] = bounded(value[name], minimum, maximum, `scenario.reconnectDelayMs.${name}`);
        }
        catch (error)
        {
            errors.push(message(error));
            result[name] = name === 'maximum' ? 1250 : name === 'minimum' ? 250 : 500;
        }
    }
    if (result.minimum > result.scheduled || result.scheduled > result.maximum)
    {
        errors.push('scenario.reconnectDelayMs must satisfy minimum <= scheduled <= maximum');
    }
    return result;
}

function normalizeSnapshotMode(value, mode, errors)
{
    if (!isObject(value))
    {
        errors.push(`scenario.modes.${mode} must be an object`);
        return null;
    }
    const requestPath = String(value.path ?? '');
    if (!requestPath.startsWith('/') || requestPath.startsWith('//') || requestPath.includes('\\')
    || requestPath.includes('\r') || requestPath.includes('\n') || requestPath.split(/[?#]/u)[0].split('/').includes('..'))
    {
        errors.push(`scenario.modes.${mode}.path must be a safe same-origin absolute path`);
    }
    if ((value.method ?? 'GET') !== 'GET')
    {
        errors.push(`scenario.modes.${mode}.method must be GET`);
    }
    const accept = String(value.accept ?? '').trim();
    if (!accept || /[\r\n]/u.test(accept))
    {
        errors.push(`scenario.modes.${mode}.accept is invalid`);
    }
    const expectedContentType = String(value.expectedContentType ?? '').trim().toLowerCase();
    if (!expectedContentType || /[\r\n]/u.test(expectedContentType))
    {
        errors.push(`scenario.modes.${mode}.expectedContentType is invalid`);
    }
    const watermarkHeader = normalizeEvidenceHeader(value.watermarkHeader, `${mode}.watermarkHeader`, errors);
    const contentHashHeader = normalizeEvidenceHeader(value.contentHashHeader, `${mode}.contentHashHeader`, errors);
    if (watermarkHeader && contentHashHeader && watermarkHeader.toLowerCase() === contentHashHeader.toLowerCase())
    {
        errors.push(`scenario.modes.${mode} watermark/content hash headers must differ`);
    }
    let minimumBytes = null;
    let maximumBytes = null;
    try
    {
        minimumBytes = bounded(value.minimumBytes, 1, 16 * 1024 * 1024, `scenario.modes.${mode}.minimumBytes`);
    }
    catch (error)
    {
        errors.push(message(error));
    }
    try
    {
        maximumBytes = bounded(value.maximumBytes, 1, 16 * 1024 * 1024, `scenario.modes.${mode}.maximumBytes`);
    }
    catch (error)
    {
        errors.push(message(error));
    }
    if (Number.isFinite(minimumBytes) && Number.isFinite(maximumBytes) && minimumBytes > maximumBytes)
    {
        errors.push(`scenario.modes.${mode} minimumBytes must not exceed maximumBytes`);
    }
    return {
        mode,
        path: requestPath,
        method: 'GET',
        accept,
        expectedContentType,
        watermarkHeader,
        contentHashHeader,
        minimumBytes,
        maximumBytes
    };
}

function normalizeEvidenceHeader(value, label, errors)
{
    const header = String(value ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9-]{1,63}$/u.test(header))
    {
        errors.push(`scenario.modes.${label} is invalid`);
    }
    if (/^(authorization|cookie|set-cookie|proxy-authorization)$/iu.test(header))
    {
        errors.push(`scenario.modes.${label} must not be sensitive`);
    }
    return header;
}

function readResyncScenario(file)
{
    requireRegularFile(file, 'resync scenario');
    return normalizeResyncScenario(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function createState(rollout, scenario, inputBindings = {})
{
    return {
        rolloutId: rollout.rolloutId,
        source: rollout.source,
        target: rollout.target,
        startedAtUtc: new Date().toISOString(),
        scenario,
        inputBindings,
        clients: {
            guest: emptyClient('guest', 'guest'),
            auth: emptyClient('auth', 'auth')
        },
        expected: { pre: [], post: [], gap: [], afterResync: [] },
        errors: []
    };
}

export function emptyClient(label, mode = label.toLowerCase().includes('auth') ? 'auth' : 'guest')
{
    return {
        label,
        mode,
        openCount: 0,
        closeCodes: [],
        closeReasons: [],
        closeEvents: [],
        eventIds: [],
        appliedEventIds: [],
        businessEventIds: [],
        appliedBusinessEventIds: [],
        events: [],
        duplicateAppliedEventCount: 0,
        duplicateBusinessEventCount: 0,
        heartbeatCount: 0,
        fullResyncCount: 0,
        resyncSnapshots: [],
        reconnects: [],
        reconnectDurationsMs: [],
        lastCloseAt: null,
        errors: []
    };
}

async function installClient(page, label, state, nextUrl, clientOptions = {})
{
    const reportBinding = `__fsusReport_${label}_${process.pid}`;
    const urlBinding = `__fsusUrl_${label}_${process.pid}`;
    await page.exposeFunction(reportBinding, event => recordClientEvent(state, label, event));
    await page.exposeFunction(urlBinding, cursor => nextUrl(cursor));
    const initialUrl = await nextUrl(clientOptions.initialCursor ?? null);
    const browserConfig = {
        labelValue: label,
        initial: initialUrl,
        reportName: reportBinding,
        urlName: urlBinding,
        protocolValue: NOTIFICATION_PROTOCOL,
        initialCursor: clientOptions.initialCursor ?? null,
        resync: clientOptions.resync,
        target: clientOptions.target,
        reconnect: state.scenario.reconnectDelayMs
    };
    await page.evaluate(config =>
    {
        const recent = [];
        const applied = new Set();
        let lastEventId = config.initialCursor ?? 0;
        let pendingReconnect = null;
        const report = event => window[config.reportName](event);
        const reader = bytes =>
        {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let offset = 0;
            const requireBytes = count =>
            {
                if (offset + count > bytes.byteLength)
                {
                    throw new Error('notification payload truncated');
                }
            };
            const readByte = () =>
            {
                requireBytes(1);
                return bytes[offset++];
            };
            const readInt32 = () =>
            {
                requireBytes(4);
                const value = view.getInt32(offset, true);
                offset += 4;
                return value;
            };
            const readInt64 = () =>
            {
                requireBytes(8);
                const value = Number(view.getBigInt64(offset, true));
                offset += 8;
                return value;
            };
            const readDouble = () =>
            {
                requireBytes(8);
                const value = view.getFloat64(offset, true);
                offset += 8;
                return value;
            };
            const readString = () =>
            {
                const length = readInt32();
                if (length < 0)
                {
                    throw new Error('notification string length invalid');
                }
                requireBytes(length);
                const value = new TextDecoder().decode(bytes.subarray(offset, offset + length));
                offset += length;
                return value;
            };
            const readValue = () =>
            {
                const kind = readByte();
                if (kind === 0)
                {
                    return null;
                }
                if (kind === 1)
                {
                    return readString();
                }
                if (kind === 2)
                {
                    return readInt32();
                }
                if (kind === 3)
                {
                    return readInt64();
                }
                if (kind === 4)
                {
                    return readDouble();
                }
                if (kind === 5)
                {
                    return readByte() === 1;
                }
                if (kind === 6)
                {
                    const count = readInt32();
                    if (count < 0)
                    {
                        throw new Error('notification object count invalid');
                    }
                    const result = {};
                    for (let index = 0; index < count; index += 1)
                    {
                        result[readString()] = readValue();
                    }
                    return result;
                }
                if (kind === 7)
                {
                    const count = readInt32();
                    if (count < 0)
                    {
                        throw new Error('notification array count invalid');
                    }
                    const result = [];
                    for (let index = 0; index < count; index += 1)
                    {
                        result.push(readValue());
                    }
                    return result;
                }
                throw new Error(`notification value kind invalid: ${kind}`);
            };
            return { readInt32, readInt64, readValue, remaining: () => bytes.byteLength - offset };
        };
        const decode = buffer =>
        {
            const view = new DataView(buffer);
            if (view.byteLength < 16)
            {
                throw new Error('aeds frame too short');
            }
            if (view.getUint32(0, true) !== 0x53444541 || view.getUint8(4) !== 2 || view.getUint8(5) !== 16)
            {
                throw new Error('aeds frame header invalid');
            }
            const payloadLength = view.getUint32(10, true);
            if (payloadLength + 16 !== view.byteLength)
            {
                throw new Error('aeds frame length mismatch');
            }
            const payloadBytes = new Uint8Array(buffer, 16);
            let payloadCrc = 0xffff;
            for (const byte of payloadBytes)
            {
                payloadCrc ^= byte;
                for (let bit = 0; bit < 8; bit += 1)
                {
                    payloadCrc = (payloadCrc & 1) !== 0 ? ((payloadCrc >>> 1) ^ 0xa001) : (payloadCrc >>> 1);
                }
            }
            if ((payloadCrc & 0xffff) !== view.getUint16(14, true))
            {
                throw new Error('aeds frame payload crc mismatch');
            }
            const frameType = view.getUint16(8, true);
            if (frameType === 70)
            {
                return { kind: 'heartbeat' };
            }
            if (frameType !== 69)
            {
                throw new Error(`unexpected notification frame type ${frameType}`);
            }
            const payloadReader = reader(payloadBytes);
            const eventId = payloadReader.readInt64();
            const timestamp = payloadReader.readInt64();
            const eventType = payloadReader.readInt32();
            payloadReader.readInt32();
            const payload = payloadReader.readValue();
            if (payloadReader.remaining() !== 0)
            {
                throw new Error('notification payload trailing bytes');
            }
            if (!Number.isSafeInteger(eventId) || eventId < 1)
            {
                throw new Error('notification event id invalid');
            }
            if (!Number.isSafeInteger(timestamp) || timestamp < 1)
            {
                throw new Error('notification event timestamp invalid');
            }
            if (!Number.isSafeInteger(eventType) || eventType < 1)
            {
                throw new Error('notification event type invalid');
            }
            const drillId = typeof payload?.drillId === 'string' ? payload.drillId : null;
            const sequence = Number.isSafeInteger(payload?.sequence) ? payload.sequence : null;
            return {
                kind: 'event', eventId, timestamp, eventType, payload,
                businessEventId: drillId && sequence > 0 ? `${drillId}:${sequence}` : null
            };
        };
        const normalizeHash = value =>
        {
            const normalized = String(value ?? '').trim().toLowerCase();
            if (/^[0-9a-f]{64}$/u.test(normalized))
            {
                return `sha256:${normalized}`;
            }
            return /^sha256:[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
        };
        const sha256 = async buffer =>
        {
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
            return `sha256:${[...digest].map(value => value.toString(16).padStart(2, '0')).join('')}`;
        };
        const captureSnapshot = async phase =>
        {
            const observedAtUtc = new Date().toISOString();
            const errors = [];
            let observation;
            try
            {
                const requestUrl = new URL(config.resync.path, window.location.origin);
                if (requestUrl.origin !== window.location.origin)
                {
                    throw new Error('resync request escaped current origin');
                }
                const requestHeaders = { Accept: config.resync.accept };
                if (config.resync.mode === 'guest')
                {
                    const proofUrl = new URL(await window[config.urlName](null));
                    const powProof = proofUrl.searchParams.get('pow');
                    if (!powProof)
                    {
                        throw new Error('guest full-state resync could not obtain a fresh PoW proof');
                    }
                    requestHeaders['X-Fsus-Pow-Proof'] = powProof;
                }
                const response = await fetch(requestUrl, {
                    method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
                    headers: requestHeaders
                });
                const body = await response.arrayBuffer();
                const contentSha256 = await sha256(body);
                const declaredContentSha256 = normalizeHash(response.headers.get(config.resync.contentHashHeader));
                const watermarkRaw = response.headers.get(config.resync.watermarkHeader);
                const watermark = Number(watermarkRaw);
                const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
                const releaseId = response.headers.get('x-fsus-release-id');
                const releaseSlot = response.headers.get('x-fsus-release-slot');
                if (!response.ok)
                {
                    errors.push(`snapshot HTTP ${response.status}`);
                }
                if (!contentType.startsWith(config.resync.expectedContentType))
                {
                    errors.push(`snapshot content-type mismatch: ${contentType || 'missing'}`);
                }
                if (body.byteLength < config.resync.minimumBytes || body.byteLength > config.resync.maximumBytes)
                {
                    errors.push(`snapshot bytes ${body.byteLength} outside ${config.resync.minimumBytes}..${config.resync.maximumBytes}`);
                }
                if (!Number.isSafeInteger(watermark) || watermark < 1)
                {
                    errors.push(`snapshot watermark is invalid: ${watermarkRaw ?? 'missing'}`);
                }
                if (!declaredContentSha256)
                {
                    errors.push('snapshot declared content hash is missing or invalid');
                }
                else if (declaredContentSha256 !== contentSha256)
                {
                    errors.push('snapshot declared content hash does not match response bytes');
                }
                if (releaseId !== config.target.releaseId || releaseSlot !== config.target.slot)
                {
                    errors.push(`snapshot release identity mismatch: ${releaseId ?? 'missing'}/${releaseSlot ?? 'missing'}`);
                }
                observation = {
                    type: 'resync', phase, mode: config.resync.mode, status: errors.length === 0 ? 'pass' : 'fail',
                    requestedPath: `${requestUrl.pathname}${requestUrl.search}`,
                    httpStatus: response.status, contentType, bytes: body.byteLength, watermark,
                    contentSha256, declaredContentSha256, releaseId, releaseSlot, observedAtUtc, errors
                };
            }
            catch (error)
            {
                observation = {
                    type: 'resync', phase, mode: config.resync.mode, status: 'fail',
                    requestedPath: config.resync.path, httpStatus: null, contentType: null, bytes: null,
                    watermark: null, contentSha256: null, declaredContentSha256: null,
                    releaseId: null, releaseSlot: null, observedAtUtc,
                    errors: [String(error?.message ?? error)]
                };
            }
            report(observation);
            return observation;
        };
        window[`__fsusNotificationResync_${config.labelValue}`] = captureSnapshot;
        const connect = url =>
        {
            const socket = new WebSocket(url, config.protocolValue);
            socket.binaryType = 'arraybuffer';
            socket.addEventListener('open', () =>
            {
                const reconnect = pendingReconnect
                    ? { ...pendingReconnect, observedDurationMs: performance.now() - pendingReconnect.startedAt }
                    : null;
                pendingReconnect = null;
                report({ type: 'open', protocol: socket.protocol, reconnect });
            });
            socket.addEventListener('message', event =>
            {
                try
                {
                    const decoded = decode(event.data);
                    if (decoded.kind === 'heartbeat')
                    {
                        report({ type: 'heartbeat' });
                    }
                    else if (decoded.kind === 'event')
                    {
                        lastEventId = Math.max(lastEventId, decoded.eventId);
                        const duplicate = applied.has(decoded.eventId);
                        if (!duplicate)
                        {
                            applied.add(decoded.eventId);
                            recent.push(decoded.eventId);
                            if (recent.length > 512)
                            {
                                applied.delete(recent.shift());
                            }
                        }
                        report({ type: 'event', ...decoded, duplicate });
                    }
                }
                catch (error)
                {
                    report({ type: 'error', message: String(error?.message ?? error) });
                }
            });
            socket.addEventListener('error', () => report({ type: 'error', message: 'websocket error' }));
            socket.addEventListener('close', async event =>
            {
                const cursorBeforeClose = lastEventId;
                report({ type: 'close', code: event.code, reason: event.reason, cursorBeforeClose, closedAtUtc: new Date().toISOString() });
                if (event.code !== 1012 && event.code !== 4009)
                {
                    return;
                }
                if (event.code === 4009)
                {
                    const resync = await captureSnapshot('replay-miss');
                    if (resync.status !== 'pass')
                    {
                        return;
                    }
                    lastEventId = resync.watermark;
                    recent.splice(0);
                    applied.clear();
                    report({ type: 'full-resync', watermark: lastEventId, contentSha256: resync.contentSha256 });
                }
                const reconnectCursor = lastEventId > 0 ? lastEventId : null;
                pendingReconnect = {
                    afterCloseCode: event.code,
                    afterCloseReason: event.reason,
                    cursorBeforeClose,
                    reconnectCursor,
                    scheduledDelayMs: config.reconnect.scheduled,
                    startedAt: performance.now()
                };
                setTimeout(async () =>
                {
                    try
                    {
                        const next = await window[config.urlName](reconnectCursor);
                        connect(next);
                    }
                    catch (error)
                    {
                        report({ type: 'error', message: String(error?.message ?? error) });
                    }
                }, config.reconnect.scheduled);
            });
            window[`__fsusNotificationSocket_${config.labelValue}`] = socket;
        };
        connect(config.initial);
    }, browserConfig);
}

export function recordClientEvent(state, label, event)
{
    const client = state.clients[label];
    if (!client)
    {
        return;
    }
    if (event.type === 'open')
    {
        client.openCount += 1;
        if (event.protocol !== NOTIFICATION_PROTOCOL)
        {
            client.errors.push(`protocol:${event.protocol ?? 'missing'}`);
        }
        if (event.reconnect)
        {
            const reconnect = { ...event.reconnect };
            delete reconnect.startedAt;
            client.reconnects.push(reconnect);
            if (Number.isFinite(reconnect.observedDurationMs))
            {
                client.reconnectDurationsMs.push(reconnect.observedDurationMs);
            }
        }
    }
    else if (event.type === 'close')
    {
        client.closeCodes.push(event.code);
        client.closeReasons.push(event.reason ?? '');
        client.lastCloseAt = event.closedAtUtc ?? new Date().toISOString();
        client.closeEvents.push({
            code: event.code,
            reason: event.reason ?? '',
            cursorBeforeClose: event.cursorBeforeClose ?? null,
            closedAtUtc: client.lastCloseAt
        });
    }
    else if (event.type === 'event')
    {
        const businessEventId = event.businessEventId ?? null;
        client.eventIds.push(event.eventId);
        client.events.push({
            eventId: event.eventId,
            businessEventId,
            eventType: event.eventType ?? null,
            timestamp: event.timestamp ?? null,
            observedAtUtc: new Date().toISOString(),
            drillId: event.payload?.drillId ?? null,
            sequence: event.payload?.sequence ?? null,
            releaseId: event.payload?.releaseId ?? null,
            slot: event.payload?.slot ?? null,
            generation: event.payload?.generation ?? null,
            duplicate: event.duplicate === true
        });
        if (event.duplicate)
        {
            client.duplicateAppliedEventCount += 1;
        }
        else
        {
            client.appliedEventIds.push(event.eventId);
        }
        if (businessEventId)
        {
            client.businessEventIds.push(businessEventId);
            if (event.duplicate || client.appliedBusinessEventIds.includes(businessEventId))
            {
                client.duplicateBusinessEventCount += 1;
            }
            else
            {
                client.appliedBusinessEventIds.push(businessEventId);
            }
        }
    }
    else if (event.type === 'heartbeat')
    {
        client.heartbeatCount += 1;
    }
    else if (event.type === 'full-resync')
    {
        client.fullResyncCount += 1;
    }
    else if (event.type === 'resync')
    {
        const observation = { ...event };
        delete observation.type;
        client.resyncSnapshots.push(observation);
        for (const error of event.errors ?? [])
        {
            client.errors.push(`resync:${event.phase}:${error}`);
        }
    }
    else if (event.type === 'error')
    {
        client.errors.push(event.message ?? 'unknown');
    }
}

async function publishDrill(port, identity, suffix, count, adminHeader, options)
{
    const rolloutId = path.basename(path.dirname(options.rolloutState)) || 'rollout';
    const drillId = createDrillId(rolloutId, suffix);
    const response = await fetch(`http://127.0.0.1:${port}/api/ops/deployment/notification-stream/drill/publish`, {
        method: 'POST',
        headers: {
            [adminHeader.name]: adminHeader.value,
            Origin: options.controlOrigin,
            Accept: 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            releaseId: identity.releaseId,
            slot: identity.slot,
            generation: identity.runtimeGeneration,
            drillId,
            count,
            dryRun: false
        })
    });
    const text = await response.text();
    let value;
    try
    {
        value = JSON.parse(text);
    }
    catch
    {
        throw new NotificationProbeInputError([`notification drill returned non-JSON HTTP ${response.status}`]);
    }
    const errors = [];
    if (!response.ok || value.accepted !== true || value.status !== 'published' || value.dryRun !== false)
    {
        errors.push(`notification drill rejected HTTP ${response.status}: ${value.errorCode ?? value.status ?? 'unknown'}`);
    }
    if (value.releaseId !== identity.releaseId || value.slot !== identity.slot || Number(value.generation) !== identity.runtimeGeneration)
    {
        errors.push('notification drill response identity mismatch');
    }
    if (value.drillId !== drillId)
    {
        errors.push('notification drill response drillId mismatch');
    }
    if (!Array.isArray(value.eventIds) || value.eventIds.length !== count)
    {
        errors.push('notification drill response event count mismatch');
    }
    else
    {
        const ids = value.eventIds.map(Number);
        if (ids.some(id => !Number.isSafeInteger(id) || id < 1))
        {
            errors.push('notification drill event IDs must be positive safe integers');
        }
        if (new Set(ids).size !== ids.length)
        {
            errors.push('notification drill event IDs must be unique');
        }
        for (let index = 1; index < ids.length; index += 1)
        {
            if (ids[index] <= ids[index - 1])
            {
                errors.push('notification drill event IDs must be strictly increasing');
            }
        }
    }
    if (errors.length > 0)
    {
        throw new NotificationProbeInputError(errors);
    }
    return value;
}

function createDrillId(rolloutId, suffix)
{
    const timestamp = Date.now().toString(36);
    const raw = `${rolloutId}-${suffix}-${timestamp}`.replace(/[^0-9A-Za-z._-]/gu, '-');
    if (raw.length <= 96)
    {
        return raw;
    }
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const suffixPart = String(suffix).replace(/[^0-9A-Za-z._-]/gu, '-').slice(0, 24);
    return `${String(rolloutId).slice(0, 48)}-${suffixPart}-${digest}`.slice(0, 96);
}

export function expectedDrillEvents(published, phase)
{
    return published.eventIds.map((eventId, index) => ({
        phase,
        eventId: Number(eventId),
        drillId: published.drillId,
        sequence: index + 1,
        eventType: 10,
        businessEventId: `${published.drillId}:${index + 1}`,
        releaseId: published.releaseId,
        slot: published.slot,
        generation: Number(published.generation)
    }));
}

function websocketUrl(base, cursor, pow, client)
{
    const url = new URL('/api/notifications/stream', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('client', `release-rollout-${client}`);
    if (pow)
    {
        url.searchParams.set('pow', pow);
    }
    if (cursor !== null && cursor !== undefined)
    {
        url.searchParams.set('cursor', String(cursor));
    }
    if (client === 'slow')
    {
        url.searchParams.set('drillSlowConsumer', '1');
        url.searchParams.set('drillReadDelayMs', '1000');
        url.searchParams.set('drillQueueCapacity', '16');
    }
    return url.toString();
}

function deliveredToClients(state, records, labels)
{
    return records.length > 0 && labels.every(label => records.every(record => clientHasExpectedEvent(state.clients[label], record)));
}

function clientHasExpectedEvent(client, expected)
{
    return client?.events.some(event => event.eventId === expected.eventId
    && event.businessEventId === expected.businessEventId
    && Number(event.eventType) === expected.eventType
    && event.drillId === expected.drillId
    && Number(event.sequence) === expected.sequence
    && event.releaseId === expected.releaseId
    && event.slot === expected.slot
    && Number(event.generation) === expected.generation) ?? false;
}

function hasClose(client, code, reason)
{
    return client?.closeEvents.some(event => event.code === code && event.reason === reason) ?? false;
}

function replayMissResyncReady(state)
{
    return ['staleGuest', 'staleAuth'].every(label =>
    {
        const client = state.clients[label];
        return hasClose(client, REPLAY_MISS_CLOSE_CODE, REPLAY_MISS_REASON)
      && client.resyncSnapshots.some(item => item.phase === 'replay-miss' && item.status === 'pass')
      && client.fullResyncCount > 0
      && client.openCount > 1;
    });
}

function preFinalConditionsMet(state)
{
    return ['guest', 'auth'].every(label => hasClose(state.clients[label], SERVICE_RESTART_CLOSE_CODE, SERVICE_RESTART_REASON))
    && deliveredToClients(state, state.expected.gap, ['guest', 'auth'])
    && replayMissResyncReady(state)
    && deliveredToClients(state, state.expected.afterResync, ['guest', 'auth', 'staleGuest', 'staleAuth']);
}

function evidenceConditionsMet(state)
{
    return preFinalConditionsMet(state)
    && ['staleGuest', 'staleAuth'].every(label => state.clients[label].resyncSnapshots.some(item => item.phase === 'final' && item.status === 'pass'));
}

function drainGatePassed(file)
{
    try
    {
        const value = readOptionalJson(file);
        return value?.schema === 'fsusblog.release-rollout-gate.v1'
      && value?.gate === 'source-drain'
      && value?.status === 'pass';
    }
    catch
    {
        return false;
    }
}

export function finalizeNotificationEvidence(state, options)
{
    const errors = [...state.errors];
    const allExpected = Object.values(state.expected).flat();
    const expectedBeforeResync = [...state.expected.pre, ...state.expected.post, ...state.expected.gap];
    const primaryLabels = ['guest', 'auth'];
    const staleLabels = ['staleGuest', 'staleAuth'];
    const resyncChecks = {};
    for (const [label, client] of Object.entries(state.clients))
    {
        for (const error of client.errors)
        {
            errors.push(`${label}:${error}`);
        }
    }
    for (const label of primaryLabels)
    {
        const client = state.clients[label];
        if (!hasClose(client, SERVICE_RESTART_CLOSE_CODE, SERVICE_RESTART_REASON))
        {
            errors.push(`${label}: service restart 1012/fsus_service_restart was not observed`);
        }
        for (const expected of allExpected)
        {
            if (!clientHasExpectedEvent(client, expected))
            {
                errors.push(`${label}: missing business event ${expected.businessEventId} at stream event ${expected.eventId}`);
            }
        }
    }
    for (const label of staleLabels)
    {
        const client = state.clients[label];
        if (!client)
        {
            errors.push(`${label}: replay-miss client was not started`);
            continue;
        }
        if (!hasClose(client, REPLAY_MISS_CLOSE_CODE, REPLAY_MISS_REASON))
        {
            errors.push(`${label}: replay miss 4009/fsus_replay_miss was not observed`);
        }
        for (const expected of state.expected.afterResync)
        {
            if (!clientHasExpectedEvent(client, expected))
            {
                errors.push(`${label}: missing post-resync business event ${expected.businessEventId}`);
            }
        }
        resyncChecks[label] = evaluateResyncEvidence(client, expectedBeforeResync, allExpected, state, errors);
    }
    const relevantClients = ['guest', 'auth', 'staleGuest', 'staleAuth'].map(label => state.clients[label]).filter(Boolean);
    const duplicateAppliedEventCount = relevantClients.reduce((sum, client) => sum + client.duplicateAppliedEventCount, 0);
    const duplicateBusinessEventCount = relevantClients.reduce((sum, client) => sum + client.duplicateBusinessEventCount, 0);
    if (duplicateAppliedEventCount > 0)
    {
        errors.push(`duplicate applied stream events: ${duplicateAppliedEventCount}`);
    }
    if (duplicateBusinessEventCount > 0)
    {
        errors.push(`duplicate applied business events: ${duplicateBusinessEventCount}`);
    }
    const reconnects = relevantClients.flatMap(client => client.reconnects);
    for (const [index, reconnect] of reconnects.entries())
    {
        if (!Number.isFinite(reconnect.observedDurationMs)
      || reconnect.observedDurationMs < state.scenario.reconnectDelayMs.minimum
      || reconnect.observedDurationMs > state.scenario.reconnectDelayMs.maximum)
        {
            errors.push(`reconnect[${index}] duration ${reconnect.observedDurationMs ?? 'missing'}ms is outside ${state.scenario.reconnectDelayMs.minimum}..${state.scenario.reconnectDelayMs.maximum}ms`);
        }
        if (reconnect.afterCloseCode === SERVICE_RESTART_CLOSE_CODE && reconnect.reconnectCursor !== reconnect.cursorBeforeClose)
        {
            errors.push(`reconnect[${index}] did not preserve cursor across service restart`);
        }
    }
    const drain = readOptionalJson(options.drainEvidence);
    const drainBinding = drain ? fileBinding(options.drainEvidence, 'source drain evidence') : null;
    const slowClientDidNotBlockDrain = evaluateSlowClientDrain(state.clients.slow, drain, state.scenario.slowClientDrainDeadlineMs, errors);
    const serviceRestartObserved = primaryLabels.every(label => hasClose(state.clients[label], SERVICE_RESTART_CLOSE_CODE, SERVICE_RESTART_REASON));
    const serviceRestartCursorPreserved = primaryLabels.every(label => state.clients[label]?.reconnects.some(item =>
        item.afterCloseCode === SERVICE_RESTART_CLOSE_CODE && item.reconnectCursor === item.cursorBeforeClose));
    const cursorReplayVerified = state.expected.gap.length > 0
    && deliveredToClients(state, state.expected.gap, primaryLabels)
    && serviceRestartCursorPreserved;
    const replayMissFullResyncVerified = staleLabels.every(label => resyncChecks[label] === true);
    const businessEventsExactlyOnce = duplicateBusinessEventCount === 0
    && primaryLabels.every(label => allExpected.every(record => clientHasExpectedEvent(state.clients[label], record)))
    && staleLabels.every(label => state.expected.afterResync.every(record => clientHasExpectedEvent(state.clients[label], record)));
    const reconnectDurationMs = reconnects.length > 0
        ? Math.max(...reconnects.map(item => Number(item.observedDurationMs)).filter(Number.isFinite))
        : null;
    const report = {
        schema: NOTIFICATION_EVIDENCE_SCHEMA,
        contractVersion: 2,
        status: errors.length === 0 ? 'pass' : 'fail',
        rolloutId: state.rolloutId,
        source: state.source,
        target: state.target,
        startedAtUtc: state.startedAtUtc,
        completedAtUtc: new Date().toISOString(),
        inputBindings: state.inputBindings,
        serviceRestartObserved,
        serviceRestartCloseCode: SERVICE_RESTART_CLOSE_CODE,
        serviceRestartReason: SERVICE_RESTART_REASON,
        serviceRestartCursorPreserved,
        cursorReplayVerified,
        replayMissFullResyncVerified,
        replayMissCloseCode: REPLAY_MISS_CLOSE_CODE,
        replayMissReason: REPLAY_MISS_REASON,
        businessEventsExactlyOnce,
        slowClientDidNotBlockDrain,
        slowClientDrainDeadlineMs: state.scenario.slowClientDrainDeadlineMs,
        missingEventCount: errors.filter(item => item.includes('missing business event') || item.includes('missing post-resync')).length,
        duplicateAppliedEventCount,
        duplicateBusinessEventCount,
        reconnectDurationMs: Number.isFinite(reconnectDurationMs) ? reconnectDurationMs : null,
        reconnectDelayBudgetMs: state.scenario.reconnectDelayMs,
        expectedEventIds: allExpected.map(item => item.eventId),
        expectedBusinessEventIds: allExpected.map(item => item.businessEventId),
        expectedEvents: allExpected,
        resync: Object.fromEntries(staleLabels.map(label => [label, state.clients[label]?.resyncSnapshots ?? []])),
        drainEvidence: drainBinding,
        clients: state.clients,
        errors: unique(errors)
    };
    report.evidenceSha256 = sha256Value({ ...report, evidenceSha256: undefined });
    return report;
}

function evaluateResyncEvidence(client, beforeRecords, allRecords, state, errors)
{
    const errorCountBefore = errors.length;
    const replay = client.resyncSnapshots.find(item => item.phase === 'replay-miss');
    const final = client.resyncSnapshots.find(item => item.phase === 'final');
    if (!replay || replay.status !== 'pass')
    {
        errors.push(`${client.label}: successful replay-miss full-state snapshot is missing`);
    }
    if (!final || final.status !== 'pass')
    {
        errors.push(`${client.label}: successful final full-state snapshot is missing`);
    }
    if (!replay || !final)
    {
        return false;
    }
    const beforeWatermark = Math.max(0, ...beforeRecords.map(item => item.eventId));
    const finalWatermark = Math.max(0, ...allRecords.map(item => item.eventId));
    if (!Number.isSafeInteger(replay.watermark) || replay.watermark < beforeWatermark)
    {
        errors.push(`${client.label}: replay-miss snapshot watermark ${replay.watermark ?? 'missing'} is behind ${beforeWatermark}`);
    }
    for (const event of client.events.filter(item => Number(item.eventId) <= Number(replay.watermark)))
    {
        errors.push(`${client.label}: stream event ${event.eventId}/${event.businessEventId ?? 'unknown'} was applied even though the full-state snapshot watermark already covered it`);
    }
    if (!Number.isSafeInteger(final.watermark) || final.watermark < finalWatermark || final.watermark < replay.watermark)
    {
        errors.push(`${client.label}: final snapshot watermark ${final.watermark ?? 'missing'} is behind ${finalWatermark} or replay watermark`);
    }
    if (!isSha256(replay.contentSha256) || replay.declaredContentSha256 !== replay.contentSha256)
    {
        errors.push(`${client.label}: replay-miss snapshot content hash is not bound to response bytes`);
    }
    if (!isSha256(final.contentSha256) || final.declaredContentSha256 !== final.contentSha256)
    {
        errors.push(`${client.label}: final snapshot content hash is not bound to response bytes`);
    }
    if (state.scenario.stableContentHashRequired && replay.contentSha256 !== final.contentSha256)
    {
        errors.push(`${client.label}: full-state content hash changed between replay-miss and final reconciliation`);
    }
    const replayReconnect = client.reconnects.find(item => item.afterCloseCode === REPLAY_MISS_CLOSE_CODE);
    if (!replayReconnect || replayReconnect.reconnectCursor !== replay.watermark)
    {
        errors.push(`${client.label}: replay-miss reconnect did not use the actual snapshot watermark`);
    }
    if (replay.releaseId !== state.target.releaseId || final.releaseId !== state.target.releaseId
    || replay.releaseSlot !== state.target.slot || final.releaseSlot !== state.target.slot)
    {
        errors.push(`${client.label}: full-state snapshots are not bound to the target release`);
    }
    return errors.length === errorCountBefore;
}

function evaluateSlowClientDrain(client, drain, deadlineMs, errors)
{
    let valid = true;
    if (!client || !hasClose(client, SERVICE_RESTART_CLOSE_CODE, SERVICE_RESTART_REASON))
    {
        errors.push('slow client did not observe 1012/fsus_service_restart');
        valid = false;
    }
    if (drain?.schema !== 'fsusblog.release-rollout-gate.v1' || drain?.gate !== 'source-drain' || drain?.status !== 'pass')
    {
        errors.push('source drain evidence is missing or failed');
        valid = false;
    }
    if (!Array.isArray(drain?.errors) || drain.errors.length > 0)
    {
        errors.push('source drain evidence contains errors');
        for (const error of drain?.errors ?? [])
        {
            errors.push(`source drain: ${String(error)}`);
        }
        valid = false;
    }
    if (!Array.isArray(drain?.observations?.blockers) || drain.observations.blockers.length > 0)
    {
        errors.push('source drain evidence contains blockers');
        for (const blocker of drain?.observations?.blockers ?? [])
        {
            errors.push(`source drain blocker: ${String(blocker)}`);
        }
        valid = false;
    }
    if (!Number.isFinite(drain?.durationMs) || drain.durationMs < 0 || drain.durationMs > deadlineMs)
    {
        errors.push(`source drain duration ${drain?.durationMs ?? 'missing'}ms exceeds slow-client deadline ${deadlineMs}ms`);
        valid = false;
    }
    return valid;
}

function buildSnapshot(state, status)
{
    return {
        schema: NOTIFICATION_EVIDENCE_SCHEMA,
        contractVersion: 2,
        status,
        rolloutId: state.rolloutId,
        source: state.source,
        target: state.target,
        startedAtUtc: state.startedAtUtc,
        observedAtUtc: new Date().toISOString(),
        expectedEventIds: Object.values(state.expected).flat().map(item => item.eventId),
        expectedBusinessEventIds: Object.values(state.expected).flat().map(item => item.businessEventId),
        clients: state.clients,
        errors: state.errors
    };
}

function writeSnapshot(state, file, status)
{
    writeJsonAtomic(file, buildSnapshot(state, status));
}

function readAdminHeader(file)
{
    requirePrivateFile(file, 'admin header');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 1)
    {
        throw new NotificationProbeInputError(['admin header file must contain one line']);
    }
    const match = /^(Authorization|Cookie): (\S(?:.*\S)?)$/u.exec(lines[0]);
    if (!match || (match[1] === 'Authorization' && !match[2].startsWith('Bearer ')))
    {
        throw new NotificationProbeInputError(['admin header must be Authorization: Bearer or Cookie']);
    }
    return { name: match[1], value: match[2] };
}

function requirePrivateFile(file, label)
{
    requireRegularFile(file, label);
    const mode = fs.statSync(file).mode & 0o777;
    if (![0o400, 0o600].includes(mode))
    {
        throw new NotificationProbeInputError([`${label} must have mode 0400 or 0600`]);
    }
}

function requireRegularFile(file, label)
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new NotificationProbeInputError([`${label} must be a regular non-symlink file`]);
    }
}

function readOptionalJson(file)
{
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile())
    {
        return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function waitFor(label, predicate, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (predicate())
        {
            return;
        }
        await delay(50);
    }
    throw new NotificationProbeInputError([`timeout waiting for ${label}`]);
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    let descriptor;
    try
    {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, file);
        fsyncDirectory(path.dirname(file));
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporary, { force: true });
    }
}

function writeJsonExclusiveAtomic(file, value)
{
    if (fs.existsSync(file))
    {
        throw new NotificationProbeInputError([`output already exists: ${file}`]);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    let descriptor;
    try
    {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporary, file);
        fs.unlinkSync(temporary);
        fsyncDirectory(path.dirname(file));
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporary, { force: true });
    }
}

function fsyncDirectory(directory)
{
    const descriptor = fs.openSync(directory, 'r');
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function fileBinding(file, label)
{
    requireRegularFile(file, label);
    const bytes = fs.readFileSync(file);
    return { path: fs.realpathSync(file), bytes: bytes.length, sha256: sha256(bytes) };
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256Value(value)
{
    return sha256(JSON.stringify(value));
}

function isSha256(value)
{
    return /^sha256:[0-9a-f]{64}$/u.test(String(value ?? ''));
}

function bounded(value, minimum, maximum, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    {
        throw new NotificationProbeInputError([`--${label} must be ${minimum}..${maximum}`]);
    }
    return parsed;
}

function resolveOptional(value)
{
    return value ? path.resolve(String(value)) : null;
}

function isObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values)
{
    return [...new Set(values)];
}

function message(error)
{
    return error instanceof Error ? error.message : String(error);
}

function errorList(error)
{
    return error instanceof NotificationProbeInputError ? error.errors : [message(error)];
}

function delay(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main()
{
    let options = null;
    try
    {
        options = parseNotificationProbeArgs(process.argv.slice(2));
        await runNotificationProbe(options);
    }
    catch (error)
    {
        const errors = unique(errorList(error));
        for (const item of errors)
        {
            process.stderr.write(`[release-notification-probe] ${item}\n`);
        }
        if (options?.out && !fs.existsSync(options.out))
        {
            try
            {
                writeJsonExclusiveAtomic(options.out, {
                    schema: NOTIFICATION_EVIDENCE_SCHEMA,
                    contractVersion: 2,
                    status: 'fail',
                    completedAtUtc: new Date().toISOString(),
                    errors
                });
            }
            catch
            {
            }
        }
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    await main();
}
