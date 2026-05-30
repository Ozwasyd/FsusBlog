import { describe, expect, it } from 'vitest'
import { mapPageContentFromPayload, mapSeoConfigFromPayload } from '@/adapters/binary/systemAdapter'

describe('system binary adapter', () => {
  it('maps seo config payload', () => {
    const b = new Uint8Array(1096 + 4 + 'Forward'.length)
    writeFixedUtf8(b, 0, 256, 'Fsus')
    writeInt32(b, 256, 0)
    writeInt32(b, 260, 'Forward'.length)
    writeFixedUtf8(b, 264, 256, 'blog,aeds')
    writeFixedUtf8(b, 520, 64, 'Fsu')
    writeFixedUtf8(b, 584, 256, '/og.webp')
    writeFixedUtf8(b, 840, 256, 'https://example.test')
    writeBlob(b, 1096, 'Forward')

    expect(mapSeoConfigFromPayload(b)).toEqual({
      title: 'Fsus',
      description: 'Forward',
      keywords: 'blog,aeds',
      author: 'Fsu',
      ogImage: '/og.webp',
      baseUrl: 'https://example.test'
    })
  })

  it('throws when seo payload has trailing bytes', () => {
    const b = new Uint8Array(1096 + 4 + 'Forward'.length + 1)
    writeFixedUtf8(b, 0, 256, 'Fsus')
    writeInt32(b, 256, 0)
    writeInt32(b, 260, 'Forward'.length)
    writeBlob(b, 1096, 'Forward')
    b[b.length - 1] = 1

    expect(() => mapSeoConfigFromPayload(b)).toThrow()
  })

  it('maps page content payload', () => {
    const content = '# About'
    const b = new Uint8Array(136 + 4 + content.length)
    writeFixedUtf8(b, 0, 128, 'about')
    writeInt32(b, 128, 0)
    writeInt32(b, 132, content.length)
    writeBlob(b, 136, content)

    expect(mapPageContentFromPayload(b)).toEqual({
      slug: 'about',
      content
    })
  })

  it('throws when page content payload has trailing bytes', () => {
    const content = '# About'
    const b = new Uint8Array(136 + 4 + content.length + 1)
    writeFixedUtf8(b, 0, 128, 'about')
    writeInt32(b, 128, 0)
    writeInt32(b, 132, content.length)
    writeBlob(b, 136, content)
    b[b.length - 1] = 1

    expect(() => mapPageContentFromPayload(b)).toThrow()
  })
})

function writeInt32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff
  b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff
  b[off + 3] = (v >>> 24) & 0xff
}

function writeFixedUtf8(b: Uint8Array, off: number, length: number, value: string): void {
  b.set(new TextEncoder().encode(value).subarray(0, length), off)
}

function writeBlob(b: Uint8Array, off: number, value: string): void {
  const payload = new TextEncoder().encode(value)
  writeInt32(b, off, payload.byteLength)
  b.set(payload, off + 4)
}
