import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import { adminChangeStatus, getAdminUserList } from '@/api/admin'

const mockBinary = vi.mocked(requestBinaryOnly)
const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

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

  it('adminChangeStatus sends binary status request for accountId with admin step-up proof', async () => {
    await adminChangeStatus({ accountId: 10, status: 1, reason: 'spam' }, { mfaProofToken: 'proof-status' })
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

  it('keeps admin status DTO and callers on accountId naming', () => {
    const adminApi = readRepoFile('src/frontend/src/api/admin.ts')
    const adminUserManage = readRepoFile('src/frontend/src/composables/useAdminUserManage.ts')

    expect(adminApi).toContain('export interface AdminChangeStatusDto extends PowBaseDto {\n  accountId: number')
    expect(adminApi).toContain('view.setInt32(0, data.accountId, true)')
    expect(adminApi).not.toMatch(/AdminChangeStatusDto[\s\S]*?userId: number/)
    expect(adminApi).not.toContain('data.userId')
    expect(adminUserManage).toContain('adminChangeStatus({ accountId: row.accountId, status: 0 }')
    expect(adminUserManage).toContain('accountId: targetUser.accountId')
    expect(adminUserManage).not.toContain('userId: row.accountId')
    expect(adminUserManage).not.toContain('userId: targetUser.accountId')
  })

  it('does not export or encode legacy admin password reset', () => {
    const adminApi = readRepoFile('src/frontend/src/api/admin.ts')

    expect(adminApi).not.toContain('adminResetPassword')
    expect(adminApi).not.toContain('AdminResetPwdDto')
    expect(adminApi).not.toContain('AdminResetUserPasswordRequest')
    expect(adminApi).not.toContain('/api/binary/admin/users/reset-pwd')
    expect(adminApi).not.toContain('encodeAdminResetPasswordRequest')
  })
})
