import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { binaryRequest } from '@/api/binaryApiClient'
import { getBinary } from '@/api/binaryClient'
import {
  privateRequestRuntime,
  StalePrivateResponseError
} from '@/services/privateRequestRuntime'

vi.mock('@/api/binaryApiClient', () => ({
  binaryRequest: vi.fn()
}))

const binaryRequestMock = vi.mocked(binaryRequest)
const encoder = new TextEncoder()

beforeEach(() => {
  privateRequestRuntime.resetForTests()
  binaryRequestMock.mockReset()
})

afterEach(() => {
  privateRequestRuntime.resetForTests()
})

describe('binary client private request generation', () => {
  it('uses an administrator lease signal and decodes the current JSON response', async () => {
    binaryRequestMock.mockResolvedValue(encoder.encode(JSON.stringify({ ready: true })).buffer)

    await expect(getBinary<{ ready: boolean }>('/api/binary/author/ops/fonts')).resolves.toEqual({ ready: true })

    expect(binaryRequestMock).toHaveBeenCalledWith('/api/binary/author/ops/fonts', {
      signal: expect.any(AbortSignal)
    })
    expect(binaryRequestMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
  })

  it('aborts a deferred administrator transport and drops its stale response before JSON parsing', async () => {
    let resolveResponse!: (value: ArrayBuffer) => void
    let transportSignal: AbortSignal | undefined
    binaryRequestMock.mockImplementation(async (_url, options) => {
      transportSignal = options?.signal
      return await new Promise<ArrayBuffer>((resolve) => { resolveResponse = resolve })
    })

    const pending = getBinary('/api/binary/author/ops/fonts')
    privateRequestRuntime.advance('admin')
    expect(transportSignal?.aborted).toBe(true)
    resolveResponse(encoder.encode('not valid JSON').buffer)

    await expect(pending).rejects.toBeInstanceOf(StalePrivateResponseError)
  })

  it('forwards a caller abort through the administrator lease signal', async () => {
    const caller = new AbortController()
    let transportSignal: AbortSignal | undefined
    binaryRequestMock.mockImplementation(async (_url, options) => {
      transportSignal = options?.signal
      return await new Promise<ArrayBuffer>((_resolve, reject) => {
        transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true })
      })
    })

    const pending = getBinary('/api/binary/author/ops/fonts', caller.signal)
    caller.abort(new DOMException('caller cancelled', 'AbortError'))

    expect(transportSignal?.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
