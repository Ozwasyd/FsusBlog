import { decode, getAedsRuntimeDiagnostics, initWasm, type AedsRuntimeDiagnostics } from '@wasm/aeds';
import { mapFramePayloadToViewModel } from '@/adapters/binary';
import { AppErrorCode, isAppError } from '@/utils/appError';

export const DECODE_WORKER_PROTOCOL_VERSION = 1;

export type DecodeErrorCode =
  | 'none'
  | 'wasm_init_failed'
  | 'decode_failed'
  | 'frame_type_unexpected'
  | 'crc_failed'
  | 'payload_out_of_range'
  | 'schema_mismatch'
  | 'pod_parse_failed';

type DecodeRequestV1 = {
  v: 1;
  type?: 'decode';
  requestId: number;
  buffer: ArrayBuffer;
  expectedFrameType?: number;
  sentAtUnixMs?: number;
};

type CancelRequestV1 = {
  v: 1;
  type: 'cancel';
  requestId: number;
};

type WorkerRequestV1 = DecodeRequestV1 | CancelRequestV1;

type DecodeResponseV1 = {
  v: 1;
  requestId: number;
  ok: boolean;
  frameType?: number;
  data?: unknown;
  errorCode: DecodeErrorCode;
  error?: string;
  workerTransferMs?: number;
  diagnostics?: AedsRuntimeDiagnostics;
};

const canceledRequests = new Set<number>();
let wasmReadyPromise: Promise<boolean> | null = null;

const exactDecodeErrorMap: Record<string, DecodeErrorCode> = {
  frame_too_short: 'payload_out_of_range',
  magic_mismatch: 'schema_mismatch',
  version_mismatch: 'schema_mismatch',
  payload_length_mismatch: 'payload_out_of_range',
  oom: 'decode_failed',
  payload_ptr_invalid: 'payload_out_of_range',
  payload_invalid: 'payload_out_of_range',
  payload_too_short: 'payload_out_of_range',
  invalid_input: 'schema_mismatch'
};

const payloadRangePrefixes = [
  'article_list_',
  'comment_',
  'stats_',
  'article_hot_'
] as const;

function classifyDecodeErrorId(errorId: string): DecodeErrorCode {
  const exact = exactDecodeErrorMap[errorId];
  if (exact) {
    return exact;
  }

  if (
    payloadRangePrefixes.some((prefix) => errorId.startsWith(prefix))
    || errorId.startsWith('search_index_')
    || errorId.startsWith('search_patch_')
  ) {
    return 'payload_out_of_range';
  }

  return 'pod_parse_failed';
}

function classifyError(error: unknown): DecodeErrorCode {
  if (isAppError(error)) {
    switch (error.code) {
      case AppErrorCode.ProtocolFailure:
        return 'schema_mismatch';
      case AppErrorCode.InvariantViolation:
      case AppErrorCode.InfraFailure:
      case AppErrorCode.Unknown:
      default:
        return 'pod_parse_failed';
    }
  }

  if (error instanceof Error) {
    return classifyDecodeErrorId(error.message || 'pod_parse_failed');
  }

  if (typeof error === 'string' && error.length > 0) {
    return classifyDecodeErrorId(error);
  }

  return 'pod_parse_failed';
}

function ensureWasmReady(): Promise<boolean> {
  if (!wasmReadyPromise) {
    wasmReadyPromise = initWasm();
  }

  return wasmReadyPromise;
}

function isRequestCanceled(requestId: number): boolean {
  return canceledRequests.has(requestId);
}

function postDecodeResponse(response: DecodeResponseV1): void {
  if (!isRequestCanceled(response.requestId)) {
    self.postMessage(response);
  }
  canceledRequests.delete(response.requestId);
}

self.onmessage = async (event: MessageEvent<WorkerRequestV1>) => {
  const { v, requestId } = event.data;
  try {
    if (v !== DECODE_WORKER_PROTOCOL_VERSION) {
      const response: DecodeResponseV1 = {
        v: DECODE_WORKER_PROTOCOL_VERSION,
        requestId,
        ok: false,
        errorCode: 'schema_mismatch',
        error: 'worker_protocol_version_mismatch'
      };
      postDecodeResponse(response);
      return;
    }

    if (event.data.type === 'cancel') {
      canceledRequests.add(requestId);
      return;
    }

    const { buffer, expectedFrameType, sentAtUnixMs } = event.data;
    const workerTransferMs = typeof sentAtUnixMs === 'number' && Number.isFinite(sentAtUnixMs)
      ? Math.max(0, Date.now() - sentAtUnixMs)
      : undefined;
    if (isRequestCanceled(requestId)) {
      canceledRequests.delete(requestId);
      return;
    }

    const ready = await ensureWasmReady();
    if (isRequestCanceled(requestId)) {
      canceledRequests.delete(requestId);
      return;
    }

    if (!ready) {
      const response: DecodeResponseV1 = {
        v: 1,
        requestId,
        ok: false,
        errorCode: 'wasm_init_failed',
        error: 'wasm_init_failed',
        workerTransferMs,
        diagnostics: getAedsRuntimeDiagnostics()
      };
      postDecodeResponse(response);
      return;
    }

    const frame = decode(buffer);
    if (isRequestCanceled(requestId)) {
      canceledRequests.delete(requestId);
      return;
    }

    if (!frame.ok) {
      const response: DecodeResponseV1 = {
        v: 1,
        requestId,
        ok: false,
        frameType: frame.frameType,
        errorCode: classifyError(frame.error ?? 'decode_failed'),
        error: frame.error ?? 'decode_failed',
        workerTransferMs,
        diagnostics: getAedsRuntimeDiagnostics()
      };
      postDecodeResponse(response);
      return;
    }

    if (expectedFrameType !== undefined && frame.frameType !== expectedFrameType) {
      const response: DecodeResponseV1 = {
        v: 1,
        requestId,
        ok: false,
        frameType: frame.frameType,
        errorCode: 'frame_type_unexpected',
        error: 'frame_type_unexpected',
        workerTransferMs,
        diagnostics: getAedsRuntimeDiagnostics()
      };
      postDecodeResponse(response);
      return;
    }

    const data = mapFramePayloadToViewModel(frame.frameType, frame.payloadView);
    if (isRequestCanceled(requestId)) {
      canceledRequests.delete(requestId);
      return;
    }

    const response: DecodeResponseV1 = {
      v: 1,
      requestId,
      ok: true,
      frameType: frame.frameType,
      data,
      errorCode: 'none',
      workerTransferMs,
      diagnostics: getAedsRuntimeDiagnostics()
    };
    postDecodeResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'pod_parse_failed';
    const response: DecodeResponseV1 = {
      v: 1,
      requestId,
      ok: false,
      errorCode: message === 'wasm_init_failed' ? 'wasm_init_failed' : classifyError(error),
      error: message
    };
    postDecodeResponse(response);
  }
};

export {};
