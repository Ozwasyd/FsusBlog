import { describe, expect, it } from 'vitest'
import { mapSecurityChallengeIssueResponseFromPayload } from '@/adapters/binary/securityAdapter'
import { encodeSecurityChallengeVerifyRequest } from '@/codecs/binary/securityRequestEncoder'
import {
  PerceptionCharacterV3Representation,
  SecurityChallengeKind
} from '@/contracts/binaryApi'

const challengeId = '01900000-0000-7000-8000-000000000014'
const envelopeId = '01900000-0000-7000-8000-000000000001'
const policyVersion = 'risk-v3'
const algorithm = 'fsu.challenge/perception-character-raster@v3'

describe('PerceptionCharacterV3 typed transport', () => {
  it('decodes the nested issue POD and preserves bounded Gray8 media', () => {
    const decoded = mapSecurityChallengeIssueResponseFromPayload(createIssueResponse())
    const typed = decoded.providerPayloads[0]?.perceptionCharacterV3

    expect(decoded.envelope?.assignments[0]?.kind).toBe(SecurityChallengeKind.PerceptionCharacterV3)
    expect(typed).toMatchObject({
      algorithm,
      challengeId,
      envelopeId,
      representation: PerceptionCharacterV3Representation.Visual,
      mediaType: 'application/x-fsus-gray8',
      physicalWidth: 512,
      physicalHeight: 192,
      displayWidth: 320,
      displayHeight: 120,
      attemptBudget: 2,
      policyVersion,
      stateToken: 'opaque-state'
    })
    expect(typed?.mediaBytes).toHaveLength(512 * 192)
    expect(decoded.providerPayloads[0]?.payload).toEqual({})
  })

  it('rejects an oversized media slice before exposing or copying it', () => {
    const response = createIssueResponse()
    const outerBlobStart = 148 + 664 + 72 + 4
    const nestedView = new DataView(response.buffer, response.byteOffset + outerBlobStart)
    nestedView.setInt32(240, 0, true)
    nestedView.setInt32(244, 512 * 192 + 1, true)

    expect(() => mapSecurityChallengeIssueResponseFromPayload(response)).toThrow('perception_character_v3_media_size_invalid')
  })

  it('encodes verify as the closed nested typed POD without forbidden client truth', () => {
    const encoded = encodeSecurityChallengeVerifyRequest({
      envelopeId,
      challengeId,
      kind: SecurityChallengeKind.PerceptionCharacterV3,
      action: 'comment.create',
      routeKey: '/article/42',
      providerPayloadJson: '',
      perceptionCharacterV3: {
        algorithm,
        challengeId,
        envelopeId,
        representation: PerceptionCharacterV3Representation.Visual,
        answer: 'AB12CD',
        stateToken: 'opaque-state'
      }
    })
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    const outerBlobStart = 48
    const nestedOffset = view.getInt32(36, true)
    const nestedLength = view.getInt32(40, true)
    const nested = encoded.subarray(outerBlobStart + nestedOffset, outerBlobStart + nestedOffset + nestedLength)

    expect(encoded[0]).toBe(SecurityChallengeKind.PerceptionCharacterV3)
    expect(nested[0]).toBe(PerceptionCharacterV3Representation.Visual)
    expect(readFixed(nested, 4, 64)).toBe(challengeId)
    expect(readFixed(nested, 68, 64)).toBe(envelopeId)
    expect(new TextDecoder().decode(nested)).not.toMatch(/solveDuration|recipe|seed|glyph|verifier/iu)
  })
})

function createIssueResponse(): Uint8Array {
  const media = new Uint8Array(512 * 192).fill(127)
  const nestedBlobParts = [encode(algorithm), encode('application/x-fsus-gray8'), media, encode('opaque-state')]
  const nestedBlobLength = nestedBlobParts.reduce((sum, part) => sum + part.byteLength, 0)
  const nested = new Uint8Array(256 + 4 + nestedBlobLength)
  const nestedView = new DataView(nested.buffer)
  nested[0] = PerceptionCharacterV3Representation.Visual
  nested[1] = 2
  nestedView.setUint16(2, 512, true)
  nestedView.setUint16(4, 192, true)
  nestedView.setUint16(6, 320, true)
  nestedView.setUint16(8, 120, true)
  nestedView.setInt32(12, media.byteLength, true)
  nestedView.setBigInt64(16, 1_770_000_000_000n, true)
  nestedView.setBigInt64(24, 1_770_000_300_000n, true)
  writeFixed(nested, 32, 64, challengeId)
  writeFixed(nested, 96, 64, envelopeId)
  writeFixed(nested, 160, 64, policyVersion)
  let offset = 0
  nestedBlobParts.forEach((part, index) => {
    nestedView.setInt32(224 + index * 8, offset, true)
    nestedView.setInt32(228 + index * 8, part.byteLength, true)
    nested.set(part, 260 + offset)
    offset += part.byteLength
  })
  nestedView.setInt32(256, nestedBlobLength, true)

  const outer = new Uint8Array(148 + 664 + 72 + 4 + nested.byteLength)
  const view = new DataView(outer.buffer)
  outer[0] = 2
  outer[1] = 1
  view.setUint16(2, 1, true)
  writeFixed(outer, 20, 64, envelopeId)
  writeFixed(outer, 84, 64, policyVersion)
  const assignment = 148
  outer[assignment] = SecurityChallengeKind.PerceptionCharacterV3
  view.setBigInt64(assignment + 8, 1_770_000_000_000n, true)
  view.setBigInt64(assignment + 16, 1_770_000_300_000n, true)
  writeFixed(outer, assignment + 24, 64, challengeId)
  writeFixed(outer, assignment + 280, 64, 'comment.create')
  writeFixed(outer, assignment + 344, 128, '/article/42')
  const provider = assignment + 664
  writeFixed(outer, provider, 64, challengeId)
  view.setInt32(provider + 64, 0, true)
  view.setInt32(provider + 68, nested.byteLength, true)
  view.setInt32(provider + 72, nested.byteLength, true)
  outer.set(nested, provider + 76)
  return outer
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function writeFixed(target: Uint8Array, offset: number, size: number, value: string): void {
  target.set(encode(value).subarray(0, size), offset)
}

function readFixed(source: Uint8Array, offset: number, size: number): string {
  const end = source.subarray(offset, offset + size).indexOf(0)
  return new TextDecoder().decode(source.subarray(offset, end < 0 ? offset + size : offset + end))
}
