import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
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

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { adminStepUpPasskeyBegin, beginRecoveryPasskeyRegistration, bootstrapAnonymousAccount, cancelEnrollment, completeRecoveryPasskeyRegistration, createRecoveryKey, deleteAccount, deletePasskey, disableMfa, enrollmentPasskeyRegisterBegin, enrollmentPasskeyRegisterComplete, getEnrollmentStatus, getMe, getMfaProfile, getPasskeySignalState, getPowChallenge, listPasskeys, listSessions, logout, logoutAdmin, passkeyLoginBegin, passkeyLoginComplete, passkeyRegisterBegin, passkeyRegisterComplete, refreshToken, regenerateMfaRecoveryCodes, renamePasskey, revokeOtherSessions, revokeSession, rotateRecoveryKey, startMfaChallenge, startMfaSetup, updatePublicHandle, userStepUpPasskeyBegin, userStepUpPasskeyComplete, verifyMfaChallenge, verifyMfaSetup, verifyRecoveryKey } from '@/api/auth'

const mockBinary = vi.mocked(requestBinaryOnly)

const expectBinaryRoute = (operationId: string, frameType: FrameType, requestOptions?: unknown) => {
  expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
    binaryRoute: { operationId },
    frameType,
    ...(requestOptions ? { requestOptions } : {})
  }))
}

const findBinaryRouteCall = (operationId: string) =>
  mockBinary.mock.calls.find(([request]) => request.binaryRoute?.operationId === operationId)?.[0]

