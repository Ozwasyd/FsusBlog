import { describe, expect, it, vi } from 'vitest'

import {
  createFontPreparationPort,
  FONT_PREPARATION_RECEIPT_SCHEMA,
  type FontFaceSetPort
} from '@/bootstrap/fontPreparationPort'
import {
  ENABLED_LOCALES,
  type SupportedLocale
} from '@/locales/localeCatalog'
import {
  LOCALE_FONT_CATALOG,
  LOCALE_FONT_CATALOG_DIGEST,
  LOCALE_FONT_WEIGHTS,
  SCRIPT_FONT_CATALOG,
  type LocaleFontScript,
  type LocaleFontWeight
} from '@/locales/localeFontCatalog'

function createFontFaceSet(
  available: ReadonlySet<string> = new Set(LOCALE_FONT_WEIGHTS.map(String))
): FontFaceSetPort & {
  load: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
} {
  const load = vi.fn(async (query: string, text?: string) => {
    const weight = query.split(' ')[0] ?? ''
    if (!available.has(weight)) {
      return []
    }
    return [{ family: query, text }]
  })
  const check = vi.fn((query: string) => {
    const weight = query.split(' ')[0] ?? ''
    return available.has(weight)
  })
  return { load, check }
}

function createPort(options?: {
  available?: ReadonlySet<string>
  loadScriptStyle?: (script: LocaleFontScript) => Promise<unknown>
  fontFaceSet?: () => FontFaceSetPort | undefined
}) {
  const fontFaceSet = options?.fontFaceSet
    ?? (() => createFontFaceSet(options?.available))
  const loadScriptStyle = options?.loadScriptStyle
    ?? vi.fn(async () => undefined)
  return {
    port: createFontPreparationPort({ fontFaceSet, loadScriptStyle }),
    loadScriptStyle: loadScriptStyle as ReturnType<typeof vi.fn>,
    fontFaceSet
  }
}

