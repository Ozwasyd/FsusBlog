import { describe, expect, it, beforeEach } from 'vitest'
import { computed, createApp, h, nextTick } from 'vue'
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

  it('uses the single-link GitHub issue default', () => {
    expect(buildConsoleWelcomeCalloutLinks(resolveConsoleWelcomeCalloutConfig())).toEqual([
      {
        key: 'issue',
        label: '新建 Issue',
        href: 'https://github.com/Ozwasyd/FsusBlog/issues/new/choose'
      }
    ])
  })

  it('keeps the configured three-link maintenance order', () => {
    const config = resolveConsoleWelcomeCalloutConfig({
      contributeUrl: 'https://example.com/guide',
      issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new/choose',
      communityUrl: 'https://github.com/Ozwasyd/FsusBlog/discussions'
    })

    expect(buildConsoleWelcomeCalloutLinks(config)).toEqual([
      { key: 'contribute', label: '维护说明', href: 'https://example.com/guide' },
      { key: 'issue', label: '新建 Issue', href: 'https://github.com/Ozwasyd/FsusBlog/issues/new/choose' },
      { key: 'community', label: '讨论区', href: 'https://github.com/Ozwasyd/FsusBlog/discussions' }
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

  it('does not let localStorage remove the initial pre-hydration render', () => {
    localStorage.setItem(`${CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX}admin-user`, '1')
    const callout = useConsoleWelcomeCallout({
      userKey: 'admin-user',
      config: resolveConsoleWelcomeCalloutConfig({
        issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new'
      })
    })

    expect(callout.dismissed.value).toBe(false)
    expect(callout.visible.value).toBe(true)
  })

  it('loads the dismissed state after component mount', async () => {
    localStorage.setItem(`${CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX}admin-user`, '1')
    let callout: ReturnType<typeof useConsoleWelcomeCallout> | null = null
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      setup() {
        callout = useConsoleWelcomeCallout({
          userKey: 'admin-user',
          config: resolveConsoleWelcomeCalloutConfig({
            issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new'
          })
        })
        return () => h('div')
      }
    })

    app.mount(host)
    await nextTick()

    expect(callout?.dismissed.value).toBe(true)
    expect(callout?.visible.value).toBe(false)

    app.unmount()
    host.remove()
  })
})
