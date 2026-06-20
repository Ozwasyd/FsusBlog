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
import { beginRecoveryPasskeyRegistration, bootstrapAnonymousAccount, completeRecoveryPasskeyRegistration, createRecoveryKey, deleteAccount, deletePasskey, disableMfa, getMe, getMfaProfile, getPowChallenge, listPasskeys, listSessions, logout, passkeyLoginBegin, passkeyLoginComplete, passkeyRegisterBegin, passkeyRegisterComplete, refreshToken, regenerateMfaRecoveryCodes, renamePasskey, revokeOtherSessions, revokeSession, rotateRecoveryKey, startMfaChallenge, startMfaSetup, updatePassword, updatePublicHandle, updateUsername, verifyMfaChallenge, verifyMfaSetup, verifyRecoveryKey } from '@/api/auth'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('auth API binary base session flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue(null as never)
  })

  it('anonymous bootstrap sends the passkey-first account bootstrap request', async () => {
    await bootstrapAnonymousAccount({ publicHandle: 'alice', acceptedGuidelines: true })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/anonymous/bootstrap',
      frameType: FrameType.AuthLoginFlow,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('getMe uses binary anonymous identity account frame', async () => {
    await getMe()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/me',
      frameType: FrameType.IdentityAccountSnapshot
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

  it('updatePublicHandle sends a dedicated binary public handle request', async () => {
    await updatePublicHandle({ publicHandle: 'QuietReader' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/public-handle',
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

  it('deleteAccount sends anonymous delete request with step-up proof and no password payload', async () => {
    await deleteAccount({ confirmText: 'DELETE', mfaProofToken: 'proof-delete' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/auth/delete-account',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        headers: expect.any(Headers),
        body: expect.any(ArrayBuffer)
      })
    }))
    const call = mockBinary.mock.calls.at(-1)?.[0]
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-delete')
    const bytes = new Uint8Array(call?.requestOptions?.body as ArrayBuffer)
    expect(new TextDecoder().decode(bytes)).toContain('DELETE')
    expect(new TextDecoder().decode(bytes)).not.toContain('pw')
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
    await disableMfa({ mfaProofToken: 'proof-disable' })
    await regenerateMfaRecoveryCodes({ mfaProofToken: 'proof-regenerate' })
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

  it('anonymous MFA mutations use step-up proof headers without password payloads', async () => {
    await startMfaSetup({ mfaProofToken: 'proof-setup' })
    await disableMfa({ mfaProofToken: 'proof-disable' })
    await regenerateMfaRecoveryCodes({ mfaProofToken: 'proof-regenerate' })

    const setup = mockBinary.mock.calls.find(([call]) => call.binaryUrl === '/api/binary/auth/mfa/setup/start')?.[0]
    const disable = mockBinary.mock.calls.find(([call]) => call.binaryUrl === '/api/binary/auth/mfa/disable')?.[0]
    const regenerate = mockBinary.mock.calls.find(([call]) => call.binaryUrl === '/api/binary/auth/mfa/recovery/regenerate')?.[0]

    for (const call of [setup, disable, regenerate]) {
      expect(call?.requestOptions).toEqual(expect.objectContaining({ method: 'POST' }))
      expect(call?.requestOptions).not.toHaveProperty('body')
      expect(call?.requestOptions?.headers).toBeInstanceOf(Headers)
      expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toMatch(/^proof-/)
    }
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

  it('Passkey credential mutations send step-up proof headers without legacy proof bodies', async () => {
    await deletePasskey(7, { mfaProofToken: 'proof-delete-passkey' })
    await renamePasskey(7, 'Phone', { mfaProofToken: 'proof-rename-passkey' })

    const remove = mockBinary.mock.calls.find(([request]) =>
      request.binaryUrl === '/api/binary/auth/passkey/credentials/7'
    )?.[0]
    const rename = mockBinary.mock.calls.find(([request]) =>
      request.binaryUrl === '/api/binary/auth/passkey/credentials/7/name'
    )?.[0]

    expect(remove?.requestOptions).toEqual(expect.objectContaining({
      method: 'DELETE',
      headers: expect.any(Headers)
    }))
    expect(remove?.requestOptions).not.toHaveProperty('body')
    expect((remove?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-delete-passkey')

    expect(rename?.requestOptions).toEqual(expect.objectContaining({
      method: 'PUT',
      headers: expect.any(Headers),
      body: expect.any(ArrayBuffer)
    }))
    expect((rename?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-rename-passkey')
  })

  it('Recovery Key methods use binary identity frames', async () => {
    const recoveryKey = 'frk_lookupid_secret'
    await createRecoveryKey()
    await rotateRecoveryKey()
    await verifyRecoveryKey({
      recoveryKey,
      revokeSessions: true,
      revokePasskeys: true
    } as Parameters<typeof verifyRecoveryKey>[0])
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
    const verifyCall = mockBinary.mock.calls.find(([request]) =>
      request.binaryUrl === '/api/binary/auth/recovery-key/verify'
    )?.[0]
    expect(verifyCall).toBeTruthy()
    const body = new Uint8Array(verifyCall?.requestOptions?.body as ArrayBuffer)
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    const recoveryKeyLength = new TextEncoder().encode(recoveryKey).byteLength
    const payloadOffset = 16
    expect(body.byteLength).toBe(payloadOffset + 16 + recoveryKeyLength)
    expect(body[payloadOffset]).toBe(1)
    expect(body[payloadOffset + 1]).toBe(1)
    expect(view.getUint16(payloadOffset + 2, true)).toBe(0)
    expect(view.getInt32(payloadOffset + 4, true)).toBe(0)
    expect(view.getInt32(payloadOffset + 8, true)).toBe(recoveryKeyLength)
    expect(view.getInt32(payloadOffset + 12, true)).toBe(recoveryKeyLength)
    expect(new TextDecoder().decode(body.subarray(payloadOffset + 16))).toBe(recoveryKey)
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

  it('Recovery Key create and rotate send step-up proof headers without legacy proof bodies', async () => {
    await createRecoveryKey({ mfaProofToken: 'proof-create-recovery-key' })
    await rotateRecoveryKey({ mfaProofToken: 'proof-rotate-recovery-key' })

    const create = mockBinary.mock.calls.find(([request]) =>
      request.binaryUrl === '/api/binary/auth/recovery-key/create'
    )?.[0]
    const rotate = mockBinary.mock.calls.find(([request]) =>
      request.binaryUrl === '/api/binary/auth/recovery-key/rotate'
    )?.[0]

    for (const [call, proof] of [
      [create, 'proof-create-recovery-key'],
      [rotate, 'proof-rotate-recovery-key']
    ] as const) {
      expect(call?.requestOptions).toEqual(expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers)
      }))
      expect(call?.requestOptions).not.toHaveProperty('body')
      expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe(proof)
    }
  })
})
