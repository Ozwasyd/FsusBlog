import { describe, expect, it, vi } from 'vitest'
import {
  createPerceptionCharacterV3Flow,
  createPerceptionCharacterV3Media,
  mapPerceptionCharacterV3VerifyResult,
  type PerceptionCharacterV3FlowOptions
} from '@/services/securityPerceptionCharacterV3Flow'
import {
  PerceptionCharacterV3Representation,
  SecurityChallengeKind,
  type PerceptionCharacterV3IssuePayload,
  type SecurityChallengeAssignment,
  type SecurityChallengeVerifyResponse
} from '@/contracts/binaryApi'
import {
  canonicalPerceptionCharacterV3OpusOgg,
  canonicalPerceptionCharacterV3Png
} from '../../helpers/perceptionCharacterV3Media'

const challengeId = '01900000-0000-7000-8000-000000000014'
const envelopeId = '01900000-0000-7000-8000-000000000001'

describe('PerceptionCharacterV3 frontend flow', () => {
  it('exposes final PNG through an image object URL and revokes it exactly once', async () => {
    const payload = visualPayload()
    const createObjectUrl = vi.fn<(blob: Blob) => string>(() => 'blob:v3-visual')
    const revokeObjectUrl = vi.fn()
    const resource = createPerceptionCharacterV3Media(payload, { createObjectUrl, revokeObjectUrl })
    const raster = resource.media.raster
    expect(raster).toEqual({
      kind: 'image-url',
      src: 'blob:v3-visual',
      width: 320,
      height: 120
    })
    const blob = createObjectUrl.mock.calls[0]![0]
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(payload.mediaBytes)

    resource.dispose()
    resource.dispose()
    expect(resource.media.raster).toBeNull()
    expect(revokeObjectUrl).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:v3-visual')
  })

  it('creates and revokes an audio blob URL exactly once', () => {
    const createObjectUrl = vi.fn<(blob: Blob) => string>(() => 'blob:v3-audio')
    const revokeObjectUrl = vi.fn()
    const resource = createPerceptionCharacterV3Media(audioPayload(), { createObjectUrl, revokeObjectUrl })
    expect(resource.media.audio).toEqual({ src: 'blob:v3-audio', type: 'audio/ogg; codecs=opus' })
    const blob = createObjectUrl.mock.calls[0]![0]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('audio/ogg; codecs=opus')

    resource.dispose()
    resource.dispose()
    expect(revokeObjectUrl).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:v3-audio')
    expect(resource.media.audio).toBeNull()
  })

  it('submits only answer, state, identity and representation in the typed verify member', async () => {
    const verifyChallenge = vi.fn<PerceptionCharacterV3FlowOptions['verifyChallenge']>(async () => verifyResponse({ verified: false, reason: 'retryable' }))
    const flow = createPerceptionCharacterV3Flow({
      assignment: assignment(),
      payload: visualPayload(),
      verifyChallenge
    })
    const result = await flow.verify('A1B2C3')
    const request = verifyChallenge.mock.calls[0]?.[0]

    expect(result).toMatchObject({ outcome: 'retryable', retryable: true, reissueRequired: false })
    expect(request?.kind).toBe(SecurityChallengeKind.PerceptionCharacterV3)
    expect(Object.keys(request?.perceptionCharacterV3 ?? {}).sort()).toEqual([
      'algorithm', 'answer', 'challengeId', 'envelopeId', 'representation', 'stateToken'
    ])
    expect(JSON.stringify(request)).not.toMatch(/solveDuration|recipe|seed|glyph|verifier/iu)
    expect(request?.providerPayload).toBeUndefined()
  })

  it('disposes the current media and tombstones the flow resource', () => {
    const payload = visualPayload()
    const revokeObjectUrl = vi.fn()
    const flow = createPerceptionCharacterV3Flow({
      assignment: assignment(),
      payload,
      verifyChallenge: vi.fn(),
      createObjectUrl: vi.fn()
        .mockReturnValueOnce('blob:first')
        .mockReturnValueOnce('blob:second'),
      revokeObjectUrl
    })
    const first = flow.createMedia()
    const second = flow.createMedia()
    expect(first.media.raster).toBeNull()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first')

    flow.dispose()
    flow.dispose()
    expect(second.media.raster).toBeNull()
    expect(payload.mediaBytes[0]).toBe(0)
    expect(() => flow.createMedia()).toThrow('perception_character_v3_flow_disposed')
  })

  it.each([
    ['oversized PNG', () => ({ ...visualPayload(), mediaBytes: new Uint8Array(32 * 1024 + 1) })],
    ['truncated PNG', () => ({ ...visualPayload(), mediaBytes: canonicalPerceptionCharacterV3Png().subarray(0, 40) })],
    ['polyglot PNG', () => {
      const bytes = new Uint8Array(canonicalPerceptionCharacterV3Png().byteLength + 1)
      bytes.set(canonicalPerceptionCharacterV3Png())
      return { ...visualPayload(), mediaBytes: bytes }
    }],
    ['wrong visual dimensions', () => ({ ...visualPayload(), physicalWidth: 512 })],
    ['WAV masquerading as Opus', () => ({ ...audioPayload(), mediaBytes: new Uint8Array([82, 73, 70, 70]) })]
  ])('rejects %s before creating a browser media allocation', (_name, invalidPayload) => {
    const createObjectUrl = vi.fn()
    expect(() => createPerceptionCharacterV3Media(invalidPayload(), { createObjectUrl })).toThrow()
    expect(createObjectUrl).not.toHaveBeenCalled()
  })

  it.each([
    ['retryable', 'retryable'],
    ['reissueRequired', 'reissue'],
    ['unavailable', 'unavailable'],
    ['expired', 'rejected'],
    ['internal_detail_that_must_not_escape', 'rejected']
  ] as const)('maps backend reason %s to coarse outcome %s', (reason, outcome) => {
    expect(mapPerceptionCharacterV3VerifyResult(verifyResponse({ verified: false, reason })).outcome).toBe(outcome)
  })
})

