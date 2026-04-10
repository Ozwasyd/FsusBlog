import axios, { type InternalAxiosRequestConfig, type AxiosResponse  } from 'axios'
import { useUserStore } from '@/store/user'
import router from '@/router'
import { toast } from '@/utils/toast'
import { usePow, PowAbortError } from '@/composables/usePow' 
import { getBrowserFp } from '@/utils/fingerprint' 
import { decodeBinaryEnvelope } from './binaryEnvelope'

// 核心修复 2：TypeScript 类型扩展，彻底解决 IDE 报错 (修复日期: 2026-02-20)
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
    export interface AxiosRequestConfig {
        requiresPow?: boolean;
    }
    export interface InternalAxiosRequestConfig {
        requiresPow?: boolean;
    }
}

interface ApiResponse<T = any> {
    code?: number
    Code?: number
    message?: string
    Message?: string
    data?: T
    Data?: T
}

function toArrayBuffer(data: unknown): ArrayBuffer | null {
    if (data instanceof ArrayBuffer) {
        return data;
    }
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return null;
}

function decodeApiBody(data: unknown): ApiResponse {
    const buffer = toArrayBuffer(data);
    if (!buffer) {
        return (data ?? {}) as ApiResponse;
    }

    const envelope = decodeBinaryEnvelope(buffer);
    if (envelope.bodyJson && typeof envelope.bodyJson === 'object') {
        return envelope.bodyJson as ApiResponse;
    }

    if (envelope.bodyText.length > 0) {
        return { code: envelope.statusCode, message: envelope.bodyText };
    }

    return { code: envelope.statusCode };
}

const utf8Encoder = new TextEncoder();
const BASE64_ENCODE_CHUNK = 0x8000;

// 性能与稳定性优化：避免对大 Uint8Array 使用展开运算符导致栈抖动。
const toBinaryString = (bytes: Uint8Array): string => {
    let result = '';
    for (let i = 0; i < bytes.length; i += BASE64_ENCODE_CHUNK) {
        const chunk = bytes.subarray(i, i + BASE64_ENCODE_CHUNK);
        result += String.fromCharCode(...chunk);
    }
    return result;
};

const toSafeBase64 = (obj: object): string => {
    const str = JSON.stringify(obj);
    const bytes = utf8Encoder.encode(str);
    return btoa(toBinaryString(bytes));
};

// =================================================================================
// 核心状态锁
// =================================================================================
let isReloginShow = false
//[修改日期 2026-03-01 11] 
// 恢复并发锁状态变量，用于真正驱动 JWT 无感自换票机制
let isRefreshing = false
let requestsQueue: Array<{ resolve: Function, reject: Function, originalConfig: any }> =[]

const service = axios.create({
    baseURL: '/api',
    timeout: 10000,
    withCredentials: true,
    responseType: 'arraybuffer'
})

// =================================================================================
// 1. 请求拦截器：PoW 算力注入
// =================================================================================
service.interceptors.request.use(
    async (config: InternalAxiosRequestConfig) => {
        if (!config.requiresPow || config.url?.includes('pow-challenge')) {
            return config;
        }

        const { calculate } = usePow();
        const controller = new AbortController();
        
        if (config.signal) {
            const externalSignal = config.signal as any;
            if (typeof externalSignal.addEventListener === 'function') {
                externalSignal.addEventListener('abort', () => controller.abort());
            }
        }
        config.signal = controller.signal;

        try {
            const challenge = await service.get<any>('/Auth/pow-challenge', {
                params: { _t: Date.now() },
                withCredentials: true
            });
            
            const raw = challenge;
            const c = raw.data || raw.Data || raw; 

            const salt = c.salt || c.Salt;
            const difficulty = c.difficulty ?? c.Difficulty;
            const timestamp = c.timestamp ?? c.Timestamp;
            const signature = c.signature || c.Signature;

            if (!salt || signature === undefined) {
                throw new Error("CHALLENGE_PARSE_FAILED");
            }

            const fp = getBrowserFp(); 
            const { nonce } = await calculate(salt, fp, difficulty);

            const powPayload = {
                powSalt: salt,
                powNonce: nonce,
                powTimestamp: timestamp, 
                difficulty: difficulty,
                powSignature: signature,
                browserFp: fp
            };

            config.headers = config.headers || {};
            config.headers['X-Fsus-Pow-Proof'] = toSafeBase64(powPayload);
            
            return config;
        } catch (error) {
            if (error instanceof PowAbortError) {
                controller.abort();
            }
            return Promise.reject(error);
        }
    },
    (error) => Promise.reject(error)
)

