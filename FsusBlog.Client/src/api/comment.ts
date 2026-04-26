import type { AxiosRequestConfig } from 'axios';
import api from './index'
import type { PowRequest } from './auth'
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';

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
export const createComment = (data: CommentDto, config?: AxiosRequestConfig) => {
  return api.post<null>('/Comment', data, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
}

/** 获取文章下的评论列表 
 * 算法最优：透传 config 确保长列表加载时可被物理中断
 */
export const getComments = (
  articleId: number, 
  cursor?: string | null, 
  limit = 10, 
  config?: AxiosRequestConfig
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
  config?: AxiosRequestConfig
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
  config?: AxiosRequestConfig
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
export const deleteComment = (id: string, config?: AxiosRequestConfig) =>
  api.delete<void>(`/Comment/${id}`, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
