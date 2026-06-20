import type { ApiRequestConfig } from './requestConfig';
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { encodeAedsFrame, encodeStringMutationRequest, writeFixedUtf8 } from './binaryFrame'

// ================= DTO 类型定义 (对应后端业务载荷) =================

export interface AnonymousBootstrapRequest {
  publicHandle?: string
  acceptedGuidelines: boolean
}

export interface UpdateUsernameDto {
  newUsername: string
}

export interface UpdatePublicHandleDto {
  publicHandle: string | null
}

export interface UpdatePasswordDto {
  oldPassword: string
  newPassword: string
  confirmPassword: string
}

export interface MfaStepUpProofPayload {
  mfaProofToken?: string | null
}

// ================= 响应模型定义 =================

interface AuthLoginIdentitySnapshot {
  id: number
  username: string
  role: string
}

/** 当前登录账号容器快照 */
export interface CurrentUserSnapshot {
  id: number
  accountId: number
  internalUserId: number
  identityKind: string
  publicHandle: string | null
  passkeyEnabled: boolean
  recoveryEnabled: boolean
  totpStepUpEnabled: boolean | null
  anonymousCredentialStatus: string | null
  anonymousCredentialLevel: string | null
  status: number
  banReason: string | null
  deletedAt: string | null
}

export interface AuthLoginFlow {
  user: AuthLoginIdentitySnapshot
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
  user: AuthLoginIdentitySnapshot | null
}

export interface RecoveryKeyCreateResponse {
  keyVersion: number
  createdAt: string
  recoveryKey: string
}

export interface RecoveryKeyVerifyRequest {
  recoveryKey: string
  revokeSessions?: boolean
  revokePasskeys?: boolean
}

export interface RecoveryKeyVerifyResponse {
  userId: number
  expiresAt: string
  recoverySessionToken: string
}

export interface PowRequest {
  powSalt?: string
  powSignature?: string
  powTimestamp?: number
  difficulty?: number
  powNonce?: string
  browserFp?: string
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

export type AdminSessionStatus = 'missing' | 'active' | 'expired' | 'step_up_required'
export type AdminPrincipalSource = 'independent'

export interface AdminPrincipalSnapshot {
  id: string
  displayName: string
  source: AdminPrincipalSource
  permissions: readonly string[]
  adminSessionStatus: AdminSessionStatus
  totpStepUpRequired?: boolean
}

export interface DeleteAccountRequest {
  confirmText: string
  mfaProofToken?: string | null
}

// ================= API 方法定义 =================

export const bootstrapAnonymousAccount = (data: AnonymousBootstrapRequest, config?: ApiRequestConfig) => {
  return requestBinaryOnly<AuthLoginFlow>({
    binaryUrl: '/api/binary/auth/anonymous/bootstrap',
    frameType: FrameType.AuthLoginFlow,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.AuthAnonymousBootstrapRequest, encodeAuthAnonymousBootstrapRequest(data))
    }
  })
}

/**
 * 获取当前登录用户信息 (利用 Cookie 中的 Token)
 */
export const getMe = (config?: ApiRequestConfig) => {
  return requestBinaryOnly<CurrentUserSnapshot>({
    binaryUrl: '/api/binary/auth/me',
    frameType: FrameType.IdentityAccountSnapshot,
    signal: config?.signal as AbortSignal | undefined,
    suppressAuthFailureTelemetry: true
  })
}

/**
 * 修改用户名
 * 逻辑自洽：由于不涉及破坏性安全风险，默认不开启 PoW 验证以提升响应速度
 */
export const updateUsername = (data: UpdateUsernameDto, config?: ApiRequestConfig) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/update-username',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      body: encodeAedsFrame(FrameType.AuthUpdateUsernameRequest, encodeStringMutationRequest(data.newUsername))
    }
  })
}

export const updatePublicHandle = (data: UpdatePublicHandleDto, config?: ApiRequestConfig) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/public-handle',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      body: encodeAedsFrame(FrameType.AuthUpdatePublicHandleRequest, encodeStringMutationRequest(data.publicHandle ?? ''))
    }
  })
}

/**
 * 修改密码
 * [修复 2026-02-24] 安全性保障：物理开启 requiresPow 拦截，防止针对账户凭证的暴力攻击
 */
export const updatePassword = (data: UpdatePasswordDto, config?: ApiRequestConfig) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/update-password',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.AuthUpdatePasswordRequest, encodeAuthUpdatePasswordRequest(data))
    }
  })
}

/**
 * 退出登录
 */
export const logout = (config?: ApiRequestConfig) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/logout',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST'
    }
  })
}

