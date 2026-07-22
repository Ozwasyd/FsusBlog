import { describe, expect, it } from 'vitest'
import { decodeAedsFrame, encodeAedsFrame, encodeArticleWriteRequest, readAedsResponse } from '../../support/aeds-envelope.mjs'

describe('support ArticleWriteRequest encoder', () => {
  it('emits the V5 preserve mode and zero create base revision when rights are omitted', () => {
    const payload = encodeArticleWriteRequest({
      title: 'Title',
      content: 'Content',
      summary: 'Summary',
      coverImageUrl: '',
      categoryId: 3,
      tagIds: [1, 2],
      status: 0,
      scheduledPublishAt: null
    })

    const parsed = parseArticleWriteRequestPayload(payload)

    expect(parsed.version).toBe(5)
    expect(parsed.rightsMutation).toBe(0)
    expect(parsed.flags).toBe(15)
    expect(parsed.copyrightYear).toBe(0)
    expect(parsed.maxExcerptChars).toBe(300)
    expect(parsed.rights.licenseType).toBe('all-rights-reserved')
    expect(parsed.rights.copyPolicy).toBe('append-attribution')
    expect(parsed.baseRevisionId).toBe(0n)
  })

  it('appends the update base revision coordinate', () => {
    const payload = encodeArticleWriteRequest({
      title: 'Title',
      content: 'Content',
      categoryId: 3,
      tagIds: [],
      baseRevisionId: 8123
    })

    expect(parseArticleWriteRequestPayload(payload).baseRevisionId).toBe(8123n)
  })

  it('decodes the 48-byte article mutation result carried by MutationId', async () => {
    const payload = new Uint8Array(48)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 42, true)
    view.setBigInt64(4, 8123n, true)
    view.setInt32(12, 8, true)
    view.setBigInt64(16, 7201n, true)
    view.setInt32(24, 4, true)
    view.setInt32(28, 2, true)
    view.setBigInt64(32, 9001n, true)
    view.setInt32(40, 7, true)
    payload[44] = 1

    const frame = encodeAedsFrame(241, payload)
    const decoded = await readAedsResponse({ arrayBuffer: async () => frame })

    expect(decoded).toMatchObject({
      id: 42,
      articleId: 42,
      revisionId: 8123,
      revisionNo: 8,
      releaseId: 7201,
      releaseNo: 4,
      status: 2,
      rightsSnapshotId: 9001,
      rightsRevisionNo: 7,
      idempotencyReplay: true,
      errorCode: 0,
      outcome: 0
    })
    expect(decodeAedsFrame(frame).payload).toHaveLength(48)
  })
})

function parseArticleWriteRequestPayload(payload: Uint8Array): {
  version: number
  rightsMutation: number
  flags: number
  copyrightYear: number
  maxExcerptChars: number
  baseRevisionId: bigint
  rights: Record<'licenseType' | 'copyrightHolder' | 'rightsStatement' | 'attributionTemplate' | 'copyPolicy', string>
} {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const decoder = new TextDecoder()
  const tagCount = view.getInt32(4, true)
  let cursor = 40 + tagCount * 4
  const articleBlobLength = view.getInt32(cursor, true)
  cursor += 4 + articleBlobLength
  cursor += 4
  cursor += 8
  const version = view.getInt32(cursor, true)
  cursor += 4
  const rightsMutation = view.getInt32(cursor, true)
  cursor += 4
  const flags = view.getInt32(cursor, true)
  cursor += 4
  const copyrightYear = view.getInt32(cursor, true)
  cursor += 4
  const maxExcerptChars = view.getInt32(cursor, true)
  cursor += 4

  const sliceRefs = Array.from({ length: 5 }, () => {
    const offset = view.getInt32(cursor, true)
    const length = view.getInt32(cursor + 4, true)
    cursor += 8
    return { offset, length }
  })
  const rightsBlobLength = view.getInt32(cursor, true)
  cursor += 4
  const rightsBlob = payload.subarray(cursor, cursor + rightsBlobLength)
  const readSlice = (index: number) => {
    const slice = sliceRefs[index]!
    return decoder.decode(rightsBlob.subarray(slice.offset, slice.offset + slice.length))
  }

  cursor += rightsBlobLength
  const baseRevisionId = view.getBigInt64(cursor, true)

  return {
    version,
    rightsMutation,
    flags,
    copyrightYear,
    maxExcerptChars,
    baseRevisionId,
    rights: {
      licenseType: readSlice(0),
      copyrightHolder: readSlice(1),
      rightsStatement: readSlice(2),
      attributionTemplate: readSlice(3),
      copyPolicy: readSlice(4)
    }
  }
}
