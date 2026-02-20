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
   * 彻底重置本地缓存的认证状态与 API 锁
   */
  const clearLocalState = () => {
    resetApiLocks()
    userInfo.value = null
    isLoaded.value = false
    isAuthChecked.value = false
    fetchPromise = null
  }

  // ================= 4. Actions =================

  /**
   * 手动设置用户信息
   */
  const setUserInfo = (info: UserInfo) => {
    userInfo.value = info
    isLoaded.value = true
    // 逻辑自洽：手动填入数据意味着鉴权肯定已完成
    isAuthChecked.value = true
  }

  /**
   * 获取/恢复用户信息 (带并发锁与熔断机制)
   */
  const fetchUserInfo = async () => {
    // 1. 性能最大化：如果已经完成过鉴权（哪怕是 401 失败变成了游客），
    // 直接返回，彻底阻断路由切换时的重复无效请求。
    if (isAuthChecked.value) return

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
        // 2. 核心修复：无论成功还是异常，都标记“鉴权动作已完成”
        // 这样下次调用时，第一行代码就会拦截，不再触发网络请求
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
      // 逻辑自洽：无论后端调用成功与否，前端必须彻底清理状态
      clearLocalState()
      // 彻底抹除并回归首页
      window.location.href = '/'
    }
  }

  /**
   * 静默更新用户状态 (用于 SignalR 实时下发)
   */
  const updateStatus = (status: number, reason: string | null) => {
    if (userInfo.value) {
      userInfo.value.status = status
      userInfo.value.banReason = reason
      console.log(`[Store] 用户状态已更新: ${status === 1 ? '受限' : '正常'}`)
    }
  }

  /**
   * 强制安全登出 (纯前端清理)
   * 用于封禁、重置密码等高危场景，无需等待后端回执
   */
  const forceLogout = () => {
    clearLocalState()
    
    // 由于使用了 Cookie 模式，后端封禁后 Cookie 会在 API 层失效
    // 前端直接重定向回首页或登录页，触发重新加载以清除所有闭包状态
    window.location.href = '/login?reason=security_kickout'
  }

  return {
    userInfo,
    isLoggedIn, // 用于 App.vue 监听
    isAdmin,
    isBanned,
    isLoaded,
    isAuthChecked, // 导出此状态，以便路由守卫可能需要判断“鉴权是否完成”
    setUserInfo,
    fetchUserInfo,
    updateStatus,
    logout,
    forceLogout
  }
})