describe('localeFontCatalog', () => {
  it('projects exactly the enabled locale inventory without zh-TW', () => {
    expect(Object.keys(LOCALE_FONT_CATALOG).sort()).toEqual(
      ENABLED_LOCALES.map((locale) => locale.code).sort()
    )
    expect(LOCALE_FONT_CATALOG).not.toHaveProperty('zh-TW')
    expect(JSON.stringify(LOCALE_FONT_CATALOG)).not.toMatch(/"zh-TW"/u)
    expect(LOCALE_FONT_WEIGHTS).toEqual([400, 500, 700])
  })

  it('maps every script to a bundled face family and representative glyphs', () => {
    expect(Object.keys(SCRIPT_FONT_CATALOG).sort()).toEqual(
      ['Cyrl', 'Hans', 'Hant', 'Jpan', 'Kore', 'Latn'].sort()
    )
    expect(LOCALE_FONT_CATALOG['zh-CN']).toMatchObject({
      script: 'Hans',
      family: 'Noto Sans SC',
      faceIds: ['noto-sans-sc:400', 'noto-sans-sc:500', 'noto-sans-sc:700'],
      representativeText: '汉语字形'
    })
    expect(LOCALE_FONT_CATALOG['zh-Hant']).toMatchObject({
      script: 'Hant',
      family: 'Noto Sans TC',
      faceIds: ['noto-sans-tc:400', 'noto-sans-tc:500', 'noto-sans-tc:700'],
      representativeText: '漢語字形'
    })
    expect(LOCALE_FONT_CATALOG['ja-JP']).toMatchObject({
      script: 'Jpan',
      family: 'Noto Sans JP'
    })
    expect(LOCALE_FONT_CATALOG['ko-KR']).toMatchObject({
      script: 'Kore',
      family: 'Noto Sans KR',
      faceIds: ['noto-sans-kr:400', 'noto-sans-kr:500', 'noto-sans-kr:700'],
      representativeText: '한국어글꼴'
    })
    expect(LOCALE_FONT_CATALOG['ru-RU']).toMatchObject({
      script: 'Cyrl',
      family: 'Google Sans',
      representativeText: 'Привет'
    })
    for (const locale of ['en-US', 'es-419', 'fr-FR', 'de-DE', 'pt-BR'] as const) {
      expect(LOCALE_FONT_CATALOG[locale]).toMatchObject({
        script: 'Latn',
        family: 'Google Sans',
        representativeText: 'Àéñçõ'
      })
    }
    expect(JSON.stringify(LOCALE_FONT_CATALOG)).not.toMatch(/https?:\/\//u)
    expect(JSON.stringify(SCRIPT_FONT_CATALOG)).not.toMatch(/fonts\.googleapis|cdn\./iu)
  })
})

describe('fontPreparationPort', () => {
  it('prepares first-paint zh-Hant faces with Traditional Han glyph evidence', async () => {
    const faces = createFontFaceSet()
    const { port, loadScriptStyle } = createPort({
      fontFaceSet: () => faces
    })

    const receipt = await port.prepareLocaleFonts('zh-Hant', [400, 500])

    expect(receipt).toMatchObject({
      schema: FONT_PREPARATION_RECEIPT_SCHEMA,
      locale: 'zh-Hant',
      script: 'Hant',
      family: 'Noto Sans TC',
      faceIds: ['noto-sans-tc:400', 'noto-sans-tc:500'],
      weights: [400, 500],
      representativeText: '漢語字形',
      catalogDigest: LOCALE_FONT_CATALOG_DIGEST
    })
    expect(receipt.generation).toBe(1)
    expect(loadScriptStyle).toHaveBeenCalledTimes(1)
    expect(loadScriptStyle).toHaveBeenCalledWith('Hant')
    expect(faces.load).toHaveBeenCalledWith('400 1em "Noto Sans TC"', '漢語字形')
    expect(faces.check).toHaveBeenCalledWith('400 1em "Noto Sans TC"', '漢語字形')
    expect(port.peekPreparedLocaleFonts('zh-Hant')).toBe(receipt)
  })

  it('switches zh-CN to ja-JP by loading only the target Jpan script', async () => {
    const { port, loadScriptStyle } = createPort()

    await port.prepareLocaleFonts('zh-CN', [400, 500])
    const japanese = await port.prepareLocaleFonts('ja-JP', [400, 500])

    expect(loadScriptStyle.mock.calls.map((call) => call[0])).toEqual(['Hans', 'Jpan'])
    expect(japanese).toMatchObject({
      locale: 'ja-JP',
      script: 'Jpan',
      family: 'Noto Sans JP',
      faceIds: ['noto-sans-jp:400', 'noto-sans-jp:500']
    })
  })

  it('covers the required locale transition matrix with script-scoped loads', async () => {
    const { port, loadScriptStyle } = createPort()
    const matrix: ReadonlyArray<readonly [SupportedLocale, LocaleFontScript]> = [
      ['zh-Hant', 'Hant'],
      ['zh-CN', 'Hans'],
      ['ja-JP', 'Jpan'],
      ['ko-KR', 'Kore'],
      ['en-US', 'Latn'],
      ['ru-RU', 'Cyrl'],
      ['fr-FR', 'Latn'],
      ['de-DE', 'Latn'],
      ['es-419', 'Latn'],
      ['pt-BR', 'Latn']
    ]

    for (const [locale, script] of matrix) {
      const receipt = await port.prepareLocaleFonts(locale, [400, 500, 700])
      expect(receipt.script).toBe(script)
      expect(receipt.weights).toEqual([400, 500, 700])
      expect(receipt.faceIds).toEqual(LOCALE_FONT_CATALOG[locale].faceIds)
    }

    expect(loadScriptStyle.mock.calls.map((call) => call[0])).toEqual([
      'Hant',
      'Hans',
      'Jpan',
      'Kore',
      'Latn',
      'Cyrl'
    ])
  })

  it('deduplicates concurrent same-script face loads and reuses cached faces', async () => {
    let resolveStyle: (() => void) | undefined
    const loadScriptStyle = vi.fn(() => new Promise((resolve) => {
      resolveStyle = () => resolve(undefined)
    }))
    const faces = createFontFaceSet()
    const { port } = createPort({
      loadScriptStyle,
      fontFaceSet: () => faces
    })

    const first = port.prepareLocaleFonts('zh-CN', [400, 500])
    const second = port.prepareLocaleFonts('zh-CN', [400, 500])
    expect(loadScriptStyle).toHaveBeenCalledTimes(1)
    resolveStyle?.()
    const [left, right] = await Promise.all([first, second])
    expect(left.faceIds).toEqual(right.faceIds)
    expect(faces.load).toHaveBeenCalledTimes(2)

    faces.load.mockClear()
    loadScriptStyle.mockClear()
    const reused = await port.prepareLocaleFonts('zh-CN', [400])
    expect(reused.faceIds).toEqual(['noto-sans-sc:400'])
    expect(loadScriptStyle).not.toHaveBeenCalled()
    expect(faces.load).not.toHaveBeenCalled()
  })

  it('does not cache failures or aborts and remains retryable', async () => {
    const loadScriptStyle = vi.fn()
      .mockRejectedValueOnce(new Error('style-unavailable'))
      .mockResolvedValue(undefined)
    const { port } = createPort({ loadScriptStyle })

    await expect(port.prepareLocaleFonts('ja-JP', [400])).rejects.toThrow('style-unavailable')
    expect(port.peekPreparedLocaleFonts('ja-JP')).toBeUndefined()

    const recovered = await port.prepareLocaleFonts('ja-JP', [400])
    expect(recovered.locale).toBe('ja-JP')
    expect(loadScriptStyle).toHaveBeenCalledTimes(2)

    const controller = new AbortController()
    controller.abort()
    await expect(port.prepareLocaleFonts('ko-KR', [400], controller.signal))
      .rejects
      .toMatchObject({ name: 'AbortError' })
    expect(port.peekPreparedLocaleFonts('ko-KR')).toBeUndefined()

    const afterAbort = await port.prepareLocaleFonts('ko-KR', [400])
    expect(afterAbort.script).toBe('Kore')
  })

  it('fails closed on empty faces or missing glyph evidence without writing a receipt', async () => {
    const emptyFaces: FontFaceSetPort = {
      load: vi.fn(async () => []),
      check: vi.fn(() => true)
    }
    const emptyPort = createFontPreparationPort({
      fontFaceSet: () => emptyFaces,
      loadScriptStyle: async () => undefined
    })
    await expect(emptyPort.prepareLocaleFonts('ru-RU', [400]))
      .rejects
      .toThrow(/font_face_load_empty:ru-RU:google-sans-cyrillic:400/u)
    expect(emptyPort.peekPreparedLocaleFonts('ru-RU')).toBeUndefined()

    const missingGlyphs: FontFaceSetPort = {
      load: vi.fn(async () => [{ ok: true }]),
      check: vi.fn(() => false)
    }
    const glyphPort = createFontPreparationPort({
      fontFaceSet: () => missingGlyphs,
      loadScriptStyle: async () => undefined
    })
    await expect(glyphPort.prepareLocaleFonts('ru-RU', [400]))
      .rejects
      .toThrow(/font_face_glyph_unavailable:ru-RU:google-sans-cyrillic:400/u)
  })

  it('rejects invalid weight lists and never dispatches font evidence CustomEvents', async () => {
    const { port } = createPort()
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })

    await expect(port.prepareLocaleFonts('en-US', [] as unknown as LocaleFontWeight[]))
      .rejects
      .toThrow('font_preparation_weights_invalid')
    await expect(port.prepareLocaleFonts('en-US', [600] as unknown as LocaleFontWeight[]))
      .rejects
      .toThrow('font_preparation_weights_invalid')

    await port.prepareLocaleFonts('en-US', [400, 700])
    expect(dispatchEvent).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

})