// =================================================================================
// 2. 响应拦截器：全局错误处理与装箱拆包
// =================================================================================
service.interceptors.response.use(
    (response: AxiosResponse<ArrayBuffer | ApiResponse>) => {
        const res = decodeApiBody(response.data)
        const code = res.code ?? res.Code;
        const message = res.message ?? res.Message;
        
        const isStandardSuccess = code === 200 || code === 201;
        const isAnonymousSuccess = !Object.prototype.hasOwnProperty.call(res, 'code') && !Object.prototype.hasOwnProperty.call(res, 'Code') && response.status >= 200 && response.status < 300;

        // 1. 业务成功 (直接脱壳并返回数据指针)
        if (isStandardSuccess) {
            const data = res.data !== undefined ? res.data : res.Data;
            return data as any
        }

        // 2. 匿名请求成功
        if (isAnonymousSuccess) {
            return res as any
        }

        // 3. 账户锁定 (423)
        if (code === 423) {
            const userStore = useUserStore()
            const banMsg = message || '操作受限：账户已被锁定'
            userStore.updateStatus(1, banMsg) 
            toast.error(banMsg)
            return Promise.reject(new Error(banMsg))
        }

        // 4. 权限不足 (403)
        if (code === 403) {
            toast.error(message || '权限不足')
            return Promise.reject(new Error(message || 'Forbidden'))
        }

        // 5. 其他业务失败
        toast.error(message || '服务响应异常')
        return Promise.reject(new Error(message || 'Error'))
    },
    async (error) => {
        if (axios.isCancel(error)) {
            return Promise.reject(error);
        }

        const { response, config } = error
        const userStore = useUserStore()

        if (response) {
            const { status, data } = response
            const responseData = decodeApiBody(data) as ApiResponse | undefined;
            const message = responseData?.message ?? responseData?.Message;

            // ==============================================================================
            //[修改日期 2026-03-01 11]
            // 修改理由：实现真正的 Token 无感自换票。拦截 401 状态，阻塞并发请求，完成换票后重发。
            // ==============================================================================
            if (status === 401) {
                // 防御性设计：如果是刷新 Token 的接口本身报 401，说明 RefreshToken 已过期或被伪造，彻底注销
                if (config.url?.includes('/Auth/refresh-token')) {
                    return performFinalLogout(userStore, window.location.pathname);
                }

                if (!isRefreshing) {
                    isRefreshing = true;
                    try {
                        // 1. 发起换票请求 (依赖 withCredentials 自动提交 Cookie 中的 refreshToken)
                        await service.post('/Auth/refresh-token');
                        
                        // 2. 换票成功，后端已重写 HttpOnly Cookie。释放队列中挂起的所有请求，触发自动重试
                        requestsQueue.forEach(q => q.resolve(service(q.originalConfig)));
                        requestsQueue =[];
                        
                        // 3. 重试当前触发 401 的原始请求
                        return service(config);
                    } catch (refreshError) {
                        // 换票失败，清空挂起队列并将其全部驳回，然后强制注销用户
                        requestsQueue.forEach(q => q.reject(refreshError));
                        requestsQueue =[];
                        return performFinalLogout(userStore, window.location.pathname);
                    } finally {
                        isRefreshing = false;
                    }
                } else {
                    // 锁被占用，说明当前有正在进行的换票流程。
                    // 逻辑自洽：挂起 Promise，将其指针存入队列。这实现了 $O(1)$ 的并发拦截，不会产生冗余的网络请求。
                    return new Promise((resolve, reject) => {
                        requestsQueue.push({ resolve, reject, originalConfig: config });
                    });
                }
            }

            // 2. 账户锁定 (423)
            if (status === 423) {
                const banMsg = message || '操作已拦截：您的账号当前处于受限状态'
                userStore.updateStatus(1, banMsg) 
                toast.error(banMsg)
                return Promise.reject(new Error(banMsg))
            }

            // 3. 访问受限 (403)
            if (status === 403) {
                toast.error(message || '访问受限：无操作权限')
                return Promise.reject(new Error(message || 'Forbidden'))
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

// 恢复清空全锁状态，供页面级路由守卫或极端异常时重置使用
export const resetApiLocks = () => {
    isRefreshing = false
    isReloginShow = false
    requestsQueue = []
}
export default service
