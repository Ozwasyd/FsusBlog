import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { adminChangeStatus, getAdminUserList } from '@/api/admin'

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
      binaryRoute: { operationId: 'binary_get_admin_users', query: expect.any(URLSearchParams) },
      frameType: FrameType.AdminUserList
    }))
    expect(routeUrl(mockBinary.mock.calls[0][0])).toBe('/api/binary/admin/users?page=2&pageSize=20&keyword=alice&status=1')
  })

  it('adminChangeStatus sends binary status request for accountId with admin step-up proof', async () => {
    await adminChangeStatus({ accountId: 10, status: 1, reason: 'spam' }, { mfaProofToken: 'proof-status' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_put_admin_users_status' },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        headers: expect.any(Headers),
        body: expect.any(ArrayBuffer)
      })
    }))
    const call = mockBinary.mock.calls[0]?.[0]
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-status')
    const frame = call?.requestOptions?.body as ArrayBuffer
    const payload = new DataView(frame, 16)
    expect(payload.getInt32(0, true)).toBe(10)
    expect(payload.getInt32(4, true)).toBe(1)
  })
})

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
