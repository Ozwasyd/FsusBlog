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
    expect(accountLayoutSource).toContain('account-mobile-drawer-trigger')
    expect(accountLayoutSource).toContain('id="account-mobile-drawer"')
    expect(accountLayoutSource).toContain('account-mobile-drawer-nav')
  })

  it('compacts account chrome for short landscape viewports', () => {
    expect(accountLayoutSource).toContain('@media (max-height: 520px) and (orientation: landscape)')
    expect(accountLayoutSource).toMatch(/:deep\(\.account-site-header__inner\) \{[\s\S]*?padding-block: 0\.5rem;/u)
    expect(accountLayoutSource).toMatch(/:deep\(\.account-site-header__primary-row\) \{[\s\S]*?gap: 0\.75rem;/u)
    expect(accountLayoutSource).toMatch(/:deep\(\.account-site-header__actions\) \{[\s\S]*?display: none;/u)
    expect(accountLayoutSource).toMatch(/:deep\(\.account-site-header__mobile-actions\) \{[\s\S]*?display: inline-flex;/u)
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
