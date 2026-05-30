import { describe, expect, it } from 'vitest'
import { mapAuthLoginFlowFromPayload, mapCurrentUserSnapshotFromPayload, mapMfaChallengeResultFromPayload, mapMfaProfileFromPayload, mapMfaSetupStartFromPayload, mapMfaSetupVerifyFromPayload, mapUserSessionsFromPayload } from '@/adapters/binary/authAdapter'

const encoder = new TextEncoder()

function writeFixed(bytes: Uint8Array, offset: number, length: number, value: string): void {
  bytes.set(encoder.encode(value).subarray(0, length), offset)
}

function writeSliceRef(bytes: Uint8Array, offset: number, sliceOffset: number, value: string): number {
  const encoded = encoder.encode(value)
  const view = new DataView(bytes.buffer)
  view.setInt32(offset, sliceOffset, true)
  view.setInt32(offset + 4, encoded.length, true)
  return sliceOffset + encoded.length
}

describe('binary auth adapter', () => {
  it('maps auth login flow payload', () => {
    const payload = new Uint8Array(168)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 7, true)
    payload[4] = 2
    payload[5] = 1
    payload[6] = 1
    writeFixed(payload, 8, 64, 'alice')
    writeFixed(payload, 72, 32, 'admin')
    writeFixed(payload, 104, 64, 'ticket-1')

    expect(mapAuthLoginFlowFromPayload(payload)).toEqual({
      user: { id: 7, username: 'alice', role: 'admin' },
      authPhase: 'mfa_required',
      mfaMode: 'risk',
      challengeToken: 'ticket-1'
    })
  })

  it('maps current user snapshot payload', () => {
    const payload = new Uint8Array(372)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 7, true)
    view.setInt32(4, 1, true)
    view.setBigInt64(8, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    payload[16] = 1
    writeFixed(payload, 20, 64, 'alice')
    writeFixed(payload, 84, 32, 'admin')
    writeFixed(payload, 116, 256, 'banned')

    expect(mapCurrentUserSnapshotFromPayload(payload)).toEqual({
      id: 7,
      username: 'alice',
      role: 'admin',
      status: 1,
      banReason: 'banned',
      deletedAt: '2026-01-02T03:04:05.000Z'
    })
  })

  it('maps user session list payload', () => {
    const payload = new Uint8Array(4 + 396)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 1, true)
    view.setBigInt64(4, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    payload[12] = 1
    payload[13] = 1
    payload[14] = 1
    writeFixed(payload, 16, 64, 'session-1')
    writeFixed(payload, 80, 128, 'fp-1')
    writeFixed(payload, 208, 64, '127.0.0.1')
    writeFixed(payload, 272, 128, 'Chrome on Linux')

    expect(mapUserSessionsFromPayload(payload)).toEqual([{
      sessionId: 'session-1',
      deviceFingerprint: 'fp-1',
      lastIp: '127.0.0.1',
      deviceLabel: 'Chrome on Linux',
      lastSeenAt: '2026-01-02T03:04:05.000Z',
      isCurrent: true,
      mfaVerified: true
    }])
  })

  it('maps MFA setup verify and profile payloads', () => {
    const verifyPayload = new Uint8Array(8 + 64)
    const verifyView = new DataView(verifyPayload.buffer)
    verifyPayload[0] = 1
    verifyView.setInt32(4, 1, true)
    writeFixed(verifyPayload, 8, 64, 'code-1')
    expect(mapMfaSetupVerifyFromPayload(verifyPayload)).toEqual({
      enabled: true,
      recoveryCodes: ['code-1']
    })

    const profilePayload = new Uint8Array(12)
    const profileView = new DataView(profilePayload.buffer)
    profileView.setBigInt64(0, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    profilePayload[8] = 1
    profilePayload[9] = 1
    expect(mapMfaProfileFromPayload(profilePayload)).toEqual({
      enabled: true,
      verifiedAt: '2026-01-02T03:04:05.000Z'
    })
  })

  it('maps MFA setup start payload and rejects trailing bytes', () => {
    const blob = 'secretotpauth://totp/Fsus%20Blog?secret=secretFsus Blogalice@example.com'
    const payload = new Uint8Array(40 + blob.length)
    payload[0] = 1

    let nextOffset = 0
    nextOffset = writeSliceRef(payload, 4, nextOffset, 'secret')
    nextOffset = writeSliceRef(payload, 12, nextOffset, 'otpauth://totp/Fsus%20Blog?secret=secret')
    nextOffset = writeSliceRef(payload, 20, nextOffset, 'Fsus Blog')
    writeSliceRef(payload, 28, nextOffset, 'alice@example.com')

    const view = new DataView(payload.buffer)
    view.setInt32(36, blob.length, true)
    payload.set(encoder.encode(blob), 40)

    expect(mapMfaSetupStartFromPayload(payload)).toEqual({
      enabled: true,
      secret: 'secret',
      otpAuthUrl: 'otpauth://totp/Fsus%20Blog?secret=secret',
      issuer: 'Fsus Blog',
      account: 'alice@example.com'
    })

    const trailingPayload = new Uint8Array(payload.length + 1)
    trailingPayload.set(payload, 0)
    trailingPayload[payload.length] = 1
    expect(() => mapMfaSetupStartFromPayload(trailingPayload)).toThrow()
  })

  it('maps MFA challenge result payload', () => {
    const payload = new Uint8Array(296)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 7, true)
    payload[4] = 1
    payload[5] = 1
    payload[6] = 1
    writeFixed(payload, 8, 64, 'alice')
    writeFixed(payload, 72, 32, 'admin')
    writeFixed(payload, 104, 64, 'login')
    writeFixed(payload, 168, 128, 'proof-1')

    expect(mapMfaChallengeResultFromPayload(payload)).toEqual({
      verified: true,
      action: 'login',
      proofToken: 'proof-1',
      user: { id: 7, username: 'alice', role: 'admin' }
    })
  })
})
