import { BinaryRequestError, binaryRequest, type BinaryRequestOptions } from '@/api/binaryApiClient';
import { FSUS_HEADERS } from '@/api/contracts';
import { readFixedUtf8, readInt32 } from '@/codecs/binary/reader';
import { binaryDecodeWorkerProtocolVersion } from '@/contracts/binaryTransport';
import type {
    BinaryDecodeFailure,
    BinaryDecodeResult,
    BinaryDecodeSuccess,
    BinaryFramePayloadDecoder,
    BinaryTransportLocalFailure,
    BinaryTransportOperation,
    BinaryTransportRequest,
    BinaryTransportResources,
    BinaryTransportTerminal,
    BinaryWorkerResponse,
    CancelWorkerRequest,
    DecodeWorkerRequest,
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
let retiredWorkerCleanup: { worker: Worker; owners: LocalTransportOwner[]; cause: unknown; } | null = null;
let requestSeq = 0;
const DECODE_WORKER_TIMEOUT_MS = 15000;
const WORKER_IDLE_TTL_MS = 30000;

interface PendingDecodeRequest {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeoutId: ReturnType<typeof setTimeout> | null;
    task: OwnedDecode;
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
    task: OwnedDecode;
}

const queuedRequests: QueuedDecodeRequest[] = [];
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
let lastAedsDiagnosticsSignature = '';

interface OwnedDecode {
    owner: LocalTransportOwner;
    requestId: number;
    posted: boolean;
    abortCleanup: (() => void) | null;
    abortCleanupInProgress: boolean;
    abortCleanupFailure: unknown;
    state: 'queued' | 'pending' | 'observed' | 'unknown';
    terminal: Promise<void>;
    finish: (state: 'observed' | 'unknown') => void;
}

class LocalTransportOwner
{
    execution: BinaryTransportResources['execution'] = 'running';
    lease: BinaryTransportResources['lease'] = 'not-opened';
    callerAbortListener = false;
    cancellationRequested = false;
    readonly decodes: OwnedDecode[] = [];
    readonly abortRaceTimers = new Set<ReturnType<typeof setTimeout>>();
    // A failed original release is not converted into a receipt by calling its retired no-op again.
    retainedLease: ReturnType<typeof privateRequestRuntime.open> | undefined;
    retainedAbortCleanup: (() => void) | undefined;
    callerCleanupFailure: unknown;
    private callerCleanupInProgress = false;
    private readonly failures = new Map<BinaryTransportLocalFailure['stage'], Readonly<BinaryTransportLocalFailure>>();

    record(stage: BinaryTransportLocalFailure['stage'], cause: unknown): void
    {
        const prior = this.failures.get(stage);
        this.failures.set(stage, Object.freeze({
            stage,
            firstCause: prior ? prior.firstCause : cause,
            cause,
            occurrences: (prior?.occurrences ?? 0) + 1
        }));
    }

    inspectFailures(): readonly Readonly<BinaryTransportLocalFailure>[]
    {
        return Object.freeze(Array.from(this.failures.values()));
    }

    releaseCallerListener(): boolean
    {
        if (this.callerCleanupInProgress)
        {
            return false;
        }
        const cleanup = this.retainedAbortCleanup;
        if (!cleanup)
        {
            return true;
        }
        this.callerCleanupInProgress = true;
        try
        {
            cleanup();
            if (this.retainedAbortCleanup === cleanup)
            {
                this.retainedAbortCleanup = undefined;
                this.callerAbortListener = false;
            }
            return this.retainedAbortCleanup === undefined;
        }
        catch (error)
        {
            this.callerCleanupFailure = error;
            this.record('cleanup', error);
            return false;
        }
        finally
        {
            this.callerCleanupInProgress = false;
        }
    }

    observeCallerOnceDispatch(): void
    {
        if (!this.callerCleanupInProgress)
        {
            this.callerAbortListener = false;
        }
    }

    createDecode(requestId: number): OwnedDecode
    {
        let resolveTerminal!: () => void;
        const terminal = new Promise<void>((resolve) =>
        {
            resolveTerminal = resolve;
        });
        const task: OwnedDecode = {
            owner: this,
            requestId,
            posted: false,
            abortCleanup: null,
            abortCleanupInProgress: false,
            abortCleanupFailure: undefined,
            state: 'queued',
            terminal,
            finish: (state) =>
            {
                if (task.state === 'observed' || task.state === 'unknown')
                {
                    return;
                }
                task.state = state;
                resolveTerminal();
            }
        };
        this.decodes.push(task);
        return task;
    }

    inspectResources(): Readonly<BinaryTransportResources>
    {
        const pending = Array.from(pendingRequests.values()).filter((entry) => entry.task.owner === this);
        const queuedDecodes = queuedRequests.filter((entry) => entry.task.owner === this).length;
        const postedDecodes = this.decodes.filter((task) => task.posted);
        const workerTerminal = postedDecodes.some((task) => task.state === 'unknown')
            ? 'unknown'
            : postedDecodes.some((task) => task.state === 'pending')
                ? 'pending'
                : postedDecodes.length > 0 ? 'observed' : 'not-used';
        return Object.freeze({
            execution: this.execution,
            lease: this.lease,
            callerAbortListener: this.callerAbortListener || this.retainedAbortCleanup !== undefined,
            cancellationRequested: this.cancellationRequested,
            queuedDecodes,
            pendingDecodes: pending.length,
            decodeTimeouts: pending.filter((entry) => entry.timeoutId !== null).length,
            decodeAbortListeners: this.decodes.filter((task) => task.abortCleanup !== null).length,
            abortRaceTimers: this.abortRaceTimers.size,
            workerTerminal,
            sharedWorker: workerSingleton !== null,
            sharedWorkerIdleTimer: workerIdleTimer !== null,
            sharedWorkerCleanupPending: retiredWorkerCleanup !== null,
            networkTerminal: 'unavailable',
            sharedWasmInitialization: 'unavailable'
        });
    }

    async observeTerminal(): Promise<Readonly<BinaryTransportTerminal>>
    {
        await Promise.all(this.decodes.map((task) => task.terminal));
        const resources = this.inspectResources();
        return Object.freeze({
            local: resources.workerTerminal === 'unknown' || resources.lease === 'cleanup-failed'
                || resources.callerAbortListener || resources.pendingDecodes > 0
                || resources.queuedDecodes > 0 || resources.decodeAbortListeners > 0 ? 'unknown' : 'observed',
            resources,
            failures: this.inspectFailures()
        });
    }
}

function wait(ms: number, owner?: LocalTransportOwner): Promise<void>
{
    return new Promise((resolve) =>
    {
        const timer = globalThis.setTimeout(() =>
        {
            owner?.abortRaceTimers.delete(timer);
            resolve();
        }, ms);
        owner?.abortRaceTimers.add(timer);
    });
}

function clearPendingRequest(requestId: number, pumpQueue = true): PendingDecodeRequest | undefined
{
    const pending = pendingRequests.get(requestId);
    if (!pending)
    {
        return undefined;
    }

    if (pending.timeoutId !== null)
    {
        try
        {
            clearTimeout(pending.timeoutId);
            pending.timeoutId = null;
        }
        catch (error)
        {
            pending.task.owner.record('cleanup', error);
        }
    }
    releaseDecodeListener(pending.task);
    if (pending.timeoutId === null && pending.task.abortCleanup === null)
    {
        pendingRequests.delete(requestId);
    }
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
    const lostWorker = workerSingleton;
    workerSingleton = null;
    const affected = Array.from(pendingRequests.values()).filter((entry) => entry.task.state === 'pending');
    const pending = affected.map((entry) => entry.task.requestId);
    for (let i = 0; i < pending.length; i += 1)
    {
        const request = clearPendingRequest(pending[i], false);
        request?.reject(error);
        request?.task.owner.record('worker', error);
        request?.task.finish('unknown');
    }

    for (const queued of [...queuedRequests])
    {
        rejectQueuedRequest(queued.requestId, error);
        queued.task.owner.record('worker', error);
    }

    if (lostWorker)
    {
        try
        {
            lostWorker.terminate();
        }
        catch (cleanupError)
        {
            const owners = Array.from(new Set(affected.map((entry) => entry.task.owner)));
            retiredWorkerCleanup = { worker: lostWorker, owners, cause: cleanupError };
            for (const owner of owners)
            {
                owner.record('cleanup', cleanupError);
            }
        }
    }
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

    const queued = queuedRequests[index];
    if (releaseQueuedListener(queued))
    {
        queuedRequests.splice(index, 1);
    }
    queued.reject(reason);
    queued.task.finish('observed');
    return true;
}

function releaseQueuedListener(queued: QueuedDecodeRequest): boolean
{
    return releaseDecodeListener(queued.task);
}

function releaseDecodeListener(task: OwnedDecode): boolean
{
    if (task.abortCleanupInProgress)
    {
        return false;
    }
    const cleanup = task.abortCleanup;
    if (!cleanup)
    {
        return true;
    }
    task.abortCleanupInProgress = true;
    try
    {
        cleanup();
        if (task.abortCleanup === cleanup)
        {
            task.abortCleanup = null;
        }
        return task.abortCleanup === null;
    }
    catch (error)
    {
        task.abortCleanupFailure = error;
        task.owner.record('cleanup', error);
        return false;
    }
    finally
    {
        task.abortCleanupInProgress = false;
    }
}

function handleWorkerMessage(event: MessageEvent<BinaryWorkerResponse>): void
{
    const payload = event.data;
    if (event.currentTarget !== workerSingleton || payload.v !== binaryDecodeWorkerProtocolVersion)
    {
        return;
    }
    if ('type' in payload)
    {
        const pending = clearPendingRequest(payload.requestId, false);
        if (!pending)
        {
            return;
        }
        if (payload.error)
        {
            pending.task.owner.record('worker', createAppError(workerErrorToCode(payload.errorCode), payload.error, {
                details: payload.errorCode
            }));
        }
        // A canceled producer may have suppressed its public response.
        pending.reject(createAbortLikeError('binary_decode_aborted'));
        pending.task.finish('observed');
        pumpDecodeQueue();
        scheduleWorkerIdleTerminate();
        return;
    }
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
    const pending = pendingRequests.get(payload.requestId);
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
    // Shared acquisition retries the original broken worker's cleanup before any replacement.
    // A request's cancel method never receives this shared termination authority.
    if (retiredWorkerCleanup)
    {
        const cleanup = retiredWorkerCleanup;
        try
        {
            cleanup.worker.terminate();
            retiredWorkerCleanup = null;
        }
        catch (error)
        {
            cleanup.cause = error;
            for (const owner of cleanup.owners)
            {
                owner.record('cleanup', error);
            }
            throw error;
        }
    }
    if (!workerSingleton)
    {
        workerSingleton = new Worker(toTrustedApplicationWorkerScriptUrl(
            new URL(wasmDecodeWorkerUrl, import.meta.url)
        ) as string | URL, { type: 'module' });
        emitRumMetric('binary_worker_init_count', {
            value: 1
        });
        workerSingleton.addEventListener('message', handleWorkerMessage);
        const originalWorker = workerSingleton;
        workerSingleton.addEventListener('error', (event) =>
        {
            if (workerSingleton === originalWorker)
            {
                handleWorkerFatalError(event.error ?? new Error(event.message || 'binary_decode_worker_failed'));
            }
        });
        workerSingleton.addEventListener('messageerror', () =>
        {
            if (workerSingleton === originalWorker)
            {
                handleWorkerFatalError(createAppError(AppErrorCode.ProtocolFailure, 'binary_decode_worker_message_error'));
            }
        });
    }

    return workerSingleton;
}

function pumpDecodeQueue(): void
{
    clearWorkerIdleTimer();
    while (pendingRequests.size < DECODE_WORKER_ACTIVE_LIMIT && queuedRequests.length > 0)
    {
        const queued = queuedRequests[0];
        if (queued.task.abortCleanupInProgress)
        {
            break;
        }
        if (!releaseQueuedListener(queued))
        {
            queued.reject(queued.task.abortCleanupFailure);
            queued.task.finish('observed');
            break;
        }
        queuedRequests.shift();
        if (queued.task.state === 'observed')
        {
            continue;
        }

        if (queued.signal?.aborted)
        {
            queued.reject(createAbortLikeError('binary_decode_aborted'));
            queued.task.finish('observed');
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
    let worker: Worker;
    try
    {
        worker = getWorker();
    }
    catch (error)
    {
        queued.reject(error);
        queued.task.owner.record('worker', error);
        queued.task.finish('observed');
        return;
    }
    const { requestId, signal, task } = queued;
    // Worker acquisition emits synchronous telemetry before this request owns any listener.
    if (signal?.aborted)
    {
        task.owner.cancellationRequested = true;
        queued.reject(createAbortLikeError('binary_decode_aborted'));
        task.finish('observed');
        scheduleWorkerIdleTerminate();
        return;
    }

    const pending: PendingDecodeRequest = {
        resolve: queued.resolve,
        reject: queued.reject,
        timeoutId: null,
        task
    };
    pendingRequests.set(requestId, pending);
    task.state = 'pending';
    const abortHandler = (event?: Event): void =>
    {
        if (pendingRequests.get(requestId) !== pending)
        {
            return;
        }
        pending.reject(createAbortLikeError('binary_decode_aborted'));
        task.owner.cancellationRequested = true;
        if (event && event.currentTarget === signal && event.type === 'abort')
        {
            // Only a real once-listener dispatch proves automatic listener removal.
            if (!task.abortCleanupInProgress)
            {
                task.abortCleanup = null;
            }
        }
        else
        {
            releaseDecodeListener(task);
        }
        if (task.posted)
        {
            requestDecodeCancellation(pending);
        }
    };
    const finishUnposted = (reason: unknown): void =>
    {
        clearPendingRequest(requestId, false);
        pending.reject(reason);
        task.finish('observed');
        pumpDecodeQueue();
        scheduleWorkerIdleTerminate();
    };

    try
    {
        if (signal)
        {
            // Capture original removal custody before registration can throw or reenter.
            task.abortCleanup = () => signal.removeEventListener('abort', abortHandler);
            signal.addEventListener('abort', abortHandler, { once: true });
        }
        if (signal?.aborted)
        {
            abortHandler();
            finishUnposted(createAbortLikeError('binary_decode_aborted'));
            return;
        }
        pending.timeoutId = setTimeout(() =>
        {
            if (pendingRequests.get(requestId) !== pending)
            {
                return;
            }
            const timeoutError = createAppError(AppErrorCode.InfraFailure, 'binary_decode_timeout');
            pending.timeoutId = null;
            task.owner.record('decode', timeoutError);
            pending.reject(timeoutError);
            // Keep this slot until producer terminal/channel loss; never terminate the shared worker.
            requestDecodeCancellation(pending);
        }, DECODE_WORKER_TIMEOUT_MS);
        if (signal?.aborted)
        {
            abortHandler();
            finishUnposted(createAbortLikeError('binary_decode_aborted'));
            return;
        }
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
        task.posted = true;
    }
    catch (error)
    {
        task.owner.record('decode', error);
        finishUnposted(error);
        return;
    }
    if (signal?.aborted)
    {
        abortHandler();
    }
}

function requestDecodeCancellation(pending: PendingDecodeRequest): void
{
    if (!pending.task.posted)
    {
        return;
    }
    try
    {
        postWorkerCancel(pending.task.requestId);
    }
    catch (error)
    {
        pending.task.owner.record('cancel', error);
    }
}

function hasDecodeEnded(task: OwnedDecode): boolean
{
    // Read live state after listener callbacks/removal may have synchronously reentered.
    return task.state === 'observed' || task.state === 'unknown';
}

function decodeInWorker<T>(
    buffer: ArrayBuffer,
    expectedFrameType: FrameType,
    accessProfile?: AedsAccessProfileId,
    signal?: AbortSignal,
    owner?: LocalTransportOwner
): Promise<T>
{
    if (signal?.aborted)
    {
        return Promise.reject(createAbortLikeError('binary_decode_aborted'));
    }

    requestSeq += 1;
    const requestId = requestSeq;
    const task = (owner ?? new LocalTransportOwner()).createDecode(requestId);
    return new Promise<T>((resolve, reject) =>
    {
        const queued: QueuedDecodeRequest = {
            requestId,
            buffer,
            expectedFrameType,
            accessProfile,
            signal,
            resolve: (value) => resolve(value as T),
            reject,
            task
        };
        try
        {
            if (signal)
            {
                const abortHandler = (event?: Event): void =>
                {
                    task.owner.cancellationRequested = true;
                    if (event && event.currentTarget === signal && event.type === 'abort')
                    {
                        if (!task.abortCleanupInProgress)
                        {
                            task.abortCleanup = null;
                        }
                    }
                    else
                    {
                        releaseDecodeListener(task);
                    }
                    const reason = createAbortLikeError('binary_decode_aborted');
                    if (!rejectQueuedRequest(requestId, reason))
                    {
                        reject(reason);
                        task.finish('observed');
                    }
                };
                task.abortCleanup = () => signal.removeEventListener('abort', abortHandler);
                signal.addEventListener('abort', abortHandler, { once: true });
            }
            if (signal?.aborted || hasDecodeEnded(task))
            {
                releaseDecodeListener(task);
                reject(createAbortLikeError('binary_decode_aborted'));
                task.finish('observed');
                return;
            }
            if (pendingRequests.size >= DECODE_WORKER_ACTIVE_LIMIT)
            {
                if (queuedRequests.length >= DECODE_WORKER_QUEUE_LIMIT)
                {
                    const released = releaseDecodeListener(task);
                    reject(released
                        ? createAppError(AppErrorCode.InfraFailure, 'binary_decode_backpressure')
                        : task.abortCleanupFailure);
                    task.finish('observed');
                    return;
                }
                queuedRequests.push(queued);
                return;
            }
            if (!releaseDecodeListener(task))
            {
                reject(task.abortCleanupFailure);
                task.finish('observed');
                return;
            }
            if (signal?.aborted || hasDecodeEnded(task))
            {
                reject(createAbortLikeError('binary_decode_aborted'));
                task.finish('observed');
                return;
            }
            startWorkerDecode(queued);
        }
        catch (error)
        {
            task.owner.record('decode', error);
            releaseDecodeListener(task);
            reject(error);
            task.finish('observed');
        }
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
    signal?: AbortSignal,
    owner?: LocalTransportOwner
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
    const value = await decodeInWorker<T>(buffer, frameType, accessProfile, signal, owner);
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
    signal?: AbortSignal,
    owner?: LocalTransportOwner
): Promise<BinaryDecodeResult<T>>
{
    return loadBinaryAndDecode<T>(decodeFramePayload, url, frameType, accessProfile, requestOptions, signal, owner)
        .then((value): BinaryDecodeSuccess<T> => ({ ok: true, value }))
        .catch(async (error: unknown) =>
        {
            owner?.record('request', error);
            if (!signal?.aborted && error instanceof TypeError && error.message === 'Failed to fetch')
            {
                await wait(ABORT_RACE_SETTLE_MS, owner);
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

            let binaryErrorMessage = '';
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
                    binaryErrorMessage = apiError.message;
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
            const message = binaryErrorMessage || normalizedError.message || 'binary_transport_failed';
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

function startBinaryOnlyWithDecoder<T>(
    decodeFramePayload: BinaryFramePayloadDecoder,
    options: BinaryTransportRequest
): BinaryTransportOperation<T>
{
    const owner = new LocalTransportOwner();
    const controller = new AbortController();
    const result = (async (): Promise<T> =>
    {
        let lease: ReturnType<typeof privateRequestRuntime.open> | undefined;
        let callerSignal: AbortSignal | undefined;
        const forwardAbort = (event?: Event): void =>
        {
            if (event && event.currentTarget === callerSignal && event.type === 'abort')
            {
                owner.observeCallerOnceDispatch();
            }
            owner.cancellationRequested = true;
            controller.abort(callerSignal?.reason);
        };
        let failed = false;
        try
        {
            const resolved = resolveBinaryRequest(options);
            callerSignal = options.signal ?? resolved.requestOptions?.signal ?? undefined;
            if (callerSignal?.aborted)
            {
                forwardAbort();
            }
            else if (callerSignal)
            {
                owner.callerAbortListener = true;
                callerSignal.addEventListener('abort', forwardAbort, { once: true });
                if (callerSignal.aborted)
                {
                    forwardAbort();
                }
            }
            lease = privateRequestRuntime.open(resolved.privateScope, controller.signal, {
                abortOnGenerationChange: resolved.abortOnGenerationChange
            });
            owner.lease = 'held';
            const value = await executeBinaryRequest<T>(decodeFramePayload, options, resolved, lease.signal, owner);
            lease.assertCurrent();
            return value;
        }
        catch (error)
        {
            failed = true;
            owner.record('request', error);
            throw error;
        }
        finally
        {
            let cleanupError: unknown;
            let cleanupFailed = false;
            try
            {
                lease?.release();
                if (lease)
                {
                    owner.lease = 'released';
                }
            }
            catch (error)
            {
                owner.lease = 'cleanup-failed';
                owner.retainedLease = lease;
                owner.record('cleanup', error);
                cleanupError = error;
                cleanupFailed = true;
            }
            owner.retainedAbortCleanup = () => callerSignal?.removeEventListener('abort', forwardAbort);
            if (!owner.releaseCallerListener())
            {
                cleanupError = owner.callerCleanupFailure;
                cleanupFailed = true;
            }
            owner.execution = 'ended';
            // Cleanup never replaces the original request failure.
            if (cleanupFailed && !failed)
            {
                throw cleanupError;
            }
        }
    })();
    const terminal = result.then(() => owner.observeTerminal(), () => owner.observeTerminal());
    return Object.freeze({
        result,
        terminal,
        cancel: (reason?: unknown): void =>
        {
            owner.cancellationRequested = true;
            controller.abort(reason);
            // Reentry retries a failed cancel send against the same original pending request.
            for (const task of owner.decodes)
            {
                if (task.state === 'observed')
                {
                    releaseDecodeListener(task);
                    rejectQueuedRequest(task.requestId, createAbortLikeError('binary_decode_aborted'));
                }
                const pending = pendingRequests.get(task.requestId);
                if (pending)
                {
                    if (task.state === 'pending')
                    {
                        if (task.posted)
                        {
                            requestDecodeCancellation(pending);
                        }
                    }
                    else
                    {
                        clearPendingRequest(task.requestId);
                    }
                }
            }
            owner.releaseCallerListener();
            pumpDecodeQueue();
            scheduleWorkerIdleTerminate();
        },
        inspectResources: () => owner.inspectResources(),
        inspectFailures: () => owner.inspectFailures()
    });
}

async function executeBinaryRequest<T>(
    decodeFramePayload: BinaryFramePayloadDecoder,
    options: BinaryTransportRequest,
    resolved: ReturnType<typeof resolveBinaryRequest>,
    requestSignal?: AbortSignal,
    owner?: LocalTransportOwner
): Promise<T>
{
    const { binaryUrl, requestOptions } = resolved;
    let binaryResult = await loadBinaryAndDecodeSafe<T>(
        decodeFramePayload,
        binaryUrl,
        options.frameType,
        options.accessProfile,
        requestOptions,
        requestSignal,
        owner
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
            requestSignal,
            owner
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
    requestBinaryOnly<T>(this: void, options: BinaryTransportRequest): Promise<T>;
    startBinaryOnly<T>(this: void, options: BinaryTransportRequest): BinaryTransportOperation<T>;
}
{
    return {
        requestBinaryOnly: async <T>(options: BinaryTransportRequest): Promise<T> =>
            await startBinaryOnlyWithDecoder<T>(decodeFramePayload, options).result,
        startBinaryOnly: <T>(options: BinaryTransportRequest): BinaryTransportOperation<T> =>
            startBinaryOnlyWithDecoder<T>(decodeFramePayload, options)
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
        const privateScope: PrivateRequestScope = descriptor.auth === 'admin'
            ? 'admin'
            : descriptor.auth === 'user' || descriptor.auth === 'optional'
        ? 'account'
        : 'public';
        const abortOnGenerationChange = descriptor.auth !== 'optional';
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
