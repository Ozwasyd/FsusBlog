import type { AxiosRequestConfig } from 'axios'
import api from '@/api/index'

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
export interface PowBaseDto {
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
  status: number // 1: 禁用, 0: 启用
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
 * 逻辑：自动解包 ApiResponse，返回 PageResult
 */
export const getAdminUserList = async (
  params: UserQueryDto, 
  config?: AxiosRequestConfig
): Promise<PageResult<UserListItem>> => {
  // 性能最大化：利用解构合并参数，确保上游的 signal 能穿透到底层
  const res = await api.get<any>('/admin/users', { ...config, params })
  
  // 核心修正：参考 auth.ts 的逻辑进行健壮性解包
  return (res.data || res) as PageResult<UserListItem>
}

/**
 * 封禁/解封用户
 * 安全性保障：标记为 requiresPow，拦截器将自动处理算力注入
 */
export const adminChangeStatus = async (
  data: AdminChangeStatusDto, 
  config?: AxiosRequestConfig
) => {
  // 逻辑自洽：对于高危写操作，强制通过拦截器注入 Header 级的 PoW 证明
  return api.put('/admin/users/status', data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)
}

/**
 * 强制重置密码
 * 安全性保障：强制算力校验，防止针对管理员 Token 泄露后的暴力改密攻击
 */
export const adminResetPassword = async (
  data: AdminResetPwdDto, 
  config?: AxiosRequestConfig
) => {
  return api.post('/admin/users/reset-pwd', data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)
}