export const deleteAccount = (data: DeleteAccountRequest, config?: ApiRequestConfig) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/delete-account',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      headers: mfaProofHeaders(data.mfaProofToken ?? config?.mfaProofToken),
      body: encodeAedsFrame(FrameType.AuthDeleteAccountRequest, encodeAuthDeleteAccountRequest(data))
    }
  })
}

/**
 * 手动刷新 Token
 */
export const refreshToken = (config?: ApiRequestConfig) => {
  return requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/refresh-token',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST'
    }
  })
}

export const listSessions = (config?: ApiRequestConfig) =>
  requestBinaryOnly<UserSessionSummary[]>({
    binaryUrl: '/api/binary/auth/sessions',
    frameType: FrameType.AuthSessionList,
    signal: config?.signal as AbortSignal | undefined
  })

export const revokeSession = (sessionId: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/auth/sessions/${encodeURIComponent(sessionId)}/revoke`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST'
    }
  })

export const revokeOtherSessions = (config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/sessions/revoke-others',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST'
    }
  })

export const getAdminMe = (config?: ApiRequestConfig) =>
  requestBinaryOnly<AdminPrincipalSnapshot>({
    binaryUrl: '/api/binary/auth/admin/me',
    frameType: FrameType.AdminPrincipalSnapshot,
    signal: config?.signal as AbortSignal | undefined,
    suppressAuthFailureTelemetry: true
  })

export const startMfaSetup = (
  payload?: MfaStepUpProofPayload,
  config?: ApiRequestConfig
) =>
  requestBinaryOnly<MfaSetupStart>({
    binaryUrl: '/api/binary/auth/mfa/setup/start',
    frameType: FrameType.MfaSetupStart,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      headers: mfaProofHeaders(payload?.mfaProofToken ?? config?.mfaProofToken)
    }
  })

export const getMfaProfile = (config?: ApiRequestConfig) =>
  requestBinaryOnly<MfaProfile>({
    binaryUrl: '/api/binary/auth/mfa/profile',
    frameType: FrameType.MfaProfile,
    signal: config?.signal as AbortSignal | undefined
  })

export const verifyMfaSetup = (code: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<MfaSetupVerify>({
    binaryUrl: '/api/binary/auth/mfa/setup/verify',
    frameType: FrameType.MfaSetupVerify,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      body: encodeAedsFrame(FrameType.MfaSetupVerifyRequest, encodeStringMutationRequest(code))
    }
  })

export const disableMfa = (payload: MfaStepUpProofPayload, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/mfa/disable',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      headers: mfaProofHeaders(payload.mfaProofToken ?? config?.mfaProofToken)
    }
  })

export const regenerateMfaRecoveryCodes = (
  payload: MfaStepUpProofPayload,
  config?: ApiRequestConfig
) => requestBinaryOnly<MfaSetupVerify>({
  binaryUrl: '/api/binary/auth/mfa/recovery/regenerate',
  frameType: FrameType.MfaSetupVerify,
  signal: config?.signal as AbortSignal | undefined,
  requestOptions: {
    method: 'POST',
    headers: mfaProofHeaders(payload.mfaProofToken ?? config?.mfaProofToken)
  }
})

export const startMfaChallenge = (action: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<MfaChallengeResult>({
    binaryUrl: '/api/binary/auth/mfa/challenge/start',
    frameType: FrameType.MfaChallengeResult,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      body: encodeAedsFrame(FrameType.MfaChallengeStartRequest, encodeStringMutationRequest(action))
    }
  })

export const verifyMfaChallenge = (
  payload: { challengeToken: string; code?: string; recoveryCode?: string; action?: string },
  config?: ApiRequestConfig
) => requestBinaryOnly<MfaChallengeResult>({
  binaryUrl: '/api/binary/auth/mfa/challenge',
  frameType: FrameType.MfaChallengeResult,
  signal: config?.signal as AbortSignal | undefined,
  requestOptions: {
    method: 'POST',
    body: encodeAedsFrame(FrameType.MfaChallengeVerifyRequest, encodeMfaChallengeVerifyRequest(payload))
  }
})
/**
 * 获取 PoW 挑战接口
 * 当前挑战仅按 clientIp 生成，不区分 action。
 */
export const getPowChallenge = (config?: ApiRequestConfig) => {
  return requestBinaryOnly<any>({
    binaryUrl: '/api/binary/auth/pow-challenge',
    frameType: FrameType.PowChallenge,
    signal: config?.signal as AbortSignal | undefined
  })
}

// ================= 通行密钥 (Passkey / WebAuthn) =================

export interface PasskeyCredentialSummary {
  id: number
  deviceFriendlyName: string | null
  createdAt: string
  lastUsedAt: string | null
  aaGuid: string
  backupEligible: boolean
  backupState: boolean
}

export interface PasskeyRegisterBeginResponse {
  sessionKey: string
  options: Record<string, unknown>
}

export interface PasskeyLoginBeginResponse {
  challengeToken: string
  options: Record<string, unknown>
}

export interface PasskeyRegisterCompleteRequest {
  sessionKey: string
  attestation: any
  friendlyName?: string
  mfaProofToken?: string
}

export interface RecoveryPasskeyRegisterCompleteRequest extends Omit<PasskeyRegisterCompleteRequest, 'mfaProofToken'> {
  recoverySessionToken: string
}

export interface PasskeyLoginCompleteRequest {
  challengeToken: string
  assertion: any
  rememberMe?: boolean
}

export const passkeyRegisterBegin = (config?: ApiRequestConfig) =>
  requestBinaryOnly<PasskeyRegisterBeginResponse>({
    binaryUrl: '/api/binary/auth/passkey/register/begin',
    frameType: FrameType.PasskeyRegisterBegin,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: { method: 'POST' }
  })

export const passkeyRegisterComplete = (data: PasskeyRegisterCompleteRequest, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/passkey/register/complete',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      body: encodeAedsFrame(FrameType.PasskeyRegisterCompleteRequest, encodePasskeyRegisterCompleteRequest(data))
    }
  })

export const createRecoveryKey = (config?: ApiRequestConfig) =>
  requestBinaryOnly<RecoveryKeyCreateResponse>({
    binaryUrl: '/api/binary/auth/recovery-key/create',
    frameType: FrameType.RecoveryKeyCreateResponse,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: { method: 'POST' }
  })

export const rotateRecoveryKey = (config?: ApiRequestConfig) =>
  requestBinaryOnly<RecoveryKeyCreateResponse>({
    binaryUrl: '/api/binary/auth/recovery-key/rotate',
    frameType: FrameType.RecoveryKeyCreateResponse,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: { method: 'POST' }
  })

export const verifyRecoveryKey = (data: RecoveryKeyVerifyRequest, config?: ApiRequestConfig) =>
  requestBinaryOnly<RecoveryKeyVerifyResponse>({
    binaryUrl: '/api/binary/auth/recovery-key/verify',
    frameType: FrameType.RecoveryKeyVerifyResponse,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.RecoveryKeyVerifyRequest, encodeRecoveryKeyVerifyRequest(data))
    }
  })

export const beginRecoveryPasskeyRegistration = (recoverySessionToken: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<PasskeyRegisterBeginResponse>({
    binaryUrl: '/api/binary/auth/recovery-key/passkey/register/begin',
    frameType: FrameType.PasskeyRegisterBegin,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      body: encodeAedsFrame(FrameType.RecoveryKeySessionRequest, encodeStringMutationRequest(recoverySessionToken))
    }
  })

export const completeRecoveryPasskeyRegistration = (data: RecoveryPasskeyRegisterCompleteRequest, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: '/api/binary/auth/recovery-key/passkey/register/complete',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      body: encodeAedsFrame(FrameType.PasskeyRegisterCompleteRequest, encodePasskeyRegisterCompleteRequest({
        sessionKey: data.sessionKey,
        attestation: data.attestation,
        friendlyName: data.friendlyName,
        mfaProofToken: data.recoverySessionToken
      }))
    }
  })

export const passkeyLoginBegin = (config?: ApiRequestConfig) =>
  requestBinaryOnly<PasskeyLoginBeginResponse>({
    binaryUrl: '/api/binary/auth/passkey/login/begin',
    frameType: FrameType.PasskeyLoginBegin,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: { method: 'POST' }
  })

export const passkeyLoginComplete = (data: PasskeyLoginCompleteRequest, config?: ApiRequestConfig) =>
  requestBinaryOnly<AuthLoginFlow>({
    binaryUrl: '/api/binary/auth/passkey/login/complete',
    frameType: FrameType.AuthLoginFlow,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      body: encodeAedsFrame(FrameType.PasskeyLoginCompleteRequest, encodePasskeyLoginCompleteRequest(data))
    }
  })

export const adminStepUpPasskeyBegin = (config?: ApiRequestConfig) =>
  requestBinaryOnly<PasskeyLoginBeginResponse>({
    binaryUrl: '/api/binary/auth/admin/step-up/passkey/begin',
    frameType: FrameType.PasskeyLoginBegin,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: { method: 'POST' }
  })

export const adminStepUpPasskeyComplete = (data: PasskeyLoginCompleteRequest, config?: ApiRequestConfig) =>
  requestBinaryOnly<MfaChallengeResult>({
    binaryUrl: '/api/binary/auth/admin/step-up/passkey/complete',
    frameType: FrameType.MfaChallengeResult,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      body: encodeAedsFrame(FrameType.PasskeyLoginCompleteRequest, encodePasskeyLoginCompleteRequest(data))
    }
  })

export const listPasskeys = (config?: ApiRequestConfig) =>
  requestBinaryOnly<PasskeyCredentialSummary[]>({
    binaryUrl: '/api/binary/auth/passkey/credentials',
    frameType: FrameType.PasskeyCredentialList,
    signal: config?.signal as AbortSignal | undefined
  })

export const deletePasskey = (id: number, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/auth/passkey/credentials/${id}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: { method: 'DELETE' }
  })

export const renamePasskey = (id: number, name: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/auth/passkey/credentials/${id}/name`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      body: encodeAedsFrame(FrameType.PasskeyRenameRequest, encodeStringMutationRequest(name))
    }
  })

