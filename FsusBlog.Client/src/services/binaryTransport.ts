import { BinaryRequestError, binaryRequest } from '@/api/binaryApiClient';
import { decodeBinaryEnvelope } from '@/api/binaryEnvelope';
import { AppError, AppErrorCode, createAppError, isAppError, toAppError } from '@/utils/appError';
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

function workerErrorToCode(code?: string, message?: string): AppErrorCode {
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
    || message?.includes('decode')
    || message?.includes('frame')
    || message?.includes('schema')
    || message?.includes('payload')
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

function getWorker(): Worker {
  if (!workerSingleton) {
    workerSingleton = new Worker(new URL('../workers/wasmDecode.worker.ts', import.meta.url), { type: 'module' });
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

function decodeInWorker<T>(buffer: ArrayBuffer, expectedFrameType: FrameType): Promise<T> {
  const worker = getWorker();
  requestSeq += 1;
  const requestId = requestSeq;

  return new Promise<T>((resolve, reject) => {
    const listener = (event: MessageEvent<DecodeWorkerResponse>) => {
      const payload = event.data;
      if (payload.requestId !== requestId) {
        return;
      }

      worker.removeEventListener('message', listener);
      if (!payload.ok) {
        const message = payload.error ?? payload.errorCode ?? 'binary_decode_failed';
        reject(createAppError(workerErrorToCode(payload.errorCode, message), message, {
          details: payload.errorCode
        }));
        return;
      }

      resolve(payload.data as T);
    };

    worker.addEventListener('message', listener);
    const request: BinaryDecodeRequest = { v: 1, requestId, buffer, expectedFrameType };
    worker.postMessage(request, [buffer]);
  });
}

export async function loadBinaryAndDecode<T>(
  url: string,
  frameType: FrameType,
  requestOptions?: RequestInit & { requiresPow?: boolean },
  signal?: AbortSignal
): Promise<T> {
  if (!isBinaryEnabled()) {
    throw createAppError(AppErrorCode.InfraFailure, 'binary_disabled');
  }

  const buffer = await binaryRequest(url, {
    ...(requestOptions ?? {}),
    ...(signal ? { signal } : {})
  });
  return await decodeInWorker<T>(buffer, frameType);
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
      const kind: TransportFailureKind = message.includes('disabled')
        ? 'binary_disabled'
        : error instanceof BinaryRequestError && error.status === 401
        ? 'auth_failed'
        : error instanceof BinaryRequestError && error.status === 403
        ? 'forbidden'
        : appCode === AppErrorCode.ProtocolFailure
          || message.includes('decode')
          || message.includes('frame')
          || message.includes('schema')
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

  const { kind, message, traceId } = binaryResult.failure;
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
