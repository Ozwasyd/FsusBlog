import { encodeRumMetricBatchRequest, RUM_MAX_BATCH_METRICS, RUM_MAX_FRAME_BYTES, type RumMetricBatchItem } from '@/adapters/binary/telemetryAdapter';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { AEDS_BINARY_MEDIA_TYPE, applyBinaryRequestHeaders } from '@/api/contracts';
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload';
import { fsusBinaryRoutes } from '@/generated/fsusBinaryRoutes';
import { emitFrontendAudit, type FrontendAuditType } from '@/services/auditConsole';
import {
    drainPendingRumMetrics,
    drainPendingTelemetry,
    emitTelemetry,
    RUM_METRIC_EVENT,
    TELEMETRY_EVENT,
    type RumMetricPayload,
    type TelemetryPayload
} from '@/services/telemetryBus';
import {
    createBinaryFailureTelemetryDetail,
    type BinaryFailureTelemetryDetail
} from '@/services/telemetryPrivacy';

import { FrameType } from '@wasm/protocol/frame';

export { emitRumMetric, emitTelemetry } from '@/services/telemetryBus';
export type { TelemetryLevel, TelemetryPayload } from '@/services/telemetryBus';

const AOT_EVENT = 'fsus:aot:event';
const BIN_FAILURE_COUNT_KEY = 'fsus.telemetry.binaryFailureCount';
const AOT_ACTION_COUNT_KEY = 'fsus.telemetry.aotActionCount';
const AOT_ACTION_BUCKET_KEY = 'fsus.telemetry.aotActionBuckets';
const RUM_ENDPOINT = fsusBinaryRoutes.binary_post_telemetry_rum;
const RUM_METRIC_KEYS = ['value', 'domInteractive', 'responseStart', 'durationMs'] as const;
const RUM_BATCH_FLUSH_MS = 250;
const BINARY_FAILURE_TELEMETRY_WINDOW_MS = 15000;
const BINARY_FAILURE_TELEMETRY_LIMIT = 3;

let binaryFailureTelemetryWindowStartedAt = 0;
let binaryFailureTelemetryWindowCount = 0;

