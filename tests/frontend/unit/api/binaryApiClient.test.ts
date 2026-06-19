import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { binaryRequest } from '@/api/binaryApiClient'

describe('binaryApiClient credentials handling', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0)
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('strips auth-bearing headers when credentials are omitted', async () => {
    await binaryRequest('/api/binary/comment/anonymous', {
      method: 'POST',
      credentials: 'omit',
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'sid=secret',
        'X-Test': 'kept'
      },
      body: new Uint8Array([1, 2, 3])
    })

    const fetchMock = vi.mocked(fetch)
    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Headers
    expect(init?.credentials).toBe('omit')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-test')).toBe('kept')
  })
})
