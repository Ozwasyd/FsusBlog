import { describe, expect, it } from 'vitest'
import {
  createPoSpaceVerifyPayload,
  detectPoSpaceCapability,
  parsePoSpaceAssignment,
  parsePoSpacePayload,
  solvePoSpaceProof
} from '@/services/securityPoSpaceRuntime'

const providerPayload = {
  algorithm: 'fsu.pospace/argon2id@v1',
  saltHex: '000102030405060708090a0b0c0d0e0f',
  memoryKib: '1024',
  iterations: '1',
  lanes: '1',
  targetDurationMs: '100'
}

const assignment = {
  challengeId: '01900000-0000-7000-8000-000000000000',
  action: 'auth.login',
  routeKey: 'auth.login',
  subjectHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientIpHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  deviceFpHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  policyVersion: 'risk-policy-v2'
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

    expect(parsed.memoryKib).toBe(1024)
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
      memoryKib: '16384'
    })
    const capability = detectPoSpaceCapability(parsed, {
      workerAvailable: true,
      hardwareConcurrency: 6,
      deviceMemoryGb: 8,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
    })

    expect(capability.supported).toBe(false)
    expect(capability.reason).toBe('mobile_memory_cap')
    expect(capability.maxAllowedMemoryKib).toBe(8192)
  })

  it('derives deterministic Argon2id proof fields for a fixed nonce', async () => {
    const parsedPayload = parsePoSpacePayload(providerPayload)
    const parsedAssignment = parsePoSpaceAssignment(assignment)
    const nonceHex = '00112233445566778899aabbccddeeff'

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
      expect(first.proofHex).toMatch(/^[0-9a-f]{64}$/)
      expect(second.proofHex).toBe(first.proofHex)
      expect(createPoSpaceVerifyPayload(providerPayload, first.nonceHex, first.proofHex)).toMatchObject({
        nonceHex,
        proofHex: first.proofHex,
        memoryKib: '1024'
      })
    }
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
