import { describe, expect, it } from 'vitest'
import {
  BRAND_ICON_SET_UPLOADS,
  encodeIcoFromPngEntries,
  getSafeBrandIconBaseName,
  isRasterBrandIconSource
} from '@/utils/brandIconGenerator'

const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('brand icon generator', () => {
  it('declares the favicon and PWA fields generated from one raster source', () => {
    expect(BRAND_ICON_SET_UPLOADS.map((target) => target.field)).toEqual([
      'faviconIcoUrl',
      'faviconPngUrl',
      'appleTouchIconUrl',
      'pwaIcon192Url',
      'pwaIcon512Url',
      'pwaMaskableIconUrl'
    ])
    expect(BRAND_ICON_SET_UPLOADS.find((target) => target.field === 'faviconIcoUrl')?.format).toBe('ico')
    const targetFields: readonly string[] = BRAND_ICON_SET_UPLOADS.map((target) => target.field)
    expect(targetFields.every((field) => field !== 'faviconSvgUrl')).toBe(true)
  })

  it('encodes PNG payloads into a valid ICO directory', () => {
    const ico = encodeIcoFromPngEntries([
      { size: 16, png: pngHeader },
      { size: 32, png: new Uint8Array([...pngHeader, 0x20]) }
    ])
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength)

    expect(view.getUint16(0, true)).toBe(0)
    expect(view.getUint16(2, true)).toBe(1)
    expect(view.getUint16(4, true)).toBe(2)
    expect(ico[6]).toBe(16)
    expect(ico[7]).toBe(16)
    expect(view.getUint32(14, true)).toBe(pngHeader.byteLength)
    expect(view.getUint32(18, true)).toBe(6 + 16 * 2)
    expect(ico[22]).toBe(32)
    expect(ico[23]).toBe(32)
  })

  it('accepts common raster sources but rejects SVG sources', () => {
    expect(isRasterBrandIconSource(new File([pngHeader], 'logo.png', { type: 'image/png' }))).toBe(true)
    expect(isRasterBrandIconSource(new File([pngHeader], 'logo.webp', { type: 'image/webp' }))).toBe(true)
    expect(isRasterBrandIconSource(new File(['<svg></svg>'], 'logo.svg', { type: 'image/svg+xml' }))).toBe(false)
    expect(getSafeBrandIconBaseName(' ../Brand Logo.svg ')).toBe('Brand-Logo')
  })
})
