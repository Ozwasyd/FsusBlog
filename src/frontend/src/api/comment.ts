import type { ApiRequestConfig } from './requestConfig';
import type { PowRequest } from './auth'
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';
import { encodeAedsFrame } from './binaryFrame';
import { validateCommentContent } from '@/utils/contentFilter';

// =================================================================================
// 1. 类型定义 (DTOs)
// =================================================================================

export type CommentAuthorMode = 'anonymous' | 'public' | 'zk_anonymous'
export type CommentDisplayLanguage = 'zh-CN' | 'en'

export interface CommentAuthorView {
  mode: 'anonymous' | 'public' | 'zk_anonymous'
  displayName: string
  displayLanguage: 'zh-CN' | 'en'
  badge?: string | null
  scopeLabel?: string | null
}

/** * 发布评论所需的 DTO
 * 继承 PowRequest 以包含 nonce, salt 等字段
 */
export interface CommentDto extends PowRequest {
  articleId: number
  content: string
  parentId?: string | null
  rootId?: string | null
  replyToCommentId?: string | null
  replyToUserId?: number | null
  authorMode?: CommentAuthorMode | 'pseudonymous' | null
  publicSendExplicitlySelected?: boolean | null
  anonymousScope?: string | null
  displayLanguage?: string | null
  proofToken?: string | null
  zkProof?: Uint8Array | number[] | null
}

export interface CommentCreateV2Dto extends PowRequest {
  articleId: number
  content: string
  parentId?: string | null
  rootId?: string | null
  replyToCommentId?: string | null
  replyToUserId?: number | null
  authorMode: CommentAuthorMode
  publicSendExplicitlySelected: boolean
  anonymousScope?: string | null
  displayLanguage: CommentDisplayLanguage
  proofToken?: string | null
  zkProof?: Uint8Array | number[] | null
}

export interface CommentPolicySnapshot {
  anonymousCommentsEnabled: boolean
  publicCommentsEnabled: boolean
  zkAnonymousEnabled: boolean
  defaultAuthorMode: CommentAuthorMode | 'pseudonymous'
  supportedDisplayLanguages: string[]
}

/** 游标响应包装 */
export interface CursorResponse<T> {
  data: T[]
  nextCursor: string | null // 修改：游标改为 string 以适配 Snowflake
  hasMore: boolean
}

/** 文章详情页显示的评论项 */
export interface CommentReplyItem {
  id: string // Snowflake ID 必须使用 string
  content: string
  createTime: string
  author: CommentAuthorView
  userName: string
  replyToUserId?: number | null
  replyToUserName?: string | null
  replyToAuthor?: CommentAuthorView | null
  parentId?: string | null
  rootId: string
  replyToCommentId?: string | null
  depth: number
  isDeleted: boolean
}

export interface CommentThreadItem {
  id: string
  content: string
  createTime: string
  author: CommentAuthorView
  userName: string
  rootId: string
  isDeleted: boolean
  replyCount: number
  hasMoreReplies: boolean
  repliesPreview: CommentReplyPreviewItem[]
}

export interface CommentReplyPreviewItem {
  id: string
  content: string
  createTime: string
  author: CommentAuthorView
  userName: string
  replyToUserName?: string | null
  replyToAuthor?: CommentAuthorView | null
  isDeleted: boolean
}

/** 个人中心显示的评论项 (包含文章信息) */
export interface UserCommentResponse {
  id: string // Snowflake ID 必须使用 string
  content: string
  createTime: string
  articleId: number
  articleTitle: string
  rootId?: string | null
  replyToUserName?: string | null
  moderationStatus: number
  moderationStatusLabel: string
  visibilityState: string
  visibilityReasonCode: string
  isPubliclyVisible: boolean
}

export function resolveCommentAuthorView(input: {
  author?: CommentAuthorView | null
  userName?: string | null
  displayLanguage?: CommentDisplayLanguage | string | null
}): CommentAuthorView {
  const author = input.author
  if (author?.displayName?.trim()) {
    return {
      ...author,
      mode: normalizeCommentAuthorMode(author.mode),
      displayName: author.displayName.trim(),
      displayLanguage: normalizeCommentDisplayLanguage(author.displayLanguage)
    }
  }

  const displayName = input.userName?.trim() || 'fixture compatibility'
  return {
    mode: 'public',
    displayName,
    displayLanguage: normalizeCommentDisplayLanguage(input.displayLanguage),
    badge: 'legacy',
    scopeLabel: 'fixture compatibility'
  }
}

