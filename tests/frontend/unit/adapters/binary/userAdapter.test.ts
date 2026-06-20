import { describe, expect, it } from 'vitest'
import { mapAdminUserPageFromPayload } from '@/adapters/binary/userAdapter'

const encoder = new TextEncoder()

function writeFixed(bytes: Uint8Array, offset: number, length: number, value: string): void {
  bytes.set(encoder.encode(value).subarray(0, length), offset)
}

describe('binary user adapter', () => {
  it('maps admin anonymous account list payload', () => {
    const payload = new Uint8Array(8 + 208)
    const view = new DataView(payload.buffer)
    const createTime = Date.parse('2026-01-02T03:04:05.000Z')
    const privacyInitializedAt = Date.parse('2026-01-03T03:04:05.000Z')
    const deletedAt = Date.parse('2026-01-04T03:04:05.000Z')

    view.setInt32(0, 9, true)
    view.setInt32(4, 1, true)
    view.setInt32(8, 42, true)
    view.setInt32(12, 1, true)
    view.setInt32(16, 7, true)
    view.setInt32(20, 0, true)
    view.setBigInt64(24, BigInt(createTime), true)
    view.setBigInt64(32, BigInt(privacyInitializedAt), true)
    view.setBigInt64(40, BigInt(deletedAt), true)
    writeFixed(payload, 48, 32, 'anonymous_account')
    writeFixed(payload, 80, 64, 'alice-public')
    writeFixed(payload, 144, 32, 'active')
    writeFixed(payload, 176, 32, 'basic')
    payload[208] = 1
    payload[209] = 1
    payload[210] = 1
    payload[211] = 1
    payload[212] = 1

    expect(mapAdminUserPageFromPayload(payload)).toEqual({
      total: 9,
      items: [{
        accountId: 42,
        status: 1,
        riskFlags: 7,
        createTime: '2026-01-02T03:04:05.000Z',
        privacyInitializedAt: '2026-01-03T03:04:05.000Z',
        identityKind: 'anonymous_account',
        publicHandle: 'alice-public',
        anonymousCredentialStatus: 'active',
        anonymousCredentialLevel: 'basic',
        passkeyInitialized: true,
        recoveryInitialized: true,
        deletedAt: '2026-01-04T03:04:05.000Z'
      }]
    })
  })
})
