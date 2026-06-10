import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: vi.fn(() => 'fp-test')
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import { FSUS_HEADERS } from '@/api/contracts'
import { requestHumanReadChallenge, submitHumanReadProof } from '@/api/readProof'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('readProof API (binary)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('requests challenge with an AEDS request frame and device fingerprint', async () => {
    const signal = new AbortController().signal

    await requestHumanReadChallenge({
      scope: 'article',
      routeKey: 'article:42',
      articleId: 42,
      signal
    })

    const call = mockBinary.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({
      binaryUrl: '/api/binary/read-proof/challenge.aeds',
      frameType: FrameType.HumanReadChallengeResponse,
      signal
    }))
    expect(call.requestOptions).toEqual(expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ [FSUS_HEADERS.deviceFingerprint]: 'fp-test' }),
      body: expect.any(ArrayBuffer)
    }))
    expect(readFrameType(call.requestOptions?.body as ArrayBuffer)).toBe(FrameType.HumanReadChallengeRequest)
  })

  it('submits proof with an AEDS request frame and device fingerprint', async () => {
    await submitHumanReadProof({
      token: 'token-1',
      scope: 'site',
      routeKey: 'home',
      articleId: null,
      dwellMs: 9000
    })

    const call = mockBinary.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({
      binaryUrl: '/api/binary/read-proof/submit.aeds',
      frameType: FrameType.HumanReadSubmitResponse
    }))
    expect(call.requestOptions).toEqual(expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ [FSUS_HEADERS.deviceFingerprint]: 'fp-test' }),
      body: expect.any(ArrayBuffer)
    }))
    expect(readFrameType(call.requestOptions?.body as ArrayBuffer)).toBe(FrameType.HumanReadSubmitRequest)
  })

  it('does not retain JSON fetch compatibility in the API module', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../src/frontend/src/api/readProof.ts', import.meta.url)), 'utf8')

    expect(source).not.toContain('response.json')
    expect(source).not.toContain('JSON.stringify')
    expect(source).not.toContain('/api/read-proof/')
    expect(source).not.toContain('application/json')
    expect(source).not.toContain('JsonApiResponse')
  })
})

function readFrameType(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint16(8, true)
}
