import axios, { type InternalAxiosRequestConfig, type AxiosResponse, type AxiosRequestConfig } from 'axios'
import { useUserStore } from '@/store/user'
import router from '@/router'
import { toast } from '@/utils/toast'

// 核心修复 2：TypeScript 类型扩展，彻底解决 IDE 报错 (修复日期: 2026-02-20)
// 逻辑自洽：告诉 TypeScript，经过拦截器处理后，Axios 实例将直接返回解包后的业务数据 T
declare module 'axios' {
    export interface AxiosInstance {
        request<T = any, R = T, D = any>(config: AxiosRequestConfig<D>): Promise<R>;
        get<T = any, R = T, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<R>;
        delete<T = any, R = T, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<R>;
        head<T = any, R = T, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<R>;
        options<T = any, R = T, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<R>;
        post<T = any, R = T, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<R>;
        put<T = any, R = T, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<R>;
        patch<T = any, R = T, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<R>;
    }
}

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
            // 核心修复 1：必须解包并返回真实的业务数据 res.data！(修复日期: 2026-02-20)
            // 防止前端组件拿到的永远是外层的 ApiResponse 包装壳，导致数据读取全部变成 undefined
            return res.data as any
        }

        // 2. 匿名请求成功 (针对外部 API 或特殊端点)
        if (isAnonymousSuccess) {
            return res as any
        }

        // 3. 账户锁定 (423) - 适配 BannedUserFilter (修复日期: 2026-02-20)
        // 逻辑自洽：当后端显式返回 423 时，仅提示错误并同步 Store 状态，不清除登录态
        if (res.code === 423) {
            const userStore = useUserStore()
            userStore.updateStatus(1, res.message) // 静默同步横幅状态
            toast.error(res.message || '操作受限：账户已被锁定')
            return Promise.reject(new Error(res.message || 'Account Locked'))
        }

        // 4. 权限不足 (403)
        if (res.code === 403) {
            toast.error(res.message || '权限不足')
            return Promise.reject(new Error(res.message || 'Forbidden'))
        }

        // 5. 其他业务失败
        toast.error(res.message || '服务响应异常')
        return Promise.reject(new Error(res.message || 'Error'))
    },
    (error) => {
        const { response } = error
        const userStore = useUserStore()

        if (response) {
            const { status, data } = response

            // 1. 身份失效 (401)
            if (status === 401) {
                return performFinalLogout(userStore, window.location.pathname)
            }

            // 2. 账户锁定 (423) - 适配 BannedUserFilter HTTP 状态码 (修复日期: 2026-02-20)
            // 安全性保障：捕获 423 状态码，防止被后续的 403 或通用错误逻辑拦截
            if (status === 423) {
                const banMsg = data?.message || '操作已拦截：您的账号当前处于受限状态'
                userStore.updateStatus(1, banMsg) // 同步 Store，确认为封禁用户
                toast.error(banMsg)
                return Promise.reject(new Error(banMsg))
            }

            // 3. 访问受限 (403)
            if (status === 403) {
                toast.error(data?.message || '访问受限：无操作权限')
                return Promise.reject(new Error(data?.message || 'Forbidden'))
            }

            // 4. 服务器崩溃 (500)
            if (status === 500) {
                toast.error('服务器内部错误，请稍后再试')
                return Promise.reject(new Error('Internal Server Error'))
            }
        }

        // 网络中断或超时处理
        if (error.message.includes('timeout')) {
            toast.error('请求超时，请检查网络连接')
        } else if (!window.navigator.onLine) {
            toast.error('网络已断开')
        }

        return Promise.reject(error)
    }
)

/**
 * 执行最终注销逻辑
 */
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
    requestsQueue = []
}

export default service