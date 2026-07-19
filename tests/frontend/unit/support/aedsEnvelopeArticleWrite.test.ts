import { describe, expect, it } from 'vitest'
import { encodeArticleWriteRequest } from '../../support/aeds-envelope.mjs'

describe('support ArticleWriteRequest encoder', () => {
  it('emits the V4 preserve mode when rights are omitted', () => {
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

    expect(parsed.version).toBe(4)
    expect(parsed.rightsMutation).toBe(0)
    expect(parsed.flags).toBe(15)
    expect(parsed.copyrightYear).toBe(0)
    expect(parsed.maxExcerptChars).toBe(300)
    expect(parsed.rights.licenseType).toBe('all-rights-reserved')
    expect(parsed.rights.copyPolicy).toBe('append-attribution')
  })
})

function parseArticleWriteRequestPayload(payload: Uint8Array): {
  version: number
  rightsMutation: number
  flags: number
  copyrightYear: number
  maxExcerptChars: number
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

  return {
    version,
    rightsMutation,
    flags,
    copyrightYear,
    maxExcerptChars,
    rights: {
      licenseType: readSlice(0),
      copyrightHolder: readSlice(1),
      rightsStatement: readSlice(2),
      attributionTemplate: readSlice(3),
      copyPolicy: readSlice(4)
    }
  }
}