describe('auth API binary base session flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue(null as never)
  })

  it('anonymous bootstrap sends the passkey-first account bootstrap request', async () => {
    await bootstrapAnonymousAccount({ publicHandle: 'alice', acceptedGuidelines: true })
    expectBinaryRoute('binary_post_auth_anonymous_bootstrap', FrameType.AuthLoginFlow, expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
  })

  it('uses isolated enrollment routes for the first passkey lifecycle', async () => {
    await enrollmentPasskeyRegisterBegin()
    expectBinaryRoute('binary_post_auth_enrollment_passkey_register_begin', FrameType.PasskeyRegisterBegin)

    await enrollmentPasskeyRegisterComplete({
      sessionKey: 'challenge',
      id: 'credential',
      rawId: new Uint8Array([1]),
      clientDataBytes: new Uint8Array([2]),
      attestationObject: new Uint8Array([3]),
      transports: []
    })
    expectBinaryRoute('binary_post_auth_enrollment_passkey_register_complete', FrameType.AuthLoginFlow)

    await getEnrollmentStatus()
    expectBinaryRoute('binary_get_auth_enrollment_status', FrameType.AuthLoginFlow)

    await cancelEnrollment()
    expectBinaryRoute('binary_post_auth_enrollment_cancel', FrameType.EmptySuccess)
  })

  it('getMe uses binary anonymous identity account frame', async () => {
    mockBinary.mockImplementationOnce(async (request) => {
      request.requestOptions?.onResponseHeaders?.(new Headers({
        'X-Fsus-Access-Expires-At-Utc': '2026-07-19T00:15:00.000Z'
      }))
      return { accountId: 7 } as never
    })
    await getMe()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_auth_me' },
      frameType: FrameType.IdentityAccountSnapshot,
      suppressAuthFailureTelemetry: true
    }))
  })

  it('getMe rejects a snapshot without server access expiry metadata', async () => {
    mockBinary.mockResolvedValueOnce({ accountId: 7 } as never)

    await expect(getMe()).rejects.toThrow('auth_access_expiry_missing')
    expect(mockBinary).toHaveBeenCalledTimes(1)
  })

  it('getMe rejects malformed server access expiry metadata', async () => {
    mockBinary.mockImplementationOnce(async (request) => {
      request.requestOptions?.onResponseHeaders?.(new Headers({
        'X-Fsus-Access-Expires-At-Utc': 'not-a-date'
      }))
      return { accountId: 7 } as never
    })

    await expect(getMe()).rejects.toThrow('auth_access_expiry_missing')
  })

  it('refreshToken uses binary empty success frame', async () => {
    await refreshToken()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_auth_refresh_token' },
      frameType: FrameType.EmptySuccess,
      suppressAuthFailureTelemetry: true,
      requestOptions: expect.objectContaining({ })
    }))
  })

  it('refreshToken does not replay an ambiguous network failure', async () => {
    mockBinary.mockRejectedValueOnce({ name: 'BinaryTransportError', kind: 'network', message: 'connection reset' })

    await expect(refreshToken()).rejects.toMatchObject({ kind: 'network' })

    expect(mockBinary).toHaveBeenCalledTimes(1)
  })

  it('refreshToken does not retry auth failures', async () => {
    mockBinary.mockRejectedValueOnce({
      name: 'BinaryTransportError',
      kind: 'auth_failed',
      message: 'refresh rejected',
      status: 401
    })

    await expect(refreshToken()).rejects.toMatchObject({ kind: 'auth_failed' })
    expect(mockBinary).toHaveBeenCalledTimes(1)
  })

  it('updatePublicHandle sends a dedicated binary public handle request', async () => {
    await updatePublicHandle({ publicHandle: 'QuietReader' })
    expectBinaryRoute('binary_put_auth_public_handle', FrameType.EmptySuccess, expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
  })

  it('deleteAccount sends anonymous delete request with step-up proof and no password payload', async () => {
    await deleteAccount({ confirmText: 'DELETE', mfaProofToken: 'proof-delete' })
    expectBinaryRoute('binary_post_auth_delete_account', FrameType.EmptySuccess, expect.objectContaining({
      headers: expect.any(Headers),
      body: expect.any(ArrayBuffer)
    }))
    const call = mockBinary.mock.calls.at(-1)?.[0]
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-delete')
    const bytes = new Uint8Array(call?.requestOptions?.body as ArrayBuffer)
    expect(new TextDecoder().decode(bytes)).toContain('DELETE')
    expect(new TextDecoder().decode(bytes)).not.toContain('pw')
  })

  it('listSessions uses binary session list frame', async () => {
    await listSessions()
    expectBinaryRoute('binary_get_auth_sessions', FrameType.AuthSessionList)
  })

  it('revokeSession uses binary empty success frame', async () => {
    await revokeSession('session/id')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_auth_sessions_id_revoke', params: { id: 'session/id' } },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ })
    }))
  })

  it('revokeOtherSessions uses binary empty success frame', async () => {
    await revokeOtherSessions()
    expectBinaryRoute('binary_post_auth_sessions_revoke_others', FrameType.EmptySuccess, expect.objectContaining({ }))
  })

  it('getPowChallenge uses binary pow frame', async () => {
    await getPowChallenge()
    expectBinaryRoute('binary_get_auth_pow_challenge', FrameType.PowChallenge)
  })

  it('admin passkey step-up begin suppresses expected auth failure telemetry', async () => {
    await adminStepUpPasskeyBegin()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_auth_admin_step_up_passkey_begin' },
      frameType: FrameType.PasskeyLoginBegin,
      suppressAuthFailureTelemetry: true,
      requestOptions: expect.objectContaining({ })
    }))
  })

  it('ordinary account passkey step-up returns an MFA proof for credential mutations', async () => {
    await userStepUpPasskeyBegin('account.delete')
    await userStepUpPasskeyComplete({
      challengeToken: 'challenge-1',
      rememberMe: false,
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

    expectBinaryRoute('binary_post_auth_step_up_passkey_begin', FrameType.PasskeyLoginBegin, expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
    expectBinaryRoute('binary_post_auth_step_up_passkey_complete', FrameType.MfaChallengeResult, expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
  })

  it('MFA methods use binary frames', async () => {
    await startMfaSetup()
    await getMfaProfile()
    await verifyMfaSetup('123456')
    await disableMfa({ mfaProofToken: 'proof-disable' })
    await regenerateMfaRecoveryCodes({ mfaProofToken: 'proof-regenerate' })
    await startMfaChallenge('recovery-key.rotate')
    await verifyMfaChallenge({ challengeToken: 'ticket', code: '123456', action: 'login' })

    expectBinaryRoute('binary_post_auth_mfa_setup_start', FrameType.MfaSetupStart)
    expectBinaryRoute('binary_get_auth_mfa_profile', FrameType.MfaProfile)
    expectBinaryRoute('binary_post_auth_mfa_setup_verify', FrameType.MfaSetupVerify)
    expectBinaryRoute('binary_post_auth_mfa_disable', FrameType.EmptySuccess)
    expectBinaryRoute('binary_post_auth_mfa_recovery_regenerate', FrameType.MfaSetupVerify)
    expectBinaryRoute('binary_post_auth_mfa_challenge_start', FrameType.MfaChallengeResult)
    expectBinaryRoute('binary_post_auth_mfa_challenge', FrameType.MfaChallengeResult)
  })

  it('anonymous MFA mutations use step-up proof headers without password payloads', async () => {
    await startMfaSetup({ mfaProofToken: 'proof-setup' })
    await disableMfa({ mfaProofToken: 'proof-disable' })
    await regenerateMfaRecoveryCodes({ mfaProofToken: 'proof-regenerate' })

    const setup = findBinaryRouteCall('binary_post_auth_mfa_setup_start')
    const disable = findBinaryRouteCall('binary_post_auth_mfa_disable')
    const regenerate = findBinaryRouteCall('binary_post_auth_mfa_recovery_regenerate')

    for (const call of [setup, disable, regenerate]) {
      expect(call?.requestOptions).toEqual(expect.objectContaining({ }))
      expect(call?.requestOptions).not.toHaveProperty('body')
      expect(call?.requestOptions?.headers).toBeInstanceOf(Headers)
      expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toMatch(/^proof-/)
    }
  })

  it('logout uses binary empty success frame', async () => {
    await logout()
    expectBinaryRoute('binary_post_auth_logout', FrameType.EmptySuccess, expect.objectContaining({ }))
  })

  it('admin logout uses the independent admin binary route', async () => {
    await logoutAdmin()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_auth_admin_logout' },
      frameType: FrameType.EmptySuccess,
      suppressAuthFailureTelemetry: true,
      requestOptions: expect.objectContaining({ })
    }))
  })

  it('admin logout retries one network failure for an idempotent revocation', async () => {
    mockBinary
      .mockRejectedValueOnce({ name: 'BinaryTransportError', kind: 'network', message: 'response lost' })
      .mockResolvedValueOnce(null as never)

    await logoutAdmin()

    expect(mockBinary).toHaveBeenCalledTimes(2)
    expect(mockBinary.mock.calls[0]?.[0]).toEqual(mockBinary.mock.calls[1]?.[0])
  })

  it('admin logout does not retry an explicit 401', async () => {
    mockBinary.mockRejectedValueOnce({
      name: 'BinaryTransportError',
      kind: 'auth_failed',
      message: 'admin session missing'
    })

    await expect(logoutAdmin()).rejects.toMatchObject({ kind: 'auth_failed' })
    expect(mockBinary).toHaveBeenCalledTimes(1)
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
    await getPasskeySignalState()
    await deletePasskey(7)
    await renamePasskey(7, 'Phone')

    expectBinaryRoute('binary_post_auth_passkey_register_begin', FrameType.PasskeyRegisterBegin, expect.objectContaining({ }))
    expectBinaryRoute('binary_post_auth_passkey_register_complete', FrameType.PasskeySignalState, expect.objectContaining({ body: expect.any(ArrayBuffer) }))
    expectBinaryRoute('binary_post_auth_passkey_login_begin', FrameType.PasskeyLoginBegin, expect.objectContaining({ }))
    expectBinaryRoute('binary_post_auth_passkey_login_complete', FrameType.AuthLoginFlow, expect.objectContaining({ body: expect.any(ArrayBuffer) }))
    expectBinaryRoute('binary_get_auth_passkey_credentials', FrameType.PasskeyCredentialList)
    expectBinaryRoute('binary_get_auth_passkey_signal_state', FrameType.PasskeySignalState)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_delete_auth_passkey_credentials_id_int', params: { id: 7 } },
      frameType: FrameType.PasskeySignalState,
      requestOptions: expect.objectContaining({ })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_put_auth_passkey_credentials_id_int_name', params: { id: 7 } },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({ body: expect.any(ArrayBuffer) })
    }))
  })

  it('Passkey credential mutations send step-up proof headers without legacy proof bodies', async () => {
    await deletePasskey(7, { mfaProofToken: 'proof-delete-passkey' })
    await renamePasskey(7, 'Phone', { mfaProofToken: 'proof-rename-passkey' })

    const remove = findBinaryRouteCall('binary_delete_auth_passkey_credentials_id_int')
    const rename = findBinaryRouteCall('binary_put_auth_passkey_credentials_id_int_name')

    expect(remove?.requestOptions).toEqual(expect.objectContaining({
      headers: expect.any(Headers)
    }))
    expect(remove?.requestOptions).not.toHaveProperty('body')
    expect((remove?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-delete-passkey')

    expect(rename?.requestOptions).toEqual(expect.objectContaining({
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

    expectBinaryRoute('binary_post_auth_recovery_key_create', FrameType.RecoveryKeyCreateResponse, expect.objectContaining({ }))
    expectBinaryRoute('binary_post_auth_recovery_key_rotate', FrameType.RecoveryKeyCreateResponse, expect.objectContaining({ }))
    expectBinaryRoute('binary_post_auth_recovery_key_verify', FrameType.RecoveryKeyVerifyResponse, expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
    const verifyCall = findBinaryRouteCall('binary_post_auth_recovery_key_verify')
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
    expectBinaryRoute('binary_post_auth_recovery_key_passkey_register_begin', FrameType.PasskeyRegisterBegin, expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
    expectBinaryRoute('binary_post_auth_recovery_key_passkey_register_complete', FrameType.EmptySuccess, expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
  })

  it('Recovery Key create and rotate send step-up proof headers without legacy proof bodies', async () => {
    await createRecoveryKey({ mfaProofToken: 'proof-create-recovery-key' })
    await rotateRecoveryKey({ mfaProofToken: 'proof-rotate-recovery-key' })

    const create = findBinaryRouteCall('binary_post_auth_recovery_key_create')
    const rotate = findBinaryRouteCall('binary_post_auth_recovery_key_rotate')

    for (const [call, proof] of [
      [create, 'proof-create-recovery-key'],
      [rotate, 'proof-rotate-recovery-key']
    ] as const) {
      expect(call?.requestOptions).toEqual(expect.objectContaining({
        headers: expect.any(Headers)
      }))
      expect(call?.requestOptions).not.toHaveProperty('body')
      expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe(proof)
    }
  })
})

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
