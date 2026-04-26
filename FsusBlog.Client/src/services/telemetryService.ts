import { emitFrontendAudit, type FrontendAuditType } from '@/services/auditConsole'

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
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAotBuckets(value: Record<string, number>): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(AOT_ACTION_BUCKET_KEY, JSON.stringify(value));
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

  window.dispatchEvent(new CustomEvent(TELEMETRY_EVENT, { detail: payload }));
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

export function initTelemetryService(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }

  window.addEventListener(BIN_FAILURE_EVENT, onBinaryFailure as EventListener);
  window.addEventListener(AOT_EVENT, onAotEvent as EventListener);
  window.addEventListener(TELEMETRY_EVENT, onTelemetry as EventListener);
  initialized = true;
}

function classifyTelemetryType(payload: TelemetryPayload): FrontendAuditType {
  if (payload.level === 'error') {
    return 'exception';
  }

  if (payload.name === 'binary_failure') {
    return 'infra';
  }

  if (payload.name.startsWith('aot_')) {
    return 'performance';
  }

  return 'business';
}
