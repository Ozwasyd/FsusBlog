import { BinaryRequestError, binaryRequest } from '@/api/binaryApiClient';
import { decodeBinaryEnvelope } from '@/api/binaryEnvelope';
import { AppError, AppErrorCode, createAppError, isAppError, toAppError } from '@/utils/appError';
import { isAbortError } from '@/utils/errors';
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
  requestId: number;
  buffer: ArrayBuffer;
  expectedFrameType: FrameType;
};

export type TransportFailureKind = 'binary_disabled' | 'auth_failed' | 'forbidden' | 'network' | 'decode_failed';

export type TransportFailure = {
  kind: TransportFailureKind;
  message: string;
  traceId?: string;
  canceled?: boolean;
};

function transportFailureToCode(kind: TransportFailureKind): AppErrorCode {
  switch (kind) {
    case 'auth_failed':
      return AppErrorCode.Unauthorized;
    case 'forbidden':
      return AppErrorCode.Forbidden;
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
    super(transportFailureToCode(failure.kind), failure.message, { traceId: failure.traceId });
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

type PendingDecodeRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
};

const pendingRequests = new Map<number, PendingDecodeRequest>();

function clearPendingRequest(requestId: number): PendingDecodeRequest | undefined {
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

  return pending;
}

function resetWorker(error: unknown): void {
  const pending = Array.from(pendingRequests.keys());
  for (let i = 0; i < pending.length; i += 1) {
    const request = clearPendingRequest(pending[i]);
    request?.reject(error);
  }

  workerSingleton?.terminate();
  workerSingleton = null;
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
  if (!workerSingleton) {
    workerSingleton = new Worker(new URL('../workers/wasmDecode.worker.ts', import.meta.url), { type: 'module' });
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

function isBinaryEnabled(): boolean {
  return true;
}

function reportTransportEvent(name: string, detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function createAbortLikeError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function decodeInWorker<T>(buffer: ArrayBuffer, expectedFrameType: FrameType, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(createAbortLikeError('binary_decode_aborted'));
  }

  const worker = getWorker();
  requestSeq += 1;
  const requestId = requestSeq;

  return new Promise<T>((resolve, reject) => {
    const abortHandler = () => {
      const pending = clearPendingRequest(requestId);
      if (!pending) {
        return;
      }

      pending.reject(createAbortLikeError('binary_decode_aborted'));
      if (pendingRequests.size === 0) {
        resetWorker(createAbortLikeError('binary_decode_aborted'));
      }
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
      resolve: (value) => resolve(value as T),
      reject,
      timeoutId,
      abortCleanup
    });

    try {
      const request: BinaryDecodeRequest = { v: 1, requestId, buffer, expectedFrameType };
      worker.postMessage(request, [buffer]);
    } catch (error) {
      const pending = clearPendingRequest(requestId);
      pending?.reject(error);
    }
  });
}

export async function loadBinaryAndDecode<T>(
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
  return await decodeInWorker<T>(buffer, frameType, signal);
}

export async function loadBinaryAndDecodeSafe<T>(
  url: string,
  frameType: FrameType,
  requestOptions?: RequestInit & { requiresPow?: boolean },
  signal?: AbortSignal
): Promise<BinaryDecodeResult<T>> {
  return loadBinaryAndDecode<T>(url, frameType, requestOptions, signal)
    .then((value) => ({ ok: true, value }))
    .catch((error: unknown) => {
      if (isAbortError(error)) {
        return {
          ok: false,
          failure: {
            kind: 'network',
            message: error instanceof Error ? error.message : 'request_aborted',
            canceled: true
          }
        };
      }

      let envelopeMessage = '';
      if (error instanceof BinaryRequestError) {
        try {
          const envelope = decodeBinaryEnvelope(error.buffer);
          const body = envelope.bodyJson as { message?: string; Message?: string; traceId?: string; TraceId?: string } | null;
          envelopeMessage = body?.message ?? body?.Message ?? envelope.bodyText;
          const envelopeTraceId = body?.traceId ?? body?.TraceId;
          if (envelopeTraceId) {
            return {
              ok: false,
              failure: {
                kind: error.status === 401
                  ? 'auth_failed'
                  : error.status === 403
                  ? 'forbidden'
                  : 'network',
                message: envelopeMessage || (error instanceof Error ? error.message : 'binary_transport_failed'),
                traceId: envelopeTraceId
              }
            };
          }
        } catch {
          envelopeMessage = '';
        }
      }

      const normalizedError = toAppError(error, 'binary_transport_failed');
      const message = envelopeMessage || normalizedError.message || 'binary_transport_failed';
      const appCode = isAppError(error) ? error.code : normalizedError.code;
      const kind: TransportFailureKind = normalizedError.details === 'binary_disabled'
        ? 'binary_disabled'
        : error instanceof BinaryRequestError && error.status === 401
        ? 'auth_failed'
        : error instanceof BinaryRequestError && error.status === 403
        ? 'forbidden'
        : appCode === AppErrorCode.ProtocolFailure
        ? 'decode_failed'
        : 'network';
      return {
        ok: false,
        failure: { kind, message }
      };
    });
}

export async function requestBinaryOnly<T>(options: {
  binaryUrl: string;
  frameType: FrameType;
  requestOptions?: RequestInit & { requiresPow?: boolean };
  signal?: AbortSignal;
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

  const { kind, message, traceId, canceled } = binaryResult.failure;
  if (canceled) {
    throw createAbortLikeError(message);
  }

  reportTransportEvent('fsus:binary:failure', {
    kind,
    message,
    traceId,
    url: options.binaryUrl,
    frameType: options.frameType
  });
  const error = new BinaryTransportError({ kind, message, traceId });
  reportTransportEvent('fsus:binary:error', {
    kind,
    message,
    traceId,
    url: options.binaryUrl,
    frameType: options.frameType
  });
  throw error;
}
