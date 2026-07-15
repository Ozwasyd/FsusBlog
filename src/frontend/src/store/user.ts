import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getMe, logout as logoutApi, type CurrentUserSnapshot } from '@/api/auth'
import { notificationStreamRuntime } from '@/services/notificationStreamRuntime'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { isAbortError } from '@/utils/errors'
import { getKnownErrorInfo, isAuthFailureError } from '@/utils/errorKinds'
import { clearLocalFixtureSession } from '@/services/localFixtureSession'
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime'

function createMemoryStorage(): Storage {
    const store = new Map<string, string>()
    return {
        get length() {
            return store.size
        },
        clear() {
            store.clear()
        },
        getItem(key: string) {
            return store.has(String(key)) ? store.get(String(key)) ?? null : null
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null
        },
        removeItem(key: string) {
            store.delete(String(key))
        },
        setItem(key: string, value: string) {
            store.set(String(key), String(value))
        }
    }
}

const safeStorage = typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage()

export type AccountSessionState = 'unknown' | 'guest' | 'authenticated'

export const ACCOUNT_GUEST_NEGATIVE_CACHE_MS = 5 * 60 * 1000

async function broadcastLogoutAcrossTabs(): Promise<void> {
    const { authBroadcastRuntime } = await import('@/services/authBroadcastRuntime')
    authBroadcastRuntime.broadcastLogout()
}

export const useUserStore = defineStore('user', () => {
    const notificationStreamStore = useNotificationStreamStore()

    // ================= 1. State =================
    const userInfo = ref<CurrentUserSnapshot | null>(null)
    const accountState = ref<AccountSessionState>('unknown')
    const lastVerifiedAt = ref(0)
    const authCacheVersion = ref(2)
    const isLoading = ref(false)
    const isLoggingOut = ref(false)
    const lastFetchedAt = ref(0)

    let fetchPromise: Promise<void> | null = null
    let abortController: AbortController | null = null

    // ================= 2. Getters =================
    const isAuthChecked = computed(() => accountState.value !== 'unknown')
    const isLoggedIn = computed(() => accountState.value === 'authenticated' && userInfo.value !== null)

    const isAdmin = computed(() => false)

    const isBanned = computed(() => userInfo.value?.status === 1)
    const isDeleted = computed(() => userInfo.value?.status === 2)

    // ================= 3. Private Helpers =================

    // ================= 4. Actions =================

    const markGuest = () => {
        userInfo.value = null
        accountState.value = 'guest'
        lastVerifiedAt.value = Date.now()
        lastFetchedAt.value = lastVerifiedAt.value
    }

    const markAuthenticated = (info: CurrentUserSnapshot) => {
        userInfo.value = info
        accountState.value = 'authenticated'
        lastVerifiedAt.value = Date.now()
        lastFetchedAt.value = lastVerifiedAt.value
    }

    const invalidateGuestCache = () => {
        if (accountState.value === 'guest') {
            accountState.value = 'unknown'
            lastVerifiedAt.value = 0
            lastFetchedAt.value = 0
        }
    }

    const fetchUserInfo = async (force = false) => {
        if (!force) {
            if (accountState.value === 'authenticated' && userInfo.value) return
            if (accountState.value === 'guest' && Date.now() - lastVerifiedAt.value <= ACCOUNT_GUEST_NEGATIVE_CACHE_MS) return
        }

        if (force && abortController) {
            abortController.abort()
            fetchPromise = null
        }

        if (fetchPromise) return fetchPromise

        abortController = new AbortController()
        const currentController = abortController;
        isLoading.value = true

        fetchPromise = (async () => {
            try {
                const res = await getMe({ signal: currentController.signal })

                if (currentController === abortController) {
                    markAuthenticated(res)
                }
            } catch (error: unknown) {
                if (isAbortError(error)) return;

                if (isAuthFailureError(error)) {
                    markGuest()
                } else {
                    const info = getKnownErrorInfo(error, 'auth_handshake_failed')
                    console.error('[UserStore] Auth handshake failed:', info.message);
                    // 如果是 500 或网络错误，不设置 accountState，允许重试
                }
            } finally {
                if (currentController === abortController) {
                    fetchPromise = null;
                    abortController = null;
                    isLoading.value = false;
                }
            }
        })()

        return fetchPromise
    }

    const ensureUserInfoFresh = async (options?: { maxAgeMs?: number; forceWhenUnknown?: boolean }) => {
        const maxAgeMs = options?.maxAgeMs ?? 30_000
        const forceWhenUnknown = options?.forceWhenUnknown ?? true

        if (accountState.value === 'unknown') {
            return fetchUserInfo(false)
        }

        if (accountState.value === 'guest') {
            if (lastVerifiedAt.value > 0 && Date.now() - lastVerifiedAt.value <= ACCOUNT_GUEST_NEGATIVE_CACHE_MS) {
                return
            }
            return fetchUserInfo(forceWhenUnknown)
        }

        if (lastVerifiedAt.value <= 0) {
            return fetchUserInfo(forceWhenUnknown)
        }

        if (Date.now() - lastVerifiedAt.value <= maxAgeMs) {
            return
        }

        return fetchUserInfo(true)
    }

    const logout = async () => {
        if (isLoggingOut.value) return;
        isLoggingOut.value = true;

        try {
            await logoutApi()
        } catch (error) {
            console.warn('[UserStore] Logout partial failure.');
        } finally {
            clearLocalFixtureSession()
            markGuest()
            await clearPrivateBrowserState('logout')
            await broadcastLogoutAcrossTabs()
            isLoggingOut.value = false;
            notificationStreamStore.dispose()
            notificationStreamStore.resetCursor()
            notificationStreamStore.setStatus('stopped')
            void notificationStreamRuntime.stop(true)
            if (typeof window !== 'undefined') {
                window.location.href = '/'
            }
        }
    }

    const updateStatus = (status: number, reason: string | null) => {
        if (userInfo.value) {
            userInfo.value = {
                ...userInfo.value,
                status: status,
                banReason: reason
            }
        }
    }

    return {
        userInfo,
        isLoading,
        accountState,
        isAuthChecked,
        lastVerifiedAt,
        authCacheVersion,
        lastFetchedAt,
        isLoggedIn,
        isAdmin,
        isBanned,
        isDeleted,
        markGuest,
        markAuthenticated,
        invalidateGuestCache,
        fetchUserInfo,
        ensureUserInfoFresh,
        logout,
        updateStatus
    }
}, {
    persist: {
        key: 'fsus_user_storage',
        storage: safeStorage,
        pick: ['accountState', 'lastVerifiedAt', 'authCacheVersion', 'lastFetchedAt']
    }
})
