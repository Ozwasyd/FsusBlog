import { describe, it, expect } from 'vitest'
import { mapHumanReadChallengeFromPayload, mapHumanReadSubmitFromPayload } from '@/adapters/binary/readProofAdapter'

const encoder = new TextEncoder()

describe('readProof binary adapter', () => {
  it('maps challenge response payload', () => {
    const issued = Date.UTC(2026, 4, 20, 8, 30, 0)
    const expires = issued + 5 * 60 * 1000
    const payload = withBlob(52, ['token-1', 'article', 'article:42'], (view, refs) => {
      view.setInt32(0, 42, true)
      view.setInt32(4, 8000, true)
      view.setBigInt64(8, BigInt(issued), true)
      view.setBigInt64(16, BigInt(expires), true)
      view.setUint8(24, 1)
      writeSliceRef(view, 28, refs[0])
      writeSliceRef(view, 36, refs[1])
      writeSliceRef(view, 44, refs[2])
    })

    expect(mapHumanReadChallengeFromPayload(payload)).toEqual({
      token: 'token-1',
      scope: 'article',
      routeKey: 'article:42',
      articleId: 42,
      minDwellMs: 8000,
      issuedAt: '2026-05-20T08:30:00.000Z',
      expiresAt: '2026-05-20T08:35:00.000Z'
    })
  })

  it('maps submit response payload', () => {
    const payload = withBlob(12, ['counted'], (view, refs) => {
      view.setUint8(0, 1)
      writeSliceRef(view, 4, refs[0])
    })

    expect(mapHumanReadSubmitFromPayload(payload)).toEqual({
      counted: true,
      status: 'counted'
    })
  })
})

function withBlob(
  podSize: number,
  values: string[],
  writePod: (view: DataView, refs: Array<{ offset: number; length: number }>) => void
): Uint8Array {
  const parts = values.map((value) => encoder.encode(value))
  const refs: Array<{ offset: number; length: number }> = []
  let blobLength = 0
  for (const part of parts) {
    refs.push({ offset: blobLength, length: part.byteLength })
    blobLength += part.byteLength
  }

  const payload = new Uint8Array(podSize + 4 + blobLength)
  const view = new DataView(payload.buffer)
  writePod(view, refs)
  view.setInt32(podSize, blobLength, true)

  let blobOffset = podSize + 4
  for (const part of parts) {
    payload.set(part, blobOffset)
    blobOffset += part.byteLength
  }

  return payload
}

function writeSliceRef(view: DataView, offset: number, ref: { offset: number; length: number } | undefined): void {
  view.setInt32(offset, ref?.offset ?? 0, true)
  view.setInt32(offset + 4, ref?.length ?? 0, true)
}