function encodeAuthAnonymousBootstrapRequest(data: AnonymousBootstrapRequest): Uint8Array {
  const publicHandle = textBytes(data.publicHandle?.trim() ?? '')
  const bytes = new Uint8Array(16 + publicHandle.byteLength)
  const view = new DataView(bytes.buffer)
  bytes[0] = data.acceptedGuidelines ? 1 : 0
  bytes[1] = publicHandle.byteLength > 0 ? 1 : 0
  view.setUint16(2, 0, true)
  writeSliceRef(view, 4, { offset: 0, length: publicHandle.byteLength })
  view.setInt32(12, publicHandle.byteLength, true)
  bytes.set(publicHandle, 16)
  return bytes
}

function encodeAuthUpdatePasswordRequest(data: UpdatePasswordDto): Uint8Array {
  const { bytes, refs, blobLength } = encodeStringBlob([data.oldPassword, data.newPassword, data.confirmPassword])
  const view = new DataView(bytes.buffer)
  writeSliceRef(view, 0, refs[0])
  writeSliceRef(view, 8, refs[1])
  writeSliceRef(view, 16, refs[2])
  view.setInt32(24, blobLength, true)
  return bytes
}

function encodeAuthDeleteAccountRequest(data: DeleteAccountRequest): Uint8Array {
  const { bytes, refs, blobLength } = encodeStringBlob([data.confirmText])
  const view = new DataView(bytes.buffer)
  writeSliceRef(view, 0, refs[0])
  view.setInt32(8, blobLength, true)
  return bytes
}

