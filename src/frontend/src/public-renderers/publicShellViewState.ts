import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import { getActiveNavForKind } from '@/public-renderers/publicPageModel'
import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'
import { createPublicShellState, PUBLIC_SHELL_DEFAULTS, type PublicShellState } from '@/public-renderers/publicShellState'
import type { SiteComplianceConfigPublic } from '@/api/system'

export type PublicShellViewInput = Readonly<{
  hydrationKind?: PublicPageKind | null
  siteTitle?: string | null
  isSearchRoute?: boolean
  initialSearchQuery?: string | null
  spaSearch?: boolean
  showRuntime?: boolean
  compliance?: SiteComplianceConfigPublic | null
  isRuntimeAuthResolved?: boolean
  isLoggedIn?: boolean
  isAdmin?: boolean
}>

function resolveAuthState(input: PublicShellViewInput): Pick<PublicShellState, 'authLabel' | 'authHref'> {
  if (!input.isRuntimeAuthResolved || !input.isLoggedIn) {
    return {
      authLabel: PUBLIC_SHELL_DEFAULTS.authLabel,
      authHref: PUBLIC_SHELL_DEFAULTS.authHref
    }
  }

  if (input.isAdmin) {
    return {
      authLabel: '控制板',
      authHref: '/user/manage'
    }
  }

  return {
    authLabel: '账户',
    authHref: ACCOUNT_ROUTE_PATHS.profile
  }
}

export function createPublicShellViewState(input: PublicShellViewInput = {}): PublicShellState {
  const hydrationKind = input.hydrationKind ?? null
  const isSearchRoute = Boolean(input.isSearchRoute)

  return createPublicShellState({
    hydrationKind,
    siteTitle: input.siteTitle?.trim() || PUBLIC_SHELL_DEFAULTS.siteTitle,
    activeNav: hydrationKind ? getActiveNavForKind(hydrationKind) : PUBLIC_SHELL_DEFAULTS.activeNav,
    searchPlaceholder: isSearchRoute ? '搜索文章、标签或关键词 (Ctrl+K)' : PUBLIC_SHELL_DEFAULTS.searchPlaceholder,
    initialSearchQuery: isSearchRoute ? String(input.initialSearchQuery ?? '') : '',
    spaSearch: Boolean(input.spaSearch),
    showRuntime: Boolean(input.showRuntime),
    compliance: input.compliance ?? null,
    ...resolveAuthState(input)
  })
}
