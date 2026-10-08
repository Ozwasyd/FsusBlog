import { describe, expect, it } from 'vitest'
import { mapArticlePageFromPodPayload } from '@/adapters/binary/articleAdapter'
import { mapPublicArticleListCardProjection } from '@/adapters/binary/articleProjectionReader'
import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry'
import { AEDS_ACCESS_PROFILE } from '@/generated/aedsAccessProfiles'
import { ARTICLE_LIST_WIRE as ARTICLE_LIST_ACCESS } from '@/generated/aedsArticleListWire'
import { FrameType } from '@wasm/protocol/frame'

const encoder = new TextEncoder()

function buildArticleListPayload(recordBytes: 56 | 76 | 100, options?: {
  corruptTitleOffset?: boolean
  invalidUtf8?: boolean
  reservedByte?: number
}): Uint8Array {
  const parts = [
    encoder.encode('Tech'),
    options?.invalidUtf8 ? new Uint8Array([0xc3, 0x28]) : encoder.encode('Projection title'),
    encoder.encode('Projection summary'),
    encoder.encode('aeds'),
    encoder.encode('extra')
  ]
  const offsets: Array<{ offset: number; length: number }> = []
  let blobLength = 0
  for (const part of parts) {
    offsets.push({ offset: blobLength, length: part.byteLength })
    blobLength += part.byteLength
  }
  const blob = new Uint8Array(blobLength)
  let blobOffset = 0
  for (const part of parts) {
    blob.set(part, blobOffset)
    blobOffset += part.byteLength
  }

  const prefixBytes = 8 + 1 + 4 + 4 + 4 + 4 + 4
  const payload = new Uint8Array(prefixBytes + blobLength + recordBytes + 2 * 12)
  const view = new DataView(payload.buffer)
  let offset = 0
  view.setInt32(offset, ARTICLE_LIST_ACCESS.cursorMagic, true); offset += 4
  view.setInt32(offset, 2, true); offset += 4
  payload[offset++] = 0
  view.setInt32(offset, 1, true); offset += 4
  view.setInt32(offset, 0, true); offset += 4
  view.setInt32(offset, 1, true); offset += 4
  view.setInt32(offset, 2, true); offset += 4
  view.setInt32(offset, blobLength, true); offset += 4
  payload.set(blob, offset); offset += blobLength

  view.setInt32(offset + 0, 42, true)
  view.setInt32(offset + 4, 900, true)
  view.setBigInt64(offset + 8, 1_715_299_200_000n, true)
  view.setInt32(offset + 16, 7, true)
  const slices = [offsets[0]!, offsets[1]!, offsets[2]!]
  for (let index = 0; index < slices.length; index += 1) {
    const sliceOffset = offset + 20 + index * 8
    view.setInt32(sliceOffset, index === 1 && options?.corruptTitleOffset ? blobLength + 1 : slices[index]!.offset, true)
    view.setInt32(sliceOffset + 4, slices[index]!.length, true)
  }
  view.setInt32(offset + 44, 0, true)
  view.setInt32(offset + 48, 2, true)
  payload[offset + 52] = 0
  payload[offset + 53] = 1
  payload[offset + 54] = options?.reservedByte ?? 0
  payload[offset + 55] = 0
  if (recordBytes >= 76) {
    view.setInt32(offset + 56, 2, true)
    view.setBigInt64(offset + 60, 0n, true)
    view.setBigInt64(offset + 68, 1_715_299_200_000n, true)
  }
  if (recordBytes === 100) {
    view.setBigInt64(offset + 76, 99n, true)
    view.setInt32(offset + 84, 3, true)
    view.setBigInt64(offset + 88, 88n, true)
    view.setInt32(offset + 96, 2, true)
  }
  offset += recordBytes
  for (let index = 0; index < 2; index += 1) {
    view.setInt32(offset, index + 10, true)
    view.setInt32(offset + 4, offsets[index + 3]!.offset, true)
    view.setInt32(offset + 8, offsets[index + 3]!.length, true)
    offset += 12
  }
  return payload
}

describe('ArticleList access projection reader', () => {
  it.each([100] as const)('matches canonical public card fields for %s-byte records', (recordBytes) => {
    const payload = buildArticleListPayload(recordBytes)
    const canonical = mapArticlePageFromPodPayload(payload)
    const projected = mapPublicArticleListCardProjection(payload)

    expect(projected.decodePath).toBe('projection')
    expect(projected.items).toEqual(canonical.items.map((item) => ({
      id: item.id,
      createTime: item.createTime,
      category: item.category,
      title: item.title,
      summary: item.summary,
      tags: item.tags
    })))
    expect(projected.items[0]).not.toHaveProperty('views')
    expect(projected.items[0]).not.toHaveProperty('currentRevisionId')
  })

  it.each([56, 76] as const)('rejects retired %s-byte records in both readers', (size) => {
    const payload = buildArticleListPayload(size)
    expect(() => mapPublicArticleListCardProjection(payload)).toThrow()
    expect(() => mapArticlePageFromPodPayload(payload)).toThrow()
  })

  it.each(['revision', 'publication', 'tag range', 'trailing'] as const)('rejects malformed current %s coordinates in both readers', (kind) => {
    const original = buildArticleListPayload(100)
    const payload = kind === 'trailing' ? new Uint8Array([...original, 0]) : original
    const view = new DataView(payload.buffer)
    const offset = 29 + view.getInt32(25, true)
    if (kind === 'revision') view.setBigInt64(offset + ARTICLE_LIST_ACCESS.offsets.currentRevisionId, 0n, true)
    if (kind === 'publication') view.setInt32(offset + ARTICLE_LIST_ACCESS.offsets.publicationNo, 0, true)
    if (kind === 'tag range') view.setInt32(offset + ARTICLE_LIST_ACCESS.offsets.tagCount, 3, true)
    expect(() => mapPublicArticleListCardProjection(payload)).toThrow()
    expect(() => mapArticlePageFromPodPayload(payload)).toThrow()
  })

  it.each([
    ['slice range', { corruptTitleOffset: true }],
    ['utf8', { invalidUtf8: true }],
    ['reserved bytes', { reservedByte: 1 }]
  ])('rejects malformed %s without partial success', (_name, options) => {
    expect(() => mapPublicArticleListCardProjection(buildArticleListPayload(100, options))).toThrow()
  })

  it('dispatches the profile through the shared decoder registry entrypoint', () => {
    const decoded = decodeBinaryFramePayload(
      FrameType.ArticleList,
      buildArticleListPayload(100),
      AEDS_ACCESS_PROFILE.publicArticleListCard
    )
    expect(decoded).toMatchObject({ decodePath: 'projection', total: 1 })
  })
})
