import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { requestHumanReadChallenge, submitHumanReadProof } from '@/api/readProof'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('readProof API (binary)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('requests challenge without a stable cross-article fingerprint', async () => {
    const signal = new AbortController().signal

    await requestHumanReadChallenge({
      scope: 'article',
      routeKey: 'article:42',
      articleId: 42,
      signal
    })

    const call = mockBinary.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_read_proof_challenge_aeds' },
      frameType: FrameType.HumanReadChallengeResponse,
      signal
    }))
    expect(call.requestOptions).toEqual(expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
    expect(call.requestOptions?.headers).toBeUndefined()
    expect(readFrameType(call.requestOptions?.body as ArrayBuffer)).toBe(FrameType.HumanReadChallengeRequest)
  })

  it('submits proof without a stable cross-article fingerprint', async () => {
    await submitHumanReadProof({
      token: 'token-1',
      scope: 'site',
      routeKey: 'home',
      articleId: null,
      dwellMs: 9000
    })

    const call = mockBinary.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_read_proof_submit_aeds' },
      frameType: FrameType.HumanReadSubmitResponse
    }))
    expect(call.requestOptions).toEqual(expect.objectContaining({
      body: expect.any(ArrayBuffer)
    }))
    expect(call.requestOptions?.headers).toBeUndefined()
    expect(readFrameType(call.requestOptions?.body as ArrayBuffer)).toBe(FrameType.HumanReadSubmitRequest)
  })

})

function readFrameType(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint16(8, true)
}

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
