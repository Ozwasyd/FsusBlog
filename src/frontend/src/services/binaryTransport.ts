import { BinaryRequestError, binaryRequest } from '@/api/binaryApiClient';
import { decode } from '@wasm/aeds';
import { mapFramePayloadToViewModel } from '@/adapters/binary';
import { readFixedUtf8, readInt32 } from '@/adapters/binary/reader';
import { AppError, AppErrorCode, createAppError, isAppError, toAppError } from '@/utils/appError';
import { isAbortError } from '@/utils/errors';
import { emitRumMetric } from '@/services/telemetryService';
import { FrameType } from '@wasm/protocol/frame';


type DecodeWorkerResponse = {
  v: 1;
  requestId: number;
  ok: boolean;
  frameType?: number;
  data?: unknown;
  errorCode?: string;
  error?: string;
};

type BinaryDecodeRequest = {
  v: 1;
  type: 'decode';
  requestId: number;
  buffer: ArrayBuffer;
  expectedFrameType: FrameType;
};

type BinaryCancelRequest = {
  v: 1;
  type: 'cancel';
  requestId: number;
};

export type TransportFailureKind =
  | 'binary_disabled'
  | 'auth_failed'
  | 'forbidden'
  | 'not_found'
  | 'public_artifact_not_ready'
  | 'client_route_contract'
  | 'accept_contract'
  | 'network'
  | 'decode_failed';

export type TransportFailure = {
  kind: TransportFailureKind;
  message: string;
  status?: number;
  traceId?: string;
  canceled?: boolean;
};

function transportFailureToCode(kind: TransportFailureKind): AppErrorCode {
  switch (kind) {
    case 'auth_failed':
      return AppErrorCode.Unauthorized;
    case 'forbidden':
      return AppErrorCode.Forbidden;
    case 'not_found':
      return AppErrorCode.NotFound;
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

function workerErrorToCode(code?: string): AppErrorCode {
  if (code === 'wasm_init_failed') {
    return AppErrorCode.InfraFailure;
  }

  if (
    code === 'decode_failed'
    || code === 'frame_type_unexpected'
    || code === 'crc_failed'
    || code === 'payload_out_of_range'
    || code === 'schema_mismatch'
    || code === 'pod_parse_failed'
  ) {
    return AppErrorCode.ProtocolFailure;
  }

  return AppErrorCode.Unknown;
}

export class BinaryTransportError extends AppError {
  readonly kind: TransportFailureKind;

  constructor(failure: TransportFailure) {
    super(transportFailureToCode(failure.kind), failure.message, { traceId: failure.traceId, status: failure.status });
    this.name = 'BinaryTransportError';
    this.kind = failure.kind;
  }
}

type BinaryDecodeSuccess<T> = {
  ok: true;
  value: T;
};

type BinaryDecodeFailure = {
  ok: false;
  failure: TransportFailure;
};

type BinaryDecodeResult<T> = BinaryDecodeSuccess<T> | BinaryDecodeFailure;

let workerSingleton: Worker | null = null;
let requestSeq = 0;
const DECODE_WORKER_TIMEOUT_MS = 15000;
const WORKER_IDLE_TTL_MS = 30000;

type PendingDecodeRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
};

const pendingRequests = new Map<number, PendingDecodeRequest>();
const MAIN_THREAD_DECODE_MAX_BYTES = 4096;
const ABORT_RACE_SETTLE_MS = 50;
const DECODE_WORKER_ACTIVE_LIMIT = 2;
const DECODE_WORKER_QUEUE_LIMIT = 32;

type QueuedDecodeRequest = {
  requestId: number;
  buffer: ArrayBuffer;
  expectedFrameType: FrameType;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  abortCleanup: (() => void) | null;
};

const queuedRequests: QueuedDecodeRequest[] = [];
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function clearPendingRequest(requestId: number, pumpQueue = true): PendingDecodeRequest | undefined {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    return undefined;
  }

  pendingRequests.delete(requestId);
  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
    pending.timeoutId = null;
  }
  pending.abortCleanup?.();
  pending.abortCleanup = null;
  if (pumpQueue) {
    pumpDecodeQueue();
    scheduleWorkerIdleTerminate();
  }

  return pending;
}

