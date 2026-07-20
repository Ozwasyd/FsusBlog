import { describe, expect, it, vi } from 'vitest'
import {
  createPerceptionCharacterV3Flow,
  createPerceptionCharacterV3Media,
  mapPerceptionCharacterV3VerifyResult
} from '@/services/securityPerceptionCharacterV3Flow'
import {
  PerceptionCharacterV3Representation,
  SecurityChallengeKind,
  type PerceptionCharacterV3IssuePayload,
  type SecurityChallengeAssignment,
  type SecurityChallengeVerifyResponse
} from '@/contracts/binaryApi'

const challengeId = '01900000-0000-7000-8000-000000000014'
const envelopeId = '01900000-0000-7000-8000-000000000001'

describe('PerceptionCharacterV3 frontend flow', () => {
  it('converts bounded Gray8 to the protocol-neutral FsusUI RGBA media and disposes it', () => {
    const payload = visualPayload()
    payload.mediaBytes[0] = 23
    const resource = createPerceptionCharacterV3Media(payload)
    const raster = resource.media.raster
    expect(raster?.kind).toBe('rgba-raster')
    if (raster?.kind !== 'rgba-raster') throw new Error('expected rgba raster')
    expect([...raster.pixels.subarray(0, 4)]).toEqual([23, 23, 23, 255])
    expect(raster.pixels).toHaveLength(512 * 192 * 4)

    resource.dispose()
    resource.dispose()
    expect(resource.media.raster).toBeNull()
    expect(raster.pixels[0]).toBe(0)
  })

  it('creates and revokes an audio blob URL exactly once', () => {
    const createObjectUrl = vi.fn(() => 'blob:v3-audio')
    const revokeObjectUrl = vi.fn()
    const resource = createPerceptionCharacterV3Media(audioPayload(), { createObjectUrl, revokeObjectUrl })
    expect(resource.media.audio).toEqual({ src: 'blob:v3-audio', type: 'audio/wav' })
    expect(createObjectUrl.mock.calls[0]?.[0]).toBeInstanceOf(Blob)

    resource.dispose()
    resource.dispose()
    expect(revokeObjectUrl).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:v3-audio')
    expect(resource.media.audio).toBeNull()
  })

  it('submits only answer, state, identity and representation in the typed verify member', async () => {
    const verifyChallenge = vi.fn(async () => verifyResponse({ verified: false, reason: 'retryable' }))
    const flow = createPerceptionCharacterV3Flow({ assignment: assignment(), payload: visualPayload(), verifyChallenge })
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
    payload.mediaBytes.fill(91)
    const flow = createPerceptionCharacterV3Flow({
      assignment: assignment(),
      payload,
      verifyChallenge: vi.fn()
    })
    const first = flow.createMedia()
    const firstRaster = first.media.raster
    const second = flow.createMedia()
    expect(first.media.raster).toBeNull()

    flow.dispose()
    flow.dispose()
    expect(second.media.raster).toBeNull()
    expect(payload.mediaBytes[0]).toBe(0)
    if (firstRaster?.kind === 'rgba-raster') expect(firstRaster.pixels[0]).toBe(0)
    expect(() => flow.createMedia()).toThrow('perception_character_v3_flow_disposed')
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
    algorithm: 'fsu.challenge/perception-character-raster@v3',
    challengeId,
    envelopeId,
    representation: PerceptionCharacterV3Representation.Visual,
    mediaType: 'application/x-fsus-gray8',
    mediaBytes: new Uint8Array(512 * 192),
    physicalWidth: 512,
    physicalHeight: 192,
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
    mediaType: 'audio/wav',
    mediaBytes: new Uint8Array([82, 73, 70, 70]),
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
