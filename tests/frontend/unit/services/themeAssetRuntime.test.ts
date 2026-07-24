// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createThemeAssetRuntime,
  resolveThemeAsset,
  type ThemeAssetDescriptor
} from '@/services/themeAssetRuntime'

const DEFAULT_HASH = 'a'.repeat(64)
const ACTIVE_HASH = 'b'.repeat(64)
const PREVIEW_HASH = 'c'.repeat(64)

function descriptor(id: string, hash: string, defaultMode: 'light' | 'dark' = 'light'): ThemeAssetDescriptor {
  return {
    id,
    contentHash: hash,
    cssUrl: `/_themes/${id}/${hash}/tokens.css`,
    defaultMode
  }
}

afterEach(() => {
  document.head.replaceChildren()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-color-scheme')
  document.documentElement.removeAttribute('data-reduced-motion')
  document.documentElement.removeAttribute('data-high-contrast')
  vi.restoreAllMocks()
})

describe('theme asset resolution', () => {
  it('prefers per-user preview, then active, then default', () => {
    const defaultTheme = descriptor('fsusblog.theme.default', DEFAULT_HASH)
    const activeTheme = descriptor('fsusblog.theme.active', ACTIVE_HASH)
    const previewTheme = descriptor('fsusblog.theme.preview', PREVIEW_HASH)

    expect(resolveThemeAsset({ defaultTheme, activeTheme, previewTheme })).toEqual({
      source: 'preview',
      theme: previewTheme
    })
    expect(resolveThemeAsset({ defaultTheme, activeTheme })).toEqual({
      source: 'active',
      theme: activeTheme
    })
    expect(resolveThemeAsset({ defaultTheme })).toEqual({
      source: 'default',
      theme: defaultTheme
    })
  })
})

