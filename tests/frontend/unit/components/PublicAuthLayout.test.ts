import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const authLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/PublicAuthLayout.vue'),
  'utf8',
)
const loginSource = readFileSync(
  resolve(process.cwd(), 'src/views/auth/Login.vue'),
  'utf8',
)
const registerSource = readFileSync(
  resolve(process.cwd(), 'src/views/auth/Register.vue'),
  'utf8',
)
const routerSource = readFileSync(
  resolve(process.cwd(), 'src/router/index.ts'),
  'utf8',
)
const adapterSource = readFileSync(
  resolve(process.cwd(), 'src/components/layout/SiteChromeHeaderAdapter.vue'),
  'utf8',
)

describe('PublicAuthLayout header integration', () => {
  it('routes login and register through the public auth layout', () => {
    expect(routerSource).toContain(
      "component: () => import('@/layouts/PublicAuthLayout.vue')",
    )
    expect(routerSource).toContain("path: 'login'")
    expect(routerSource).toContain("path: 'register'")
    expect(routerSource).toContain(
      "component: () => import('@/views/auth/Login.vue')",
    )
    expect(routerSource).toContain(
      "component: () => import('@/views/auth/Register.vue')",
    )
  })

  it('uses the site chrome adapter without search in auth pages', () => {
    expect(authLayoutSource).toContain('SiteChromeHeaderAdapter')
    expect(authLayoutSource).toContain('brand-context="auth"')
    expect(authLayoutSource).toContain(
      ':login-logo-url="siteStore.siteInfo.loginLogoUrl"',
    )
    expect(authLayoutSource).toContain(
      ':login-icon-url="siteStore.siteInfo.loginIconUrl"',
    )
    expect(authLayoutSource).toContain(
      '<ThemeModeToggle visibility="desktop" />',
    )
    expect(authLayoutSource).toContain('visibility="mobile"')
    expect(authLayoutSource).not.toContain('el-public-shell__search')
  })

  it('removes duplicated nav chrome from login and register views', () => {
    expect(loginSource).not.toContain('<nav')
    expect(registerSource).not.toContain('<nav')
    expect(loginSource).not.toContain('loginBrandImageUrl')
    expect(registerSource).not.toContain('loginBrandImageUrl')
    expect(loginSource).not.toContain('auth-page-shell')
    expect(registerSource).not.toContain('auth-page-shell')
  })

  it('keeps auth brand image selection centralized in the adapter', () => {
    expect(adapterSource).toContain(
      "export type SiteChromeBrandContext = 'public' | 'auth' | 'account'",
    )
    expect(adapterSource).toContain("if (props.brandContext === 'auth')")
    expect(adapterSource).toContain('props.loginLogoUrl')
    expect(adapterSource).toContain('props.loginIconUrl')
  })
})
