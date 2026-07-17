import { describe, expect, it } from 'vitest'
import { projectPublicBrowserEnvironment } from '@/public-renderers/publicBrowserEnvironment'

describe('public browser environment projection', () => {
  it.each([
    ['anonymous', '登录', '/login'],
    ['user', '账户', '/user/profile'],
    ['admin', '控制板', '/user/manage']
  ] as const)('projects %s auth through the production shell contract', (sessionState, authText, authHref) => {
    const result = projectPublicBrowserEnvironment({
      hydrationKind: 'Home',
      sessionState,
      storageBehavior: 'normal',
      themePreference: 'system',
      motionPreference: 'normal',
      colorScheme: 'light'
    })

    expect(result).toMatchObject({ authText, authHref, activeNav: 'home' })
  })

  it.each([
    ['normal', 'dark', 'dark', true],
    ['unavailable', 'dark', 'system', false],
    ['cleared-after-reload', 'light', 'system', true]
  ] as const)('models %s storage without accepting stale state', (storageBehavior, preference, themeMode, storageAvailable) => {
    const result = projectPublicBrowserEnvironment({
      hydrationKind: 'ArticleDetail',
      sessionState: 'anonymous',
      storageBehavior,
      themePreference: preference,
      motionPreference: 'reduced',
      colorScheme: 'dark',
      stalePublicShellState: true,
      staleSiteInfo: true
    })

    expect(result).toMatchObject({
      themeMode,
      themeResolved: 'dark',
      storageAvailable,
      reducedMotion: true,
      darkColorScheme: true,
      staleStateAccepted: false,
      activeNav: 'none'
    })
  })
})
