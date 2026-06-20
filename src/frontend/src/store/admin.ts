import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAdminMe, type CurrentUserSnapshot } from '@/api/auth'
import { isAuthFailureError } from '@/utils/errorKinds'

export type AdminSessionStatus = 'missing' | 'active' | 'expired' | 'step_up_required'
export type AdminPrincipalSource = 'independent'

export interface AdminPrincipalSnapshot {
  id: string
  displayName: string
  source: AdminPrincipalSource
  permissions: readonly string[]
  adminSessionStatus: AdminSessionStatus
  totpStepUpRequired?: boolean
}

export interface AnonymousCommentPolicySnapshot {
  anonymousCommentsEnabled: boolean
  publicSendOptionEnabled: boolean
  zkAnonymousEnabled: boolean
  anonymousCommentGovernanceAvailable: boolean
  zkAnonymousConfigurable: boolean
}

const DEFAULT_ANONYMOUS_COMMENT_POLICY: AnonymousCommentPolicySnapshot = Object.freeze({
  anonymousCommentsEnabled: true,
  publicSendOptionEnabled: true,
  zkAnonymousEnabled: false,
  anonymousCommentGovernanceAvailable: true,
  zkAnonymousConfigurable: true
})

export const useAdminStore = defineStore('admin', () => {
  const adminPrincipal = ref<AdminPrincipalSnapshot | null>(null)
  const anonymousCommentPolicy = ref<AnonymousCommentPolicySnapshot>({ ...DEFAULT_ANONYMOUS_COMMENT_POLICY })

  const adminSessionStatus = computed<AdminSessionStatus>(() => adminPrincipal.value?.adminSessionStatus ?? 'missing')
  const permissions = computed<readonly string[]>(() => adminPrincipal.value?.permissions ?? [])
  const canManage = computed(() => adminSessionStatus.value === 'active' && permissions.value.length > 0)
  const anonymousCommentsEnabled = computed(() => anonymousCommentPolicy.value.anonymousCommentsEnabled)
  const publicSendOptionEnabled = computed(() => anonymousCommentPolicy.value.publicSendOptionEnabled)
  const zkAnonymousEnabled = computed(() => anonymousCommentPolicy.value.zkAnonymousEnabled)
  const anonymousCommentGovernanceAvailable = computed(() => anonymousCommentPolicy.value.anonymousCommentGovernanceAvailable)
  const zkAnonymousConfigurable = computed(() => anonymousCommentPolicy.value.zkAnonymousConfigurable)
  const publicOnlyMode = computed(() => !anonymousCommentsEnabled.value && publicSendOptionEnabled.value)
  const totpStepUpRequired = computed(() => adminPrincipal.value?.totpStepUpRequired === true || adminSessionStatus.value === 'step_up_required')

  const hasPermission = (permission: string): boolean =>
    permissions.value.includes(permission)

  const setAdminPrincipal = (snapshot: AdminPrincipalSnapshot | null): void => {
    adminPrincipal.value = snapshot ? {
      ...snapshot,
      permissions: [...snapshot.permissions]
    } : null
  }

  const clearAdminPrincipal = (): void => {
    adminPrincipal.value = null
  }

  const syncLegacyAdminPrincipal = (account: CurrentUserSnapshot | null): void => {
    void account
  }

  const setAnonymousCommentPolicy = (snapshot: Partial<AnonymousCommentPolicySnapshot>): void => {
    anonymousCommentPolicy.value = {
      ...anonymousCommentPolicy.value,
      ...snapshot
    }
  }

  const ensureAdminSessionFresh = async (account: CurrentUserSnapshot | null): Promise<void> => {
    syncLegacyAdminPrincipal(account)

    try {
      setAdminPrincipal(await getAdminMe())
    } catch (error: unknown) {
      if (isAuthFailureError(error)) {
        if (adminPrincipal.value?.source === 'independent') {
          clearAdminPrincipal()
        }
        return
      }

      console.warn('[AdminStore] Admin session refresh failed.')
    }
  }

  const logout = async (): Promise<void> => {
    clearAdminPrincipal()

    if (typeof window !== 'undefined') {
      window.location.href = '/'
    }
  }

  return {
    adminPrincipal,
    anonymousCommentPolicy,
    adminSessionStatus,
    permissions,
    canManage,
    anonymousCommentsEnabled,
    publicSendOptionEnabled,
    zkAnonymousEnabled,
    anonymousCommentGovernanceAvailable,
    zkAnonymousConfigurable,
    publicOnlyMode,
    totpStepUpRequired,
    hasPermission,
    setAdminPrincipal,
    clearAdminPrincipal,
    syncLegacyAdminPrincipal,
    ensureAdminSessionFresh,
    setAnonymousCommentPolicy,
    logout
  }
})
