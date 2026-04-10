import { BinaryRequestError, binaryRequest } from '@/api/binaryApiClient';
import { decodeBinaryEnvelope } from '@/api/binaryEnvelope';
import { FrameType } from '@wasm/protocol/frame';


type DecodeWorkerResponse = {
  v: 1;
  requestId: number;
  ok: boolean;
  frameType?: number;
  data?: unknown;
  renderedHtml?: string;
  errorCode?: string;
  error?: string;
};

type DecodeWorkerError = {
  code?: string;
  message: string;
};

type BinaryDecodeRequest = {
  v: 1;
  requestId: number;
  buffer: ArrayBuffer;
  expectedFrameType: FrameType;
  renderHtml?: boolean;
  renderContext?: Record<string, number | string | boolean | null | undefined>;
};

export type TransportFailureKind = 'binary_disabled' | 'auth_failed' | 'forbidden' | 'network' | 'decode_failed';

export type TransportFailure = {
  kind: TransportFailureKind;
  message: string;
};

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

function decodeInWorker<T>(
  buffer: ArrayBuffer,
  expectedFrameType: FrameType,
  renderHtml: boolean,
  renderContext?: Record<string, number | string | boolean | null | undefined>
): Promise<T> {
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
        reject({
          code: payload.errorCode,
          message: payload.error ?? payload.errorCode ?? 'binary_decode_failed'
        } satisfies DecodeWorkerError);
        return;
      }

      if (payload.renderedHtml && payload.renderedHtml.length > 0) {
        reportTransportEvent('fsus:binary:rendered', {
          frameType: payload.frameType,
          htmlLength: payload.renderedHtml.length,
          html: payload.renderedHtml
        });
      }

      resolve(payload.data as T);
    };

    worker.addEventListener('message', listener);
    const request: BinaryDecodeRequest = { v: 1, requestId, buffer, expectedFrameType, renderHtml, renderContext };
    worker.postMessage(request, [buffer]);
  });
}

export async function loadBinaryAndDecode<T>(
  url: string,
  frameType: FrameType,
  signal?: AbortSignal,
  renderHtml = false,
  renderContext?: Record<string, number | string | boolean | null | undefined>
): Promise<T> {
  if (!isBinaryEnabled()) {
    throw new Error('binary_disabled');
  }

  const buffer = await binaryRequest(url, signal ? { signal } : undefined);
  return await decodeInWorker<T>(buffer, frameType, renderHtml, renderContext);
}

export async function loadBinaryAndDecodeSafe<T>(
  url: string,
  frameType: FrameType,
  signal?: AbortSignal,
  renderHtml = false,
  renderContext?: Record<string, number | string | boolean | null | undefined>
): Promise<BinaryDecodeResult<T>> {
  return loadBinaryAndDecode<T>(url, frameType, signal, renderHtml, renderContext)
    .then((value) => ({ ok: true, value }))
    .catch((error: unknown) => {
      const workerError = (error && typeof error === 'object' && 'message' in error)
        ? (error as DecodeWorkerError)
        : undefined;
      let envelopeMessage = '';
      if (error instanceof BinaryRequestError) {
        try {
          const envelope = decodeBinaryEnvelope(error.buffer);
          const body = envelope.bodyJson as { message?: string; Message?: string } | null;
          envelopeMessage = body?.message ?? body?.Message ?? envelope.bodyText;
        } catch {
          envelopeMessage = '';
        }
      }

      const message = (envelopeMessage || workerError?.message)
        ?? (error instanceof Error ? error.message : 'binary_transport_failed');
      const code = workerError?.code ?? '';
      const kind: TransportFailureKind = message.includes('disabled')
        ? 'binary_disabled'
        : error instanceof BinaryRequestError && error.status === 401
        ? 'auth_failed'
        : error instanceof BinaryRequestError && error.status === 403
        ? 'forbidden'
        : code.includes('decode')
          || code.includes('frame')
          || code.includes('crc')
          || code.includes('schema')
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
  signal?: AbortSignal;
  renderHtml?: boolean;
  renderContext?: Record<string, number | string | boolean | null | undefined>;
}): Promise<T> {
  const binaryResult = await loadBinaryAndDecodeSafe<T>(
    options.binaryUrl,
    options.frameType,
    options.signal,
    options.renderHtml === true,
    options.renderContext
  );
  if (binaryResult.ok) {
    return binaryResult.value;
  }

  const { kind, message } = binaryResult.failure;
  reportTransportEvent('fsus:binary:failure', {
    kind,
    message,
    url: options.binaryUrl,
    frameType: options.frameType
  });
  throw new Error(`binary_only_request_failed:${kind}:${message}`);
}
