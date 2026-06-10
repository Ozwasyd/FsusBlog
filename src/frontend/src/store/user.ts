import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getMe, logout as logoutApi, type CurrentUserSnapshot } from '@/api/auth'
import { notificationStreamRuntime } from '@/services/notificationStreamRuntime'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { isAbortError } from '@/utils/errors'
import { getKnownErrorInfo, isAuthFailureError } from '@/utils/errorKinds'

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

export const useUserStore = defineStore('user', () => {
    const notificationStreamStore = useNotificationStreamStore()

    // ================= 1. State =================
    const userInfo = ref<CurrentUserSnapshot | null>(null)
    const isAuthChecked = ref(false)
    const isLoading = ref(false)
    const isLoggingOut = ref(false)
    const lastFetchedAt = ref(0)

    let fetchPromise: Promise<void> | null = null
    let abortController: AbortController | null = null

    // ================= 2. Getters =================
    const isLoggedIn = computed(() => !!userInfo.value)

    const isAdmin = computed(() => {
        const adminRoles = ['admin'];
        return userInfo.value ? adminRoles.includes(userInfo.value.role) : false;
    })

    const isBanned = computed(() => userInfo.value?.status === 1)
    const isDeleted = computed(() => userInfo.value?.status === 2)

    // ================= 3. Private Helpers =================

    const clearLocalState = () => {
        if (abortController) {
            abortController.abort()
            abortController = null
        }
        userInfo.value = null
        isAuthChecked.value = false
        isLoading.value = false
        lastFetchedAt.value = 0
        fetchPromise = null

        notificationStreamStore.dispose()
        notificationStreamStore.resetCursor()
        notificationStreamStore.setStatus('stopped')
        void notificationStreamRuntime.stop(true)
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem('notification_stream_guest_pow');
        }
    }

    // ================= 4. Actions =================

    const setUserInfo = (info: CurrentUserSnapshot | null) => {
        if (!info) {
            clearLocalState()
            return
        }
        userInfo.value = info
        isAuthChecked.value = true
        lastFetchedAt.value = Date.now()
    }

    const fetchUserInfo = async (force = false) => {
        if (isAuthChecked.value && userInfo.value && !force) return

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
                    userInfo.value = res
                    isAuthChecked.value = true
                    lastFetchedAt.value = Date.now()
                }
            } catch (error: unknown) {
                if (isAbortError(error)) return;

                if (isAuthFailureError(error)) {
                    userInfo.value = null;
                    isAuthChecked.value = true; // 标记握手完成，身份确认：游客
                    lastFetchedAt.value = Date.now()
                } else {
                    const info = getKnownErrorInfo(error, 'auth_handshake_failed')
                    console.error('[UserStore] Auth handshake failed:', info.message);
                    // 如果是 500 或网络错误，不设置 isAuthChecked，允许重试
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

        if (!isAuthChecked.value) {
            return fetchUserInfo(false)
        }

        if (lastFetchedAt.value <= 0) {
            return fetchUserInfo(forceWhenUnknown)
        }

        if (Date.now() - lastFetchedAt.value <= maxAgeMs) {
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
            clearLocalState()
            isLoggingOut.value = false;
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
        isAuthChecked,
        lastFetchedAt,
        isLoggedIn,
        isAdmin,
        isBanned,
        isDeleted,
        setUserInfo,
        fetchUserInfo,
        ensureUserInfoFresh,
        logout,
        updateStatus
    }
}, {
    persist: {
        key: 'fsus_user_storage',
        storage: safeStorage,
        pick: ['isAuthChecked']
    }
})
