import { getBrowserFp } from '@/utils/fingerprint';
import api from './index'

// ================= DTO 类型定义 (对应后端入参) =================

export interface PowChallenge {
  salt: string;        // 对应后端 Salt
  difficulty: number;  // 对应后端 Difficulty
  timestamp: number;   // 对应后端 Timestamp
  signature: string;   // 对应后端 Signature
}

// 统一 PoW 接口定义
export interface PowRequest {
  powSalt: string;
  powNonce: string;
  powTimestamp: number;
  difficulty: number;
  powSignature: string;
  browserFp: string;
}

export interface RegisterDto {
  username: string;
  password: string;
  confirmpassword: string;
  // PoW 相关字段
  powSalt?: string;
  powNonce?: string;
  powTimestamp?: number;
  difficulty?: number;
  powSignature?: string;
  browserFp?: string;
}

/** 登录参数 */
export interface LoginDto {
  username: string
  password: string
  // PoW 验证字段 
  powSalt?: string
  powNonce?: string
  powTimestamp?: number
  difficulty?: number
  powSignature?: string
  browserFp?: string
}

/** 修改用户名参数 */
export interface UpdateUsernameDto {
  newUsername: string
}

/** 修改密码参数 */
export interface UpdatePasswordDto extends PowRequest {
  oldPassword: string
  newPassword: string
  confirmpassword: string 
}

// ================= 响应模型定义 (对应后端出参) =================

/** * 用户基础信息 
 * 对应 Login 和 GetMe 接口返回的匿名对象: { id, username, role }
 */
export interface UserInfo {
  id: number
  username: string
  role: string // 'admin' | 'guest'
  status: number 
  banReason: string | null 
}

// ================= API 方法定义 =================

/**
 * 登录：严格保障指纹一致性
 * 安全性保障：必须优先使用外部传入的 browserFp，那是计算 Nonce 时的原始依据
 */
export const login = async (data: LoginDto): Promise<UserInfo> => {
  // 逻辑自洽：如果外部没有传入 browserFp (非 PoW 场景或逻辑漏洞)，则在此锁定指纹
  // 性能最大化：使用对象解构直接构造 payload
  const payload = {
    ...data,
    browserFp: data.browserFp || getBrowserFp()
  }
  
  const res = await api.post<any>('/Auth/login', payload)
  // 与原代码保持风格一致，处理不同的数据结构层级
  return (res.data || res.user || res) as UserInfo
}

/**
 * 注册
 */
export const register = async (data: RegisterDto) => {
  const payload = {
    ...data,
    browserFp: data.browserFp || getBrowserFp()
  }
  return api.post('/Auth/register', payload)
}

/**
 * 获取当前登录用户信息 (利用 Cookie 中的 Token)
 * 对应后端: [HttpGet("me")]
 */
export const getMe = () => {
  return api.get<UserInfo>('/Auth/me', { skipErrorMessage: true } as any)
}

/**
 * 根据 ID 获取用户信息
 */
export const getUserById = (id: number) => {
  return api.get<UserInfo>(`/Auth/${id}`)
}

/**
 * (管理员) 根据用户名查找用户
 */
export const findUserByName = (username: string) => {
  return api.get<UserInfo>(`/Auth/find/${username}`)
}

/**
 * 修改用户名
 */
export const updateUsername = (data: UpdateUsernameDto) => {
  return api.put('/Auth/update-username', data)
}

/**
 * 修改密码
 */
export const updatePassword = (data: UpdatePasswordDto) => {
  return api.put('/Auth/update-password', data)
}

/**
 * 退出登录
 */
export const logout = () => {
  return api.post('/Auth/logout')
}

/**
 * 手动刷新 Token
 */
export const refreshToken = () => {
  return api.post('/Auth/refresh-token')
}

/**
 * 获取 PoW 挑战接口
 * @param params action 指定行为（如 login, register, signalr_connect）
 */
export const getPowChallenge = (params?: { action: string }) => {
  return api.get<PowChallenge>('/Auth/pow-challenge', { params })
}