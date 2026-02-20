import axios, { type InternalAxiosRequestConfig, type AxiosResponse } from 'axios'
import { useUserStore } from '@/store/user'
import router from '@/router' 
import { toast } from '@/utils/toast'

interface ApiResponse<T = any> {
  code: number
  message: string
  data: T
}

// =================================================================================
// 核心状态锁
// =================================================================================
let isRefreshing = false     
let requestsQueue: Array<{ resolve: Function, reject: Function, originalConfig: any }> = [] 
let isReloginShow = false    

const service = axios.create({
  baseURL: '/api',
  timeout: 10000,
  withCredentials: true 
})

service.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => config,
  (error) => Promise.reject(error)
)

service.interceptors.response.use(
  (response: AxiosResponse<ApiResponse>) => {
    const res = response.data
    const isStandardSuccess = res.code === 200 || res.code === 201;
    const isAnonymousSuccess = !Object.prototype.hasOwnProperty.call(res, 'code') && response.status >= 200 && response.status < 300;
    
    // 1. 业务成功 (200, 201)
    if (isStandardSuccess) {
      return res.data !== null && res.data !== undefined ? res.data : res;
    }

    if (isAnonymousSuccess) {
      return res;
    }

    // 2. 业务级 401 处理
    if (res.code === 401) return handle401Error(response.config)

    //  3. 业务级 403 处理 (针对部分后端将 403 放在 200 响应体中的情况)
    if (res.code === 403) {
      toast.error(res.message || '账号当前受限，无法执行此操作。', 6000)
      return Promise.reject(new Error(res.message || 'Forbidden'))
    }

    // 4. 其他业务错误
    toast.error(res.message || '系统错误。')
    return Promise.reject(new Error(res.message || 'Error'))
  },
  async (error) => {
    const status = error.response?.status
    const config = error.config
    const backendData = error.response?.data as ApiResponse
    const msg = backendData?.message || error.response?.data?.message || '网络错误。'

    switch (status) {
      case 401:
        return handle401Error(config)
      case 403:
        toast.error(msg || '访问被拒绝：您的账号权限不足或已被限制。', 8000)
        break
      case 404:
        toast.error('资源未找到。')
        break
      case 500:
        toast.error(`服务器错误: ${msg.toUpperCase()}`)
        break
      default:
        toast.error(msg.toUpperCase())
    }
    return Promise.reject(error)
  }
)

async function handle401Error(config: any) {
  const userStore = useUserStore()
  const currentPath = router.currentRoute.value.fullPath
  
  const isRefreshRequest = config.url.toLowerCase().includes('refresh-token')

  if (isRefreshRequest) {
    isRefreshing = false
    clearQueue(new Error('SESSION_EXPIRED')) 
    return performFinalLogout(userStore, currentPath)
  }

  if (isRefreshing) {
    return new Promise((resolve, reject) => {
      requestsQueue.push({ resolve, reject, originalConfig: config })
    })
  }

  isRefreshing = true
  try {
    await axios.post('/api/Auth/refresh-token', {}, { withCredentials: true })
    
    isRefreshing = false
    const pendingRequests = [...requestsQueue]
    requestsQueue = []
    
    pendingRequests.forEach(({ resolve, originalConfig }) => {
      resolve(service(originalConfig))
    })
    
    return service(config)
  } catch (err) {
    isRefreshing = false
    clearQueue(err) 
    return performFinalLogout(userStore, currentPath)
  }
}

const clearQueue = (error: any = null) => {
  if (error) {
    requestsQueue.forEach(({ reject }) => reject(error))
  }
  requestsQueue = []
}

function performFinalLogout(userStore: any, currentPath: string) {
  const isAuthPage = currentPath.includes('/login') || currentPath.includes('/register')
  if (isAuthPage) {
    isReloginShow = false
    return Promise.reject(new Error('Auth page 401'))
  }

  if (!isReloginShow) {
    isReloginShow = true
    const requiresAuth = router.currentRoute.value.meta.requiresAuth

    if (userStore.isLoggedIn || userStore.userInfo?.role) {
      toast.error('SESSION过期。请重新登录。')
      userStore.userInfo = null
      localStorage.removeItem('user_metadata')
      router.push(`/login?redirect=${encodeURIComponent(currentPath)}`)
        .finally(() => { setTimeout(() => { isReloginShow = false }, 1000) })
    } 
    else if (requiresAuth) {
      toast.info('需要验证。')
      router.push(`/login?redirect=${encodeURIComponent(currentPath)}`)
        .finally(() => { setTimeout(() => { isReloginShow = false }, 1000) })
    }
    else {
      isReloginShow = false
    }
  }
  return Promise.reject(new Error('Unauthorized'))
}

export const resetApiLocks = () => {
  isRefreshing = false
  isReloginShow = false
  clearQueue(false) 
}

export default service as unknown as {
  get<T = any>(url: string, config?: any): Promise<T>
  post<T = any>(url: string, data?: any, config?: any): Promise<T>
  put<T = any>(url: string, data?: any, config?: any): Promise<T>
  delete<T = any>(url: string, config?: any): Promise<T>
}