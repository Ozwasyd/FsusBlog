import { emitFrontendAudit, type FrontendAuditType } from '@/services/auditConsole'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

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
const RUM_ENDPOINT = '/api/telemetry/rum';
const RUM_METRIC_KEYS = ['value', 'domInteractive', 'responseStart', 'durationMs'] as const;

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
  if (typeof navigator === 'undefined' || typeof fetch === 'undefined') {
    return;
  }

  const body = JSON.stringify(payload);
  if (typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon(RUM_ENDPOINT, blob)) {
      return;
    }
  }

  void fetch(RUM_ENDPOINT, {
    method: 'POST',
    credentials: 'omit',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json'
    },
    body
  }).catch(() => {});
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
