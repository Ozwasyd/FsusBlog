import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/api/index', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import { beginRecoveryPasskeyRegistration, completeRecoveryPasskeyRegistration, createRecoveryKey, deleteAccount, deletePasskey, disableMfa, getMe, getMfaProfile, getPowChallenge, listPasskeys, listSessions, login, logout, passkeyLoginBegin, passkeyLoginComplete, passkeyRegisterBegin, passkeyRegisterComplete, refreshToken, regenerateMfaRecoveryCodes, register, renamePasskey, revokeOtherSessions, revokeSession, rotateRecoveryKey, startMfaChallenge, startMfaSetup, updatePassword, updateUsername, verifyMfaChallenge, verifyMfaSetup, verifyRecoveryKey } from '@/api/auth'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('auth API binary base session flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue(null as never)
  })

  it('login sends binary auth login request', async () => {
    await login({ username: 'alice', password: 'pw', rememberMe: true })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/login',
      frameType: FrameType.AuthLoginFlow,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('register sends binary auth register request', async () => {
    await register({ username: 'alice', password: 'pw', confirmPassword: 'pw' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/register',
      frameType: FrameType.AuthLoginFlow,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('getMe uses binary current user frame', async () => {
    await getMe()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/me',
      frameType: FrameType.CurrentUserSnapshot
    }))
  })

  it('refreshToken uses binary empty success frame', async () => {
    await refreshToken()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/refresh-token',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ method: 'POST' })
    }))
  })

  it('updateUsername sends binary username request', async () => {
    await updateUsername({ newUsername: 'newname' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/update-username',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'PUT',
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('updatePassword sends binary password request with PoW', async () => {
    await updatePassword({ oldPassword: 'old', newPassword: 'newpass', confirmPassword: 'newpass' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/update-password',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('deleteAccount sends binary delete request with PoW', async () => {
    await deleteAccount({ password: 'pw', confirmText: 'DELETE' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/delete-account',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('listSessions uses binary session list frame', async () => {
    await listSessions()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/sessions',
      frameType: FrameType.AuthSessionList
    }))
  })

  it('revokeSession uses binary empty success frame', async () => {
    await revokeSession('session/id')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/sessions/session%2Fid/revoke',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ method: 'POST' })
    }))
  })

  it('revokeOtherSessions uses binary empty success frame', async () => {
    await revokeOtherSessions()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/sessions/revoke-others',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ method: 'POST' })
    }))
  })

  it('getPowChallenge uses binary pow frame', async () => {
    await getPowChallenge()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/pow-challenge',
      frameType: FrameType.PowChallenge
    }))
  })

  it('MFA methods use binary frames', async () => {
    await startMfaSetup()
    await getMfaProfile()
    await verifyMfaSetup('123456')
    await disableMfa({ password: 'pw', code: '123456' })
    await regenerateMfaRecoveryCodes({ password: 'pw', recoveryCode: 'backup' })
    await startMfaChallenge('update-password')
    await verifyMfaChallenge({ challengeToken: 'ticket', code: '123456', action: 'login' })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/mfa/setup/start', frameType: FrameType.MfaSetupStart }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/mfa/profile', frameType: FrameType.MfaProfile }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/mfa/setup/verify', frameType: FrameType.MfaSetupVerify }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/mfa/disable', frameType: FrameType.EmptySuccess }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/mfa/recovery/regenerate', frameType: FrameType.MfaSetupVerify }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/mfa/challenge/start', frameType: FrameType.MfaChallengeResult }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/mfa/challenge', frameType: FrameType.MfaChallengeResult }))
  })

  it('logout uses binary empty success frame', async () => {
    await logout()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/logout',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ method: 'POST' })
    }))
  })

  it('Passkey methods use binary frames', async () => {
    await passkeyRegisterBegin()
    await passkeyRegisterComplete({
      sessionKey: 'session-1',
      friendlyName: 'Laptop',
      attestation: {
        id: 'credential-id',
        rawId: 'AQID',
        response: {
          clientDataBytes: 'BAUG',
          attestationObject: 'BwgJ',
          transports: ['internal']
        }
      }
    })
    await passkeyLoginBegin()
    await passkeyLoginComplete({
      challengeToken: 'challenge-1',
      rememberMe: true,
      assertion: {
        id: 'credential-id',
        rawId: 'AQID',
        response: {
          clientDataBytes: 'BAUG',
          authenticatorData: 'BwgJ',
          signature: 'CgsM',
          userHandle: 'DQ4P'
        }
      }
    })
    await listPasskeys()
    await deletePasskey(7)
    await renamePasskey(7, 'Phone')

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/passkey/register/begin', frameType: FrameType.PasskeyRegisterBegin }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/passkey/register/complete',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ method: 'POST', body: expect.any(ArrayBuffer) })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/passkey/login/begin', frameType: FrameType.PasskeyLoginBegin }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/passkey/login/complete',
      frameType: FrameType.AuthLoginFlow,
      requestOptions: expect.objectContaining({ method: 'POST', body: expect.any(ArrayBuffer) })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/passkey/credentials', frameType: FrameType.PasskeyCredentialList }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({ binaryUrl: '/api/binary/auth/passkey/credentials/7', frameType: FrameType.EmptySuccess, requestOptions: expect.objectContaining({ method: 'DELETE' }) }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/passkey/credentials/7/name',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ method: 'PUT', body: expect.any(ArrayBuffer) })
    }))
  })

  it('Recovery Key methods use binary identity frames', async () => {
    await createRecoveryKey()
    await rotateRecoveryKey()
    await verifyRecoveryKey({
      userId: 42,
      recoveryKey: 'frk_account_recovery_key',
      revokeSessions: true,
      revokePasskeys: true
    })
    await beginRecoveryPasskeyRegistration('recovery-session-token')
    await completeRecoveryPasskeyRegistration({
      recoverySessionToken: 'recovery-session-token',
      sessionKey: 'session-1',
      friendlyName: 'Recovered laptop',
      attestation: {
        id: 'credential-id',
        rawId: 'AQID',
        response: {
          clientDataBytes: 'BAUG',
          attestationObject: 'BwgJ',
          transports: ['internal']
        }
      }
    })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/recovery-key/create',
      frameType: FrameType.RecoveryKeyCreateResponse,
      requestOptions: expect.objectContaining({ method: 'POST' })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/recovery-key/rotate',
      frameType: FrameType.RecoveryKeyCreateResponse,
      requestOptions: expect.objectContaining({ method: 'POST' })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/recovery-key/verify',
      frameType: FrameType.RecoveryKeyVerifyResponse,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/recovery-key/passkey/register/begin',
      frameType: FrameType.PasskeyRegisterBegin,
      requestOptions: expect.objectContaining({
        method: 'POST',
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/recovery-key/passkey/register/complete',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        body: expect.any(ArrayBuffer)
      })
    }))
  })
})
