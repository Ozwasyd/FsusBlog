import { describe, expect, it } from 'vitest'
import { mapSecurityChallengeVerifyResponseFromPayload } from '@/adapters/binary/securityAdapter'
import { SecurityChallengeKind } from '@/contracts/binaryApi'

describe('security challenge binary adapter', () => {
  it('decodes the authoritative proof expiry from the fixed response pod', () => {
    const proof = new TextEncoder().encode('fcp_authoritative')
    const reason = new TextEncoder().encode('ok')
    const bytes = new Uint8Array(160 + 4 + proof.length + reason.length)
    const view = new DataView(bytes.buffer)
    bytes[0] = 1
    bytes[1] = SecurityChallengeKind.Sha256PowV1
    view.setInt32(4, 0, true)
    writeFixed(bytes, 8, 64, 'challenge-1')
    writeFixed(bytes, 72, 64, 'risk-v2')
    view.setInt32(136, 0, true)
    view.setInt32(140, proof.length, true)
    view.setInt32(144, proof.length, true)
    view.setInt32(148, reason.length, true)
    view.setBigInt64(152, 1_770_000_300_000n, true)
    view.setInt32(160, proof.length + reason.length, true)
    bytes.set(proof, 164)
    bytes.set(reason, 164 + proof.length)

    const decoded = mapSecurityChallengeVerifyResponseFromPayload(bytes)

    expect(decoded).toEqual({
      verified: true,
      kind: SecurityChallengeKind.Sha256PowV1,
      retryAfterMs: 0,
      challengeId: 'challenge-1',
      policyVersion: 'risk-v2',
      proofToken: 'fcp_authoritative',
      reason: 'ok',
      expiresAtUnixMs: 1_770_000_300_000
    })
  })
})

function writeFixed(target: Uint8Array, offset: number, size: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, size), offset)
}
