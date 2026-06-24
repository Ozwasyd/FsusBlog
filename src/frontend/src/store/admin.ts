import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAdminMe } from '@/api/auth'
import { isAuthFailureError } from '@/utils/errorKinds'
import { clearLocalFixtureSession } from '@/services/localFixtureSession'

export type AdminSessionStatus = 'missing' | 'active' | 'expired' | 'step_up_required'
export type AdminSessionState = 'unknown' | AdminSessionStatus
export type AdminPrincipalSource = 'independent'

export const ADMIN_NEGATIVE_CACHE_MS = 5 * 60 * 1000
export const ADMIN_ACTIVE_TTL_MS = 60 * 1000

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

export interface EnsureAdminSessionFreshOptions {
  force?: boolean
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
  const adminState = ref<AdminSessionState>('unknown')
  const adminCheckedAt = ref(0)
  const anonymousCommentPolicy = ref<AnonymousCommentPolicySnapshot>({ ...DEFAULT_ANONYMOUS_COMMENT_POLICY })

  const adminSessionStatus = computed<AdminSessionStatus>(() => {
    if (adminState.value === 'unknown') {
      return 'missing'
    }

    return adminState.value
  })
  const permissions = computed<readonly string[]>(() => adminPrincipal.value?.permissions ?? [])
  const canManage = computed(() => adminState.value === 'active' && permissions.value.length > 0)
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
    adminState.value = snapshot?.adminSessionStatus ?? 'missing'
    adminCheckedAt.value = Date.now()
  }

  const clearAdminPrincipal = (state: AdminSessionState = 'missing'): void => {
    adminPrincipal.value = null
    adminState.value = state
    adminCheckedAt.value = Date.now()
  }

  const markMissing = (): void => {
    clearAdminPrincipal('missing')
  }

  const invalidateMissingCache = (): void => {
    if (adminState.value === 'missing') {
      adminPrincipal.value = null
      adminState.value = 'unknown'
      adminCheckedAt.value = 0
    }
  }

  const setAnonymousCommentPolicy = (snapshot: Partial<AnonymousCommentPolicySnapshot>): void => {
    anonymousCommentPolicy.value = {
      ...anonymousCommentPolicy.value,
      ...snapshot
    }
  }

  const ensureAdminSessionFresh = async (options?: EnsureAdminSessionFreshOptions | unknown): Promise<void> => {
    const force = Boolean(
      options
      && typeof options === 'object'
      && 'force' in options
      && (options as EnsureAdminSessionFreshOptions).force
    )
    const now = Date.now()

    if (!force) {
      if (adminState.value === 'missing' && now - adminCheckedAt.value < ADMIN_NEGATIVE_CACHE_MS) {
        return
      }

      if (adminState.value === 'active' && now - adminCheckedAt.value < ADMIN_ACTIVE_TTL_MS) {
        return
      }
    }

    try {
      setAdminPrincipal(await getAdminMe())
    } catch (error: unknown) {
      if (isAuthFailureError(error)) {
        clearAdminPrincipal('missing')
        return
      }

      console.warn('[AdminStore] Admin session refresh failed.')
    }
  }

  const logout = async (): Promise<void> => {
    clearLocalFixtureSession()
    clearAdminPrincipal()

    if (typeof window !== 'undefined') {
      window.location.href = '/'
    }
  }

  return {
    adminPrincipal,
    adminState,
    adminCheckedAt,
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
    markMissing,
    invalidateMissingCache,
    ensureAdminSessionFresh,
    setAnonymousCommentPolicy,
    logout
  }
})
