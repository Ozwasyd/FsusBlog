import { describe, expect, it } from 'vitest'
import { mapSecurityChallengeVerifyResponseFromPayload } from '@/adapters/binary/securityAdapter'
import { SecurityChallengeKind } from '@/contracts/binaryApi'

describe('security challenge binary adapter', () => {
  it('decodes the authoritative proof expiry from the fixed response pod', () => {
    const proof = new TextEncoder().encode('fcp_authoritative')
    const reason = new TextEncoder().encode('ok')
    const bytes = new Uint8Array(232 + 4 + proof.length + reason.length)
    const view = new DataView(bytes.buffer)
    bytes[0] = 1
    bytes[1] = SecurityChallengeKind.Sha256PowV1
    bytes[2] = 1
    view.setInt32(4, 0, true)
    view.setInt32(8, 2, true)
    view.setInt32(12, 2, true)
    writeFixed(bytes, 16, 64, '01900000-0000-7000-8000-000000000001')
    writeFixed(bytes, 80, 64, '01900000-0000-7000-8000-000000000002')
    writeFixed(bytes, 144, 64, 'risk-v2')
    view.setInt32(208, 0, true)
    view.setInt32(212, proof.length, true)
    view.setInt32(216, proof.length, true)
    view.setInt32(220, reason.length, true)
    view.setBigInt64(224, 1_770_000_300_000n, true)
    view.setInt32(232, proof.length + reason.length, true)
    bytes.set(proof, 236)
    bytes.set(reason, 236 + proof.length)

    const decoded = mapSecurityChallengeVerifyResponseFromPayload(bytes)

    expect(decoded).toEqual({
      verified: true,
      envelopeCompleted: true,
      kind: SecurityChallengeKind.Sha256PowV1,
      retryAfterMs: 0,
      completedCount: 2,
      memberCount: 2,
      envelopeId: '01900000-0000-7000-8000-000000000001',
      challengeId: '01900000-0000-7000-8000-000000000002',
      policyVersion: 'risk-v2',
      proofToken: 'fcp_authoritative',
      reason: 'ok',
      expiresAtUnixMs: 1_770_000_300_000
    })
  })

  it('decodes verified member progress without exposing an aggregate proof', () => {
    const bytes = createVerifyResponse({ completedCount: 1, memberCount: 2, envelopeCompleted: false, proofToken: '' })

    const decoded = mapSecurityChallengeVerifyResponseFromPayload(bytes)

    expect(decoded.verified).toBe(true)
    expect(decoded.completedCount).toBe(1)
    expect(decoded.memberCount).toBe(2)
    expect(decoded.envelopeCompleted).toBe(false)
    expect(decoded.proofToken).toBe('')
  })

  it.each([
    { completedCount: 3, memberCount: 2, envelopeCompleted: false, proofToken: '' },
    { completedCount: 1, memberCount: 2, envelopeCompleted: true, proofToken: 'fcp_early' },
    { completedCount: 1, memberCount: 2, envelopeCompleted: false, proofToken: 'fcp_early' },
    { completedCount: 2, memberCount: 2, envelopeCompleted: true, proofToken: '' }
  ])('rejects invalid aggregate state %#', (state) => {
    expect(() => mapSecurityChallengeVerifyResponseFromPayload(createVerifyResponse(state))).toThrow('security_challenge_verify_contract_invalid')
  })
})

function createVerifyResponse(state: {
  completedCount: number
  memberCount: number
  envelopeCompleted: boolean
  proofToken: string
}): Uint8Array {
  const proof = new TextEncoder().encode(state.proofToken)
  const reason = new TextEncoder().encode('ok')
  const bytes = new Uint8Array(232 + 4 + proof.length + reason.length)
  const view = new DataView(bytes.buffer)
  bytes[0] = 1
  bytes[1] = SecurityChallengeKind.Sha256PowV1
  bytes[2] = state.envelopeCompleted ? 1 : 0
  view.setInt32(8, state.completedCount, true)
  view.setInt32(12, state.memberCount, true)
  writeFixed(bytes, 16, 64, '01900000-0000-7000-8000-000000000001')
  writeFixed(bytes, 80, 64, '01900000-0000-7000-8000-000000000002')
  writeFixed(bytes, 144, 64, 'risk-v2')
  view.setInt32(208, 0, true)
  view.setInt32(212, proof.length, true)
  view.setInt32(216, proof.length, true)
  view.setInt32(220, reason.length, true)
  view.setBigInt64(224, 1_770_000_300_000n, true)
  view.setInt32(232, proof.length + reason.length, true)
  bytes.set(proof, 236)
  bytes.set(reason, 236 + proof.length)
  return bytes
}

function writeFixed(target: Uint8Array, offset: number, size: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, size), offset)
}
