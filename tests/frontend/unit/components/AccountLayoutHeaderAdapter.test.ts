import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const accountLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/AccountLayout.vue'),
  'utf8',
)
const accountContextSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/accountWorkspaceContext.ts'),
  'utf8',
)

describe('AccountLayout header adapter integration', () => {
  it('uses the shared site chrome adapter for account header chrome', () => {
    expect(accountLayoutSource).toContain('SiteChromeHeaderAdapter')
    expect(accountLayoutSource).toContain('brand-context="account"')
    expect(accountLayoutSource).toContain('account-site-header')
    expect(accountLayoutSource).not.toContain('<header class="sticky top-0')
  })

  it('keeps account-specific header actions and mobile menu entry', () => {
    expect(accountLayoutSource).toContain('<ThemeModeToggle />')
    expect(accountLayoutSource).toContain('主站')
    expect(accountLayoutSource).toContain('class="account-header-action"')
    expect(accountLayoutSource).toContain('@apply inline-flex min-h-9 items-center justify-center')
    expect(accountLayoutSource).toContain(':deep(.account-header-action)')
    expect(accountLayoutSource).not.toContain('.account-header-action.el-button')
    expect(accountLayoutSource).toContain('min-height: 2.25rem;')
    expect(accountLayoutSource).toContain("openPolicy('guidelines')")
    expect(accountLayoutSource).toContain("openPolicy('privacy')")
    expect(accountLayoutSource).toContain('handleLogout')
    expect(accountLayoutSource).toContain('account-mobile-navigation')
    expect(accountLayoutSource).toContain('account-mobile-group-control')
    expect(accountLayoutSource).toContain('account-mobile-link-strip')
  })

  it('passes raw account brand image fields to the adapter', () => {
    expect(accountContextSource).toContain(
      'brandImages: AccountWorkspaceBrandImages',
    )
    expect(accountContextSource).toContain(
      'adminLogoUrl: siteStore.siteInfo.adminLogoUrl',
    )
    expect(accountContextSource).not.toContain('resolveBrandImageUrl')
    expect(accountLayoutSource).toContain(
      ':admin-logo-url="workspaceContext.brandImages.adminLogoUrl"',
    )
    expect(accountLayoutSource).toContain(
      ':admin-collapsed-icon-url="workspaceContext.brandImages.adminCollapsedIconUrl"',
    )
  })
})
