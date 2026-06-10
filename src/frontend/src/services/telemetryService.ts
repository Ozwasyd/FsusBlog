import { emitFrontendAudit, type FrontendAuditType } from '@/services/auditConsole'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { encodeRumMetricBatchRequest, RUM_MAX_BATCH_METRICS, RUM_MAX_FRAME_BYTES, type RumMetricBatchItem } from '@/adapters/binary/telemetryAdapter'
import { encodeAedsFrame } from '@/api/binaryFrame'
import { AEDS_BINARY_MEDIA_TYPE, applyBinaryRequestHeaders } from '@/api/contracts'
import { fsusBinaryRoutes } from '@/generated/fsusBinaryRoutes'
import { FrameType } from '@wasm/protocol/frame'

export type TelemetryLevel = 'info' | 'warn' | 'error';

export type TelemetryPayload = {
  name: string;
  level?: TelemetryLevel;
  timestamp: string;
  detail?: Record<string, unknown>;
};

const BIN_FAILURE_EVENT = 'fsus:binary:failure';
const AOT_EVENT = 'fsus:aot:event';
const TELEMETRY_EVENT = 'fsus:telemetry';
const BIN_FAILURE_COUNT_KEY = 'fsus.telemetry.binaryFailureCount';
const AOT_ACTION_COUNT_KEY = 'fsus.telemetry.aotActionCount';
const AOT_ACTION_BUCKET_KEY = 'fsus.telemetry.aotActionBuckets';
const RUM_ENDPOINT = fsusBinaryRoutes.binary_post_telemetry_rum;
const RUM_METRIC_KEYS = ['value', 'domInteractive', 'responseStart', 'durationMs'] as const;
const RUM_BATCH_FLUSH_MS = 250;

function readCounter(): number {
  if (typeof localStorage === 'undefined') {
    return 0;
  }

  const raw = localStorage.getItem(BIN_FAILURE_COUNT_KEY);
  if (!raw) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeCounter(value: number): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(BIN_FAILURE_COUNT_KEY, String(value));
}

function readAotCounter(): number {
  if (typeof localStorage === 'undefined') {
    return 0;
  }

  const raw = localStorage.getItem(AOT_ACTION_COUNT_KEY);
  if (!raw) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeAotCounter(value: number): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(AOT_ACTION_COUNT_KEY, String(value));
}

