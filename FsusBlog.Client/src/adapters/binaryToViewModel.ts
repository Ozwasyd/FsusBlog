import type { ArticleDetail } from '@/api/article';

const decoder = new TextDecoder();
const ARTICLE_DETAIL_POD_SIZE = 420;
const TAG_POD_SIZE = 132;
const CATEGORY_NAME_OFFSET = 20;
const TITLE_OFFSET = 148;
const SUMMARY_SLICE_OFFSET = 404;
const CONTENT_SLICE_OFFSET = 412;

function readFixedUtf8(bytes: Uint8Array, offset: number, length: number): string {
  const end = offset + length;
  let actualEnd = offset;
  while (actualEnd < end && bytes[actualEnd] !== 0) {
    actualEnd++;
  }

  return decoder.decode(bytes.subarray(offset, actualEnd));
}

function readSliceRef(bytes: Uint8Array, offset: number): { offset: number; length: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return {
    offset: view.getInt32(0, true),
    length: view.getInt32(4, true)
  };
}

function readInt32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true);
}

function readInt64Number(bytes: Uint8Array, offset: number): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, true);
  return Number(value);
}

function readSliceText(blob: Uint8Array, sliceOffset: number, sliceLength: number): string {
  if (sliceOffset < 0 || sliceLength < 0 || sliceOffset + sliceLength > blob.byteLength) {
    return '';
  }

  return decoder.decode(blob.subarray(sliceOffset, sliceOffset + sliceLength));
}

export function mapArticleDetailFromPodPayload(payload: Uint8Array): ArticleDetail {
  if (payload.byteLength < ARTICLE_DETAIL_POD_SIZE + 4 + 4 + 1) {
    throw new Error('pod_payload_too_short');
  }

  const id = readInt32(payload, 0);
  const views = readInt32(payload, 4);
  const createTimeUnixMs = readInt64Number(payload, 8);
  const categoryId = readInt32(payload, 16);
  const categoryName = readFixedUtf8(payload, CATEGORY_NAME_OFFSET, 128);
  const title = readFixedUtf8(payload, TITLE_OFFSET, 256);
  const summarySlice = readSliceRef(payload, SUMMARY_SLICE_OFFSET);
  const contentSlice = readSliceRef(payload, CONTENT_SLICE_OFFSET);

  let offset = ARTICLE_DETAIL_POD_SIZE;
  const tagCount = readInt32(payload, offset);
  offset += 4;

  if (tagCount < 0) {
    throw new Error('pod_tag_count_invalid');
  }

  const tags: Array<{ id: number; name: string }> = [];
  for (let i = 0; i < tagCount; i++) {
    if (offset + TAG_POD_SIZE > payload.byteLength) {
      throw new Error('pod_tag_overflow');
    }

    const tagId = readInt32(payload, offset);
    const tagName = readFixedUtf8(payload, offset + 4, 128);
    tags.push({ id: tagId, name: tagName });
    offset += TAG_POD_SIZE;
  }

  if (offset + 4 > payload.byteLength) {
    throw new Error('pod_text_blob_length_missing');
  }

  const textBlobLength = readInt32(payload, offset);
  offset += 4;

  if (textBlobLength < 0 || offset + textBlobLength + 1 > payload.byteLength) {
    throw new Error('pod_text_blob_invalid');
  }

  const textBlob = payload.subarray(offset, offset + textBlobLength);
  const summary = readSliceText(textBlob, summarySlice.offset, summarySlice.length);
  const content = readSliceText(textBlob, contentSlice.offset, contentSlice.length);

  return {
    id,
    title,
    content,
    summary,
    categoryId,
    views,
    createTime: new Date(createTimeUnixMs).toISOString(),
    category: {
      id: categoryId,
      name: categoryName
    },
    tags
  };
}