// =================================================================================
// 2. 接口方法
// =================================================================================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持 AbortSignal 物理中断
 */

/** * 发布评论
 * 安全性保障：启用 requiresPow 策略，物理隔离垃圾评论攻击
 */
export const createComment = (data: CommentDto, config?: ApiRequestConfig) => {
  return sendCommentMutation(
    data,
    usesCommentCreateV2(data) ? FrameType.CommentCreateV2Request : FrameType.CommentCreateRequest,
    config
  )
}

export const createCommentV2 = (data: CommentCreateV2Dto, config?: ApiRequestConfig) => {
  return sendCommentMutation(data, FrameType.CommentCreateV2Request, config)
}

export const getCommentPolicySnapshot = (config?: ApiRequestConfig) =>
  requestBinaryOnly<CommentPolicySnapshot>({
    binaryUrl: '/api/binary/comment/policy',
    frameType: FrameType.CommentPolicySnapshot,
    signal: config?.signal as AbortSignal | undefined
  })

function sendCommentMutation(
  data: CommentDto | CommentCreateV2Dto,
  frameType: typeof FrameType.CommentCreateRequest | typeof FrameType.CommentCreateV2Request,
  config?: ApiRequestConfig
) {
  const validation = validateCommentContent(data.content ?? '')
  if (!validation.isValid) {
    return Promise.reject(new Error(validation.message))
  }

  const payload = frameType === FrameType.CommentCreateV2Request
    ? encodeCommentCreateV2Request(data)
    : encodeCommentCreateRequest(data)

  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/comment',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(frameType, payload)
    }
  })
}

/** 获取文章下的评论列表
 * 算法最优：透传 config 确保长列表加载时可被物理中断
 */
export const getComments = (
  articleId: number,
  cursor?: string | null,
  limit = 10,
  config?: ApiRequestConfig
) => {
  const search = new URLSearchParams();
  if (cursor) search.set('cursor', cursor);
  search.set('limit', String(limit));

  return requestBinaryOnly<CursorResponse<CommentThreadItem>>({
    binaryUrl: `/api/binary/comment/${articleId}?${search.toString()}`,
    frameType: FrameType.CommentArticleCursor,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      requiresPow: true
    }
  });
}

export const getThreadReplies = (
  articleId: number,
  rootId: string,
  cursor?: string | null,
  limit = 20,
  config?: ApiRequestConfig
) => {
  const search = new URLSearchParams();
  if (cursor) search.set('cursor', cursor);
  search.set('limit', String(limit));
  return requestBinaryOnly<CursorResponse<CommentReplyItem>>({
    binaryUrl: `/api/binary/comment/${articleId}/thread/${rootId}?${search.toString()}`,
    frameType: FrameType.CommentThreadReplyCursor,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      requiresPow: true
    }
  });
}

/** 获取当前登录用户的评论记录 */
export const getMyComments = (
  cursor?: string | null,
  limit: number = 10,
  config?: ApiRequestConfig
) =>
  requestBinaryOnly<CursorResponse<UserCommentResponse>>({
    binaryUrl: `/api/binary/comment/me?${new URLSearchParams({
      ...(cursor ? { cursor } : {}),
      limit: String(limit)
    }).toString()}`,
    frameType: FrameType.CommentUserCursor,
    signal: config?.signal as AbortSignal | undefined
  })

/** 删除评论
 * 修改：ID 类型改为 string
 * 安全性保障：删除操作接入 PoW，防止针对他人评论的自动化遍历删除尝试
 */
export const deleteComment = (id: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/comment/${encodeURIComponent(id)}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'DELETE',
      requiresPow: true
    }
  })

function encodeCommentCreateRequest(data: CommentDto): Uint8Array {
  const content = new TextEncoder().encode(data.content ?? '')
  const bytes = new Uint8Array(44 + 4 + content.byteLength)
  const view = new DataView(bytes.buffer)
  view.setInt32(0, data.articleId, true)
  view.setInt32(4, data.replyToUserId ?? 0, true)

  const parentId = parseOptionalId(data.parentId)
  const rootId = parseOptionalId(data.rootId)
  const replyToCommentId = parseOptionalId(data.replyToCommentId)
  bytes[8] = parentId === null ? 0 : 1
  bytes[9] = rootId === null ? 0 : 1
  bytes[10] = replyToCommentId === null ? 0 : 1
  bytes[11] = data.replyToUserId === null || data.replyToUserId === undefined ? 0 : 1
  view.setBigInt64(12, parentId ?? 0n, true)
  view.setBigInt64(20, rootId ?? 0n, true)
  view.setBigInt64(28, replyToCommentId ?? 0n, true)
  view.setInt32(36, 0, true)
  view.setInt32(40, content.byteLength, true)
  view.setInt32(44, content.byteLength, true)
  bytes.set(content, 48)
  return bytes
}

