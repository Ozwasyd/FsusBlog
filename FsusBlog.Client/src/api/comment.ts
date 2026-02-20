import api from './index'
import type { PowRequest } from './auth'

// =================================================================================
// 1. 类型定义 (DTOs)
// =================================================================================

/** * 发布评论所需的 DTO 
 * 继承 PowRequest 以包含 nonce, salt 等字段
 */
export interface CommentDto extends PowRequest {
  articleId: number
  content: string
}

/** 游标分页通用包装 */
export interface CursorResult<T> {
  data: T[]
  nextCursor: string | null // 🌟 修改：游标改为 string 以适配 Snowflake
  hasMore: boolean
}

/** 文章详情页显示的评论项 */
export interface CommentItem {
  id: string // Snowflake ID 必须使用 string
  content: string
  createTime: string
  userName: string
}

/** 个人中心显示的评论项 (包含文章信息) */
export interface MyCommentItem {
  id: string // Snowflake ID 必须使用 string
  content: string
  createTime: string
  articleId: number
  articleTitle: string 
}

// =================================================================================
// 2. 接口方法
// =================================================================================

/** * 发布评论 
 */
export const createComment = (data: CommentDto) => {
  return api.post<null>('/Comment', data)
}

/** 获取文章下的评论列表 */
export const getComments = (articleId: number, cursor?: string | null, limit = 10) => {
  return api.get<CursorResult<CommentItem>>(`/Comment/${articleId}`, {
    params: { cursor, limit }
  })
}

/** 获取当前登录用户的评论记录 */
export const getMyComments = (cursor?: string | null, limit: number = 10) =>
  api.get<CursorResult<MyCommentItem>>('/Comment/me', {
    params: { cursor, limit }
  })

/** 删除评论 */
export const deleteComment = (id: string) => // 🌟 修改：ID 类型改为 string
  api.delete<string>(`/Comment/${id}`)