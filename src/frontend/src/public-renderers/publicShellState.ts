import type { SiteComplianceConfigPublic } from '@/api/system'
import { PUBLIC_SITE_IDENTITY_DEFAULTS } from '@/public-renderers/publicSiteIdentityDefaults'

export type PublicActiveNav = 'home' | 'archive' | 'about' | 'none'

export type PublicShellState = Readonly<{
  hydrationKind?: string | null
  siteTitle: string
  siteDescription: string
  siteLogoUrl: string
  siteLogoDarkUrl: string
  siteWordmarkUrl: string
  activeNav: PublicActiveNav
  authLabel: string
  authHref: string
  searchPlaceholder: string
  initialSearchQuery: string
  spaSearch: boolean
  showRuntime: boolean
  compliance: SiteComplianceConfigPublic | null
  renderYear: number | null
}>

export const PUBLIC_SHELL_DEFAULTS: PublicShellState = {
  hydrationKind: null,
  siteTitle: PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle,
  siteDescription: PUBLIC_SITE_IDENTITY_DEFAULTS.siteDescription,
  siteLogoUrl: '',
  siteLogoDarkUrl: '',
  siteWordmarkUrl: '',
  activeNav: 'none',
  authLabel: '登录',
  authHref: '/login',
  searchPlaceholder: '搜索文章、标签或关键词',
  initialSearchQuery: '',
  spaSearch: false,
  showRuntime: false,
  compliance: null,
  renderYear: null
}

export function createPublicShellState(overrides: Partial<PublicShellState> = {}): PublicShellState {
  return {
    ...PUBLIC_SHELL_DEFAULTS,
    ...overrides
  }
}