export function encodeCommentCreateV2Request(data: CommentDto | CommentCreateV2Dto): Uint8Array {
  const anonymousScope = encodeText(data.anonymousScope ?? '')
  const displayLanguage = encodeText(data.displayLanguage ?? '')
  const proofToken = encodeText(data.proofToken ?? '')
  const zkProof = data.zkProof instanceof Uint8Array ? data.zkProof : new Uint8Array(data.zkProof ?? [])
  const content = encodeText(data.content ?? '')
  const blobLength = anonymousScope.byteLength + displayLanguage.byteLength + proofToken.byteLength + zkProof.byteLength + content.byteLength
  const bytes = new Uint8Array(80 + 4 + blobLength)
  const view = new DataView(bytes.buffer)
  const parentId = parseOptionalId(data.parentId)
  const rootId = parseOptionalId(data.rootId)
  const replyToCommentId = parseOptionalId(data.replyToCommentId)

  view.setInt32(0, data.articleId, true)
  view.setInt32(4, data.replyToUserId ?? 0, true)
  bytes[8] = parentId === null ? 0 : 1
  bytes[9] = rootId === null ? 0 : 1
  bytes[10] = replyToCommentId === null ? 0 : 1
  bytes[11] = data.replyToUserId === null || data.replyToUserId === undefined ? 0 : 1
  bytes[12] = encodeCommentAuthorMode(data.authorMode)
  bytes[13] = data.publicSendExplicitlySelected ? 1 : 0
  view.setUint16(14, 0, true)
  view.setBigInt64(16, parentId ?? 0n, true)
  view.setBigInt64(24, rootId ?? 0n, true)
  view.setBigInt64(32, replyToCommentId ?? 0n, true)

  let offset = 0
  offset = writeBlobPart(bytes, view, 40, 84, offset, anonymousScope)
  offset = writeBlobPart(bytes, view, 48, 84, offset, displayLanguage)
  offset = writeBlobPart(bytes, view, 56, 84, offset, proofToken)
  offset = writeBlobPart(bytes, view, 64, 84, offset, zkProof)
  writeBlobPart(bytes, view, 72, 84, offset, content)
  view.setInt32(80, blobLength, true)
  return bytes
}

function usesCommentCreateV2(data: CommentDto): boolean {
  return data.authorMode !== undefined ||
    data.publicSendExplicitlySelected !== undefined ||
    data.anonymousScope !== undefined ||
    data.displayLanguage !== undefined ||
    data.proofToken !== undefined ||
    data.zkProof !== undefined
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function writeBlobPart(bytes: Uint8Array, view: DataView, sliceOffset: number, blobStart: number, offset: number, value: Uint8Array): number {
  view.setInt32(sliceOffset, offset, true)
  view.setInt32(sliceOffset + 4, value.byteLength, true)
  bytes.set(value, blobStart + offset)
  return offset + value.byteLength
}

function encodeCommentAuthorMode(mode: CommentDto['authorMode'] | CommentCreateV2Dto['authorMode']): number {
  switch ((mode ?? 'anonymous').trim().toLowerCase().replace('-', '_')) {
    case 'pseudonymous':
      return 2
    case 'public':
      return 3
    case 'zk_anonymous':
      return 4
    default:
      return 1
  }
}

function normalizeCommentAuthorMode(mode: CommentAuthorView['mode'] | string | null | undefined): CommentAuthorMode {
  const normalized = String(mode ?? 'anonymous').trim().toLowerCase().replace('-', '_')
  return normalized === 'public' || normalized === 'zk_anonymous' ? normalized : 'anonymous'
}

function normalizeCommentDisplayLanguage(language: CommentDisplayLanguage | string | null | undefined): CommentDisplayLanguage {
  return language === 'en' ? 'en' : 'zh-CN'
}

function parseOptionalId(value?: string | null): bigint | null {
  if (!value) {
    return null
  }

  try {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed : null
  } catch {
    return null
  }
}
