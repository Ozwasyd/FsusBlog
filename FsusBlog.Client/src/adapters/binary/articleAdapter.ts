import type { ArticleDetail, ArticleListItem, ArticleListRes } from '@/api/article';
import { BinaryReader, readFixedUtf8, readInt32, readInt64Number, readSliceRef, readSliceText } from './reader';
import { ARTICLE_DETAIL_POD_SIZE, ARTICLE_LIST_POD_SIZE, POPULAR_ARTICLE_POD_SIZE, TAG_POD_SIZE } from './types';

function mapTagPod(span: Uint8Array): { id: number; name: string } {
  return {
    id: readInt32(span, 0),
    name: readFixedUtf8(span, 4, 128)
  };
}

function readArticleListItem(reader: BinaryReader): ArticleListItem {
  const pod = reader.readSpan(ARTICLE_LIST_POD_SIZE);
  const tagCount = reader.readInt32();
  if (tagCount < 0) throw new Error('article_list_tag_count_invalid');

  const tags: Array<{ id: number; name: string }> = [];
  for (let i = 0; i < tagCount; i++) {
    tags.push(mapTagPod(reader.readSpan(TAG_POD_SIZE)));
  }

  const payload = reader.readBlob();
  const summary = readSliceText(payload, readSliceRef(pod, 404));
  const snippet = readSliceText(payload, readSliceRef(pod, 412));

  return {
    id: readInt32(pod, 0),
    title: readFixedUtf8(pod, 148, 256),
    summary,
    snippet,
    views: readInt32(pod, 4),
    createTime: new Date(readInt64Number(pod, 8)).toISOString(),
    category: {
      id: readInt32(pod, 16),
      name: readFixedUtf8(pod, 20, 128)
    },
    tags
  };
}

export function mapArticlePageFromPodPayload(payload: Uint8Array): ArticleListRes {
  const reader = new BinaryReader(payload);
  const total = reader.readInt32();
  const count = reader.readInt32();
  if (count < 0) throw new Error('article_page_count_invalid');

  const items: ArticleListItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push(readArticleListItem(reader));
  }

  return { items, total };
}

export function mapArticleSearchFromPodPayload(payload: Uint8Array): ArticleListItem[] {
  const reader = new BinaryReader(payload);
  const count = reader.readInt32();
  if (count < 0) throw new Error('article_search_count_invalid');

  const items: ArticleListItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push(readArticleListItem(reader));
  }

  return items;
}

export function mapArticleHotFromPodPayload(payload: Uint8Array): ArticleListItem[] {
  const reader = new BinaryReader(payload);
  const count = reader.readInt32();
  if (count < 0) throw new Error('article_hot_count_invalid');

  const items: ArticleListItem[] = [];
  for (let i = 0; i < count; i++) {
    const pod = reader.readSpan(POPULAR_ARTICLE_POD_SIZE);
    items.push({
      id: readInt32(pod, 0),
      title: readFixedUtf8(pod, 8, 256),
      summary: '',
      snippet: '',
      views: readInt32(pod, 4),
      createTime: new Date(0).toISOString(),
      category: { id: 0, name: '' },
      tags: []
    });
  }

  return items;
}

export function mapArticleDetailFromPodPayload(payload: Uint8Array): ArticleDetail {
  if (payload.byteLength < ARTICLE_DETAIL_POD_SIZE + 4 + 4 + 1) {
    throw new Error('article_detail_payload_too_short');
  }

  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(ARTICLE_DETAIL_POD_SIZE);
  const tagCount = reader.readInt32();
  if (tagCount < 0) throw new Error('article_detail_tag_count_invalid');

  const tags: Array<{ id: number; name: string }> = [];
  for (let i = 0; i < tagCount; i++) {
    tags.push(mapTagPod(reader.readSpan(TAG_POD_SIZE)));
  }

  const textBlob = reader.readBlob();
  reader.readByte();

  const categoryId = readInt32(pod, 16);
  return {
    id: readInt32(pod, 0),
    title: readFixedUtf8(pod, 148, 256),
    content: readSliceText(textBlob, readSliceRef(pod, 412)),
    summary: readSliceText(textBlob, readSliceRef(pod, 404)),
    categoryId,
    views: readInt32(pod, 4),
    createTime: new Date(readInt64Number(pod, 8)).toISOString(),
    category: {
      id: categoryId,
      name: readFixedUtf8(pod, 20, 128)
    },
    tags
  };
}
