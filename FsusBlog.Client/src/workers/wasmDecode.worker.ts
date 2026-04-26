import { decode, initWasm } from '@wasm/aeds';
import { mapFramePayloadToViewModel } from '@/adapters/binary';
import { AppErrorCode, isAppError } from '@/utils/appError';
import { FrameType } from '@wasm/protocol/frame';

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
  requestId: number;
  buffer: ArrayBuffer;
  expectedFrameType?: number;
};

type DecodeResponseV1 = {
  v: 1;
  requestId: number;
  ok: boolean;
  frameType?: number;
  data?: unknown;
  errorCode: DecodeErrorCode;
  error?: string;
};

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

self.onmessage = async (event: MessageEvent<DecodeRequestV1>) => {
  const { v, requestId, buffer, expectedFrameType } = event.data;
  try {
    if (v !== DECODE_WORKER_PROTOCOL_VERSION) {
      const response: DecodeResponseV1 = {
        v: DECODE_WORKER_PROTOCOL_VERSION,
        requestId,
        ok: false,
        errorCode: 'schema_mismatch',
        error: 'worker_protocol_version_mismatch'
      };
      self.postMessage(response);
      return;
    }

    const ready = await initWasm();
    if (!ready) {
      const response: DecodeResponseV1 = {
        v: 1,
        requestId,
        ok: false,
        errorCode: 'wasm_init_failed',
        error: 'wasm_init_failed'
      };
      self.postMessage(response);
      return;
    }

    const frame = decode(buffer);
    if (!frame.ok) {
      const response: DecodeResponseV1 = {
        v: 1,
        requestId,
        ok: false,
        frameType: frame.frameType,
        errorCode: classifyError(frame.error ?? 'decode_failed'),
        error: frame.error ?? 'decode_failed'
      };
      self.postMessage(response);
      return;
    }

    if (expectedFrameType !== undefined && frame.frameType !== expectedFrameType) {
      const response: DecodeResponseV1 = {
        v: 1,
        requestId,
        ok: false,
        frameType: frame.frameType,
        errorCode: 'frame_type_unexpected',
        error: 'frame_type_unexpected'
      };
      self.postMessage(response);
      return;
    }

    const data = mapFramePayloadToViewModel(frame.frameType, frame.payloadView);
    const response: DecodeResponseV1 = {
      v: 1,
      requestId,
      ok: true,
      frameType: frame.frameType,
      data,
      errorCode: 'none'
    };
    self.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'pod_parse_failed';
    const response: DecodeResponseV1 = {
      v: 1,
      requestId,
      ok: false,
      errorCode: message === 'wasm_init_failed' ? 'wasm_init_failed' : classifyError(error),
      error: message
    };
    self.postMessage(response);
  }
};

export {};