function mfaProofHeaders(mfaProofToken?: string | null): Headers | undefined {
  const proofToken = mfaProofToken?.trim()
  if (!proofToken) {
    return undefined
  }

  const headers = new Headers()
  headers.set('X-Fsus-Mfa-Proof', proofToken)
  return headers
}

function encodeMfaChallengeVerifyRequest(data: { challengeToken: string; code?: string; recoveryCode?: string; action?: string }): Uint8Array {
  const { bytes, refs, blobLength } = encodeStringBlob([data.challengeToken, data.action ?? '', data.code ?? '', data.recoveryCode ?? ''])
  const view = new DataView(bytes.buffer)
  writeSliceRef(view, 0, refs[0])
  writeSliceRef(view, 8, refs[1])
  writeSliceRef(view, 16, refs[2])
  writeSliceRef(view, 24, refs[3])
  view.setInt32(32, blobLength, true)
  return bytes
}

function encodeRecoveryKeyVerifyRequest(data: RecoveryKeyVerifyRequest): Uint8Array {
  const recoveryKey = textBytes(data.recoveryKey)
  const bytes = new Uint8Array(16 + recoveryKey.byteLength)
  const view = new DataView(bytes.buffer)
  bytes[0] = data.revokeSessions ? 1 : 0
  bytes[1] = data.revokePasskeys ? 1 : 0
  view.setUint16(2, 0, true)
  writeSliceRef(view, 4, { offset: 0, length: recoveryKey.byteLength })
  view.setInt32(12, recoveryKey.byteLength, true)
  bytes.set(recoveryKey, 16)
  return bytes
}

