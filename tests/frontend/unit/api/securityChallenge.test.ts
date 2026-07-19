import { describe, expect, it, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import {
  issueSecurityChallenge,
  SecurityChallengeKind,
  verifySecurityChallenge
} from '@/api/security'
import { SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION } from '@/security/challenge-capability-registry'
import { FSUS_HEADERS } from '@/api/contracts'

vi.mock('@/composition/binaryTransport', () => ({
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
      attributes: { surface: 'comment' },
      capabilityManifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
    })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/security/challenge')
    expect(call?.frameType).toBe(FrameType.SecurityChallengeIssueResponse)
    expect(call?.requestOptions?.method).toBe('POST')
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-captcha-test')
    expectAedsPodBody(call?.requestOptions?.body, FrameType.SecurityChallengeIssueRequest, (payload) => {
      const blob = readPodBlob(payload, 40)
      expect(readSlice(payload, blob, 0)).toBe('comment.create')
      expect(readSlice(payload, blob, 8)).toBe('article:42')
      expect(readSlice(payload, blob, 16)).toBe('fp-captcha-test')
      expect(JSON.parse(readSlice(payload, blob, 24))).toEqual({ surface: 'comment' })
      expect(readSlice(payload, blob, 32)).toBe(SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION)
    })
  })

  it('verifies CaptchaV1 challenges with provider payload JSON and POD kind', async () => {
    binaryMock.mockResolvedValue({ verified: true, proofToken: 'proof-1' })

    await verifySecurityChallenge({
      envelopeId: '01900000-0000-7000-8000-000000000001',
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
      const blob = readPodBlob(payload, 44)
      expect(payload[0]).toBe(SecurityChallengeKind.CaptchaV1)
      expect(readSlice(payload, blob, 4)).toBe('01900000-0000-7000-8000-000000000001')
      expect(readSlice(payload, blob, 12)).toBe('01900000-0000-7000-8000-000000000000')
      expect(readSlice(payload, blob, 20)).toBe('comment.create')
      expect(readSlice(payload, blob, 28)).toBe('article:42')
      expect(JSON.parse(readSlice(payload, blob, 36))).toMatchObject({ answerText: 'AEF2', nonceHex: '01000000' })
    })
  })

  it('rejects a non-UUIDv7 envelope id before dispatch', () => {
    expect(() => verifySecurityChallenge({
      envelopeId: '8e7147d7-80a6-4cd2-bf67-57858b2edb85',
      challengeId: '01900000-0000-7000-8000-000000000000',
      kind: SecurityChallengeKind.CaptchaV1,
      action: 'comment.create',
      routeKey: 'article:42',
      providerPayload: { answerText: 'AEF2' }
    })).toThrow('security_challenge_envelope_id_invalid')
    expect(binaryMock).not.toHaveBeenCalled()
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

function readPodBlob(payload: Uint8Array, headerBytes: number): Uint8Array {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const length = view.getInt32(headerBytes, true)
  return payload.subarray(headerBytes + 4, headerBytes + 4 + length)
}

function readSlice(payload: Uint8Array, blob: Uint8Array, sliceOffset: number): string {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const offset = view.getInt32(sliceOffset, true)
  const length = view.getInt32(sliceOffset + 4, true)
  return decoder.decode(blob.subarray(offset, offset + length))
}