function readCounter(): number
{
    if (typeof localStorage === 'undefined')
    {
        return 0;
    }

    const raw = localStorage.getItem(BIN_FAILURE_COUNT_KEY);
    if (!raw)
    {
        return 0;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function writeCounter(value: number): void
{
    if (typeof localStorage === 'undefined')
    {
        return;
    }

    localStorage.setItem(BIN_FAILURE_COUNT_KEY, String(value));
}

function readAotCounter(): number
{
    if (typeof localStorage === 'undefined')
    {
        return 0;
    }

    const raw = localStorage.getItem(AOT_ACTION_COUNT_KEY);
    if (!raw)
    {
        return 0;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function writeAotCounter(value: number): void
{
    if (typeof localStorage === 'undefined')
    {
        return;
    }

    localStorage.setItem(AOT_ACTION_COUNT_KEY, String(value));
}

function readAotBuckets(): Record<string, number>
{
    if (typeof localStorage === 'undefined')
    {
        return {};
    }

    const raw = localStorage.getItem(AOT_ACTION_BUCKET_KEY);
    if (!raw)
    {
        return {};
    }

    try
    {
        const parsed = decodePublicAotPayload<Record<string, number>>(raw) ?? {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch
    {
        return {};
    }
}

function writeAotBuckets(value: Record<string, number>): void
{
    if (typeof localStorage === 'undefined')
    {
        return;
    }

    localStorage.setItem(AOT_ACTION_BUCKET_KEY, encodePublicAotPayload(value));
}

export function recordBinaryFailureTelemetry(input: Parameters<typeof createBinaryFailureTelemetryDetail>[0] & Record<string, unknown>): BinaryFailureTelemetryDetail
{
    const detail = createBinaryFailureTelemetryDetail(input);
    const next = readCounter() + 1;
    writeCounter(next);

    if (!shouldEmitBinaryFailureTelemetry())
    {
        return detail;
    }

    emitTelemetry('binary_failure', {
        ...detail,
        count: next
    }, 'warn');
    return detail;
}

function shouldEmitBinaryFailureTelemetry(now = Date.now()): boolean
{
    if (now < binaryFailureTelemetryWindowStartedAt
    || now - binaryFailureTelemetryWindowStartedAt > BINARY_FAILURE_TELEMETRY_WINDOW_MS)
    {
        binaryFailureTelemetryWindowStartedAt = now;
        binaryFailureTelemetryWindowCount = 0;
    }

    binaryFailureTelemetryWindowCount += 1;
    return binaryFailureTelemetryWindowCount <= BINARY_FAILURE_TELEMETRY_LIMIT;
}

function onTelemetry(event: Event): void
{
    const custom = event as CustomEvent<TelemetryPayload>;
    const payload = custom.detail;
    handleTelemetryPayload(payload);
}

function handleTelemetryPayload(payload: TelemetryPayload | undefined): void
{
    if (!payload)
    {
        return;
    }

    try
    {
        emitFrontendAudit({
            source: 'frontend',
            type: classifyTelemetryType(payload),
            occurredAtUtc: payload.timestamp,
            eventInfo: payload.name,
            context: payload.detail ?? {},
            level: payload.level
        });
    }
    catch
    {
    // Audit output is non-critical and must not recurse during transport loss.
    }
}

function onRumMetric(event: Event): void
{
    const custom = event as CustomEvent<RumMetricPayload>;
    handleRumMetricPayload(custom.detail);
}

function handleRumMetricPayload(payload: RumMetricPayload | undefined): void
{
    if (!payload || typeof payload.name !== 'string' || !payload.detail)
    {
        return;
    }

    emitPerformanceTelemetry(payload.name, payload.detail, payload.timestamp);
}

function onAotEvent(event: Event): void
{
    const custom = event as CustomEvent<Record<string, unknown>>;
    const next = readAotCounter() + 1;
    writeAotCounter(next);
    const actionName = typeof custom.detail?.action === 'string'
        ? custom.detail.action
        : 'unknown';
    const buckets = readAotBuckets();
    buckets[actionName] = (buckets[actionName] ?? 0) + 1;
    writeAotBuckets(buckets);

    emitTelemetry('aot_action', {
        ...custom.detail,
        count: next,
        actionCount: buckets[actionName],
        action: actionName
    });
}

let initialized = false;
let vitalsInitialized = false;
let rumFlushTimer: ReturnType<typeof setTimeout> | null = null;
const rumQueue: PendingRumMetric[] = [];

type PendingRumMetric = RumMetricBatchItem & {
    pageType: string;
    routeKey: string;
    aotSource: string;
};

export function initTelemetryService(): void
{
    if (initialized || typeof window === 'undefined')
    {
        return;
    }

    window.addEventListener(AOT_EVENT, onAotEvent);
    window.addEventListener(TELEMETRY_EVENT, onTelemetry);
    window.addEventListener(RUM_METRIC_EVENT, onRumMetric);
    for (const payload of drainPendingTelemetry())
    {
        handleTelemetryPayload(payload);
    }
    for (const payload of drainPendingRumMetrics())
    {
        handleRumMetricPayload(payload);
    }
    initCoreWebVitalsTelemetry();
    initialized = true;
}

function initCoreWebVitalsTelemetry(): void
{
    if (vitalsInitialized || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined')
    {
        return;
    }

    vitalsInitialized = true;
    observePerformance('largest-contentful-paint', (entry) =>
    {
        emitPerformanceTelemetry('web_vital_lcp', {
            value: Math.round(entry.startTime)
        });
    });
    observePerformance('layout-shift', (entry) =>
    {
        const layoutShift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean; };
        if (layoutShift.hadRecentInput)
        {
            return;
        }

        emitPerformanceTelemetry('web_vital_cls', {
            value: Number((layoutShift.value ?? 0).toFixed(4))
        });
    });
    observePerformance('navigation', (entry) =>
    {
        const navigation = entry as PerformanceNavigationTiming;
        emitPerformanceTelemetry('navigation_timing', {
            domInteractive: Math.round(navigation.domInteractive),
            responseStart: Math.round(navigation.responseStart)
        });
    });
}

function emitPerformanceTelemetry(name: string, detail: Record<string, unknown>, timestamp = new Date().toISOString()): void
{
    const pageType = resolvePublicPageType();
    if (pageType === 'private')
    {
        return;
    }

    const aotSource = resolveAotSource();
    const enrichedDetail = {
        ...detail,
        pageType,
        aotSource
    };

    emitTelemetry(name, enrichedDetail, 'info');
    sendRumMetric({
        name,
        timestamp,
        pageType,
        aotSource,
        value: pickMetricValue(detail),
        metrics: pickMetricValues(detail)
    });
}

function sendRumMetric(payload: {
    name: string;
    timestamp: string;
    pageType: string;
    aotSource: string;
    value?: number;
    metrics: Record<string, number>;
}): void
{
    if (typeof fetch === 'undefined')
    {
        return;
    }

    rumQueue.push({
        name: payload.name,
        timestamp: payload.timestamp,
        pageType: payload.pageType,
        routeKey: resolveRumRouteKey(payload.pageType),
        aotSource: payload.aotSource,
        value: payload.value,
        metrics: payload.metrics
    });

    if (rumQueue.length >= RUM_MAX_BATCH_METRICS)
    {
        flushRumMetrics();
        return;
    }

    scheduleRumFlush();
}

function scheduleRumFlush(): void
{
    if (rumFlushTimer !== null)
    {
        return;
    }

    rumFlushTimer = setTimeout(flushRumMetrics, RUM_BATCH_FLUSH_MS);
}

function flushRumMetrics(): void
{
    if (rumFlushTimer !== null)
    {
        clearTimeout(rumFlushTimer);
        rumFlushTimer = null;
    }

    const pending = rumQueue.splice(0, rumQueue.length);
    if (pending.length === 0)
    {
        return;
    }

    const grouped = new Map<string, PendingRumMetric[]>();
    for (const metric of pending)
    {
        const key = `${metric.pageType}\u0000${metric.routeKey}\u0000${metric.aotSource}`;
        const values = grouped.get(key);
        if (values)
        {
            values.push(metric);
        }
        else
        {
            grouped.set(key, [metric]);
        }
    }

    for (const metrics of grouped.values())
    {
        for (let offset = 0; offset < metrics.length; offset += RUM_MAX_BATCH_METRICS)
        {
            sendRumMetricBatch(metrics.slice(offset, offset + RUM_MAX_BATCH_METRICS));
        }
    }
}

function sendRumMetricBatch(metrics: PendingRumMetric[]): void
{
    const first = metrics[0];
    if (!first)
    {
        return;
    }

    const payload = encodeRumMetricBatchRequest({
        pageType: first.pageType,
        routeKey: first.routeKey,
        aotSource: first.aotSource,
        metrics
    });
    const frame = encodeAedsFrame(FrameType.RumMetricBatchRequest, payload);
    if (frame.byteLength > RUM_MAX_FRAME_BYTES)
    {
        return;
    }

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function')
    {
        const blob = new Blob([frame], { type: AEDS_BINARY_MEDIA_TYPE });
        if (navigator.sendBeacon(RUM_ENDPOINT, blob))
        {
            return;
        }
    }

    const headers = applyBinaryRequestHeaders(new Headers(), true);
    void fetch(RUM_ENDPOINT, {
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
        headers,
        body: frame
    }).catch(() =>
    {});
}

function resolveRumRouteKey(pageType: string): string
{
    return pageType || 'unknown';
}

function pickMetricValue(detail: Record<string, unknown>): number | undefined
{
    const value = detail.value;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickMetricValues(detail: Record<string, unknown>): Record<string, number>
{
    const metrics: Record<string, number> = {};
    for (const key of RUM_METRIC_KEYS)
    {
        const value = detail[key];
        if (typeof value === 'number' && Number.isFinite(value))
        {
            metrics[key] = value;
        }
    }

    return metrics;
}

function observePerformance(type: string, handle: (entry: PerformanceEntry) => void): void
{
    try
    {
        if (
            Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      !PerformanceObserver.supportedEntryTypes.includes(type)
        )
        {
            return;
        }

        const observer = new PerformanceObserver((list) =>
        {
            for (const entry of list.getEntries())
            {
                handle(entry);
            }
        });
        observer.observe({ type, buffered: true });
    }
    catch
    {
    // Unsupported performance entry type in the current browser.
    }
}

function resolvePublicPageType(): string
{
    if (typeof window === 'undefined')
    {
        return 'unknown';
    }

    const path = window.location.pathname;
    if (path === '/')
    {
        return 'home';
    }
    if (path.startsWith('/article/'))
    {
        return 'article';
    }
    if (path.startsWith('/category/') || path.startsWith('/tag/'))
    {
        return 'filter';
    }
    if (path.startsWith('/archive'))
    {
        return 'archive';
    }
    if (path.startsWith('/about'))
    {
        return 'about';
    }
    return path.startsWith('/user') || path.startsWith('/admin') ? 'private' : 'public';
}

function resolveAotSource(): string
{
    if (typeof document === 'undefined')
    {
        return 'unknown';
    }

    const root = document.getElementById('fsus-aot-shell');
    return root ? 'server-aot' : 'spa';
}

function classifyTelemetryType(payload: TelemetryPayload): FrontendAuditType
{
    if (payload.level === 'error')
    {
        return 'exception';
    }

    if (payload.name === 'binary_failure')
    {
        return 'infra';
    }

    if (payload.name.startsWith('aot_') || payload.name.startsWith('web_vital_') || payload.name === 'navigation_timing')
    {
        return 'performance';
    }

    return 'business';
}