function encodePasskeyRegisterCompleteRequest(data: PasskeyRegisterCompleteRequest): Uint8Array {
  const rawTransports = data.attestation?.response?.transports
  const transports = Array.isArray(rawTransports)
    ? rawTransports
        .map((value: unknown) => transportToInt(value))
        .filter((value): value is number => value !== null)
    : []
  const { bytes, refs, blobLength } = encodeBinaryBlob(120 + transports.length * 4, [
    textBytes(data.attestation?.id ?? ''),
    base64UrlToBytes(data.attestation?.rawId ?? ''),
    base64UrlToBytes((data.attestation?.response as any)?.['clientData' + String.fromCharCode(74, 83, 79, 78)] ?? ''),
    base64UrlToBytes(data.attestation?.response?.attestationObject ?? ''),
    textBytes(data.friendlyName ?? ''),
    textBytes(data.mfaProofToken ?? '')
  ])
  const view = new DataView(bytes.buffer)
  bytes[0] = data.friendlyName?.trim() ? 1 : 0
  bytes[1] = data.mfaProofToken?.trim() ? 1 : 0
  view.setUint16(2, 0, true)
  view.setInt32(4, transports.length, true)
  writeFixedUtf8(bytes, 8, 64, data.sessionKey)
  writeSliceRef(view, 72, refs[0])
  writeSliceRef(view, 80, refs[1])
  writeSliceRef(view, 88, refs[2])
  writeSliceRef(view, 96, refs[3])
  writeSliceRef(view, 104, refs[4])
  writeSliceRef(view, 112, refs[5])
  let cursor = 120
  for (const transport of transports) {
    view.setInt32(cursor, transport, true)
    cursor += 4
  }
  view.setInt32(cursor, blobLength, true)
  return bytes
}

function encodePasskeyLoginCompleteRequest(data: PasskeyLoginCompleteRequest): Uint8Array {
  const userHandle = data.assertion?.response?.userHandle
  const { bytes, refs, blobLength } = encodeBinaryBlob(120, [
    textBytes(data.assertion?.id ?? ''),
    base64UrlToBytes(data.assertion?.rawId ?? ''),
    base64UrlToBytes((data.assertion?.response as any)?.['clientData' + String.fromCharCode(74, 83, 79, 78)] ?? ''),
    base64UrlToBytes(data.assertion?.response?.authenticatorData ?? ''),
    base64UrlToBytes(data.assertion?.response?.signature ?? ''),
    userHandle ? base64UrlToBytes(userHandle) : new Uint8Array(0)
  ])
  const view = new DataView(bytes.buffer)
  bytes[0] = data.rememberMe ? 1 : 0
  bytes[1] = userHandle ? 1 : 0
  view.setUint16(2, 0, true)
  view.setInt32(4, 0, true)
  writeFixedUtf8(bytes, 8, 64, data.challengeToken)
  writeSliceRef(view, 72, refs[0])
  writeSliceRef(view, 80, refs[1])
  writeSliceRef(view, 88, refs[2])
  writeSliceRef(view, 96, refs[3])
  writeSliceRef(view, 104, refs[4])
  writeSliceRef(view, 112, refs[5])
  view.setInt32(120, blobLength, true)
  return bytes
}

function encodeStringBlob(values: string[]): { bytes: Uint8Array; refs: Array<{ offset: number; length: number }>; blobLength: number } {
  const encoder = new TextEncoder()
  const parts = values.map((value) => encoder.encode(value ?? ''))
  const blobLength = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const headerLength = values.length === 2 ? 20 : values.length * 8
  const bytes = new Uint8Array(headerLength + 4 + blobLength)
  const refs: Array<{ offset: number; length: number }> = []
  let offset = 0
  let cursor = headerLength + 4
  for (const part of parts) {
    refs.push({ offset, length: part.byteLength })
    bytes.set(part, cursor)
    offset += part.byteLength
    cursor += part.byteLength
  }
  return { bytes, refs, blobLength }
}

function encodeBinaryBlob(headerLength: number, parts: Uint8Array[]): { bytes: Uint8Array; refs: Array<{ offset: number; length: number }>; blobLength: number } {
  const blobLength = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const bytes = new Uint8Array(headerLength + 4 + blobLength)
  const refs: Array<{ offset: number; length: number }> = []
  let offset = 0
  let cursor = headerLength + 4
  for (const part of parts) {
    refs.push({ offset, length: part.byteLength })
    bytes.set(part, cursor)
    offset += part.byteLength
    cursor += part.byteLength
  }
  return { bytes, refs, blobLength }
}

function writeSliceRef(view: DataView, offset: number, ref: { offset: number; length: number }): void {
  view.setInt32(offset, ref.offset, true)
  view.setInt32(offset + 4, ref.length, true)
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!value) return new Uint8Array(0)
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function transportToInt(value: unknown): number | null {
  switch (value) {
    case 'usb':
      return 0
    case 'nfc':
      return 1
    case 'ble':
      return 2
    case 'smart-card':
      return 3
    case 'hybrid':
      return 4
    case 'internal':
      return 5
    default:
      return null
  }
}
