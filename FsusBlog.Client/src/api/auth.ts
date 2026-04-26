import type { AxiosRequestConfig } from 'axios';
import api from './index'

// ================= DTO 类型定义 (对应后端业务载荷) =================

export interface RegisterDto {
    username: string;
    password: string;
    confirmPassword: string; // 仅用于前端校验及后端业务逻辑
}

export interface LoginDto {
    username: string;
    password: string;
    rememberMe: boolean;
}

export interface UpdateUsernameDto {
  newUsername: string
}

export interface UpdatePasswordDto {
  oldPassword: string
  newPassword: string
  confirmPassword: string
}

// ================= 响应模型定义 =================

export interface AuthIdentitySnapshot {
  id: number
  username: string
  role: string
}

/** 当前登录用户信息 */
export interface CurrentUserSnapshot extends AuthIdentitySnapshot {
  status: number
  banReason: string | null
  deletedAt?: string | null
}

export interface AuthLoginFlow {
  user: AuthIdentitySnapshot
  authPhase: 'authenticated' | 'mfa_required'
  mfaMode: 'risk' | 'standard' | null
  challengeToken: string | null
}

export interface MfaSetupStart {
  enabled: boolean
  secret: string
  otpAuthUrl: string
  issuer: string
  account: string
}

export interface MfaSetupVerify {
  enabled: boolean
  recoveryCodes: string[]
}

export interface MfaProfile {
  enabled: boolean
  verifiedAt: string | null
}

export interface MfaChallengeResult {
  verified: boolean
  action: string
  proofToken: string | null
  user: AuthIdentitySnapshot | null
}

export interface UserSessionSummary {
  sessionId: string
  deviceFingerprint: string
  lastIp: string
  deviceLabel: string
  lastSeenAt: string | null
  isCurrent: boolean
  mfaVerified: boolean
}

export interface DeleteAccountRequest {
  password: string
  confirmText: string
  code?: string
  recoveryCode?: string
}

// ================= API 方法定义 =================

/**
 * 登录：严格保障指纹一致性
 *[修复 2026-02-24] 逻辑自洽：业务层不再感知 PoW 细节，由拦截器自动注入
 * 
 * [修改日期 2026-02-28]
 * 修改理由：
 * 1. 修复二次解包漏洞：拦截器已剥离响应壳，去除无意义的 .data 寻址，O(1) 直接映射 UserInfo。
 * 2. 性能最优化：移除冗余的 async/await，避免 V8 引擎生成额外的 Promise 状态机与微任务开销。
 */
export const login = (data: LoginDto, config?: AxiosRequestConfig): Promise<AuthLoginFlow> => {
  // 安全性保障：强制要求算力验证
  const finalConfig: AxiosRequestConfig = {
    ...config,
    requiresPow: true
  };
  
  return api.post<AuthLoginFlow>('/Auth/login', data, finalConfig)
}

/**
 * 注册
 * 
 *[修改日期 2026-02-28]
 * 修改理由：性能最优化：移除冗余的 async 声明，直接返回底层的 Promise 指针。
 */
export const register = (data: RegisterDto, config?: AxiosRequestConfig) => {
  return api.post('/Auth/register', data, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
}

/**
 * 获取当前登录用户信息 (利用 Cookie 中的 Token)
 */
export const getMe = (config?: AxiosRequestConfig) => {
  return api.get<CurrentUserSnapshot>('/Auth/me', config)
}

/**
 * 根据 ID 获取用户信息
 */
export const getUserById = (id: number, config?: AxiosRequestConfig) => {
  return api.get<CurrentUserSnapshot>(`/Auth/${id}`, config)
}

/**
 * (管理员) 根据用户名查找用户
 */
export const findUserByName = (username: string, config?: AxiosRequestConfig) => {
  return api.get<CurrentUserSnapshot>(`/Auth/find/${username}`, config)
}

/**
 * 修改用户名
 * 逻辑自洽：由于不涉及破坏性安全风险，默认不开启 PoW 验证以提升响应速度
 */
export const updateUsername = (data: UpdateUsernameDto, config?: AxiosRequestConfig) => {
  return api.put('/Auth/update-username', data, config)
}

/**
 * 修改密码
 * [修复 2026-02-24] 安全性保障：物理开启 requiresPow 拦截，防止针对账户凭证的暴力攻击
 */
export const updatePassword = (data: UpdatePasswordDto, config?: AxiosRequestConfig) => {
  return api.put('/Auth/update-password', data, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
}

/**
 * 退出登录
 */
export const logout = (config?: AxiosRequestConfig) => {
  return api.post('/Auth/logout', {}, config)
}

export const deleteAccount = (data: DeleteAccountRequest, config?: AxiosRequestConfig) => {
  return api.post('/Auth/delete-account', data, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
}

/**
 * 手动刷新 Token
 */
export const refreshToken = (config?: AxiosRequestConfig) => {
  return api.post('/Auth/refresh-token', {}, config)
}

export const listSessions = (config?: AxiosRequestConfig) =>
  api.get<UserSessionSummary[]>('/Auth/sessions', config)

export const revokeSession = (sessionId: string, config?: AxiosRequestConfig) =>
  api.post(`/Auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {}, config)

export const revokeOtherSessions = (config?: AxiosRequestConfig) =>
  api.post('/Auth/sessions/revoke-others', {}, config)

export const startMfaSetup = (config?: AxiosRequestConfig) =>
  api.post<MfaSetupStart>('/Auth/mfa/setup/start', {}, config)

export const getMfaProfile = (config?: AxiosRequestConfig) =>
  api.get<MfaProfile>('/Auth/mfa/profile', config)

export const verifyMfaSetup = (code: string, config?: AxiosRequestConfig) =>
  api.post<MfaSetupVerify>('/Auth/mfa/setup/verify', { code }, config)

export const disableMfa = (payload: { password: string; code?: string; recoveryCode?: string }, config?: AxiosRequestConfig) =>
  api.post('/Auth/mfa/disable', payload, config)

export const regenerateMfaRecoveryCodes = (
  payload: { password: string; code?: string; recoveryCode?: string },
  config?: AxiosRequestConfig
) => api.post<MfaSetupVerify>('/Auth/mfa/recovery/regenerate', payload, config)

export const startMfaChallenge = (action: string, config?: AxiosRequestConfig) =>
  api.post<MfaChallengeResult>('/Auth/mfa/challenge/start', { action }, config)

export const verifyMfaChallenge = (
  payload: { challengeToken: string; code?: string; recoveryCode?: string; action?: string },
  config?: AxiosRequestConfig
) => api.post<MfaChallengeResult>('/Auth/mfa/challenge', payload, config)
/**
 * 获取 PoW 挑战接口
 * 当前挑战仅按 clientIp 生成，不区分 action。
 */
export const getPowChallenge = (config?: AxiosRequestConfig) => {
  return api.get<any>('/Auth/pow-challenge', config)
}
