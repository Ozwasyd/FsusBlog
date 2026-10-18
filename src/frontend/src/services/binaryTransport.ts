import { BinaryRequestError, binaryRequest, type BinaryRequestOptions } from '@/api/binaryApiClient';
import { FSUS_HEADERS } from '@/api/contracts';
import { readFixedUtf8, readInt32 } from '@/codecs/binary/reader';
import { binaryDecodeWorkerProtocolVersion } from '@/contracts/binaryTransport';
import type {
    BinaryDecodeFailure,
    BinaryDecodeResult,
    BinaryDecodeSuccess,
    BinaryFramePayloadDecoder,
    BinaryTransportRequest,
    CancelWorkerRequest,
    DecodeWorkerRequest,
    DecodeWorkerResponse,
    PrivateRequestScope,
    TransportFailure,
    TransportFailureKind
} from '@/contracts/binaryTransport';
import type {
    RiskChallengeFailureReason,
    RiskChallengeHandoff,
    RiskControlDecision
} from '@/contracts/riskChallenge';
import type { AedsAccessProfileId } from '@/generated/aedsAccessProfiles';
import {
    buildFsusBinaryRoute,
    fsusBinaryRouteDescriptors,
    type FsusBinaryOperationId
} from '@/generated/fsusBinaryRoutes';
import { toTrustedApplicationWorkerScriptUrl } from '@/security/trustedTypesRuntime';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import type { BinaryFailureRouteClass } from '@/services/telemetryPrivacy';
import { emitRumMetric, emitTelemetry, recordBinaryFailureTelemetry } from '@/services/telemetryService';
import { AppError, AppErrorCode, createAppError, isAppError, toAppError } from '@/utils/appError';
import { isAbortError } from '@/utils/errors';
import wasmDecodeWorkerUrl from '@/workers/wasmDecode.worker.ts?worker&url';

import { decode, resolveAedsWorkerRuntimeModel } from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';



export type { TransportFailure, TransportFailureKind } from '@/contracts/binaryTransport';

function transportFailureToCode(kind: TransportFailureKind): AppErrorCode
{
    switch (kind)
    {
        case 'auth_failed':
            return AppErrorCode.Unauthorized;
        case 'forbidden':
            return AppErrorCode.Forbidden;
        case 'not_found':
            return AppErrorCode.NotFound;
        case 'conflict':
            return AppErrorCode.Conflict;
        case 'validation':
            return AppErrorCode.Validation;
        case 'precondition_required':
            return AppErrorCode.PreconditionRequired;
        case 'rate_limited':
            return AppErrorCode.RateLimited;
        case 'public_artifact_not_ready':
            return AppErrorCode.Timeout;
        case 'client_route_contract':
        case 'accept_contract':
        case 'decode_failed':
            return AppErrorCode.ProtocolFailure;
        case 'binary_disabled':
        case 'network':
        default:
            return AppErrorCode.InfraFailure;
    }
}

function workerErrorToCode(code?: string): AppErrorCode
{
    if (code === 'wasm_init_failed')
    {
        return AppErrorCode.InfraFailure;
    }

    if (
        code === 'decode_failed'
    || code === 'frame_type_unexpected'
    || code === 'crc_failed'
    || code === 'payload_out_of_range'
    || code === 'schema_mismatch'
    || code === 'pod_parse_failed'
    )
    {
        return AppErrorCode.ProtocolFailure;
    }

    return AppErrorCode.Unknown;
}

export class BinaryTransportError extends AppError
{
    readonly kind: TransportFailureKind;
    readonly backendCode?: number;
    readonly backendCategory?: number;
    readonly retryAfter?: string | null;
    readonly riskChallengeFailure?: RiskChallengeFailureReason;
    readonly riskChallengeHandoff?: RiskChallengeHandoff;
    readonly riskControlDecision?: RiskControlDecision;

