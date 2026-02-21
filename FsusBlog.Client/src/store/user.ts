import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { resetApiLocks } from '@/api/index'
import { getMe, logout as logoutApi, type UserInfo } from '@/api/auth'

export const useUserStore = defineStore('user', () => {

    // ================= 1. State =================
    const userInfo = ref<UserInfo | null>(null)
    const isLoaded = ref(false)

    /** * 鉴权状态锁
     * 用于标记“是否已经执行过初始身份检查”。
     * true = 已完成握手（无论结果是登录成功还是游客），避免 401 循环请求。
     */
    const isAuthChecked = ref(false)

    let fetchPromise: Promise<void> | null = null

    // ================= 2. Getters =================
    const isLoggedIn = computed(() => !!userInfo.value)
    const isAdmin = computed(() => userInfo.value?.role === 'admin')
    const isBanned = computed(() => userInfo.value?.status === 1)

    // ================= 3. Private Helpers =================

    /**
     * 核心状态清理 (代码复用)
     */
    const clearLocalState = () => {
        resetApiLocks()
        userInfo.value = null
        isLoaded.value = false
        isAuthChecked.value = false
        fetchPromise = null
    }

    // ================= 4. Actions =================

    // 核心修复：补充缺失的 setUserInfo 方法供登录组件手动注入状态 (修复日期: 2026-02-20)
    // 逻辑自洽：同步更新 isLoaded 和 isAuthChecked 锁，防止冗余的 API 请求
    const setUserInfo = (info: UserInfo | null) => {
        userInfo.value = info
        if (info) {
            isLoaded.value = true
            isAuthChecked.value = true
        } else {
            clearLocalState()
        }
    }

    /**
     * 同步当前用户信息
     * 逻辑自洽：通过 force 参数解决刷新后持久化数据可能过期的问题
     */
    const fetchUserInfo = async (force = false) => {
        // 如果已经检查过且非强制刷新，则直接返回
        if (isAuthChecked.value && !force) return
        if (fetchPromise) return fetchPromise

        fetchPromise = (async () => {
            try {
                const res = await getMe()
                userInfo.value = res
                isLoaded.value = true
            } catch (error) {
                userInfo.value = null
                isLoaded.value = false
            } finally {
                fetchPromise = null
                isAuthChecked.value = true
            }
        })()

        return fetchPromise
    }

    /**
     * 安全退出
     */
    const logout = async () => {
        try {
            await logoutApi()
        } catch (error) {
            console.warn('后端返回：注销失败或已失效。')
        } finally {
            clearLocalState()
            window.location.href = '/'
        }
    }

    /**
     * 静默更新用户状态 (用于 SignalR 实时下发)
     * 性能最大化：使用对象展开确保深度响应式生效
     */
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
        isLoaded,
        isAuthChecked,
        isLoggedIn,
        isAdmin,
        isBanned,
        setUserInfo, // 核心修复：必须导出该方法，否则外部组件调用时会报 is not a function (修复日期: 2026-02-20)
        fetchUserInfo,
        logout,
        updateStatus
    }
}, {
    persist: {
        key: 'fsus_user_storage',
        storage: localStorage,
        pick: ['userInfo', 'isAuthChecked']
    }
})