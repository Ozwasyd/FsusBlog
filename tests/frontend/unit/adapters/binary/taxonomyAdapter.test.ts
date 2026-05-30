import { describe, expect, it } from 'vitest'
import { mapCategoryListFromPayload, mapTagListFromPayload } from '@/adapters/binary/taxonomyAdapter'

describe('taxonomy binary adapter', () => {
  it('maps category list payload', () => {
    const payload = buildPayload([
      { id: 1, name: 'Tech', articleCount: 2 },
      { id: 2, name: 'Life', articleCount: 0 }
    ])

    expect(mapCategoryListFromPayload(payload)).toEqual([
      { id: 1, name: 'Tech', articleCount: 2 },
      { id: 2, name: 'Life', articleCount: 0 }
    ])
  })

  it('maps tag list payload', () => {
    const payload = buildPayload([
      { id: 7, name: 'dotnet', articleCount: 5 }
    ])

    expect(mapTagListFromPayload(payload)).toEqual([
      { id: 7, name: 'dotnet', articleCount: 5 }
    ])
  })

  it('throws on invalid payload size', () => {
    expect(() => mapCategoryListFromPayload(new Uint8Array([1, 0, 0, 0]))).toThrow()
  })
})

function buildPayload(items: Array<{ id: number; name: string; articleCount: number }>): Uint8Array {
  const encoder = new TextEncoder()
  const names = items.map(item => encoder.encode(item.name))
  const blobLength = names.reduce((sum, name) => sum + name.byteLength, 0)
  const bytes = new Uint8Array(8 + blobLength + items.length * 16)
  const view = new DataView(bytes.buffer)
  view.setInt32(0, items.length, true)
  view.setInt32(4, blobLength, true)

  let blobOffset = 8
  for (const name of names) {
    bytes.set(name, blobOffset)
    blobOffset += name.byteLength
  }

  let nameOffset = 0
  let recordOffset = 8 + blobLength
  items.forEach((item, index) => {
    const name = names[index]!
    view.setInt32(recordOffset, item.id, true)
    view.setInt32(recordOffset + 4, item.articleCount, true)
    view.setInt32(recordOffset + 8, nameOffset, true)
    view.setInt32(recordOffset + 12, name.byteLength, true)
    nameOffset += name.byteLength
    recordOffset += 16
  })

  return bytes
}
