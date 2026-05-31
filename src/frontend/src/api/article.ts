import type { ApiRequestConfig } from './requestConfig';
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { encodeAedsFrame } from './binaryFrame';

// ================= 基础类型 =================

/** 标签响应 */
export interface Tag {
  id: number
  name: string
}

export interface PopularArticleSummaryResponse {
  id: number
  title: string
  views: number
}

export interface FeaturedArticleItem {
  id: number;
  title: string;
  coverImageUrl: string;
  views: number;
  createTime: string;
  category: {
    id: number;
    name: string;
  };
}

/**
 * 文章列表项响应
 */
export interface ArticleListItemResponse {
  id: number;
  title: string;
  summary: string;
  coverImageUrl?: string;
  views: number;
  createTime: string; // 后端 UTC 字符串
  category: {
    id: number;
    name: string;
  };
  tags: Tag[];
  isDeleted?: boolean;
  status?: ArticlePublishStatus;
  scheduledPublishAt?: string | null;
  publishedAt?: string | null;
}

/**
 * 文章详情响应
 */
export interface ArticleDetailResponse {
  id: number;
  title: string;
  content: string;
  summary: string;
  coverImageUrl?: string;
  views: number;
  createTime: string; // 后端 UTC 字符串
  category: {
    id: number;
    name: string;
  };
  tags: Tag[];
  isDeleted?: boolean;
  status?: ArticlePublishStatus;
  scheduledPublishAt?: string | null;
  publishedAt?: string | null;
}

export interface RelatedReadingItemResponse {
  id: number
  title: string
  summary?: string | null
  createTime: string
  reason: string
}

export interface RelatedReadingResponse {
  related: RelatedReadingItemResponse[]
  previous?: RelatedReadingItemResponse | null
  next?: RelatedReadingItemResponse | null
}

export const ArticlePublishStatus = {
  Draft: 0,
  Scheduled: 1,
  Published: 2,
  Archived: 3,
  Deleted: 4
} as const

export type ArticlePublishStatus = typeof ArticlePublishStatus[keyof typeof ArticlePublishStatus]

/** 分页响应 */
export interface PageResponse<T> {
  items: T[]
  total: number
}

export interface ArticleWriteRequest {
  title: string
  content: string
  summary: string
  coverImageUrl?: string;
  categoryId: number | undefined
  tagIds: number[]
  status?: ArticlePublishStatus
  scheduledPublishAt?: string | null
}

// ================= API 方法 =================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持物理中断 (AbortSignal)
 */

/** 获取文章列表 */
export const getArticles = (
  params: { page?: number; size?: number; categoryId?: number; tagId?: number },
  config?: ApiRequestConfig
) => {
  const normalized = {
    page: params.page ?? 1,
    size: params.size ?? 10,
    categoryId: params.categoryId,
    tagId: params.tagId
  };

  return requestBinaryOnly<PageResponse<ArticleListItemResponse>>({
    binaryUrl: buildPublicArticleListUrl(normalized),
    frameType: FrameType.ArticleList,
    requestOptions: { credentials: 'omit' },
    signal: config?.signal as AbortSignal | undefined
  });
}

/** 获取详情 */
export const getArticleById = (id: number, config?: ApiRequestConfig) => {
  return requestBinaryOnly<ArticleDetailResponse>({
    binaryUrl: `/api/binary/article/${normalizePositiveInt(id, 1)}.aeds`,
    frameType: FrameType.ArticleDetail,
    requestOptions: { credentials: 'omit' },
    signal: config?.signal as AbortSignal | undefined
  });
}

type JsonApiResponse<T> = {
  success: boolean
  data?: T | null
  message?: string | null
}

async function readJsonEnvelope<T>(response: Response, fallbackMessage: string): Promise<T> {
  const envelope = await response.json() as JsonApiResponse<T>
  if (!response.ok || !envelope.success || envelope.data == null) {
    throw createAppError(AppErrorCode.ProtocolFailure, envelope.message || fallbackMessage, { status: response.status })
  }

  return envelope.data
}

export const getRelatedReading = async (id: number, config?: ApiRequestConfig): Promise<RelatedReadingResponse> => {
  const response = await fetch(`/api/public/articles/${id}/related`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    },
    signal: config?.signal
  })

  return await readJsonEnvelope<RelatedReadingResponse>(response, `related_reading_failed:${response.status}`)
}

/** 热门排行 */
export const getHotArticles = (size = 10, config?: ApiRequestConfig) => {
  const count = normalizeSize(size, 10)
  return requestBinaryOnly<PopularArticleSummaryResponse[]>({
    binaryUrl: `/api/binary/article/hot/${count}.aeds`,
    frameType: FrameType.ArticleHot,
    requestOptions: { credentials: 'omit' },
    signal: config?.signal as AbortSignal | undefined
  });
}

/** 精选文章 */
export const getFeaturedArticles = (size = 3, config?: ApiRequestConfig) => {
  const count = normalizeSize(size, 3)
  return requestBinaryOnly<FeaturedArticleItem[]>({
    binaryUrl: `/api/binary/article/featured/${count}.aeds`,
    frameType: FrameType.ArticleFeatured,
    requestOptions: { credentials: 'omit' },
    signal: config?.signal as AbortSignal | undefined
  });
}

