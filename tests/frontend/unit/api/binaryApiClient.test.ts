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

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
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

  it('adds csrf token from document metadata for credentialed mutations', async () => {
    document.head.innerHTML = '<meta name="fsus-csrf-token" content="csrf-token-value">'

    await binaryRequest('/api/binary/category', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3])
    })

    const fetchMock = vi.mocked(fetch)
    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Headers
    expect(init?.credentials).toBe('include')
    expect(headers.get('x-fsus-csrf-token')).toBe('csrf-token-value')
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
    expect(init?.signal).toBeDefined()
    expect(powMocks.calculate.mock.calls[0][4]).toBe(init?.signal)
  })

  it('buildBinaryPowHeaders gives browser pow enough time for release acceptance difficulty', async () => {
    await buildBinaryPowHeaders()

    expect(powMocks.calculate.mock.calls[0][3]).toBe(60_000)
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

describe('binaryApiClient pow in-flight dedupe', () => {
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

  it('dedupes concurrent pow header builds for same scope', async () => {
    const calculation = createDeferred<{ nonce: string; duration: number }>()
    powMocks.calculate.mockReturnValue(calculation.promise)

    const first = buildBinaryPowHeaders(undefined, 'comment:create')
    const second = buildBinaryPowHeaders(undefined, 'comment:create')

    await vi.waitFor(() => expect(powMocks.calculate).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledTimes(1)

    calculation.resolve({ nonce: 'shared-nonce', duration: 2 })

    const [firstHeaders, secondHeaders] = await Promise.all([first, second])
    expect(firstHeaders).toEqual(secondHeaders)
  })

  it('does not dedupe different pow scopes', async () => {
    const first = buildBinaryPowHeaders(undefined, 'comment:create')
    const second = buildBinaryPowHeaders(undefined, 'upload:start')

    await Promise.all([first, second])

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(powMocks.calculate).toHaveBeenCalledTimes(2)
  })

  it('single waiter abort does not cancel shared pow for remaining waiters', async () => {
    const firstController = new AbortController()
    const calculation = createDeferred<{ nonce: string; duration: number }>()
    powMocks.calculate.mockReturnValue(calculation.promise)

    const first = buildBinaryPowHeaders(firstController.signal, 'comment:create')
    const second = buildBinaryPowHeaders(undefined, 'comment:create')

    await vi.waitFor(() => expect(powMocks.calculate).toHaveBeenCalledTimes(1))
    const sharedSignal = powMocks.calculate.mock.calls[0][4] as AbortSignal

    firstController.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal.aborted).toBe(false)

    calculation.resolve({ nonce: 'remaining-nonce', duration: 2 })
    await expect(second).resolves.toEqual(expect.objectContaining({
      'X-Fsus-Device-Fp': 'test-browser-fp'
    }))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('all waiters abort cancels shared pow', async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    let sharedSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      sharedSignal = init?.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        sharedSignal?.addEventListener('abort', () => reject(createAbortError()), { once: true })
      })
    }))

    const first = buildBinaryPowHeaders(firstController.signal, 'comment:create')
    const second = buildBinaryPowHeaders(secondController.signal, 'comment:create')

    await vi.waitFor(() => expect(sharedSignal).toBeDefined())

    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(false)

    secondController.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('clears inflight entry after success', async () => {
    await buildBinaryPowHeaders(undefined, 'comment:create')
    await buildBinaryPowHeaders(undefined, 'comment:create')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(powMocks.calculate).toHaveBeenCalledTimes(2)
  })

  it('clears inflight entry after failure', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        arrayBuffer: async () => new ArrayBuffer(0)
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0)
      }))

    await expect(buildBinaryPowHeaders(undefined, 'comment:create')).rejects.toMatchObject({ status: 503 })
    await expect(buildBinaryPowHeaders(undefined, 'comment:create')).resolves.toEqual(expect.objectContaining({
      'X-Fsus-Device-Fp': 'test-browser-fp'
    }))

    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('binaryApiClient binary request in-flight dedupe', () => {
  beforeEach(() => {
    powMocks.calculate.mockReset()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dedupes concurrent identical binary GET requests', async () => {
    const response = createDeferred<ArrayBuffer>()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => await response.promise
    })))

    const first = binaryRequest('/api/binary/article/hot/8.aeds')
    const second = binaryRequest('/api/binary/article/hot/8.aeds')

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    response.resolve(new Uint8Array([9, 8, 7]).buffer)

    const [firstBuffer, secondBuffer] = await Promise.all([first, second])
    expect(new Uint8Array(firstBuffer)).toEqual(new Uint8Array([9, 8, 7]))
    expect(new Uint8Array(secondBuffer)).toEqual(new Uint8Array([9, 8, 7]))
    expect(secondBuffer).not.toBe(firstBuffer)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not dedupe different binary request bodies', async () => {
    await Promise.all([
      binaryRequest('/api/binary/comment', { method: 'POST', body: new Uint8Array([1]) }),
      binaryRequest('/api/binary/comment', { method: 'POST', body: new Uint8Array([2]) })
    ])

    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
