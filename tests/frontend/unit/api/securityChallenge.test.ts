import { describe, expect, it, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  issueSecurityChallenge,
  SecurityChallengeKind,
  verifySecurityChallenge
} from '@/api/security'
import { FSUS_HEADERS } from '@/api/contracts'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: () => 'fp-captcha-test'
}))

const binaryMock = vi.mocked(requestBinaryOnly)
const decoder = new TextDecoder()

describe('security challenge binary API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('issues CaptchaV1 challenges through the public binary challenge endpoint', async () => {
    binaryMock.mockResolvedValue({ decision: 'challenge', providerPayloads: [] })

    await issueSecurityChallenge({
      action: 'comment.create',
      routeKey: 'article:42',
      attributes: { surface: 'comment' }
    })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/security/challenge')
    expect(call?.frameType).toBe(FrameType.SecurityChallengeIssueResponse)
    expect(call?.requestOptions?.method).toBe('POST')
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-captcha-test')
    expectAedsPodBody(call?.requestOptions?.body, FrameType.SecurityChallengeIssueRequest, (payload) => {
      expect(readSlice(payload, 0)).toBe('comment.create')
      expect(readSlice(payload, 8)).toBe('article:42')
      expect(readSlice(payload, 16)).toBe('fp-captcha-test')
      expect(JSON.parse(readSlice(payload, 24))).toEqual({ surface: 'comment' })
    })
  })

  it('verifies CaptchaV1 challenges with provider payload JSON and POD kind', async () => {
    binaryMock.mockResolvedValue({ verified: true, proofToken: 'proof-1' })

    await verifySecurityChallenge({
      challengeId: '01900000-0000-7000-8000-000000000000',
      kind: SecurityChallengeKind.CaptchaV1,
      action: 'comment.create',
      routeKey: 'article:42',
      providerPayload: {
        answerText: 'AEF2',
        nonceHex: '01000000'
      }
    })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/security/challenge/verify')
    expect(call?.frameType).toBe(FrameType.SecurityChallengeVerifyResponse)
    expect(call?.requestOptions?.method).toBe('POST')
    expectAedsPodBody(call?.requestOptions?.body, FrameType.SecurityChallengeVerifyRequest, (payload) => {
      expect(payload[0]).toBe(SecurityChallengeKind.CaptchaV1)
      expect(readSlice(payload, 4, 36)).toBe('01900000-0000-7000-8000-000000000000')
      expect(readSlice(payload, 12, 36)).toBe('comment.create')
      expect(readSlice(payload, 20, 36)).toBe('article:42')
      expect(JSON.parse(readSlice(payload, 28, 36))).toMatchObject({ answerText: 'AEF2', nonceHex: '01000000' })
    })
  })
})

function expectAedsPodBody(
  body: BodyInit | null | undefined,
  frameType: FrameType,
  assertPayload: (payload: Uint8Array) => void
): void {
  expect(body).toBeInstanceOf(ArrayBuffer)
  const bytes = new Uint8Array(body as ArrayBuffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint16(8, true)).toBe(frameType)
  const payloadLength = view.getUint32(10, true)
  assertPayload(bytes.slice(16, 16 + payloadLength))
}

function readSlice(payload: Uint8Array, sliceOffset: number, blobOffset = 32): string {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const offset = view.getInt32(sliceOffset, true)
  const length = view.getInt32(sliceOffset + 4, true)
  return decoder.decode(payload.subarray(blobOffset + offset, blobOffset + offset + length))
}
