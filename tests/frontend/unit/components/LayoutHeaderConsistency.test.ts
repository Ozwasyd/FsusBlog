import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicShellSource = readFileSync(
  resolve(process.cwd(), 'src/components/public/PublicBlogLayoutShell.vue'),
  'utf8',
)
const authLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/PublicAuthLayout.vue'),
  'utf8',
)
const accountLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/AccountLayout.vue'),
  'utf8',
)
const routerSource = readFileSync(
  resolve(process.cwd(), 'src/router/index.ts'),
  'utf8',
)
const publicRouteRegistrySource = readFileSync(
  resolve(process.cwd(), 'src/public-renderers/publicRouteRegistry.ts'),
  'utf8',
)

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

describe('layout header consistency matrix', () => {
  it('covers public blog home, archive, article, and about routes through one public shell header', () => {
    expect(routerSource).toContain('children: [...PUBLIC_BLOG_CHILD_ROUTES]')
    expect(publicRouteRegistrySource).toContain(
      'name: PUBLIC_SEO_ROUTE_NAMES.home',
    )
    expect(publicRouteRegistrySource).toContain(
      'name: PUBLIC_SEO_ROUTE_NAMES.archive',
    )
    expect(publicRouteRegistrySource).toContain(
      'name: PUBLIC_SEO_ROUTE_NAMES.articleDetail',
    )
    expect(publicRouteRegistrySource).toContain(
      'name: PUBLIC_SEO_ROUTE_NAMES.about',
    )
    expect(publicShellSource).toContain('SiteChromeHeaderAdapter')
    expect(count(publicShellSource, '<SiteChromeHeaderAdapter')).toBe(1)
    expect(publicShellSource).toContain('el-public-shell__header is-sticky')
    expect(publicShellSource).toContain(
      'el-public-shell__mobile-primary-actions',
    )
    expect(publicShellSource).toContain('el-public-shell__auth-link')
  })

  it('covers login, register, and recover through one public auth header', () => {
    expect(routerSource).toContain("path: 'login'")
    expect(routerSource).toContain("path: 'register'")
    expect(routerSource).toContain("path: 'recover'")
    expect(authLayoutSource).toContain('SiteChromeHeaderAdapter')
    expect(count(authLayoutSource, '<SiteChromeHeaderAdapter')).toBe(1)
    expect(authLayoutSource).toContain('brand-context="auth"')
    expect(authLayoutSource).toContain(
      '<ThemeModeToggle visibility="desktop" />',
    )
    expect(authLayoutSource).toContain('visibility="mobile"')
    expect(authLayoutSource).toContain("route.name === 'Register'")
    expect(authLayoutSource).toContain("route.name === 'Recover'")
  })

  it('covers account and admin workbench routes through one account header', () => {
    expect(routerSource).toContain("name: 'UserProfile'")
    expect(routerSource).toContain("name: 'UserIdentityOverview'")
    expect(routerSource).toContain("name: 'UserMessage'")
    expect(routerSource).toContain("name: 'ManageDashboard'")
    expect(routerSource).toContain("name: 'ManageArticleList'")
    expect(routerSource).toContain("name: 'ManageSettings'")
    expect(accountLayoutSource).toContain('SiteChromeHeaderAdapter')
    expect(count(accountLayoutSource, '<SiteChromeHeaderAdapter')).toBe(1)
    expect(accountLayoutSource).toContain('brand-context="account"')
    expect(accountLayoutSource).toContain(
      'aria-controls="account-mobile-drawer"',
    )
    expect(accountLayoutSource).toContain('handleLogout')
  })

  it('prevents duplicated self-authored header chrome from returning', () => {
    expect(publicShellSource).not.toContain('<el-public-shell')
    expect(authLayoutSource).not.toContain('<nav class="mx-auto')
    expect(accountLayoutSource).not.toContain('<header class="sticky top-0')
    expect(publicShellSource).toContain(':show-desktop-theme-toggle="false"')
    expect(authLayoutSource).toContain(':show-desktop-theme-toggle="false"')
    expect(accountLayoutSource).toContain(':show-desktop-theme-toggle="false"')
  })
})