function resetWorker(error: unknown): void {
  clearWorkerIdleTimer();
  const pending = Array.from(pendingRequests.keys());
  for (let i = 0; i < pending.length; i += 1) {
    const request = clearPendingRequest(pending[i], false);
    request?.reject(error);
  }

  while (queuedRequests.length > 0) {
    const queued = queuedRequests.shift()!;
    queued.abortCleanup?.();
    queued.reject(error);
  }

  workerSingleton?.terminate();
  workerSingleton = null;
}

function clearWorkerIdleTimer(): void {
  if (!workerIdleTimer) {
    return;
  }

  clearTimeout(workerIdleTimer);
  workerIdleTimer = null;
}

function scheduleWorkerIdleTerminate(): void {
  clearWorkerIdleTimer();
  if (!workerSingleton || pendingRequests.size > 0 || queuedRequests.length > 0) {
    return;
  }

  workerIdleTimer = setTimeout(() => {
    workerIdleTimer = null;
    if (workerSingleton && pendingRequests.size === 0 && queuedRequests.length === 0) {
      workerSingleton.terminate();
      workerSingleton = null;
    }
  }, WORKER_IDLE_TTL_MS);
}

function postWorkerCancel(requestId: number): void {
  if (!workerSingleton) {
    return;
  }

  const request: BinaryCancelRequest = {
    v: 1,
    type: 'cancel',
    requestId
  };
  workerSingleton.postMessage(request);
}

function rejectQueuedRequest(requestId: number, reason: unknown): boolean {
  const index = queuedRequests.findIndex((item) => item.requestId === requestId);
  if (index < 0) {
    return false;
  }

  const [queued] = queuedRequests.splice(index, 1);
  queued.abortCleanup?.();
  queued.reject(reason);
  return true;
}

function handleWorkerMessage(event: MessageEvent<DecodeWorkerResponse>): void {
  const payload = event.data;
  const pending = clearPendingRequest(payload.requestId);
  if (!pending) {
    return;
  }

  if (!payload.ok) {
    const message = payload.error ?? payload.errorCode ?? 'binary_decode_failed';
    pending.reject(createAppError(workerErrorToCode(payload.errorCode), message, {
      details: payload.errorCode
    }));
    return;
  }

  pending.resolve(payload.data);
}

function handleWorkerFatalError(reason: unknown): void {
  const error = reason instanceof Error
    ? reason
    : createAppError(AppErrorCode.InfraFailure, 'binary_decode_worker_failed');
  resetWorker(error);
}

function getWorker(): Worker {
  clearWorkerIdleTimer();
  if (!workerSingleton) {
    workerSingleton = new Worker(new URL('../workers/wasmDecode.worker.ts', import.meta.url), { type: 'module' });
    emitRumMetric('binary_worker_init_count', {
      value: 1
    });
    workerSingleton.addEventListener('message', handleWorkerMessage);
    workerSingleton.addEventListener('error', (event) => {
      handleWorkerFatalError(event.error ?? new Error(event.message || 'binary_decode_worker_failed'));
    });
    workerSingleton.addEventListener('messageerror', () => {
      handleWorkerFatalError(createAppError(AppErrorCode.ProtocolFailure, 'binary_decode_worker_message_error'));
    });
  }

  return workerSingleton;
}

function pumpDecodeQueue(): void {
  clearWorkerIdleTimer();
  while (pendingRequests.size < DECODE_WORKER_ACTIVE_LIMIT && queuedRequests.length > 0) {
    const queued = queuedRequests.shift()!;
    queued.abortCleanup?.();
    queued.abortCleanup = null;

    if (queued.signal?.aborted) {
      queued.reject(createAbortLikeError('binary_decode_aborted'));
      continue;
    }

    startWorkerDecode(queued);
  }
}

