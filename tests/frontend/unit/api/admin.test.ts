import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import { adminChangeStatus, adminResetPassword, getAdminUserList } from '@/api/admin'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('admin API binary mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue(null as never)
  })

  it('getAdminUserList sends binary list request with query params', async () => {
    mockBinary.mockResolvedValue({ total: 0, items: [] } as never)

    await getAdminUserList({ page: 2, pageSize: 20, keyword: 'alice', status: 1 })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/users?page=2&pageSize=20&keyword=alice&status=1',
      frameType: FrameType.AdminUserList
    }))
  })

  it('adminChangeStatus sends binary status request with MFA proof', async () => {
    await adminChangeStatus({ userId: 10, status: 1, reason: 'spam' }, { mfaProofToken: 'proof-status' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/users/status',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        headers: expect.any(Headers),
        body: expect.any(ArrayBuffer)
      })
    }))
    const call = mockBinary.mock.calls[0]?.[0]
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-status')
  })

  it('adminResetPassword sends binary password reset request with MFA proof', async () => {
    await adminResetPassword({ userId: 10, newPassword: 'P@ssw0rd!' }, { mfaProofToken: 'proof-reset' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/users/reset-pwd',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        headers: expect.any(Headers),
        body: expect.any(ArrayBuffer)
      })
    }))
    const call = mockBinary.mock.calls[0]?.[0]
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-reset')
  })
})
