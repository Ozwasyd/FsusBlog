import { describe, expect, it } from 'vitest'
import {
  buildConsoleSupportLinks,
  resolveConsoleWelcomeCalloutConfig
} from '@/config/consoleWelcomeCallout'

describe('console support links', () => {
  it('filters unsafe or empty URLs while keeping explicit safe labels', () => {
    const config = resolveConsoleWelcomeCalloutConfig({
      contributeUrl: 'javascript:alert(1)',
      issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new',
      communityUrl: 'https://github.com/Ozwasyd/FsusBlog'
    })

    expect(buildConsoleSupportLinks(config)).toEqual([
      { key: 'issue', label: '提交问题', href: 'https://github.com/Ozwasyd/FsusBlog/issues/new' },
      { key: 'community', label: '参与讨论', href: 'https://github.com/Ozwasyd/FsusBlog' }
    ])
  })

  it('uses the single-link GitHub issue default', () => {
    expect(buildConsoleSupportLinks(resolveConsoleWelcomeCalloutConfig())).toEqual([
      {
        key: 'issue',
        label: '提交问题',
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

    expect(buildConsoleSupportLinks(config)).toEqual([
      { key: 'contribute', label: '查看维护说明', href: 'https://example.com/guide' },
      { key: 'issue', label: '提交问题', href: 'https://github.com/Ozwasyd/FsusBlog/issues/new/choose' },
      { key: 'community', label: '参与讨论', href: 'https://github.com/Ozwasyd/FsusBlog/discussions' }
    ])
  })

  it('does not expose support links when deployment policy forbids them', () => {
    expect(buildConsoleSupportLinks(resolveConsoleWelcomeCalloutConfig({
      externalLinksEnabled: false
    }))).toEqual([])
    expect(buildConsoleSupportLinks(resolveConsoleWelcomeCalloutConfig({
      privateDeployment: true,
      hideForPrivateDeployment: true
    }))).toEqual([])
  })
})
