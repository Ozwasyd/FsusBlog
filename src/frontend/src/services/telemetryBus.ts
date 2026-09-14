export type TelemetryLevel = 'info' | 'warn' | 'error';

export interface TelemetryPayload {
    name: string;
    level?: TelemetryLevel;
    timestamp: string;
    detail?: Record<string, unknown>;
}

export interface RumMetricPayload {
    name: string;
    timestamp: string;
    detail: Record<string, unknown>;
}

export const TELEMETRY_EVENT = 'fsus:telemetry';
export const RUM_METRIC_EVENT = 'fsus:rum-metric';

const MAX_PENDING_EVENTS = 64;

let telemetryServiceReady = false;
const pendingTelemetry: TelemetryPayload[] = [];
const pendingRumMetrics: RumMetricPayload[] = [];

export function emitTelemetry(name: string, detail?: Record<string, unknown>, level: TelemetryLevel = 'info'): void
{
    if (typeof window === 'undefined')
    {
        return;
    }

    const payload: TelemetryPayload = {
        name,
        level,
        timestamp: new Date().toISOString(),
        detail
    };

    dispatchTelemetryEvent(TELEMETRY_EVENT, payload);

    if (!telemetryServiceReady)
    {
        enqueueBounded(pendingTelemetry, payload);
    }
}

export function emitRumMetric(name: string, detail: Record<string, unknown>): void
{
    if (typeof window === 'undefined')
    {
        return;
    }

    const payload: RumMetricPayload = {
        name,
        detail,
        timestamp: new Date().toISOString()
    };

    dispatchTelemetryEvent(RUM_METRIC_EVENT, payload);

    if (!telemetryServiceReady)
    {
        enqueueBounded(pendingRumMetrics, payload);
    }
}

export function drainPendingTelemetry(): TelemetryPayload[]
{
    telemetryServiceReady = true;
    return pendingTelemetry.splice(0, pendingTelemetry.length);
}

export function drainPendingRumMetrics(): RumMetricPayload[]
{
    telemetryServiceReady = true;
    return pendingRumMetrics.splice(0, pendingRumMetrics.length);
}

function enqueueBounded<T>(queue: T[], item: T): void
{
    queue.push(item);
    if (queue.length > MAX_PENDING_EVENTS)
    {
        queue.splice(0, queue.length - MAX_PENDING_EVENTS);
    }
}

function dispatchTelemetryEvent(type: string, payload: TelemetryPayload | RumMetricPayload): void
{
    try
    {
        window.dispatchEvent(new window.CustomEvent(type, { detail: payload }));
    }
    catch
    {
    // Telemetry is best-effort; disconnected console/dev transports must not affect runtime.
    }
}
