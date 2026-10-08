import type { TransportFailureKind } from '@/contracts/binaryTransport';
import { fsusBinaryRouteDescriptors, type FsusBinaryOperationId } from '@/generated/fsusBinaryRoutes';

export const BINARY_FAILURE_TELEMETRY_FIELDS = [
    'operationId',
    'routeClass',
    'status',
    'errorCode',
    'category',
    'frameType'
] as const;

export type BinaryFailureRouteClass = 'public' | 'account' | 'admin';

export type BinaryFailureTelemetryDetail = Readonly<{
    operationId: FsusBinaryOperationId;
    routeClass: BinaryFailureRouteClass;
    status: number;
    errorCode: number | TransportFailureKind;
    category: number;
    frameType: number;
}>;

interface BinaryFailureTelemetryInput {
    operationId: FsusBinaryOperationId;
    status?: unknown;
    backendCode?: unknown;
    kind?: unknown;
    backendCategory?: unknown;
    frameType?: unknown;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:authorization|cookie|token|proof|session(?:[-_ ]?id)?|recovery(?:[-_ ]?key)?|secret|password|passkey|payload|request|response|body|content|text|message|details|url|query|fragment|hash|trace(?:[-_ ]?id)?|account[-_ ]?id|user[-_ ]?id|article[-_ ]?id|comment[-_ ]?id|conversation[-_ ]?id)/iu;
const SAFE_STRUCTURED_STRING_KEY = /^(?:operationId|routeClass|errorCode|kind|type|category|outcome|phase|level|source|eventInfo|reasonCode)$/u;
const SENSITIVE_STRING = /(?:https?:\/\/|\/api\/|\bBearer\s+|\b(?:token|proof|session|recovery[-_ ]?key|authorization|cookie|secret|password|trace(?:id)?)\s*[:=]|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/iu;
const SAFE_CONSOLE_LABEL = /^[\[\]A-Za-z0-9_.:+ -]{1,240}$/u;
const FAILURE_KINDS = new Set<TransportFailureKind>([
    'binary_disabled',
    'auth_failed',
    'forbidden',
    'not_found',
    'conflict',
    'validation',
    'precondition_required',
    'rate_limited',
    'public_artifact_not_ready',
    'client_route_contract',
    'accept_contract',
    'network',
    'decode_failed'
]);

export function createBinaryFailureTelemetryDetail(input: BinaryFailureTelemetryInput): BinaryFailureTelemetryDetail
{
    const descriptor = fsusBinaryRouteDescriptors[input.operationId];
    if (!descriptor || !['anonymous', 'optional', 'user', 'admin'].includes(descriptor.auth))
    {
        throw new Error('binary_failure_telemetry_descriptor_invalid');
    }
    const operationId = descriptor.operationId;
    const routeClass: BinaryFailureRouteClass = descriptor.auth === 'admin'
        ? 'admin' : descriptor.auth === 'anonymous' ? 'public' : 'account';
    const kind = typeof input.kind === 'string' && FAILURE_KINDS.has(input.kind as TransportFailureKind)
        ? input.kind as TransportFailureKind
        : 'decode_failed';

    return Object.freeze({
        operationId,
        routeClass,
        status: boundedInteger(input.status, 0, 599),
        errorCode: isBoundedInteger(input.backendCode, 0, 65_535) ? input.backendCode : kind,
        category: boundedInteger(input.backendCategory, 0, 255),
        frameType: boundedInteger(input.frameType, 0, 65_535)
    });
}

export function redactAuditContext(context: Record<string, unknown> | undefined): Record<string, unknown>
{
    return redactRecord(context ?? {}, false, new WeakSet<object>(), 0);
}

export function redactConsoleArguments(data: unknown[]): unknown[]
{
    return data.map((value, index) =>
    {
        if (index === 0 && typeof value === 'string')
        {
            return SAFE_CONSOLE_LABEL.test(value) && !SENSITIVE_STRING.test(value) ? value : REDACTED;
        }
        if (typeof value === 'string')
        {
            return REDACTED;
        }
        return redactValue(value, true, new WeakSet<object>(), 0);
    });
}

function redactRecord(
    input: Record<string, unknown>,
    strictStrings: boolean,
    seen: WeakSet<object>,
    depth: number
): Record<string, unknown>
{
    if (seen.has(input) || depth > 5)
    {
        return {};
    }
    seen.add(input);
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input).slice(0, 64))
    {
        if (SENSITIVE_KEY.test(key))
        {
            output[key] = REDACTED;
            continue;
        }
        if (strictStrings && typeof value === 'string' && !SAFE_STRUCTURED_STRING_KEY.test(key))
        {
            output[key] = REDACTED;
            continue;
        }
        const redactStringValue = strictStrings && !(typeof value === 'string' && SAFE_STRUCTURED_STRING_KEY.test(key));
        output[key] = redactValue(value, redactStringValue, seen, depth + 1);
    }
    return output;
}

function redactValue(value: unknown, strictStrings: boolean, seen: WeakSet<object>, depth: number): unknown
{
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined')
    {
        return value;
    }
    if (typeof value === 'string')
    {
        if (strictStrings || SENSITIVE_STRING.test(value) || value.length > 256)
        {
            return REDACTED;
        }
        return value;
    }
    if (value instanceof Error)
    {
        const candidate = value as Error & { code?: unknown; kind?: unknown; status?: unknown; };
        return {
            name: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value.name) ? value.name : 'Error',
            code: sanitizeStableScalar(candidate.code),
            kind: sanitizeStableScalar(candidate.kind),
            status: isBoundedInteger(candidate.status, 0, 599) ? candidate.status : undefined
        };
    }
    if (Array.isArray(value))
    {
        if (seen.has(value) || depth > 5)
        {
            return [];
        }
        seen.add(value);
        return value.slice(0, 32).map((item) => redactValue(item, strictStrings, seen, depth + 1));
    }
    if (typeof value === 'object')
    {
        return redactRecord(value as Record<string, unknown>, strictStrings, seen, depth);
    }
    return REDACTED;
}

function sanitizeStableScalar(value: unknown): string | number | undefined
{
    if (typeof value === 'number' && Number.isSafeInteger(value))
    {
        return value;
    }
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/u.test(value))
    {
        return value;
    }
    return undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number
{
    return isBoundedInteger(value, minimum, maximum) ? value : 0;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number
{
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
