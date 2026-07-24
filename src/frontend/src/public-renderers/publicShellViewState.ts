import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import { getActiveNavForKind } from '@/public-renderers/publicPageModel'
import { createPublicShellState, PUBLIC_SHELL_DEFAULTS, type PublicShellState } from '@/public-renderers/publicShellState'
import {
  normalizePublicComplianceConfig,
  normalizePublicSiteDescription,
  normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity'
import type { SiteComplianceConfigPublic } from '@/api/system'

export type PublicShellViewInput = Readonly<{
  hydrationKind?: PublicPageKind | null
  siteTitle?: string | null
  siteDescription?: string | null
  siteLogoUrl?: string | null
  siteLogoDarkUrl?: string | null
  siteWordmarkUrl?: string | null
  isSearchRoute?: boolean
  initialSearchQuery?: string | null
  spaSearch?: boolean
  showRuntime?: boolean
  compliance?: SiteComplianceConfigPublic | null
  renderYear?: number | null
  isRuntimeAuthResolved?: boolean
  isLoggedIn?: boolean
  isAdmin?: boolean
}>

function resolveAuthState(input: PublicShellViewInput): Pick<PublicShellState, 'authAction' | 'authHref'> {
  if (!input.isRuntimeAuthResolved || !input.isLoggedIn) {
    return {
      authAction: PUBLIC_SHELL_DEFAULTS.authAction,
      authHref: PUBLIC_SHELL_DEFAULTS.authHref
    }
  }

  if (input.isAdmin) {
    return {
      authAction: 'dashboard',
      authHref: '/user/manage'
    }
  }

  return {
    authAction: 'account',
    authHref: '/user/profile'
  }
}

export function createPublicShellViewState(input: PublicShellViewInput = {}): PublicShellState {
  const hydrationKind = input.hydrationKind ?? null
  const isSearchRoute = Boolean(input.isSearchRoute)

  return createPublicShellState({
    hydrationKind,
    siteTitle: normalizePublicSiteTitle(input.siteTitle),
    siteDescription: normalizePublicSiteDescription(input.siteDescription),
    siteLogoUrl: input.siteLogoUrl?.trim() || '',
    siteLogoDarkUrl: input.siteLogoDarkUrl?.trim() || '',
    siteWordmarkUrl: input.siteWordmarkUrl?.trim() || '',
    activeNav: hydrationKind ? getActiveNavForKind(hydrationKind) : PUBLIC_SHELL_DEFAULTS.activeNav,
    searchAction: isSearchRoute ? 'search-shortcut' : PUBLIC_SHELL_DEFAULTS.searchAction,
    initialSearchQuery: isSearchRoute ? String(input.initialSearchQuery ?? '') : '',
    spaSearch: Boolean(input.spaSearch),
    showRuntime: Boolean(input.showRuntime),
    compliance: normalizePublicComplianceConfig(input.compliance),
    renderYear: Number.isInteger(input.renderYear) ? Number(input.renderYear) : null,
    ...resolveAuthState(input)
  })
}
