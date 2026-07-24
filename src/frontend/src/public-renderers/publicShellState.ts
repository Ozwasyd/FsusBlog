import type { SiteComplianceConfigPublic } from '@/api/system'
import { PUBLIC_SITE_IDENTITY_DEFAULTS } from '@/public-renderers/publicSiteIdentityDefaults'

export type PublicActiveNav = 'home' | 'archive' | 'about' | 'none'
export type PublicShellAuthAction = 'login' | 'account' | 'dashboard'
export type PublicShellSearchAction = 'search' | 'search-shortcut'

export type PublicShellState = Readonly<{
  hydrationKind?: string | null
  siteTitle: string
  siteDescription: string
  siteLogoUrl: string
  siteLogoDarkUrl: string
  siteWordmarkUrl: string
  activeNav: PublicActiveNav
  authAction: PublicShellAuthAction
  authHref: string
  searchAction: PublicShellSearchAction
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
  authAction: 'login',
  authHref: '/login',
  searchAction: 'search',
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
