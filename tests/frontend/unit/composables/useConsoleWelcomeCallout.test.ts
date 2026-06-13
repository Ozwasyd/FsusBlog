import { describe, expect, it, beforeEach } from 'vitest'
import { computed } from 'vue'
import {
  buildConsoleWelcomeCalloutLinks,
  resolveConsoleWelcomeCalloutConfig,
  shouldShowConsoleWelcomeCallout
} from '@/config/consoleWelcomeCallout'
import {
  CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX,
  useConsoleWelcomeCallout
} from '@/composables/useConsoleWelcomeCallout'

describe('console welcome callout', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('hides when globally disabled, external links are disabled, or private deployment is hidden', () => {
    expect(shouldShowConsoleWelcomeCallout(resolveConsoleWelcomeCalloutConfig({ enabled: false }))).toBe(false)
    expect(shouldShowConsoleWelcomeCallout(resolveConsoleWelcomeCalloutConfig({ externalLinksEnabled: false }))).toBe(false)
    expect(shouldShowConsoleWelcomeCallout(resolveConsoleWelcomeCalloutConfig({
      privateDeployment: true,
      hideForPrivateDeployment: true
    }))).toBe(false)
  })

  it('filters unsafe or empty URLs while keeping explicit safe labels', () => {
    const config = resolveConsoleWelcomeCalloutConfig({
      contributeUrl: 'javascript:alert(1)',
      issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new',
      communityUrl: 'https://github.com/Ozwasyd/FsusBlog'
    })

    expect(buildConsoleWelcomeCalloutLinks(config)).toEqual([
      { key: 'issue', label: '新建 Issue', href: 'https://github.com/Ozwasyd/FsusBlog/issues/new' },
      { key: 'community', label: '讨论区', href: 'https://github.com/Ozwasyd/FsusBlog' }
    ])
  })

  it('persists dismissal per user key', () => {
    const userKey = computed(() => 'admin-user')
    const callout = useConsoleWelcomeCallout({
      userKey,
      config: resolveConsoleWelcomeCalloutConfig({
        issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new'
      })
    })

    expect(callout.visible.value).toBe(true)
    callout.dismiss()
    expect(callout.visible.value).toBe(false)
    expect(localStorage.getItem(`${CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX}admin-user`)).toBe('1')
  })
})
