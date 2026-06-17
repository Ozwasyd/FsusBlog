import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CurrentUserSnapshot } from '@/api/auth'
import { useUserStore } from '@/store/user'

export type AdminSessionStatus = 'missing' | 'active' | 'expired' | 'step_up_required'
export type AdminPrincipalSource = 'independent' | 'legacy'

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

const DEFAULT_MANAGE_PERMISSIONS: readonly string[] = Object.freeze([
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
    permissions.value.includes(permission) || permissions.value.includes('legacy.admin')

  const setAdminPrincipal = (snapshot: AdminPrincipalSnapshot | null): void => {
    adminPrincipal.value = snapshot ? {
      ...snapshot,
      permissions: [...snapshot.permissions]
    } : null
  }

  const clearAdminPrincipal = (): void => {
    adminPrincipal.value = null
  }

  const syncLegacyAdminPrincipal = (user: CurrentUserSnapshot | null): void => {
    if (adminPrincipal.value?.source === 'independent') {
      return
    }

    if (user?.role === 'admin') {
      setAdminPrincipal({
        id: String(user.id),
        displayName: user.username,
        source: 'legacy',
        permissions: DEFAULT_MANAGE_PERMISSIONS,
        adminSessionStatus: 'active',
        totpStepUpRequired: false
      })
      return
    }

    if (adminPrincipal.value?.source === 'legacy') {
      clearAdminPrincipal()
    }
  }

  const setAnonymousCommentPolicy = (snapshot: Partial<AnonymousCommentPolicySnapshot>): void => {
    anonymousCommentPolicy.value = {
      ...anonymousCommentPolicy.value,
      ...snapshot
    }
  }

  const ensureAdminSessionFresh = async (legacyUser: CurrentUserSnapshot | null): Promise<void> => {
    syncLegacyAdminPrincipal(legacyUser)
  }

  const logout = async (): Promise<void> => {
    const wasLegacyPrincipal = adminPrincipal.value?.source === 'legacy'
    clearAdminPrincipal()

    if (wasLegacyPrincipal) {
      await useUserStore().logout()
      return
    }

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