function isBinaryEnabled(): boolean {
  return true;
}

function reportTransportEvent(name: string, detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function binaryFailureKindFromStatus(status: number): TransportFailureKind {
  if (status === 401) {
    return 'auth_failed';
  }

  if (status === 403) {
    return 'forbidden';
  }

  if (status === 404) {
    return 'not_found';
  }

  if (status === 503) {
    return 'public_artifact_not_ready';
  }

  if (status === 400) {
    return 'client_route_contract';
  }

  if (status === 406) {
    return 'accept_contract';
  }

  return 'network';
}

function createAbortLikeError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function startWorkerDecode<T>(queued: QueuedDecodeRequest): void {
  const worker = getWorker();
  const { requestId, signal } = queued;

  const abortHandler = () => {
    const pending = clearPendingRequest(requestId);
    if (!pending) {
      return;
    }

    pending.reject(createAbortLikeError('binary_decode_aborted'));
    postWorkerCancel(requestId);
    scheduleWorkerIdleTerminate();
  };

  const timeoutId = setTimeout(() => {
    const pending = clearPendingRequest(requestId);
    if (!pending) {
      return;
    }

    const timeoutError = createAppError(AppErrorCode.InfraFailure, 'binary_decode_timeout');
    pending.reject(timeoutError);
    resetWorker(timeoutError);
  }, DECODE_WORKER_TIMEOUT_MS);

  let abortCleanup: (() => void) | null = null;
  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
    abortCleanup = () => signal.removeEventListener('abort', abortHandler);
  }

  pendingRequests.set(requestId, {
    resolve: (value) => queued.resolve(value as T),
    reject: queued.reject,
    timeoutId,
    abortCleanup
  });

  try {
    const request: BinaryDecodeRequest = {
      v: 1,
      type: 'decode',
      requestId,
      buffer: queued.buffer,
      expectedFrameType: queued.expectedFrameType
    };
    worker.postMessage(request, [queued.buffer]);
  } catch (error) {
    const pending = clearPendingRequest(requestId);
    pending?.reject(error);
  }
}

function decodeInWorker<T>(buffer: ArrayBuffer, expectedFrameType: FrameType, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(createAbortLikeError('binary_decode_aborted'));
  }

  requestSeq += 1;
  const requestId = requestSeq;

  return new Promise<T>((resolve, reject) => {
    let abortCleanup: (() => void) | null = null;
    if (signal) {
      const abortHandler = () => {
        rejectQueuedRequest(requestId, createAbortLikeError('binary_decode_aborted'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', abortHandler);
    }

    const queued: QueuedDecodeRequest = {
      requestId,
      buffer,
      expectedFrameType,
      signal,
      resolve: (value) => resolve(value as T),
      reject,
      abortCleanup
    };

    if (pendingRequests.size >= DECODE_WORKER_ACTIVE_LIMIT) {
      if (queuedRequests.length >= DECODE_WORKER_QUEUE_LIMIT) {
        abortCleanup?.();
        reject(createAppError(AppErrorCode.InfraFailure, 'binary_decode_backpressure'));
        return;
      }

      queuedRequests.push(queued);
      return;
    }

    abortCleanup?.();
    queued.abortCleanup = null;
    startWorkerDecode<T>(queued);
  });
}

async function loadBinaryAndDecode<T>(
  url: string,
  frameType: FrameType,
  requestOptions?: RequestInit & { requiresPow?: boolean },
  signal?: AbortSignal
): Promise<T> {
  if (!isBinaryEnabled()) {
    throw createAppError(AppErrorCode.InfraFailure, 'binary_transport_unavailable', {
      details: 'binary_disabled'
    });
  }

  const buffer = await binaryRequest(url, {
    ...(requestOptions ?? {}),
    ...(signal ? { signal } : {})
  });
  if (buffer.byteLength <= MAIN_THREAD_DECODE_MAX_BYTES) {
    const decodeStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    const frame = decode(buffer);
    if (decodeStartedAt > 0) {
      const durationMs = Math.round(performance.now() - decodeStartedAt);
      emitRumMetric('wasm_decode_timing', {
        value: durationMs,
        durationMs
      });
    }
    if (!frame.ok) {
      throw createAppError(AppErrorCode.ProtocolFailure, frame.error ?? 'binary_decode_failed');
    }

    if (frame.frameType !== frameType) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'frame_type_unexpected');
    }

    return mapFramePayloadToViewModel(frame.frameType, frame.payloadView) as T;
  }

  const workerDecodeStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  const value = await decodeInWorker<T>(buffer, frameType, signal);
  if (workerDecodeStartedAt > 0) {
    const durationMs = Math.round(performance.now() - workerDecodeStartedAt);
    emitRumMetric('wasm_decode_timing', {
      value: durationMs,
      durationMs
    });
  }

  return value;
}

