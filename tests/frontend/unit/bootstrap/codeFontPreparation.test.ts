import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('codeFontPreparation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('@/assets/fonts/code.css', () => ({ default: undefined }))
  })

  it('loads the code font asset independently from locale scripts', async () => {
    const load = vi.fn(async () => [{ family: 'JetBrains Mono' }])
    const check = vi.fn(() => true)
    vi.stubGlobal('document', { fonts: { load, check } })

    const { prepareCodeFonts } = await import('@/bootstrap/codeFontPreparation')
    await prepareCodeFonts()

    expect(load).toHaveBeenCalledWith('400 1em "JetBrains Mono"', 'const value = 1540')
    expect(load).toHaveBeenCalledWith('500 1em "JetBrains Mono"', 'const value = 1540')
    expect(load).toHaveBeenCalledWith('700 1em "JetBrains Mono"', 'const value = 1540')
    expect(check).toHaveBeenCalled()
  })

  it('fails closed when glyph evidence is missing and retries after a failure', async () => {
    const load = vi.fn(async (query: string) => {
      if (String(query).startsWith('400') && load.mock.calls.filter((call) => String(call[0]).startsWith('400')).length === 1) {
        return []
      }
      return [{ family: 'JetBrains Mono' }]
    })
    const check = vi.fn(() => true)
    vi.stubGlobal('document', { fonts: { load, check } })

    const { prepareCodeFonts } = await import('@/bootstrap/codeFontPreparation')
    await expect(prepareCodeFonts()).rejects.toThrow(/code_font_face_unavailable:400/u)
    await expect(prepareCodeFonts()).resolves.toBeUndefined()
  })
})