function visualPayload(): PerceptionCharacterV3IssuePayload {
  return {
    algorithm: 'fsu.challenge/perception-character-artifact@v3',
    challengeId,
    envelopeId,
    representation: PerceptionCharacterV3Representation.Visual,
    mediaType: 'image/png',
    mediaBytes: canonicalPerceptionCharacterV3Png(),
    physicalWidth: 384,
    physicalHeight: 144,
    displayWidth: 320,
    displayHeight: 120,
    attemptBudget: 2,
    policyVersion: 'risk-v3',
    issuedAtUnixMs: 1_770_000_000_000,
    expiresAtUnixMs: 1_770_000_300_000,
    stateToken: 'opaque-state'
  }
}

function audioPayload(): PerceptionCharacterV3IssuePayload {
  return {
    ...visualPayload(),
    representation: PerceptionCharacterV3Representation.Audio,
    mediaType: 'audio/ogg; codecs=opus',
    mediaBytes: canonicalPerceptionCharacterV3OpusOgg(),
    physicalWidth: 0,
    physicalHeight: 0,
    displayWidth: 0,
    displayHeight: 0
  }
}

function assignment(): SecurityChallengeAssignment {
  return {
    challengeId,
    traceparent: '',
    tenantId: '',
    kind: SecurityChallengeKind.PerceptionCharacterV3,
    escalationLevel: 1,
    action: 'comment.create',
    routeKey: '/article/42',
    subjectHash: '',
    clientIpHash: '',
    deviceFpHash: '',
    issuedAtUnixMs: 1_770_000_000_000,
    expiresAtUnixMs: 1_770_000_300_000
  }
}

function verifyResponse(overrides: Partial<SecurityChallengeVerifyResponse>): SecurityChallengeVerifyResponse {
  return {
    verified: false,
    envelopeId,
    challengeId,
    kind: SecurityChallengeKind.PerceptionCharacterV3,
    policyVersion: 'risk-v3',
    completedCount: 0,
    memberCount: 1,
    envelopeCompleted: false,
    proofToken: '',
    expiresAtUnixMs: 0,
    reason: 'rejected',
    retryAfterMs: 0,
    ...overrides
  }
}
