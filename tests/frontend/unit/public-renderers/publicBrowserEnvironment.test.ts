import { describe, expect, it } from 'vitest'
import { projectPublicBrowserEnvironment } from '@/public-renderers/publicBrowserEnvironment'

describe('public browser environment projection', () => {
  it.each([
    ['anonymous', 'login', '/login'],
    ['user', 'account', '/user/profile'],
    ['admin', 'dashboard', '/user/manage']
  ] as const)('projects %s auth through the production shell contract', (sessionState, authAction, authHref) => {
    const result = projectPublicBrowserEnvironment({
      hydrationKind: 'Home',
      sessionState,
      storageBehavior: 'normal',
      themePreference: 'system',
      motionPreference: 'normal',
      colorScheme: 'light'
    })

    expect(result).toMatchObject({ authAction, authHref, activeNav: 'home' })
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
