import { describe, expect, it } from 'vitest'
import golden from '../../../../fixtures/protocol/writing-aid-preference-wire-golden.json'
import { FrameType } from '@wasm/protocol/frame'
import { encodeWritingAidPreferenceUpdateRequest } from '@/api/binaryFrame'
import type {
  WritingAidPreferenceReceipt,
  WritingAidPreferenceSnapshot,
  WritingAidPreferenceUpdate
} from '@/contracts/binaryApi'
import {
  decodeWritingAidPreferenceUpdateRequest,
  encodeWritingAidPreferenceReceipt,
  encodeWritingAidPreferenceSnapshot
} from '@/codecs/binary/writingAidPreferenceWire.generated'
import {
  binaryFrameDecoderRegistrations,
  decodeBinaryFramePayload
} from '@/composition/binaryDecoderRegistry'

// These are content-only protocol fixtures, with no authentication, device or
// persistence authority. Response decoding goes through the actual Root registry.
describe('writing aid public frame and registered response boundary', () => {
  it('binds the two real response registrations and refuses the write command as a response', () => {
    expect(FrameType.WritingAidPreferenceSnapshotResponse).toBe(272)
    expect(FrameType.WritingAidPreferenceUpdateRequest).toBe(273)
    expect(FrameType.WritingAidPreferenceReceiptResponse).toBe(274)
    expect(binaryFrameDecoderRegistrations
      .filter(([frame]) => frame >= 272 && frame <= 274)
      .map(([frame, decoder]) => [frame, decoder.name]))
      .toEqual([[272, 'decodeWritingAidPreferenceSnapshot'], [274, 'decodeWritingAidPreferenceReceipt']])
    const row = golden.cases.find(candidate => candidate.name === 'update-values-5')!
    expect(() => decodeBinaryFramePayload(FrameType.WritingAidPreferenceUpdateRequest, Buffer.from(row.payloadHex, 'hex')))
      .toThrow('frame_type_unsupported:273')
  })

  it('exposes exact owner-free Update bytes through the handwritten public export', () => {
    const update: WritingAidPreferenceUpdate = {
      expectedRevision: 7,
      operationId: '01234567-89ab-cdef-0123-456789abcdef',
      values: { schemaVersion: 1, focusEnabled: true, typewriterEnabled: false, immersiveEnabled: true }
    }
    const expected = golden.cases.find(candidate => candidate.name === 'update-values-5')!
    expect(Buffer.from(encodeWritingAidPreferenceUpdateRequest(update)).toString('hex')).toBe(expected.payloadHex)
    expect(() => encodeWritingAidPreferenceUpdateRequest({ ...update, owner: expected.expectedOwner } as WritingAidPreferenceUpdate))
      .toThrow('writing_aid_preference_payload_invalid')
    expect(() => encodeWritingAidPreferenceUpdateRequest({ ...update, deviceScope: 'device:' + 'a'.repeat(64) } as WritingAidPreferenceUpdate))
      .toThrow('writing_aid_preference_payload_invalid')
  })

  it.each(golden.cases)('$name retains independent wire bytes or refuses at the actual boundary', row => {
    const bytes = Uint8Array.from(Buffer.from(row.payloadHex, 'hex'))
    const decode = () => row.frameType === FrameType.WritingAidPreferenceUpdateRequest
      ? decodeWritingAidPreferenceUpdateRequest(bytes)
      : decodeBinaryFramePayload(row.frameType as FrameType, bytes)
    if (!row.valid) {
      if (row.name.endsWith('invalid-utf8')) {
        expect(decode).toThrow(TypeError)
        expect(decode).toThrow('The encoded data was not valid for encoding utf-8')
      } else {
        expect(decode).toThrow('writing_aid_preference_payload_invalid')
      }
      return
    }
    if (row.frameType === FrameType.WritingAidPreferenceUpdateRequest) {
      const update = decode() as WritingAidPreferenceUpdate
      expect(Object.keys(update).sort()).toEqual(['expectedRevision', 'operationId', 'values'])
      expect(Buffer.from(encodeWritingAidPreferenceUpdateRequest(update)).toString('hex')).toBe(row.payloadHex)
    } else if (row.frameType === FrameType.WritingAidPreferenceSnapshotResponse) {
      const snapshot = decode() as WritingAidPreferenceSnapshot
      expect(snapshot.owner).toEqual(row.expectedOwner)
      expect(snapshot.values.schemaVersion).toBe(1)
      expect(Buffer.from(encodeWritingAidPreferenceSnapshot(snapshot)).toString('hex')).toBe(row.payloadHex)
    } else {
      const receipt = decode() as WritingAidPreferenceReceipt
      expect(receipt.previous.owner).toEqual(row.expectedOwner)
      expect(receipt.committed.owner).toEqual(row.expectedOwner)
      expect(receipt.status).toBe('committed')
      expect(receipt.committed.revision).toBe(receipt.previous.revision + 1)
      expect(Buffer.from(encodeWritingAidPreferenceReceipt(receipt)).toString('hex')).toBe(row.payloadHex)
    }
  })
})
