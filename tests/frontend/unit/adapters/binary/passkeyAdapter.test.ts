import { describe, expect, it } from 'vitest'
import { mapPasskeyCredentialListFromPayload, mapPasskeyLoginBeginFromPayload, mapPasskeyRegisterBeginFromPayload } from '@/adapters/binary/passkeyAdapter'

const encoder = new TextEncoder()

function writeFixed(bytes: Uint8Array, offset: number, length: number, value: string): void {
  bytes.set(encoder.encode(value).subarray(0, length), offset)
}

function writeSliceRef(view: DataView, offset: number, ref: { offset: number; length: number }): void {
  view.setInt32(offset, ref.offset, true)
  view.setInt32(offset + 4, ref.length, true)
}

function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

function withBlob(prefixLength: number, parts: Uint8Array[]): { payload: Uint8Array; refs: Array<{ offset: number; length: number }>; view: DataView } {
  const blobLength = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const payload = new Uint8Array(prefixLength + 4 + blobLength)
  const view = new DataView(payload.buffer)
  const refs: Array<{ offset: number; length: number }> = []
  let offset = 0
  let cursor = prefixLength + 4
  for (const part of parts) {
    refs.push({ offset, length: part.byteLength })
    payload.set(part, cursor)
    offset += part.byteLength
    cursor += part.byteLength
  }
  view.setInt32(prefixLength, blobLength, true)
  return { payload, refs, view }
}

describe('binary passkey adapter', () => {
  it('maps register begin payload into WebAuthn creation options', () => {
    const prefixLength = 148 + 8 + 16 + 4 + 4
    const accountHandle = new Uint8Array(32)
    accountHandle.fill(0x41)
    const { payload, refs, view } = withBlob(prefixLength, [
      utf8('localhost'),
      utf8('FsusBlog'),
      utf8('fsus-anonymous-account'),
      utf8('Anonymous account'),
      accountHandle,
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9, 10, 11])
    ])

    view.setBigUint64(0, 60000n, true)
    view.setInt32(8, 1, true)
    view.setInt32(12, 1, true)
    view.setInt32(16, 0, true)
    view.setInt32(20, 1, true)
    view.setInt32(24, 1, true)
    view.setInt32(28, 0, true)
    payload[32] = 1
    payload[33] = 1
    writeFixed(payload, 36, 64, 'session-1')
    writeSliceRef(view, 100, refs[0])
    writeSliceRef(view, 108, refs[1])
    writeSliceRef(view, 116, refs[2])
    writeSliceRef(view, 124, refs[3])
    writeSliceRef(view, 132, refs[4])
    writeSliceRef(view, 140, refs[5])

    view.setInt32(148, 0, true)
    view.setInt32(152, -7, true)
    view.setInt32(156, 0, true)
    view.setInt32(160, 1, true)
    writeSliceRef(view, 164, refs[6])
    view.setInt32(172, 1, true)
    view.setInt32(176, 5, true)

    expect(mapPasskeyRegisterBeginFromPayload(payload)).toEqual({
      sessionKey: 'session-1',
      options: {
        rp: { id: 'localhost', name: 'FsusBlog' },
        user: { id: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE', name: 'fsus-anonymous-account', displayName: 'Anonymous account' },
        challenge: 'BQYHCA',
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          requireResidentKey: true,
          userVerification: 'preferred'
        },
        excludeCredentials: [{ type: 'public-key', id: 'CQoL', transports: ['internal'] }]
      }
    })
  })

  it('maps login begin payload into WebAuthn request options', () => {
    const prefixLength = 100 + 16 + 4 + 4
    const { payload, refs, view } = withBlob(prefixLength, [
      utf8('localhost'),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6])
    ])

    view.setBigUint64(0, 30000n, true)
    view.setInt32(8, 1, true)
    view.setInt32(12, 2, true)
    writeFixed(payload, 20, 64, 'challenge-1')
    writeSliceRef(view, 84, refs[0])
    writeSliceRef(view, 92, refs[1])
    view.setInt32(100, 0, true)
    view.setInt32(104, 1, true)
    writeSliceRef(view, 108, refs[2])
    view.setInt32(116, 1, true)
    view.setInt32(120, 0, true)

    expect(mapPasskeyLoginBeginFromPayload(payload)).toEqual({
      challengeToken: 'challenge-1',
      options: {
        challenge: 'AQID',
        timeout: 30000,
        rpId: 'localhost',
        userVerification: 'discouraged',
        allowCredentials: [{ type: 'public-key', id: 'BAUG', transports: ['usb'] }]
      }
    })
  })

  it('maps credential list payload', () => {
    const { payload, refs, view } = withBlob(4 + 96, [utf8('Work laptop')])
    view.setInt32(0, 1, true)
    view.setInt32(4, 7, true)
    payload[8] = 1
    payload[9] = 1
    payload[10] = 1
    payload[11] = 0
    view.setBigInt64(12, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    view.setBigInt64(20, BigInt(Date.parse('2026-01-03T04:05:06.000Z')), true)
    writeFixed(payload, 28, 64, 'aaguid-1')
    writeSliceRef(view, 92, refs[0])

    expect(mapPasskeyCredentialListFromPayload(payload)).toEqual([{
      id: 7,
      deviceFriendlyName: 'Work laptop',
      createdAt: '2026-01-02T03:04:05.000Z',
      lastUsedAt: '2026-01-03T04:05:06.000Z',
      aaGuid: 'aaguid-1',
      backupEligible: true,
      backupState: false
    }])
  })
})