async function loadBinaryAndDecodeSafe<T>(
  url: string,
  frameType: FrameType,
  requestOptions?: RequestInit & { requiresPow?: boolean },
  signal?: AbortSignal
): Promise<BinaryDecodeResult<T>> {
  return loadBinaryAndDecode<T>(url, frameType, requestOptions, signal)
    .then((value): BinaryDecodeSuccess<T> => ({ ok: true, value }))
    .catch(async (error: unknown) => {
      if (!signal?.aborted && error instanceof TypeError && error.message === 'Failed to fetch') {
        await wait(ABORT_RACE_SETTLE_MS);
      }

      if (isAbortError(error) || signal?.aborted) {
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
      if (error instanceof BinaryRequestError) {
        const apiError = decodeApiErrorFrame(error.buffer);
        const kind = binaryFailureKindFromStatus(error.status);
        if (apiError) {
          binaryErrorMessage = apiError.message;
          return {
            ok: false,
            failure: {
              kind,
              message: apiError.message || (error instanceof Error ? error.message : 'binary_transport_failed'),
              status: error.status,
              traceId: apiError.traceId || undefined
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
          status: error instanceof BinaryRequestError ? error.status : undefined
        }
      };
    });
}

function decodeApiErrorFrame(buffer: ArrayBuffer): { status: number; message: string; traceId: string } | null {
  const frame = decode(buffer);
  if (!frame.ok || frame.frameType !== FrameType.ApiError || frame.payloadView.byteLength !== 584) {
    return null;
  }

  return {
    status: readInt32(frame.payloadView, 4),
    message: readFixedUtf8(frame.payloadView, 8, 256),
    traceId: readFixedUtf8(frame.payloadView, 520, 64)
  };
}

export async function requestBinaryOnly<T>(options: {
  binaryUrl: string;
  frameType: FrameType;
  requestOptions?: RequestInit & { requiresPow?: boolean };
  signal?: AbortSignal;
  suppressAuthFailureTelemetry?: boolean;
}): Promise<T> {
  const binaryResult = await loadBinaryAndDecodeSafe<T>(
    options.binaryUrl,
    options.frameType,
    options.requestOptions,
    options.signal
  );
  if (binaryResult.ok) {
    return binaryResult.value;
  }

  const { kind, message, status, traceId, canceled } = binaryResult.failure;
  if (canceled) {
    throw createAbortLikeError(message);
  }

  const shouldReportFailure = !(options.suppressAuthFailureTelemetry && kind === 'auth_failed');
  if (shouldReportFailure) {
    reportTransportEvent('fsus:binary:failure', {
      kind,
      message,
      status,
      traceId,
      url: options.binaryUrl,
      frameType: options.frameType
    });
  }
  const error = new BinaryTransportError({ kind, message, status, traceId });
  if (shouldReportFailure) {
    reportTransportEvent('fsus:binary:error', {
      kind,
      message,
      status,
      traceId,
      url: options.binaryUrl,
      frameType: options.frameType
    });
  }
  throw error;
}