describe('theme asset runtime', () => {
  it('loads scoped content-hash CSS and exposes immutable current state', async () => {
    const defaultTheme = descriptor('fsusblog.theme.default', DEFAULT_HASH)
    const activeTheme = descriptor('fsusblog.theme.active', ACTIVE_HASH, 'dark')
    const head = document.createElement('head')
    const runtime = createThemeAssetRuntime({
      root: document.documentElement,
      head,
      matchMedia: (query) => ({
        matches: query.includes('reduced-motion') || query.includes('prefers-contrast'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      } as unknown as MediaQueryList)
    })

    const pending = runtime.apply({
      defaultTheme,
      activeTheme,
      explicitMode: null
    })
    const link = head.querySelector<HTMLLinkElement>('link[data-fsus-theme-stylesheet]')
    expect(link?.href).toContain(`/${ACTIVE_HASH}/tokens.css`)
    link?.dispatchEvent(new Event('load'))
    await pending

    expect(document.documentElement.dataset.theme).toBe(activeTheme.id)
    expect(document.documentElement.dataset.colorScheme).toBe('dark')
    expect(document.documentElement.dataset.reducedMotion).toBe('true')
    expect(document.documentElement.dataset.highContrast).toBe('true')
    const state = runtime.current()
    expect(Object.isFrozen(state)).toBe(true)
    expect(state).toMatchObject({
      source: 'active',
      themeId: activeTheme.id,
      colorScheme: 'dark',
      reducedMotion: true,
      highContrast: true
    })
  })

  it('falls back to default when active CSS fails without mutating the selection input', async () => {
    const defaultTheme = descriptor('fsusblog.theme.default', DEFAULT_HASH)
    const activeTheme = {
      ...descriptor('fsusblog.theme.active', ACTIVE_HASH),
      activationId: '019f846b-f7c8-7c73-8935-37fc0367dac6'
    }
    const selection = { defaultTheme, activeTheme, explicitMode: 'light' as const }
    const head = document.createElement('head')
    const reportFailure = vi.fn()
    const runtime = createThemeAssetRuntime({
      root: document.documentElement,
      head,
      matchMedia: () => ({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      } as unknown as MediaQueryList),
      reportFailure
    })

    const pending = runtime.apply(selection)
    head
      .querySelector<HTMLLinkElement>('link[data-fsus-theme-stylesheet]')
      ?.dispatchEvent(new Event('error'))
    await vi.waitFor(() => {
      expect(head.querySelectorAll('link[data-fsus-theme-stylesheet]')).toHaveLength(1)
      expect(head.querySelector<HTMLLinkElement>(
        'link[data-fsus-theme-stylesheet]'
      )?.dataset.contentHash).toBe(DEFAULT_HASH)
    })
    const fallbackLink = head.querySelector<HTMLLinkElement>(
      'link[data-fsus-theme-stylesheet]'
    )
    expect(fallbackLink?.href).toContain(`/${DEFAULT_HASH}/tokens.css`)
    fallbackLink?.dispatchEvent(new Event('load'))
    await pending

    expect(runtime.current()).toMatchObject({
      source: 'default',
      themeId: defaultTheme.id
    })
    expect(selection.activeTheme).toBe(activeTheme)
    expect(reportFailure).toHaveBeenCalledWith({
      source: 'active',
      themeId: activeTheme.id,
      contentHash: ACTIVE_HASH,
      activationId: activeTheme.activationId,
      code: 'theme_asset_stylesheet_load_failed',
      detail: `Theme stylesheet '${activeTheme.id}' failed to load.`
    })
  })

  it('keeps fallback available when failure reporting is unavailable', async () => {
    const defaultTheme = descriptor('fsusblog.theme.default', DEFAULT_HASH)
    const activeTheme = descriptor('fsusblog.theme.active', ACTIVE_HASH)
    const head = document.createElement('head')
    const runtime = createThemeAssetRuntime({
      root: document.documentElement,
      head,
      matchMedia: window.matchMedia.bind(window),
      reportFailure: () => Promise.reject(new Error('control plane unavailable'))
    })

    const pending = runtime.apply({ defaultTheme, activeTheme })
    head.querySelector<HTMLLinkElement>('link')?.dispatchEvent(new Event('error'))
    await vi.waitFor(() => {
      expect(head.querySelector<HTMLLinkElement>('link')?.dataset.contentHash).toBe(DEFAULT_HASH)
    })
    head.querySelector<HTMLLinkElement>('link')?.dispatchEvent(new Event('load'))

    await expect(pending).resolves.toMatchObject({
      source: 'default',
      themeId: defaultTheme.id
    })
  })

  it('falls back from a broken preview to the active theme before default', async () => {
    const defaultTheme = descriptor('fsusblog.theme.default', DEFAULT_HASH)
    const activeTheme = descriptor('fsusblog.theme.active', ACTIVE_HASH)
    const previewTheme = descriptor('fsusblog.theme.preview', PREVIEW_HASH)
    const head = document.createElement('head')
    const runtime = createThemeAssetRuntime({
      root: document.documentElement,
      head,
      matchMedia: () => ({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      } as unknown as MediaQueryList)
    })

    const pending = runtime.apply({ defaultTheme, activeTheme, previewTheme })
    head.querySelector<HTMLLinkElement>('link')?.dispatchEvent(new Event('error'))
    await vi.waitFor(() => {
      expect(head.querySelector<HTMLLinkElement>('link')?.dataset.contentHash).toBe(ACTIVE_HASH)
    })
    head.querySelector<HTMLLinkElement>('link')?.dispatchEvent(new Event('load'))

    await expect(pending).resolves.toMatchObject({
      source: 'active',
      themeId: activeTheme.id
    })
  })

  it('rejects a stylesheet URL that is not bound to its declared content hash', async () => {
    const defaultTheme = {
      ...descriptor('fsusblog.theme.default', DEFAULT_HASH),
      cssUrl: '/_themes/fsusblog.theme.default/not-the-hash/tokens.css'
    }
    const head = document.createElement('head')
    const runtime = createThemeAssetRuntime({
      root: document.documentElement,
      head,
      matchMedia: window.matchMedia.bind(window)
    })

    await expect(runtime.apply({ defaultTheme })).rejects.toMatchObject({
      code: 'theme_asset_url_hash_mismatch'
    })
    expect(head.querySelector('link[data-fsus-theme-stylesheet]')).toBeNull()
  })

  it('resolves explicit mode before system mode and system mode before the theme default', async () => {
    const defaultTheme = descriptor('fsusblog.theme.default', DEFAULT_HASH, 'light')
    const head = document.createElement('head')
    let systemDark = true
    const runtime = createThemeAssetRuntime({
      root: document.documentElement,
      head,
      matchMedia: (query) => ({
        matches: query.includes('color-scheme') && systemDark,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      } as unknown as MediaQueryList)
    })

    const systemPending = runtime.apply({ defaultTheme })
    head.querySelector<HTMLLinkElement>('link')?.dispatchEvent(new Event('load'))
    await systemPending
    expect(runtime.current().colorScheme).toBe('dark')

    systemDark = true
    const explicitPending = runtime.apply({ defaultTheme, explicitMode: 'light' })
    head.querySelectorAll<HTMLLinkElement>('link')[1]?.dispatchEvent(new Event('load'))
    await explicitPending
    expect(runtime.current().colorScheme).toBe('light')
  })
})
