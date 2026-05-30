import { describe, expect, it } from 'vitest'
import { mapAdminUserPageFromPayload } from '@/adapters/binary/userAdapter'

const encoder = new TextEncoder()

function writeFixed(bytes: Uint8Array, offset: number, length: number, value: string): void {
  bytes.set(encoder.encode(value).subarray(0, length), offset)
}

describe('binary user adapter', () => {
  it('maps admin user list payload', () => {
    const payload = new Uint8Array(8 + 200)
    const view = new DataView(payload.buffer)
    const createTime = Date.parse('2026-01-02T03:04:05.000Z')
    const lastLoginTime = Date.parse('2026-01-03T03:04:05.000Z')
    const deletedAt = Date.parse('2026-01-04T03:04:05.000Z')

    view.setInt32(0, 9, true)
    view.setInt32(4, 1, true)
    view.setInt32(8, 42, true)
    view.setInt32(12, 1, true)
    view.setBigInt64(16, BigInt(createTime), true)
    view.setBigInt64(24, BigInt(lastLoginTime), true)
    writeFixed(payload, 32, 64, 'alice')
    writeFixed(payload, 96, 32, 'admin')
    writeFixed(payload, 128, 64, '127.0.0.1')
    payload[192] = 1
    payload[193] = 1
    view.setBigInt64(196, BigInt(deletedAt), true)
    payload[204] = 1

    expect(mapAdminUserPageFromPayload(payload)).toEqual({
      total: 9,
      items: [{
        id: 42,
        status: 1,
        createTime: '2026-01-02T03:04:05.000Z',
        lastLoginTime: '2026-01-03T03:04:05.000Z',
        username: 'alice',
        role: 'admin',
        lastLoginIp: '127.0.0.1',
        deletedAt: '2026-01-04T03:04:05.000Z'
      }]
    })
  })
})
