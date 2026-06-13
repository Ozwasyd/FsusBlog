import type { ApiRequestConfig } from './requestConfig'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { encodeAedsFrame } from './binaryFrame'

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof'

// ================= 类型定义 =================

/**
 * 分页响应包装器
 * 对应后端: PageResult<T>
 */
export interface PageResult<T> {
  total: number
  items: T[]
}

/**
 * 用户列表项
 * 对应后端: UserListDto
 */
export interface UserListItem {
  id: number
  username: string
  role: string
  status: number // 0:正常, 1:封禁, 2:已注销
  createTime: string
  lastLoginIp?: string
  lastLoginTime?: string
  deletedAt?: string | null
}

/**
 * 查询参数
 * 对应后端: UserQueryDto
 */
export interface UserQueryDto {
  page: number
  pageSize: number
  keyword?: string
  status?: number
}

/**
 * PoW 基础字段 (高危操作通用)
 * 对应后端: IPowRequest
 */
interface PowBaseDto {
  powSalt?: string
  powSignature?: string
  powTimestamp?: number
  difficulty?: number
  powNonce?: string
  browserFp?: string
}

/**
 * 封禁/解封参数
 * 对应后端: AdminChangeStatusDto
 */
export interface AdminChangeStatusDto extends PowBaseDto {
  userId: number
  status: 0 | 1 // 1: 禁用, 0: 启用
  reason?: string // 封禁理由
}

/**
 * 重置密码参数
 * 对应后端: AdminResetPwdDto
 */
export interface AdminResetPwdDto extends PowBaseDto {
  userId: number
  newPassword: string
}

// ================= API 方法定义 =================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持 AbortSignal 物理中断
 */

/**
 * 获取用户列表
 * 逻辑：解码 AEDS 二进制分页载荷，返回 PageResult
 */
export const getAdminUserList = async (
  params: UserQueryDto,
  config?: ApiRequestConfig
): Promise<PageResult<UserListItem>> => {
  const search = new URLSearchParams()
  search.set('page', String(params.page))
  search.set('pageSize', String(params.pageSize))
  if (params.keyword) search.set('keyword', params.keyword)
  if (params.status !== undefined) search.set('status', String(params.status))

  return requestBinaryOnly<PageResult<UserListItem>>({
    binaryUrl: `/api/binary/admin/users?${search.toString()}`,
    frameType: FrameType.AdminUserList,
    signal: config?.signal as AbortSignal | undefined
  })
}

/**
 * 封禁/解封用户
 * 安全性保障：标记为 requiresPow，拦截器将自动处理算力注入
 */
export const adminChangeStatus = async (
  data: AdminChangeStatusDto,
  config?: ApiRequestConfig
) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/admin/users/status',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      requiresPow: true,
      headers: adminHeaders(config?.mfaProofToken),
      body: encodeAedsFrame(FrameType.AdminChangeUserStatusRequest, encodeAdminChangeStatusRequest(data))
    }
  })
}

/**
 * 强制重置密码
 * 安全性保障：强制算力校验，防止针对管理员 Token 泄露后的暴力改密攻击
 */
export const adminResetPassword = async (
  data: AdminResetPwdDto,
  config?: ApiRequestConfig
) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/admin/users/reset-pwd',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      headers: adminHeaders(config?.mfaProofToken),
      body: encodeAedsFrame(FrameType.AdminResetUserPasswordRequest, encodeAdminResetPasswordRequest(data))
    }
  })
}

function adminHeaders(mfaProofToken?: string | null): Headers | undefined {
  const proofToken = mfaProofToken?.trim()
  if (!proofToken) {
    return undefined
  }

  const headers = new Headers()
  headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken)
  return headers
}

function encodeAdminChangeStatusRequest(data: AdminChangeStatusDto): Uint8Array {
  const reason = new TextEncoder().encode(data.reason ?? '')
  const bytes = new Uint8Array(16 + 4 + reason.byteLength)
  const view = new DataView(bytes.buffer)
  view.setInt32(0, data.userId, true)
  view.setInt32(4, data.status, true)
  view.setInt32(8, 0, true)
  view.setInt32(12, reason.byteLength, true)
  view.setInt32(16, reason.byteLength, true)
  bytes.set(reason, 20)
  return bytes
}

function encodeAdminResetPasswordRequest(data: AdminResetPwdDto): Uint8Array {
  const password = new TextEncoder().encode(data.newPassword)
  const bytes = new Uint8Array(16 + 4 + password.byteLength)
  const view = new DataView(bytes.buffer)
  view.setInt32(0, data.userId, true)
  view.setInt32(4, 0, true)
  view.setInt32(8, 0, true)
  view.setInt32(12, password.byteLength, true)
  view.setInt32(16, password.byteLength, true)
  bytes.set(password, 20)
  return bytes
}
