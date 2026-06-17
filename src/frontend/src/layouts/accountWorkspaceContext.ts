import { computed, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'
import {
  accountAreaMeta,
  type AccountArea,
  type AccountAreaMeta,
} from '@/layouts/accountNav'
import { useAdminStore } from '@/store/admin'
import { useSiteStore } from '@/store/site'
import { useUserStore } from '@/store/user'

export type AccountWorkspaceSurface = 'self' | 'manage'

export interface AccountWorkspaceFeatures {
  anonymousCommentsEnabled: boolean
  zkAnonymousEnabled: boolean
  publicSendOptionEnabled: boolean
}

export interface AccountWorkspacePolicies {
  anonymousCommentGovernanceAvailable: boolean
  zkAnonymousConfigurable: boolean
}

export interface AccountWorkspaceContext {
  surface: 'self' | 'manage'
  canManage: boolean
  permissions: readonly string[]
  features: AccountWorkspaceFeatures
  policies: AccountWorkspacePolicies
  areaMeta: AccountAreaMeta
  brandTitle: string
  brandImageUrl: string
  logout: () => Promise<void>
}

export function useAccountWorkspaceContext(): ComputedRef<AccountWorkspaceContext> {
  const route = useRoute()
  const siteStore = useSiteStore()
  const userStore = useUserStore()
  const adminStore = useAdminStore()

  return computed(() => {
    const surface: AccountWorkspaceSurface = route.meta.accountArea === 'manage' ? 'manage' : 'self'
    const logout = surface === 'manage' ? adminStore.logout : userStore.logout

    return {
      surface,
      canManage: adminStore.canManage,
      permissions: adminStore.permissions,
      features: {
        anonymousCommentsEnabled: adminStore.anonymousCommentsEnabled,
        zkAnonymousEnabled: adminStore.zkAnonymousEnabled,
        publicSendOptionEnabled: adminStore.publicSendOptionEnabled
      },
      policies: {
        anonymousCommentGovernanceAvailable: adminStore.anonymousCommentGovernanceAvailable,
        zkAnonymousConfigurable: adminStore.zkAnonymousConfigurable
      },
      areaMeta: accountAreaMeta[surface as AccountArea],
      brandTitle: siteStore.siteInfo.title,
      brandImageUrl: resolveBrandImageUrl(siteStore.siteInfo),
      logout
    }
  })
}

function resolveBrandImageUrl(siteInfo: {
  adminLogoUrl?: string
  adminCollapsedIconUrl?: string
  siteWordmarkUrl?: string
  siteLogoUrl?: string
}): string {
  return siteInfo.adminLogoUrl?.trim()
    || siteInfo.adminCollapsedIconUrl?.trim()
    || siteInfo.siteWordmarkUrl?.trim()
    || siteInfo.siteLogoUrl?.trim()
    || ''
}
