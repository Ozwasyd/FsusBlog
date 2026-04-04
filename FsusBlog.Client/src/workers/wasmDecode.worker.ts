import { decode, initWasm } from '@/wasm/aeds';
import { FrameType } from '@/wasm/types';
import { mapArticleDetailFromPodPayload } from '@/adapters/binaryToViewModel';
import type { ArticleDetail } from '@/api/article';

type DecodeRequest = {
  requestId: number;
  buffer: ArrayBuffer;
};

type DecodeResponse = {
  requestId: number;
  ok: boolean;
  article?: ArticleDetail;
  error?: string;
};

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { requestId, buffer } = event.data;

  const ready = await initWasm();
  if (!ready) {
    const payload: DecodeResponse = { requestId, ok: false, error: 'wasm_init_failed' };
    self.postMessage(payload);
    return;
  }

  const result = decode(buffer);
  if (!result.ok) {
    const payload: DecodeResponse = { requestId, ok: false, error: result.error ?? 'decode_failed' };
    self.postMessage(payload);
    return;
  }

  if (result.frameType !== FrameType.ArticleDetail) {
    const payload: DecodeResponse = { requestId, ok: false, error: 'frame_type_unexpected' };
    self.postMessage(payload);
    return;
  }

  try {
    const article = mapArticleDetailFromPodPayload(result.payloadView);
    const payload: DecodeResponse = { requestId, ok: true, article };
    self.postMessage(payload);
  } catch (error) {
    const payload: DecodeResponse = {
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'pod_parse_failed'
    };
    self.postMessage(payload);
  }
};

export {};
