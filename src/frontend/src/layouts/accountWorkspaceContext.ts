import { computed, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'
import {
  accountAreaMeta,
  type AccountArea,
  type AccountAreaMeta,
} from '@/layouts/accountNav'
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

const SELF_PERMISSIONS: readonly string[] = Object.freeze([])
const LEGACY_MANAGE_PERMISSIONS: readonly string[] = Object.freeze([
  'legacy.admin',
  'article.write',
  'article.publish',
  'comment.moderate',
  'anonymous.comment.configure',
  'anonymous.nullifier.block',
  'anonymous.credential.revoke',
  'audit.read',
  'system.config',
  'admin.manage'
])

const DEFAULT_WORKSPACE_FEATURES: AccountWorkspaceFeatures = Object.freeze({
  anonymousCommentsEnabled: true,
  zkAnonymousEnabled: false,
  publicSendOptionEnabled: true
})

const DEFAULT_WORKSPACE_POLICIES: AccountWorkspacePolicies = Object.freeze({
  anonymousCommentGovernanceAvailable: true,
  zkAnonymousConfigurable: true
})

export function useAccountWorkspaceContext(): ComputedRef<AccountWorkspaceContext> {
  const route = useRoute()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const logout = async (): Promise<void> => {
    await userStore.logout()
  }

  return computed(() => {
    const surface: AccountWorkspaceSurface = route.meta.accountArea === 'manage' ? 'manage' : 'self'
    const canManage = userStore.isAdmin

    return {
      surface,
      canManage,
      permissions: canManage ? LEGACY_MANAGE_PERMISSIONS : SELF_PERMISSIONS,
      features: DEFAULT_WORKSPACE_FEATURES,
      policies: DEFAULT_WORKSPACE_POLICIES,
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
