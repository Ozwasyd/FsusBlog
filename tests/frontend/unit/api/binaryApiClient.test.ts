import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decode } from '@wasm/aeds'
import { FrameType } from '@wasm/protocol/frame'
import { binaryRequest, buildBinaryPowHeaders } from '@/api/binaryApiClient'

const powMocks = vi.hoisted(() => ({
  calculate: vi.fn()
}))

vi.mock('@/composables/usePow', () => ({
  usePow: () => ({
    calculate: powMocks.calculate
  })
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: () => 'test-browser-fp'
}))

function writeFixedUtf8(target: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value)
  target.set(encoded.subarray(0, length), offset)
}

function writeInt32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >> 8) & 0xff
  target[offset + 2] = (value >> 16) & 0xff
  target[offset + 3] = (value >> 24) & 0xff
}

function writeInt64(target: Uint8Array, offset: number, value: bigint): void {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength)
  view.setBigInt64(offset, value, true)
}

function createPowChallengePayload(): Uint8Array {
  const payload = new Uint8Array(204)
  writeFixedUtf8(payload, 0, 64, 'salt-value')
  writeInt32(payload, 64, 4)
  writeInt64(payload, 68, 1710000000000n)
  writeFixedUtf8(payload, 76, 128, 'signature-value')
  return payload
}

function mockPowChallengeDecode(): void {
  vi.mocked(decode).mockReturnValue({
    ok: true,
    frameType: FrameType.PowChallenge,
    payloadView: createPowChallengePayload(),
    payload: createPowChallengePayload(),
    textBlob: ''
  } as any)
}

describe('binaryApiClient credentials handling', () => {
  beforeEach(() => {
    powMocks.calculate.mockReset()
    powMocks.calculate.mockResolvedValue({ nonce: 'nonce-value', duration: 1 })
    mockPowChallengeDecode()
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

describe('binaryApiClient pow abort handling', () => {
  beforeEach(() => {
    powMocks.calculate.mockReset()
    powMocks.calculate.mockResolvedValue({ nonce: 'nonce-value', duration: 1 })
    mockPowChallengeDecode()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0)
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(decode).mockReset()
  })

  it('buildBinaryPowHeaders passes signal to pow challenge fetch', async () => {
    const controller = new AbortController()

    await buildBinaryPowHeaders(controller.signal)

    const fetchMock = vi.mocked(fetch)
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.signal).toBe(controller.signal)
    expect(powMocks.calculate).toHaveBeenCalledWith('salt-value', 'test-browser-fp', 4, undefined, controller.signal)
  })

  it('buildBinaryPowHeaders aborts before calculate when signal is aborted after challenge', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }))

    await expect(buildBinaryPowHeaders(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(powMocks.calculate).not.toHaveBeenCalled()
  })

  it('aborted pow header construction rejects as AbortError', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(buildBinaryPowHeaders(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    expect(powMocks.calculate).not.toHaveBeenCalled()
  })

  it('binary request does not send business request after pow abort', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }))

    await expect(binaryRequest('/api/binary/comment', {
      method: 'POST',
      requiresPow: true,
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/api/binary/auth/pow-challenge')
    expect(powMocks.calculate).not.toHaveBeenCalled()
  })
})
