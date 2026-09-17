import { describe, expect, it } from 'vitest'
import { mapPageContentFromPayload, mapSeoConfigFromPayload } from '@/adapters/binary/systemAdapter'

describe('system binary adapter', () => {
  it('maps seo config payload', () => {
    const b = new Uint8Array(5000 + 4 + 'Forward'.length)
    writeFixedUtf8(b, 0, 256, 'Fsus')
    writeInt32(b, 256, 0)
    writeInt32(b, 260, 'Forward'.length)
    writeFixedUtf8(b, 264, 256, 'blog,aeds')
    writeFixedUtf8(b, 520, 64, 'Fsu')
    writeFixedUtf8(b, 584, 256, '/og.webp')
    writeFixedUtf8(b, 840, 256, 'https://example.test')
    writeFixedUtf8(b, 1096, 256, '/favicon.svg')
    writeFixedUtf8(b, 1352, 256, '/favicon.ico')
    writeFixedUtf8(b, 1608, 256, '/favicon.png')
    writeFixedUtf8(b, 1864, 256, '/apple-touch-icon.png')
    writeFixedUtf8(b, 2120, 128, 'Fsus Manifest')
    writeFixedUtf8(b, 2248, 128, 'Fsus')
    writeFixedUtf8(b, 2376, 256, '/icon-192.png')
    writeFixedUtf8(b, 2632, 256, '/icon-512.png')
    writeFixedUtf8(b, 2888, 256, '/maskable-512.png')
    writeFixedUtf8(b, 3144, 32, '#0f0f11')
    writeFixedUtf8(b, 3176, 32, '#fcfcfc')
    writeFixedUtf8(b, 3208, 256, '/site-logo.svg')
    writeFixedUtf8(b, 3464, 256, '/site-logo-dark.svg')
    writeFixedUtf8(b, 3720, 256, '/wordmark.svg')
    writeFixedUtf8(b, 3976, 256, '/admin-logo.svg')
    writeFixedUtf8(b, 4232, 256, '/admin-icon.svg')
    writeFixedUtf8(b, 4488, 256, '/login-logo.svg')
    writeFixedUtf8(b, 4744, 256, '/login-icon.svg')
    writeBlob(b, 5000, 'Forward')

    expect(mapSeoConfigFromPayload(b)).toEqual({
      title: 'Fsus',
      description: 'Forward',
      keywords: 'blog,aeds',
      author: 'Fsu',
      ogImage: '/og.webp',
      baseUrl: 'https://example.test',
      faviconSvgUrl: '/favicon.svg',
      faviconIcoUrl: '/favicon.ico',
      faviconPngUrl: '/favicon.png',
      appleTouchIconUrl: '/apple-touch-icon.png',
      manifestName: 'Fsus Manifest',
      manifestShortName: 'Fsus',
      pwaIcon192Url: '/icon-192.png',
      pwaIcon512Url: '/icon-512.png',
      pwaMaskableIconUrl: '/maskable-512.png',
      themeColor: '#0f0f11',
      backgroundColor: '#fcfcfc',
      siteLogoUrl: '/site-logo.svg',
      siteLogoDarkUrl: '/site-logo-dark.svg',
      siteWordmarkUrl: '/wordmark.svg',
      adminLogoUrl: '/admin-logo.svg',
      adminCollapsedIconUrl: '/admin-icon.svg',
      loginLogoUrl: '/login-logo.svg',
      loginIconUrl: '/login-icon.svg'
    })
  })

  it('throws when seo payload has trailing bytes', () => {
    const b = new Uint8Array(5000 + 4 + 'Forward'.length + 1)
    writeFixedUtf8(b, 0, 256, 'Fsus')
    writeInt32(b, 256, 0)
    writeInt32(b, 260, 'Forward'.length)
    writeBlob(b, 5000, 'Forward')
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
