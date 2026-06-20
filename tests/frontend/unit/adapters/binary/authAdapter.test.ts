import { describe, expect, it } from 'vitest'
import { mapAuthLoginFlowFromPayload, mapCurrentUserSnapshotFromPayload, mapIdentityAccountSnapshotFromPayload, mapMfaChallengeResultFromPayload, mapMfaProfileFromPayload, mapMfaSetupStartFromPayload, mapMfaSetupVerifyFromPayload, mapUserSessionsFromPayload } from '@/adapters/binary/authAdapter'

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

function writeInt32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setInt32(offset, value, true)
}

function writeInt64(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setBigInt64(offset, BigInt(value), true)
}

function buildIdentityAccountSnapshotPayload(): Uint8Array {
  const publicHandle = encoder.encode('Public Alice')
  const credentialStatus = encoder.encode('active')
  const credentialLevel = encoder.encode('strong_anonymous')
  const identityKind = encoder.encode('anonymous_account')
  const banReason = encoder.encode('limited')
  const blob = new Uint8Array(publicHandle.byteLength + credentialStatus.byteLength + credentialLevel.byteLength + identityKind.byteLength + banReason.byteLength)
  let blobOffset = 0
  blob.set(publicHandle, blobOffset)
  blobOffset += publicHandle.byteLength
  blob.set(credentialStatus, blobOffset)
  blobOffset += credentialStatus.byteLength
  blob.set(credentialLevel, blobOffset)
  blobOffset += credentialLevel.byteLength
  blob.set(identityKind, blobOffset)
  blobOffset += identityKind.byteLength
  blob.set(banReason, blobOffset)

  const pod = new Uint8Array(72)
  writeInt32(pod, 0, 42)
  writeInt32(pod, 4, 7)
  writeInt32(pod, 8, 1)
  writeInt64(pod, 12, Date.parse('2026-01-02T03:04:05.000Z'))
  pod[20] = 1
  pod[21] = 1
  pod[22] = 1
  pod[23] = 1
  pod[24] = 1
  pod[25] = 1
  pod[26] = 1
  pod[27] = 1
  let sliceOffset = 0
  writeSliceRef(pod, 32, sliceOffset, 'Public Alice')
  sliceOffset += publicHandle.byteLength
  writeSliceRef(pod, 40, sliceOffset, 'active')
  sliceOffset += credentialStatus.byteLength
  writeSliceRef(pod, 48, sliceOffset, 'strong_anonymous')
  sliceOffset += credentialLevel.byteLength
  writeSliceRef(pod, 56, sliceOffset, 'anonymous_account')
  sliceOffset += identityKind.byteLength
  writeSliceRef(pod, 64, sliceOffset, 'limited')

  const payload = new Uint8Array(pod.byteLength + 4 + blob.byteLength)
  payload.set(pod, 0)
  writeInt32(payload, pod.byteLength, blob.byteLength)
  payload.set(blob, pod.byteLength + 4)
  return payload
}

describe('binary auth adapter', () => {
  it('maps auth login flow payload', () => {
    const payload = new Uint8Array(168)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 7, true)
    payload[4] = 2
    payload[5] = 1
    payload[6] = 1
    payload[7] = 1
    writeFixed(payload, 8, 64, 'anonymous_account')
    writeFixed(payload, 104, 64, 'ticket-1')

    expect(mapAuthLoginFlowFromPayload(payload)).toEqual({
      accountId: 7,
      identityKind: 'anonymous_account',
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
    payload[17] = 1
    writeFixed(payload, 20, 64, 'anonymous_account')
    writeFixed(payload, 116, 256, 'banned')

    expect(mapCurrentUserSnapshotFromPayload(payload)).toEqual({
      accountId: 7,
      identityKind: 'anonymous_account',
      status: 1,
      banReason: 'banned',
      deletedAt: '2026-01-02T03:04:05.000Z'
    })
  })

  it('maps anonymous identity account snapshot payload without legacy username or role', () => {
    expect(mapIdentityAccountSnapshotFromPayload(buildIdentityAccountSnapshotPayload())).toEqual({
      id: 42,
      accountId: 42,
      internalUserId: 7,
      identityKind: 'anonymous_account',
      publicHandle: 'Public Alice',
      passkeyEnabled: true,
      recoveryEnabled: true,
      totpStepUpEnabled: true,
      anonymousCredentialStatus: 'active',
      anonymousCredentialLevel: 'strong_anonymous',
      status: 1,
      banReason: 'limited',
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
    payload[7] = 1
    writeFixed(payload, 8, 64, 'anonymous_account')
    writeFixed(payload, 104, 64, 'login')
    writeFixed(payload, 168, 128, 'proof-1')

    expect(mapMfaChallengeResultFromPayload(payload)).toEqual({
      verified: true,
      action: 'login',
      proofToken: 'proof-1',
      user: { accountId: 7, identityKind: 'anonymous_account' }
    })
  })
})