// ================= 管理端 =================

export const getAdminArticles = (
  params: { page?: number; size?: number; categoryId?: number; tagId?: number; isDeleted?: boolean; status?: ArticlePublishStatus },
  config?: ApiRequestConfig
) => {
  const search = new URLSearchParams();
  search.set('page', String(params.page ?? 1));
  search.set('size', String(params.size ?? 10));
  search.set('isDeleted', String(params.isDeleted ?? false));
  if (params.categoryId !== undefined) search.set('categoryId', String(params.categoryId));
  if (params.tagId !== undefined) search.set('tagId', String(params.tagId));
  if (params.status !== undefined) search.set('status', String(params.status));

  return requestBinaryOnly<PageResponse<ArticleListItemResponse>>({
    binaryUrl: `/api/binary/admin/article?${search.toString()}`,
    frameType: FrameType.ArticleList,
    signal: config?.signal as AbortSignal | undefined
  });
}

export const getAdminArticleById = (id: number, config?: ApiRequestConfig) => {
  return requestBinaryOnly<ArticleDetailResponse>({
    binaryUrl: `/api/binary/admin/article/${normalizePositiveInt(id, 1)}`,
    frameType: FrameType.ArticleDetail,
    signal: config?.signal as AbortSignal | undefined
  });
}

/**
 * 创建文章
 * [修复 2026-02-23] 安全性保障：强制算力校验，防止自动化垃圾投稿攻击
 */
export const createArticle = (data: ArticleWriteRequest, config?: ApiRequestConfig) =>
  requestBinaryOnly<{ id: number }>({
    binaryUrl: '/api/binary/admin/article',
    frameType: FrameType.MutationId,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.ArticleWriteRequest, encodeArticleWriteRequest(data))
    }
  })

/**
 * 更新文章
 */
export const updateArticle = (id: number, data: ArticleWriteRequest, config?: ApiRequestConfig) =>
  requestBinaryOnly<{ id: number }>({
    binaryUrl: `/api/binary/admin/article/${id}`,
    frameType: FrameType.MutationId,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.ArticleWriteRequest, encodeArticleWriteRequest(data))
    }
  })

export const deleteArticle = (id: number, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/admin/article/${id}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'DELETE',
      requiresPow: true
    }
  })

export const restoreArticle = (id: number, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/admin/article/restore/${id}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      requiresPow: true
    }
  })

export const permanentDeleteArticle = (id: number, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/admin/article/permanent/${id}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'DELETE',
      requiresPow: true
    }
  })

function buildPublicArticleListUrl(params: { page: number; size: number; categoryId?: number; tagId?: number }): string {
  const page = normalizePositiveInt(params.page, 1)
  const size = normalizeSize(params.size, 10)
  if (params.categoryId !== undefined) {
    return `/api/binary/article/list/category/${normalizePositiveInt(params.categoryId, 1)}/${page}/${size}.aeds`
  }

  if (params.tagId !== undefined) {
    return `/api/binary/article/list/tag/${normalizePositiveInt(params.tagId, 1)}/${page}/${size}.aeds`
  }

  return `/api/binary/article/list/home/${page}/${size}.aeds`
}

function normalizePositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function normalizeSize(value: number, fallback: number): number {
  const normalized = normalizePositiveInt(value, fallback)
  return Math.min(Math.max(normalized, 1), 100)
}

function encodeArticleWriteRequest(data: ArticleWriteRequest): Uint8Array {
  const encoder = new TextEncoder()
  const textParts = [
    encoder.encode(data.title ?? ''),
    encoder.encode(data.content ?? ''),
    encoder.encode(data.summary ?? ''),
    encoder.encode(data.coverImageUrl ?? '')
  ]
  const blobLength = textParts.reduce((sum, part) => sum + part.byteLength, 0)
  const tagIds = Array.isArray(data.tagIds) ? data.tagIds : []
  const tagBytesLength = tagIds.length * 4
  const bytes = new Uint8Array(40 + tagBytesLength + 4 + blobLength + 12)
  const view = new DataView(bytes.buffer)

  view.setInt32(0, data.categoryId ?? 0, true)
  view.setInt32(4, tagIds.length, true)

  let blobOffset = 0
  for (let i = 0; i < textParts.length; i += 1) {
    const part = textParts[i]
    const refOffset = 8 + i * 8
    view.setInt32(refOffset, blobOffset, true)
    view.setInt32(refOffset + 4, part.byteLength, true)
    blobOffset += part.byteLength
  }

  let cursor = 40
  for (const tagId of tagIds) {
    view.setInt32(cursor, tagId, true)
    cursor += 4
  }

  view.setInt32(cursor, blobLength, true)
  cursor += 4
  for (const part of textParts) {
    bytes.set(part, cursor)
    cursor += part.byteLength
  }

  view.setInt32(cursor, data.status ?? ArticlePublishStatus.Published, true)
  cursor += 4
  view.setBigInt64(cursor, BigInt(toScheduledPublishAtUnixMs(data.scheduledPublishAt)), true)

  return bytes
}

function toScheduledPublishAtUnixMs(value: string | null | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}
