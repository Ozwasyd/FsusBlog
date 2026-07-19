import { describe, expect, it } from 'vitest'
import vector from '../../../fixtures/security/pospace-v1-vector.json'
import {
  createPoSpaceUnsupportedReissueAttributes,
  createPoSpaceVerifyPayload,
  detectPoSpaceCapability,
  parsePoSpaceAssignment,
  parsePoSpacePayload,
  solvePoSpaceProof
} from '@/services/securityPoSpaceRuntime'

const providerPayload = {
  ...vector.providerPayload
}

const assignment = {
  ...vector.assignment
}

describe('Argon2idPoSpaceV1 frontend runtime', () => {
  it('parses provider payload and detects desktop support', () => {
    const parsed = parsePoSpacePayload(providerPayload)
    const capability = detectPoSpaceCapability(parsed, {
      workerAvailable: true,
      hardwareConcurrency: 4,
      deviceMemoryGb: 8,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
    })

    expect(parsed.memoryKib).toBe(19456)
    expect(capability).toMatchObject({
      supported: true,
      reason: 'supported',
      memoryTier: 'high',
      mobileHint: false
    })
  })

  it('caps mobile memory and returns unsupported instead of attempting compute', () => {
    const parsed = parsePoSpacePayload({
      ...providerPayload,
      memoryKib: '19456'
    })
    const capability = detectPoSpaceCapability(parsed, {
      workerAvailable: true,
      hardwareConcurrency: 6,
      deviceMemoryGb: 8,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
    })

    expect(capability.supported).toBe(false)
    expect(capability.reason).toBe('mobile_memory_cap')
    expect(capability.maxAllowedMemoryKib).toBe(0)
  })

  it.each([
    [{ workerAvailable: false, hardwareConcurrency: 4, deviceMemoryGb: 8 }, 'worker_unavailable', 65536],
    [{ workerAvailable: true, hardwareConcurrency: 4, deviceMemoryGb: 2 }, 'memory_tier_cap', 0]
  ] as const)('rejects fake capability %o with low-cardinality reason %s', (hints, reason, maxAllowedMemoryKib) => {
    const capability = detectPoSpaceCapability(parsePoSpacePayload(providerPayload), hints)

    expect(capability.supported).toBe(false)
    expect(capability.reason).toBe(reason)
    expect(capability.maxAllowedMemoryKib).toBe(maxAllowedMemoryKib)
  })

  it('derives deterministic Argon2id proof fields for a fixed nonce', async () => {
    const parsedPayload = parsePoSpacePayload(providerPayload)
    const parsedAssignment = parsePoSpaceAssignment(assignment)
    const nonceHex = vector.nonceHex

    const first = await solvePoSpaceProof(parsedAssignment, parsedPayload, {
      nonceHex,
      workerAvailable: true,
      hardwareConcurrency: 4,
      deviceMemoryGb: 8
    })
    const second = await solvePoSpaceProof(parsedAssignment, parsedPayload, {
      nonceHex,
      workerAvailable: true,
      hardwareConcurrency: 4,
      deviceMemoryGb: 8
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.nonceHex).toBe(nonceHex)
      expect(first.proofHex).toBe(vector.expectedProofHex)
      expect(second.proofHex).toBe(first.proofHex)
      expect(createPoSpaceVerifyPayload(providerPayload, first.nonceHex, first.proofHex))
        .toEqual(vector.verifyPayload)
    }
  })

  it.each([
    ['memoryKib', '19455'],
    ['memoryKib', '65537'],
    ['iterations', '1'],
    ['iterations', '7'],
    ['lanes', '0'],
    ['lanes', '5'],
    ['targetDurationMs', '99'],
    ['targetDurationMs', '5001'],
    ['memoryKib', '019456'],
    ['iterations', '+2'],
    ['lanes', '1.0'],
    ['targetDurationMs', '-1'],
    ['memoryKib', '9007199254740992']
  ])('rejects non-canonical or out-of-range %s=%s without clamping', (field, value) => {
    expect(() => parsePoSpacePayload({ ...providerPayload, [field]: value }))
      .toThrow()
  })

  it('accepts the exact shared parameter boundaries', () => {
    expect(parsePoSpacePayload({
      ...providerPayload,
      memoryKib: '65536',
      iterations: '6',
      lanes: '4',
      targetDurationMs: '5000'
    })).toMatchObject({ memoryKib: 65536, iterations: 6, lanes: 4, targetDurationMs: 5000 })
  })

  it('serializes a bounded low-cardinality unsupported reissue request', () => {
    expect(createPoSpaceUnsupportedReissueAttributes(assignment, 'memory_tier_cap', 1)).toEqual({
      unsupportedAssignment: {
        challengeId: assignment.challengeId,
        kind: 'argon2idPoSpaceV1',
        action: assignment.action,
        routeKey: assignment.routeKey,
        reason: 'memory_tier_cap',
        reissueCount: 1
      }
    })
    expect(() => createPoSpaceUnsupportedReissueAttributes(assignment, 'slow_device', 3)).toThrow()
  })

  it('reports slow devices as unsupported with an explicit reason', async () => {
    const result = await solvePoSpaceProof(parsePoSpaceAssignment(assignment), parsePoSpacePayload(providerPayload), {
      workerAvailable: true,
      forceSlowDevice: true
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('slow_device')
      expect(result.unsupported).toBe(true)
    }
  })
})