    constructor(failure: TransportFailure)
    {
        super(transportFailureToCode(failure.kind), failure.message, {
            traceId: failure.traceId,
            status: failure.status,
            details: failure.details
        });
        this.name = 'BinaryTransportError';
        this.kind = failure.kind;
        this.backendCode = failure.backendCode;
        this.backendCategory = failure.backendCategory;
        this.retryAfter = failure.retryAfter;
        this.riskChallengeFailure = failure.riskChallengeFailure;
        this.riskChallengeHandoff = failure.riskChallengeHandoff;
        this.riskControlDecision = failure.riskControlDecision;
    }
}

let workerSingleton: Worker | null = null;
let requestSeq = 0;
const DECODE_WORKER_TIMEOUT_MS = 15000;
const WORKER_IDLE_TTL_MS = 30000;

interface PendingDecodeRequest {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeoutId: ReturnType<typeof setTimeout> | null;
    abortCleanup: (() => void) | null;
}

const pendingRequests = new Map<number, PendingDecodeRequest>();
const MAIN_THREAD_DECODE_MAX_BYTES = 4096;
const ABORT_RACE_SETTLE_MS = 50;
const DECODE_WORKER_ACTIVE_LIMIT = resolveAedsWorkerRuntimeModel().activeRequests;
const DECODE_WORKER_QUEUE_LIMIT = Math.max(16, DECODE_WORKER_ACTIVE_LIMIT * 16);

interface QueuedDecodeRequest {
    requestId: number;
    buffer: ArrayBuffer;
    expectedFrameType: FrameType;
    accessProfile?: AedsAccessProfileId;
    signal?: AbortSignal;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    abortCleanup: (() => void) | null;
}

const queuedRequests: QueuedDecodeRequest[] = [];
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
let lastAedsDiagnosticsSignature = '';

