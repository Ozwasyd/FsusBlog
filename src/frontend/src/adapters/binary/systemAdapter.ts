import type { PageContentPublic, SeoConfigPublic } from '@/api/system';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readBlobText, readFixedUtf8 } from './reader';

const SEO_CONFIG_POD_SIZE = 1096;
const PAGE_CONTENT_POD_SIZE = 136;

export function mapSeoConfigFromPayload(payload: Uint8Array): SeoConfigPublic {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(SEO_CONFIG_POD_SIZE);
  const blob = reader.readBlob();

  const result = {
    title: readFixedUtf8(pod, 0, 256),
    description: readBlobText(pod, blob, 256),
    keywords: readFixedUtf8(pod, 264, 256),
    author: readFixedUtf8(pod, 520, 64),
    ogImage: readFixedUtf8(pod, 584, 256),
    baseUrl: readFixedUtf8(pod, 840, 256)
  };

  ensureConsumed(reader, 'seo_config_trailing_payload_invalid');
  return result;
}

export function mapPageContentFromPayload(payload: Uint8Array): PageContentPublic {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(PAGE_CONTENT_POD_SIZE);
  const blob = reader.readBlob();

  const result = {
    slug: readFixedUtf8(pod, 0, 128),
    content: readBlobText(pod, blob, 128)
  };

  ensureConsumed(reader, 'page_content_trailing_payload_invalid');
  return result;
}

function ensureConsumed(reader: BinaryReader, errorCode: string): void {
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }
}
