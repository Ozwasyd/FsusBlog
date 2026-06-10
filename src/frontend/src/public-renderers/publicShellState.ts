import type { SiteComplianceConfigPublic } from '@/api/system'

export type PublicActiveNav = 'home' | 'archive' | 'about' | 'none'

export type PublicShellState = Readonly<{
  hydrationKind?: string | null
  siteTitle: string
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
}>

export const PUBLIC_SHELL_DEFAULTS: PublicShellState = {
  hydrationKind: null,
  siteTitle: "Fsu's Blog",
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
  compliance: null
}

export function createPublicShellState(overrides: Partial<PublicShellState> = {}): PublicShellState {
  return {
    ...PUBLIC_SHELL_DEFAULTS,
    ...overrides
  }
}