function wait(ms: number): Promise<void>
{
    return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function clearPendingRequest(requestId: number, pumpQueue = true): PendingDecodeRequest | undefined
{
    const pending = pendingRequests.get(requestId);
    if (!pending)
    {
        return undefined;
    }

    pendingRequests.delete(requestId);
    if (pending.timeoutId)
    {
        clearTimeout(pending.timeoutId);
        pending.timeoutId = null;
    }
    pending.abortCleanup?.();
    pending.abortCleanup = null;
    if (pumpQueue)
    {
        pumpDecodeQueue();
        scheduleWorkerIdleTerminate();
    }

    return pending;
}

function resetWorker(error: unknown): void
{
    clearWorkerIdleTimer();
    const pending = Array.from(pendingRequests.keys());
    for (const requestId of pending)
    {
        const request = clearPendingRequest(requestId, false);
        request?.reject(error);
    }

    while (queuedRequests.length > 0)
    {
        const queued = queuedRequests.shift()!;
        queued.abortCleanup?.();
        queued.reject(error);
    }

    workerSingleton?.terminate();
    workerSingleton = null;
}

function clearWorkerIdleTimer(): void
{
    if (!workerIdleTimer)
    {
        return;
    }

    clearTimeout(workerIdleTimer);
    workerIdleTimer = null;
}

function scheduleWorkerIdleTerminate(): void
{
    clearWorkerIdleTimer();
    if (!workerSingleton || pendingRequests.size > 0 || queuedRequests.length > 0)
    {
        return;
    }

    workerIdleTimer = setTimeout(() =>
    {
        workerIdleTimer = null;
        if (workerSingleton && pendingRequests.size === 0 && queuedRequests.length === 0)
        {
            workerSingleton.terminate();
            workerSingleton = null;
        }
    }, WORKER_IDLE_TTL_MS);
}

function postWorkerCancel(requestId: number): void
{
    if (!workerSingleton)
    {
        return;
    }

    const request: CancelWorkerRequest = {
        v: binaryDecodeWorkerProtocolVersion,
        type: 'cancel',
        requestId
    };
    workerSingleton.postMessage(request);
}

function rejectQueuedRequest(requestId: number, reason: unknown): boolean
{
    const index = queuedRequests.findIndex((item) => item.requestId === requestId);
    if (index < 0)
    {
        return false;
    }

    const [queued] = queuedRequests.splice(index, 1);
    queued.abortCleanup?.();
    queued.reject(reason);
    return true;
}

function handleWorkerMessage(event: MessageEvent<DecodeWorkerResponse>): void
{
    const payload = event.data;
    if (payload.diagnostics)
    {
        const signature = `${payload.diagnostics.selectedTier}:${payload.diagnostics.fallbackCount}:${payload.diagnostics.fallbackReason ?? ''}`;
        if (signature !== lastAedsDiagnosticsSignature)
        {
            lastAedsDiagnosticsSignature = signature;
            emitTelemetry('aeds_wasm_tier', {
                tier: payload.diagnostics.selectedTier,
                simdSupported: payload.diagnostics.simdSupported,
                fallbackCount: payload.diagnostics.fallbackCount,
                fallbackReason: payload.diagnostics.fallbackReason,
                wasmBytes: payload.diagnostics.load?.wasmBytes ?? 0,
                compileMs: payload.diagnostics.load?.compileMs ?? 0,
                instantiateMs: payload.diagnostics.load?.instantiateMs ?? 0,
                moduleCacheHit: payload.diagnostics.load?.compiledModuleCacheHit ?? false
            }, payload.diagnostics.fallbackCount > 0 ? 'warn' : 'info');
        }
    }
    if (typeof payload.workerTransferMs === 'number')
    {
        emitRumMetric('wasm_decode_timing', {
            value: payload.workerTransferMs,
            durationMs: payload.workerTransferMs
        });
    }
    const pending = clearPendingRequest(payload.requestId);
    if (!pending)
    {
        return;
    }

    if (!payload.ok)
    {
        const message = payload.error ?? payload.errorCode ?? 'binary_decode_failed';
        pending.reject(createAppError(workerErrorToCode(payload.errorCode), message, {
            details: payload.errorCode
        }));
        return;
    }

    pending.resolve(payload.data);
}

function handleWorkerFatalError(reason: unknown): void
{
    const error = reason instanceof Error
        ? reason
        : createAppError(AppErrorCode.InfraFailure, 'binary_decode_worker_failed');
    resetWorker(error);
}

function getWorker(): Worker
{
    clearWorkerIdleTimer();
    if (!workerSingleton)
    {
        workerSingleton = new Worker(toTrustedApplicationWorkerScriptUrl(
            new URL(wasmDecodeWorkerUrl, import.meta.url)
        ) as string | URL, { type: 'module' });
        emitRumMetric('binary_worker_init_count', {
            value: 1
        });
        workerSingleton.addEventListener('message', handleWorkerMessage);
        workerSingleton.addEventListener('error', (event) =>
        {
            handleWorkerFatalError(event.error ?? new Error(event.message || 'binary_decode_worker_failed'));
        });
        workerSingleton.addEventListener('messageerror', () =>
        {
            handleWorkerFatalError(createAppError(AppErrorCode.ProtocolFailure, 'binary_decode_worker_message_error'));
        });
    }

    return workerSingleton;
}

function pumpDecodeQueue(): void
{
    clearWorkerIdleTimer();
    while (pendingRequests.size < DECODE_WORKER_ACTIVE_LIMIT && queuedRequests.length > 0)
    {
        const queued = queuedRequests.shift()!;
        queued.abortCleanup?.();
        queued.abortCleanup = null;

        if (queued.signal?.aborted)
        {
            queued.reject(createAbortLikeError('binary_decode_aborted'));
            continue;
        }

        startWorkerDecode(queued);
    }
}

function isBinaryEnabled(): boolean
{
    return true;
}

function binaryFailureKindFromStatus(status: number): TransportFailureKind
{
    if (status === 401)
    {
        return 'auth_failed';
    }

    if (status === 403)
    {
        return 'forbidden';
    }

    if (status === 404)
    {
        return 'not_found';
    }

    if (status === 409)
    {
        return 'conflict';
    }

    if (status === 422)
    {
        return 'validation';
    }

    if (status === 428)
    {
        return 'precondition_required';
    }

    if (status === 429)
    {
        return 'rate_limited';
    }

    if (status === 503)
    {
        return 'public_artifact_not_ready';
    }

    if (status === 400)
    {
        return 'client_route_contract';
    }

    if (status === 406)
    {
        return 'accept_contract';
    }

    return 'network';
}

function createAbortLikeError(message: string): Error
{
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function startWorkerDecode(queued: QueuedDecodeRequest): void
{
    const worker = getWorker();
    const { requestId, signal } = queued;

    const abortHandler = () =>
    {
        const pending = clearPendingRequest(requestId);
        if (!pending)
        {
            return;
        }

        pending.reject(createAbortLikeError('binary_decode_aborted'));
        postWorkerCancel(requestId);
        scheduleWorkerIdleTerminate();
    };

    const timeoutId = setTimeout(() =>
    {
        const pending = clearPendingRequest(requestId);
        if (!pending)
        {
            return;
        }

        const timeoutError = createAppError(AppErrorCode.InfraFailure, 'binary_decode_timeout');
        pending.reject(timeoutError);
        resetWorker(timeoutError);
    }, DECODE_WORKER_TIMEOUT_MS);

    let abortCleanup: (() => void) | null = null;
    if (signal)
    {
        signal.addEventListener('abort', abortHandler, { once: true });
        abortCleanup = () => signal.removeEventListener('abort', abortHandler);
    }

    pendingRequests.set(requestId, {
        resolve: (value) => queued.resolve(value),
        reject: queued.reject,
        timeoutId,
        abortCleanup
    });

    try
    {
        const request: DecodeWorkerRequest = {
            v: binaryDecodeWorkerProtocolVersion,
            type: 'decode',
            requestId,
            buffer: queued.buffer,
            expectedFrameType: queued.expectedFrameType,
            sentAtUnixMs: Date.now(),
            accessProfile: queued.accessProfile
        };
        worker.postMessage(request, [queued.buffer]);
    }
    catch (error)
    {
        const pending = clearPendingRequest(requestId);
        pending?.reject(error);
    }
}

function decodeInWorker<T>(
    buffer: ArrayBuffer,
    expectedFrameType: FrameType,
    accessProfile?: AedsAccessProfileId,
    signal?: AbortSignal
): Promise<T>
{
    if (signal?.aborted)
    {
        return Promise.reject(createAbortLikeError('binary_decode_aborted'));
    }

    requestSeq += 1;
    const requestId = requestSeq;

    return new Promise<T>((resolve, reject) =>
    {
        let abortCleanup: (() => void) | null = null;
        if (signal)
        {
            const abortHandler = () =>
            {
                rejectQueuedRequest(requestId, createAbortLikeError('binary_decode_aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
            abortCleanup = () => signal.removeEventListener('abort', abortHandler);
        }

        const queued: QueuedDecodeRequest = {
            requestId,
            buffer,
            expectedFrameType,
            accessProfile,
            signal,
            resolve: (value) => resolve(value as T),
            reject,
            abortCleanup
        };

        if (pendingRequests.size >= DECODE_WORKER_ACTIVE_LIMIT)
        {
            if (queuedRequests.length >= DECODE_WORKER_QUEUE_LIMIT)
            {
                abortCleanup?.();
                reject(createAppError(AppErrorCode.InfraFailure, 'binary_decode_backpressure'));
                return;
            }

            queuedRequests.push(queued);
            return;
        }

        abortCleanup?.();
        queued.abortCleanup = null;
        startWorkerDecode(queued);
    });
}

function canUseDecodeWorker(): boolean
{
    return typeof Worker !== 'undefined';
}

async function loadBinaryAndDecode<T>(
    decodeFramePayload: BinaryFramePayloadDecoder,
    url: string,
    frameType: FrameType,
    accessProfile?: AedsAccessProfileId,
    requestOptions?: BinaryRequestOptions,
    signal?: AbortSignal
): Promise<T>
{
    if (!isBinaryEnabled())
    {
        throw createAppError(AppErrorCode.InfraFailure, 'binary_transport_unavailable', {
            details: 'binary_disabled'
        });
    }

    const buffer = await binaryRequest(url, {
        ...(requestOptions ?? {}),
        ...(signal ? { signal } : {})
    });
    if (buffer.byteLength <= MAIN_THREAD_DECODE_MAX_BYTES || !canUseDecodeWorker())
    {
        const decodeStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
        const frame = decode(buffer);
        if (decodeStartedAt > 0)
        {
            const durationMs = Math.round(performance.now() - decodeStartedAt);
            emitRumMetric('wasm_decode_timing', {
                value: durationMs,
                durationMs
            });
        }
        if (!frame.ok)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, frame.error ?? 'binary_decode_failed');
        }

        if (frame.frameType === FrameType.ApiError)
        {
            const apiError = decodeApiErrorPayload(frame.payloadView);
            if (apiError)
            {
                throw new BinaryRequestError(
                    apiError.status,
                    apiError.message || `Binary request failed: ${apiError.status}`,
                    buffer
                );
            }
        }

        if (frame.frameType !== frameType)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'frame_type_unexpected');
        }

        return decodeFramePayload(frame.frameType, frame.payloadView, accessProfile) as T;
    }

    const workerDecodeStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    const value = await decodeInWorker<T>(buffer, frameType, accessProfile, signal);
    if (workerDecodeStartedAt > 0)
    {
        const durationMs = Math.round(performance.now() - workerDecodeStartedAt);
        emitRumMetric('wasm_decode_timing', {
            value: durationMs,
            durationMs
        });
    }

    return value;
}

async function loadBinaryAndDecodeSafe<T>(
    decodeFramePayload: BinaryFramePayloadDecoder,
    url: string,
    frameType: FrameType,
    accessProfile?: AedsAccessProfileId,
    requestOptions?: BinaryRequestOptions,
    signal?: AbortSignal
): Promise<BinaryDecodeResult<T>>
{
    return loadBinaryAndDecode<T>(decodeFramePayload, url, frameType, accessProfile, requestOptions, signal)
        .then((value): BinaryDecodeSuccess<T> => ({ ok: true, value }))
        .catch(async (error: unknown) =>
        {
            if (!signal?.aborted && error instanceof TypeError && error.message === 'Failed to fetch')
            {
                await wait(ABORT_RACE_SETTLE_MS);
            }

            if (isAbortError(error) || signal?.aborted)
            {
                return {
                    ok: false,
                    failure: {
                        kind: 'network',
                        message: error instanceof Error ? error.message : 'request_aborted',
                        canceled: true
                    }
                };
            }

            if (error instanceof BinaryRequestError)
            {
                const apiError = decodeApiErrorFrame(error.buffer);
                const kind = binaryFailureKindFromStatus(error.status);
                const riskChallengeFailure = riskChallengeFailureFromResponse(
                    error.status,
                    error.headers,
                    apiError?.message
                );
                const riskChallengeHandoff = riskChallengeHandoffFromResponse(error.status, error.headers);
                const riskControlDecision = riskControlDecisionFromResponse(error.headers);
                if (apiError)
                {
                    return {
                        ok: false,
                        failure: {
                            kind,
                            message: apiError.message || (error instanceof Error ? error.message : 'binary_transport_failed'),
                            status: error.status,
                            traceId: apiError.traceId || undefined,
                            backendCode: apiError.code,
                            backendCategory: apiError.category,
                            details: apiError.details || undefined,
                            retryAfter: error.retryAfter,
                            riskChallengeFailure,
                            riskChallengeHandoff,
                            riskControlDecision
                        }
                    };
                }
            }

            const normalizedError = toAppError(error, 'binary_transport_failed');
            const message = normalizedError.message || 'binary_transport_failed';
            const appCode = isAppError(error) ? error.code : normalizedError.code;
            const kind: TransportFailureKind = normalizedError.details === 'binary_disabled'
                ? 'binary_disabled'
                : error instanceof BinaryRequestError
        ? binaryFailureKindFromStatus(error.status)
        : appCode === AppErrorCode.ProtocolFailure
        ? 'decode_failed'
        : 'network';
            return {
                ok: false,
                failure: {
                    kind,
                    message,
                    status: error instanceof BinaryRequestError ? error.status : undefined,
                    retryAfter: error instanceof BinaryRequestError ? error.retryAfter : undefined,
                    riskChallengeFailure: error instanceof BinaryRequestError
                        ? riskChallengeFailureFromResponse(error.status, error.headers)
                        : undefined,
                    riskChallengeHandoff: error instanceof BinaryRequestError
                        ? riskChallengeHandoffFromResponse(error.status, error.headers)
                        : undefined,
                    riskControlDecision: error instanceof BinaryRequestError
                        ? riskControlDecisionFromResponse(error.headers)
                        : undefined
                }
            };
        });
}

function decodeApiErrorFrame(buffer: ArrayBuffer): {
    code: number;
    category: number;
    status: number;
    message: string;
    details: string;
    traceId: string;
} | null
{
    const frame = decode(buffer);
    if (!frame.ok || frame.frameType !== FrameType.ApiError)
    {
        return null;
    }

    return decodeApiErrorPayload(frame.payloadView);
}

function decodeApiErrorPayload(payloadView: Uint8Array): {
    code: number;
    category: number;
    status: number;
    message: string;
    details: string;
    traceId: string;
} | null
{
    if (payloadView.byteLength !== 584)
    {
        return null;
    }

    return {
        code: payloadView[0] ?? 0,
        category: payloadView[1] ?? 0,
        status: readInt32(payloadView, 4),
        message: readFixedUtf8(payloadView, 8, 256),
        details: readFixedUtf8(payloadView, 264, 256),
        traceId: readFixedUtf8(payloadView, 520, 64)
    };
}

async function requestBinaryOnlyWithDecoder<T>(
    decodeFramePayload: BinaryFramePayloadDecoder,
    options: BinaryTransportRequest
): Promise<T>
{
    const resolved = resolveBinaryRequest(options);
    const { requestOptions } = resolved;
    const requestSignal = options.signal ?? requestOptions?.signal ?? undefined;
    const lease = privateRequestRuntime.open(resolved.privateScope, requestSignal, {
        abortOnGenerationChange: resolved.abortOnGenerationChange
    });
    try
    {
        const value = await executeBinaryRequest<T>(decodeFramePayload, options, resolved, lease.signal);
        lease.assertCurrent();
        return value;
    }
    finally
    {
        lease.release();
    }
}

async function executeBinaryRequest<T>(
    decodeFramePayload: BinaryFramePayloadDecoder,
    options: BinaryTransportRequest,
    resolved: ReturnType<typeof resolveBinaryRequest>,
    requestSignal?: AbortSignal
): Promise<T>
{
    const { binaryUrl, requestOptions } = resolved;
    let binaryResult = await loadBinaryAndDecodeSafe<T>(
        decodeFramePayload,
        binaryUrl,
        options.frameType,
        options.accessProfile,
        requestOptions,
        requestSignal
    );
    if (shouldRetryPublicReadWithPow(binaryResult, resolved))
    {
        binaryResult = await loadBinaryAndDecodeSafe<T>(
            decodeFramePayload,
            binaryUrl,
            options.frameType,
            options.accessProfile,
            {
                ...(requestOptions ?? {}),
                requiresPow: true,
                powScope: requestOptions?.powScope ?? `public-read:${binaryUrl}`
            },
            requestSignal
        );
    }
    if (binaryResult.ok)
    {
        return binaryResult.value;
    }

    const {
        kind,
        message,
        status,
        traceId,
        backendCode,
        backendCategory,
        details,
        retryAfter,
        canceled,
        riskChallengeFailure,
        riskChallengeHandoff,
        riskControlDecision
    } = binaryResult.failure;
    if (canceled)
    {
        throw createAbortLikeError(message);
    }

    const shouldReportFailure = !(options.suppressAuthFailureTelemetry && kind === 'auth_failed');
    if (shouldReportFailure)
    {
        recordBinaryFailureTelemetry({
            operationId: resolved.operationId,
            routeClass: resolved.routeClass,
            status,
            backendCode,
            kind,
            backendCategory,
            frameType: options.frameType
        });
    }
    const error = new BinaryTransportError({
        kind,
        message,
        status,
        traceId,
        backendCode,
        backendCategory,
        details,
        retryAfter,
        riskChallengeFailure,
        riskChallengeHandoff,
        riskControlDecision
    });
    throw error;
}

function riskChallengeFailureFromResponse(
    status: number,
    headers: Headers,
    backendMessage?: string
): RiskChallengeFailureReason | undefined
{
    const outcome = headers.get(FSUS_HEADERS.challengeProofOutcome);
    switch (outcome)
    {
        case 'expired':
            return 'expired';
        case 'replayed_or_missing':
            return 'replayed';
        case 'binding_mismatch':
            return 'binding_mismatch';
        case 'revoked':
            return 'revoked';
        case 'rejected':
            return 'rejected';
    }

    if (status !== 428)
    {
        return undefined;
    }

    switch (backendMessage)
    {
        case 'RISK_CHALLENGE_PROOF_EXPIRED':
            return 'expired';
        case 'RISK_CHALLENGE_PROOF_REPLAYED':
            return 'replayed';
        case 'RISK_CHALLENGE_PROOF_BINDING_MISMATCH':
        case 'RISK_CHALLENGE_KIND_MISMATCH':
            return 'binding_mismatch';
        case 'RISK_CHALLENGE_PROOF_REVOKED':
            return 'revoked';
        case 'RISK_CHALLENGE_PROOF_REJECTED':
        case 'RISK_CHALLENGE_SET_INCOMPLETE':
            return 'rejected';
        default:
            return 'required';
    }
}

function riskControlDecisionFromResponse(headers: Headers): RiskControlDecision | undefined
{
    switch (headers.get(FSUS_HEADERS.riskDecision))
    {
        case 'challenge':
        case 'stepUp':
        case 'queue':
        case 'throttle':
        case 'block':
        case 'reject':
            return headers.get(FSUS_HEADERS.riskDecision) as RiskControlDecision;
        default:
            return undefined;
    }
}

function riskChallengeHandoffFromResponse(status: number, headers: Headers): RiskChallengeHandoff | undefined
{
    if (status !== 428)
    {
        return undefined;
    }

    const decision = riskControlDecisionFromResponse(headers);
    const action = headers.get(FSUS_HEADERS.challengeAction)?.trim() ?? '';
    const routeKey = headers.get(FSUS_HEADERS.challengeRouteKey)?.trim() ?? '';
    const policyVersion = headers.get(FSUS_HEADERS.challengePolicyVersion)?.trim() ?? '';
    if ((decision !== 'challenge' && decision !== 'stepUp')
    || action.length === 0 || action.length > 96
    || routeKey.length === 0 || routeKey.length > 256
    || policyVersion.length === 0 || policyVersion.length > 64)
    {
        return undefined;
    }

    return { decision, action, routeKey, policyVersion };
}

export function createBinaryTransport(decodeFramePayload: BinaryFramePayloadDecoder): {
    requestBinaryOnly<T>(options: BinaryTransportRequest): Promise<T>;
}
{
    return {
        requestBinaryOnly: async <T>(options: BinaryTransportRequest): Promise<T> =>
            await requestBinaryOnlyWithDecoder<T>(decodeFramePayload, options)
    };
}

function resolveBinaryRequestScope(auth: string): {
    privateScope: PrivateRequestScope;
    abortOnGenerationChange: boolean;
}
{
    return {
        privateScope: auth === 'admin'
            ? 'admin'
            : auth === 'user' || auth === 'optional'
                ? 'account'
                : 'public',
        abortOnGenerationChange: auth !== 'optional'
    };
}

function resolveBinaryRequest(options: {
    binaryUrl?: string;
    binaryRoute?: {
        operationId: FsusBinaryOperationId;
        params?: Record<string, string | number | bigint>;
        query?: URLSearchParams | Record<string, string | number | boolean | null | undefined>;
    };
    requestOptions?: BinaryRequestOptions;
    privateScope?: PrivateRequestScope;
}): {
    binaryUrl: string;
    requestOptions?: BinaryRequestOptions;
    retryPublicReadWithPow: boolean;
    operationId: FsusBinaryOperationId | 'binary_legacy_request';
    routeClass: BinaryFailureRouteClass;
    privateScope: PrivateRequestScope;
    abortOnGenerationChange: boolean;
}
{
    if (options.binaryRoute)
    {
        const descriptor = fsusBinaryRouteDescriptors[options.binaryRoute.operationId];
        if (!descriptor)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'binary_route_descriptor_missing');
        }
        const binaryUrl = buildFsusBinaryRoute(options.binaryRoute.operationId, options.binaryRoute.params, options.binaryRoute.query);
        const retryPublicReadWithPow = descriptor.auth === 'anonymous'
      && descriptor.rateLimitPolicy === 'public_read'
      && descriptor.method === 'GET'
      && !descriptor.requiresPow;
        const { privateScope, abortOnGenerationChange } = resolveBinaryRequestScope(descriptor.auth);
        if (options.requestOptions?.credentials !== undefined || descriptor.credentialPolicy === 'include')
        {
            return {
                binaryUrl,
                requestOptions: options.requestOptions,
                retryPublicReadWithPow,
                operationId: options.binaryRoute.operationId,
                routeClass: binaryRouteClass(descriptor.auth),
                privateScope,
                abortOnGenerationChange
            };
        }
        return {
            binaryUrl,
            retryPublicReadWithPow,
            requestOptions: {
                ...options.requestOptions,
                credentials: descriptor.credentialPolicy
            },
            operationId: options.binaryRoute.operationId,
            routeClass: binaryRouteClass(descriptor.auth),
            privateScope,
            abortOnGenerationChange
        };
    }
    if (options.binaryUrl)
    {
        return {
            binaryUrl: options.binaryUrl,
            requestOptions: options.requestOptions,
            retryPublicReadWithPow: false,
            operationId: 'binary_legacy_request',
            routeClass: 'legacy',
            privateScope: options.privateScope ?? 'public',
            abortOnGenerationChange: options.privateScope !== 'public'
        };
    }
    throw createAppError(AppErrorCode.ProtocolFailure, 'binary_route_missing');
}

function binaryRouteClass(auth: string): BinaryFailureRouteClass
{
    if (auth === 'admin')
    {
        return 'admin';
    }
    if (auth === 'user' || auth === 'optional')
    {
        return 'account';
    }
    return 'public';
}

function shouldRetryPublicReadWithPow<T>(
    result: BinaryDecodeResult<T>,
    resolved: { requestOptions?: BinaryRequestOptions; retryPublicReadWithPow: boolean; }
): result is BinaryDecodeFailure
{
    return !result.ok
    && resolved.retryPublicReadWithPow
    && !resolved.requestOptions?.requiresPow
    && result.failure.kind === 'precondition_required'
    && result.failure.status === 428;
}