function readAotBuckets(): Record<string, number> {
  if (typeof localStorage === 'undefined') {
    return {};
  }

  const raw = localStorage.getItem(AOT_ACTION_BUCKET_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = decodePublicAotPayload<Record<string, number>>(raw) ?? {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAotBuckets(value: Record<string, number>): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(AOT_ACTION_BUCKET_KEY, encodePublicAotPayload(value));
}

export function emitTelemetry(name: string, detail?: Record<string, unknown>, level: TelemetryLevel = 'info'): void {
  if (typeof window === 'undefined') {
    return;
  }

  const payload: TelemetryPayload = {
    name,
    level,
    timestamp: new Date().toISOString(),
    detail
  };

  window.dispatchEvent(new window.CustomEvent(TELEMETRY_EVENT, { detail: payload }));
}

export function emitRumMetric(name: string, detail: Record<string, unknown>): void {
  emitPerformanceTelemetry(name, detail);
}

function onBinaryFailure(event: Event): void {
  const custom = event as CustomEvent<Record<string, unknown>>;
  const next = readCounter() + 1;
  writeCounter(next);

  emitTelemetry('binary_failure', {
    ...custom.detail,
    count: next
  }, 'warn');
}

function onTelemetry(event: Event): void {
  const custom = event as CustomEvent<TelemetryPayload>;
  const payload = custom.detail;
  if (!payload) {
    return;
  }

  emitFrontendAudit({
    source: 'frontend',
    type: classifyTelemetryType(payload),
    occurredAtUtc: payload.timestamp,
    eventInfo: payload.name,
    context: payload.detail ?? {},
    level: payload.level
  });
}

function onAotEvent(event: Event): void {
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
  pageType: string
  routeKey: string
  aotSource: string
};

export function initTelemetryService(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }

  window.addEventListener(BIN_FAILURE_EVENT, onBinaryFailure as EventListener);
  window.addEventListener(AOT_EVENT, onAotEvent as EventListener);
  window.addEventListener(TELEMETRY_EVENT, onTelemetry as EventListener);
  initCoreWebVitalsTelemetry();
  initialized = true;
}

function initCoreWebVitalsTelemetry(): void {
  if (vitalsInitialized || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
    return;
  }

  vitalsInitialized = true;
  observePerformance('largest-contentful-paint', (entry) => {
    emitPerformanceTelemetry('web_vital_lcp', {
      value: Math.round(entry.startTime)
    });
  });
  observePerformance('layout-shift', (entry) => {
    const layoutShift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
    if (layoutShift.hadRecentInput) {
      return;
    }

    emitPerformanceTelemetry('web_vital_cls', {
      value: Number((layoutShift.value ?? 0).toFixed(4))
    });
  });
  observePerformance('navigation', (entry) => {
    const navigation = entry as PerformanceNavigationTiming;
    emitPerformanceTelemetry('navigation_timing', {
      domInteractive: Math.round(navigation.domInteractive),
      responseStart: Math.round(navigation.responseStart)
    });
  });
}

function emitPerformanceTelemetry(name: string, detail: Record<string, unknown>): void {
  const pageType = resolvePublicPageType();
  if (pageType === 'private') {
    return;
  }

  const timestamp = new Date().toISOString();
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
  name: string
  timestamp: string
  pageType: string
  aotSource: string
  value?: number
  metrics: Record<string, number>
}): void {
  if (typeof fetch === 'undefined') {
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

  if (rumQueue.length >= RUM_MAX_BATCH_METRICS) {
    flushRumMetrics();
    return;
  }

  scheduleRumFlush();
}

function scheduleRumFlush(): void {
  if (rumFlushTimer !== null) {
    return;
  }

  rumFlushTimer = setTimeout(flushRumMetrics, RUM_BATCH_FLUSH_MS);
}

function flushRumMetrics(): void {
  if (rumFlushTimer !== null) {
    clearTimeout(rumFlushTimer);
    rumFlushTimer = null;
  }

  const pending = rumQueue.splice(0, rumQueue.length);
  if (pending.length === 0) {
    return;
  }

  const grouped = new Map<string, PendingRumMetric[]>();
  for (const metric of pending) {
    const key = `${metric.pageType}\u0000${metric.routeKey}\u0000${metric.aotSource}`;
    const values = grouped.get(key);
    if (values) {
      values.push(metric);
    } else {
      grouped.set(key, [metric]);
    }
  }

  for (const metrics of grouped.values()) {
    for (let offset = 0; offset < metrics.length; offset += RUM_MAX_BATCH_METRICS) {
      sendRumMetricBatch(metrics.slice(offset, offset + RUM_MAX_BATCH_METRICS));
    }
  }
}

function sendRumMetricBatch(metrics: PendingRumMetric[]): void {
  const first = metrics[0];
  if (!first) {
    return;
  }

  const payload = encodeRumMetricBatchRequest({
    pageType: first.pageType,
    routeKey: first.routeKey,
    aotSource: first.aotSource,
    metrics
  });
  const frame = encodeAedsFrame(FrameType.RumMetricBatchRequest, payload);
  if (frame.byteLength > RUM_MAX_FRAME_BYTES) {
    return;
  }

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([frame], { type: AEDS_BINARY_MEDIA_TYPE });
    if (navigator.sendBeacon(RUM_ENDPOINT, blob)) {
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
  }).catch(() => {});
}

function resolveRumRouteKey(pageType: string): string {
  return pageType || 'unknown';
}

function pickMetricValue(detail: Record<string, unknown>): number | undefined {
  const value = detail.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickMetricValues(detail: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const key of RUM_METRIC_KEYS) {
    const value = detail[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      metrics[key] = value;
    }
  }

  return metrics;
}

function observePerformance(type: string, handle: (entry: PerformanceEntry) => void): void {
  try {
    if (
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      !PerformanceObserver.supportedEntryTypes.includes(type)
    ) {
      return;
    }

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        handle(entry);
      }
    });
    observer.observe({ type, buffered: true });
  } catch {
    // Unsupported performance entry type in the current browser.
  }
}

function resolvePublicPageType(): string {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  const path = window.location.pathname;
  if (path === '/') return 'home';
  if (path.startsWith('/article/')) return 'article';
  if (path.startsWith('/category/') || path.startsWith('/tag/')) return 'filter';
  if (path.startsWith('/archive')) return 'archive';
  if (path.startsWith('/about')) return 'about';
  return path.startsWith('/user') || path.startsWith('/admin') ? 'private' : 'public';
}

function resolveAotSource(): string {
  if (typeof document === 'undefined') {
    return 'unknown';
  }

  const root = document.getElementById('fsus-aot-shell');
  return root ? 'server-aot' : 'spa';
}

function classifyTelemetryType(payload: TelemetryPayload): FrontendAuditType {
  if (payload.level === 'error') {
    return 'exception';
  }

  if (payload.name === 'binary_failure') {
    return 'infra';
  }

  if (payload.name.startsWith('aot_') || payload.name.startsWith('web_vital_') || payload.name === 'navigation_timing') {
    return 'performance';
  }

  return 'business';
}
