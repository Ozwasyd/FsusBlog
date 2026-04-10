import { decode, initWasm } from '@wasm/aeds';
import { mapFramePayloadToViewModel } from '@/adapters/binary';
import { FrameType, isPublicSeoFrameType } from '@wasm/protocol/frame';
import type { ArticleListRes } from '@/api/article';
import type { ArticleDetail } from '@/api/article';
import { createArticleDetailPageViewContract } from '@/view-contracts/articleDetail';
import { createArticleListViewContract } from '@/view-contracts/articleList';
import { renderArticleDetailAot, renderArticleListAot } from '@/renderers/aot';

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
  renderHtml?: boolean;
  renderContext?: Record<string, number | string | boolean | null | undefined>;
};

type DecodeResponseV1 = {
  v: 1;
  requestId: number;
  ok: boolean;
  frameType?: number;
  data?: unknown;
  renderedHtml?: string;
  errorCode: DecodeErrorCode;
  error?: string;
};

function classifyError(message: string): DecodeErrorCode {
  if (message.includes('crc')) return 'crc_failed';
  if (message.includes('payload') || message.includes('overflow') || message.includes('range')) return 'payload_out_of_range';
  if (message.includes('schema') || message.includes('unsupported') || message.includes('invalid')) return 'schema_mismatch';
  return 'pod_parse_failed';
}

self.onmessage = async (event: MessageEvent<DecodeRequestV1>) => {
  const { v, requestId, buffer, expectedFrameType, renderHtml, renderContext } = event.data;
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
  const useContractRenderer = renderHtml === true && isPublicSeoFrameType(expectedFrameType as FrameType | undefined);
  const frame = decode(buffer, ready && renderHtml === true && !useContractRenderer);
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

  try {
    const data = mapFramePayloadToViewModel(frame.frameType, frame.payloadView);
    const renderedHtml = useContractRenderer && frame.frameType === FrameType.ArticleList
      ? renderArticleListAot(createArticleListViewContract(data as ArticleListRes, {
          currentPage: Number(renderContext?.currentPage) || 1,
          pageSize: Number(renderContext?.pageSize) || 10
        }))
      : useContractRenderer && frame.frameType === FrameType.ArticleDetail
        ? await renderArticleDetailAot(createArticleDetailPageViewContract(data as ArticleDetail, 0, false))
      : frame.renderedHtml;
    const response: DecodeResponseV1 = {
      v: 1,
      requestId,
      ok: true,
      frameType: frame.frameType,
      data,
      renderedHtml,
      errorCode: 'none'
    };
    self.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'pod_parse_failed';
    const response: DecodeResponseV1 = {
      v: 1,
      requestId,
      ok: false,
      frameType: frame.frameType,
      errorCode: classifyError(message),
      error: message
    };
    self.postMessage(response);
  }
};

export {};
