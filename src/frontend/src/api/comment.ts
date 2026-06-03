import type { ApiRequestConfig } from './requestConfig';
import type { PowRequest } from './auth'
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';
import { encodeAedsFrame } from './binaryFrame';
import { validateCommentContent } from '@/utils/contentFilter';

// =================================================================================
// 1. 类型定义 (DTOs)
// =================================================================================

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
  userName: string
  replyToUserId?: number | null
  replyToUserName?: string | null
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
  userName: string
  replyToUserName?: string | null
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
  const validation = validateCommentContent(data.content ?? '')
  if (!validation.isValid) {
    return Promise.reject(new Error(validation.message))
  }

  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/comment',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.CommentCreateRequest, encodeCommentCreateRequest(data))
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
    signal: config?.signal as AbortSignal | undefined
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
    signal: config?.signal as AbortSignal | undefined
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
