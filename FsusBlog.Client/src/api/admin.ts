import api from './index'

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
  status: number // 0:正常, 1:禁用
  createTime: string
  lastLoginIp?: string
  lastLoginTime?: string
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
 * 获取用户列表
 * 逻辑：自动解包 ApiResponse，返回 PageResult
 */
export const getAdminUserList = async (params: UserQueryDto): Promise<PageResult<UserListItem>> => {
  // 使用 <any> 跳过 TS 推断，因为我们要手动处理 ApiResponse
  const res = await api.get<any>('/admin/users', { params })
  
  // 核心修正：参考 auth.ts 的 login 逻辑，提取 data 节点
  // 如果 res.data 存在，说明它是 ApiResponse；否则可能是拦截器已经解包
  return (res.data || res) as PageResult<UserListItem>
}

/**
 * 封禁/解封用户
 * 逻辑：返回 ApiResponse 的 message 或抛出错误
 */
export const adminChangeStatus = async (data: AdminChangeStatusDto) => {
  return api.put('/admin/users/status', data)
}

/**
 * 强制重置密码
 * 逻辑：返回 ApiResponse 的 message 或抛出错误
 */
export const adminResetPassword = async (data: AdminResetPwdDto) => {
  return api.post('/admin/users/reset-pwd', data)
}