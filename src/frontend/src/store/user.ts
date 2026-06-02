import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getMe, logout as logoutApi, type CurrentUserSnapshot } from '@/api/auth'
import { sseRuntime } from '@/services/sseRuntime'
import { useSseStore } from '@/store/sse'
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
    const sseStore = useSseStore()

    // ================= 1. State =================
    const userInfo = ref<CurrentUserSnapshot | null>(null)
    const isAuthChecked = ref(false)
    const isLoading = ref(false)
    const isLoggingOut = ref(false)

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
        fetchPromise = null

        sseStore.dispose()
        sseStore.resetCursor()
        sseStore.setStatus('stopped')
        void sseRuntime.stop(true)
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem('sse_guest_pow');
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
                }
            } catch (error: unknown) {
                if (isAbortError(error)) return;

                if (isAuthFailureError(error)) {
                    userInfo.value = null;
                    isAuthChecked.value = true; // 标记握手完成，身份确认：游客
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
        isLoggedIn,
        isAdmin,
        isBanned,
        isDeleted,
        setUserInfo,
        fetchUserInfo,
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
