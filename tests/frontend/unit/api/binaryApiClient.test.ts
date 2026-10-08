import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decode } from '@wasm/aeds'
import { FrameType } from '@wasm/protocol/frame'
import { binaryRequest, buildBinaryPowHeaders, resolveBinaryTransportUrl } from '@/api/binaryApiClient'
import { SecurityChallengeKind } from '@/contracts/binaryApi'
import type { RiskChallengeProofContext, RiskChallengeProofSettlement } from '@/contracts/riskChallenge'

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

  it('exposes a cloned response-header snapshot to contract-aware callers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-Fsus-Access-Expires-At-Utc': '2026-07-19T00:15:00.000Z' }),
      arrayBuffer: async () => new ArrayBuffer(0)
    })))
    const observe = vi.fn()

    await binaryRequest('/api/binary/auth/me', { onResponseHeaders: observe })

    expect(observe).toHaveBeenCalledTimes(1)
    const headers = observe.mock.calls[0]?.[0] as Headers
    expect(headers.get('X-Fsus-Access-Expires-At-Utc')).toBe('2026-07-19T00:15:00.000Z')
  })

  it('does not merge requests whose callers each require response metadata', async () => {
    const observeFirst = vi.fn()
    const observeSecond = vi.fn()

    await Promise.all([
      binaryRequest('/api/binary/auth/me', { onResponseHeaders: observeFirst }),
      binaryRequest('/api/binary/auth/me', { onResponseHeaders: observeSecond })
    ])

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(observeFirst).toHaveBeenCalledTimes(1)
    expect(observeSecond).toHaveBeenCalledTimes(1)
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

describe('binaryApiClient one-time pow headers', () => {
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

  it('uses fresh one-time pow headers for concurrent builds with same scope', async () => {
    const firstCalculation = createDeferred<{ nonce: string; duration: number }>()
    const secondCalculation = createDeferred<{ nonce: string; duration: number }>()
    powMocks.calculate
      .mockReturnValueOnce(firstCalculation.promise)
      .mockReturnValueOnce(secondCalculation.promise)

    const first = buildBinaryPowHeaders(undefined, 'comment:create')
    const second = buildBinaryPowHeaders(undefined, 'comment:create')

    await vi.waitFor(() => expect(powMocks.calculate).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenCalledTimes(2)

    firstCalculation.resolve({ nonce: 'first-nonce', duration: 2 })
    secondCalculation.resolve({ nonce: 'second-nonce', duration: 2 })

    const [firstHeaders, secondHeaders] = await Promise.all([first, second])
    expect(firstHeaders['X-Fsus-Pow-Proof']).not.toEqual(secondHeaders['X-Fsus-Pow-Proof'])
  })

  it('builds independent pow headers for different pow scopes', async () => {
    const first = buildBinaryPowHeaders(undefined, 'comment:create')
    const second = buildBinaryPowHeaders(undefined, 'upload:start')

    await Promise.all([first, second])

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(powMocks.calculate).toHaveBeenCalledTimes(2)
  })

  it('single abort only cancels its own pow build', async () => {
    const firstController = new AbortController()
    const firstCalculation = createDeferred<{ nonce: string; duration: number }>()
    const secondCalculation = createDeferred<{ nonce: string; duration: number }>()
    powMocks.calculate
      .mockReturnValueOnce(firstCalculation.promise)
      .mockReturnValueOnce(secondCalculation.promise)

    const first = buildBinaryPowHeaders(firstController.signal, 'comment:create')
    const second = buildBinaryPowHeaders(undefined, 'comment:create')

    await vi.waitFor(() => expect(powMocks.calculate).toHaveBeenCalledTimes(2))
    const firstSignal = powMocks.calculate.mock.calls[0][4] as AbortSignal
    const secondSignal = powMocks.calculate.mock.calls[1][4] as AbortSignal

    firstController.abort()
    firstCalculation.reject(new DOMException('The operation was aborted.', 'AbortError'))

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal).toBeUndefined()

    firstCalculation.resolve({ nonce: 'aborted-nonce', duration: 2 })
    secondCalculation.resolve({ nonce: 'remaining-nonce', duration: 2 })
    await expect(second).resolves.toEqual(expect.objectContaining({
      'X-Fsus-Device-Fp': 'test-browser-fp'
    }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('builds a fresh pow header after success', async () => {
    await buildBinaryPowHeaders(undefined, 'comment:create')
    await buildBinaryPowHeaders(undefined, 'comment:create')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(powMocks.calculate).toHaveBeenCalledTimes(2)
  })

  it('builds a fresh pow header after failure', async () => {
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

describe('binaryApiClient risk challenge proof transport', () => {
  beforeEach(() => {
    powMocks.calculate.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('attaches the three typed proof headers and commits an accepted response', async () => {
    const lease = createRiskChallengeLease()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0)
    })))

    await binaryRequest('/api/binary/comment', {
      method: 'POST',
      riskChallengeProof: lease
    })

    const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('X-Fsus-Challenge-Proof')).toBe('proof-token')
    expect(headers.get('X-Fsus-Challenge-Id')).toBe('challenge-1')
    expect(headers.get('X-Fsus-Challenge-Kind')).toBe('perceptionLocalizationV2')
    expect(lease.markInFlight).toHaveBeenCalledOnce()
    expect(lease.settle).toHaveBeenCalledWith('accepted')
  })

  it('restores a reservation when cancellation happens before fetch', async () => {
    const lease = createRiskChallengeLease()
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn())

    await expect(binaryRequest('/api/binary/comment', {
      method: 'POST',
      signal: controller.signal,
      riskChallengeProof: lease
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(fetch).not.toHaveBeenCalled()
    expect(lease.markInFlight).not.toHaveBeenCalled()
    expect(lease.settle).toHaveBeenCalledWith('before_send_cancelled')
  })

  it('marks an in-flight network failure terminal instead of restoring it', async () => {
    const lease = createRiskChallengeLease()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))

    await expect(binaryRequest('/api/binary/comment', {
      method: 'POST',
      riskChallengeProof: lease
    })).rejects.toThrow('Failed to fetch')

    expect(lease.markInFlight).toHaveBeenCalledOnce()
    expect(lease.settle).toHaveBeenCalledWith('unknown_network')
    expect(lease.settle).not.toHaveBeenCalledWith('before_send_cancelled')
  })

  it.each([
    ['expired', 'expired'],
    ['replayed_or_missing', 'replayed'],
    ['binding_mismatch', 'binding_mismatch'],
    ['revoked', 'revoked'],
    ['rejected', 'rejected']
  ] as const)('settles server proof outcome %s as %s', async (outcome, settlement) => {
    const lease = createRiskChallengeLease()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 428,
      headers: new Headers({ 'X-Fsus-Challenge-Proof-Outcome': outcome }),
      arrayBuffer: async () => new ArrayBuffer(0)
    })))

    await expect(binaryRequest('/api/binary/comment', {
      method: 'POST',
      riskChallengeProof: lease
    })).rejects.toMatchObject({ status: 428 })
    expect(lease.settle).toHaveBeenCalledWith(settlement)
  })
})

function createRiskChallengeLease(): RiskChallengeProofContext & {
  markInFlight: ReturnType<typeof vi.fn>
  settle: ReturnType<typeof vi.fn>
} {
  return {
    proof: {
      action: 'comment.create',
      routeKey: 'article:42',
      challengeId: 'challenge-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
      proofToken: 'proof-token',
      policyVersion: 'policy-v1',
      verifiedAtUnixMs: 1_000,
      expiresAtUnixMs: 60_000
    },
    markInFlight: vi.fn(() => true),
    settle: vi.fn((_outcome: RiskChallengeProofSettlement) => true)
  }
}


describe('binaryApiClient URL base handling', () => {
  let originalHref: string

  beforeEach(() => {
    originalHref = window.location.href
    window.location.href = 'https://fsusblog.test/author/drafts/?page=2'
  })

  afterEach(() => {
    window.location.href = originalHref
    vi.unstubAllGlobals()
  })

  it('resolves browser root-relative and path-relative routes using the real location href', () => {
    expect(resolveBinaryTransportUrl('/api/binary/article?q=one#result'))
      .toBe('https://fsusblog.test/api/binary/article?q=one#result')
    expect(resolveBinaryTransportUrl('../canvas'))
      .toBe('https://fsusblog.test/author/canvas')
  })

  it('preserves absolute URLs in browser and without a location', () => {
    const absolute = 'https://assets.fsusblog.test/item?version=2#detail'
    expect(resolveBinaryTransportUrl(absolute)).toBe(absolute)
    vi.stubGlobal('location', undefined)
    expect(resolveBinaryTransportUrl(absolute)).toBe(absolute)
  })

  it('retains the existing SSR localhost base when location is unavailable', () => {
    vi.stubGlobal('location', undefined)
    expect(resolveBinaryTransportUrl('/api/binary/article?q=one#result'))
      .toBe('http://localhost/api/binary/article?q=one#result')
    expect(resolveBinaryTransportUrl('api/binary/article')).toBe('http://localhost/api/binary/article')
  })
})
