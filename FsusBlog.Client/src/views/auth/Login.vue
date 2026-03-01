<template>
  <div class="min-h-screen flex flex-col bg-white subpixel-antialiased w-full overflow-x-hidden">
    
    <nav class="h-16 sm:h-20 flex items-center px-6 sm:px-8 shrink-0">
      <router-link to="/" class="text-xl font-bold tracking-tight text-zinc-950 hover:text-zinc-500 transition-colors duration-300">
        {{ siteStore.siteInfo.title }}
      </router-link>
    </nav>

    <main class="grow flex items-center justify-center px-6 pb-20 sm:pb-32">
      <div class="w-full max-w-sm animate-in fade-in slide-in-from-bottom-4 duration-700">
        
        <header class="mb-10 sm:mb-12">
          <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-zinc-950">
            登录
          </h1>
          <p class="mt-3 text-[13px] sm:text-sm text-zinc-500 leading-relaxed">
            欢迎回来，请验证你的身份信息以继续。
          </p>
        </header>

        <form @submit.prevent="handleLogin" class="space-y-8" novalidate>
          
          <div class="relative group">
            <label 
              for="username" 
              class="block text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase mb-2"
            >
              用户名
            </label>
            <input 
              id="username"
              v-model="loginData.username" 
              type="text"
              placeholder="输入你的用户名"
              autocomplete="username"
              autofocus
              aria-required="true"
              class="w-full bg-transparent border-b border-zinc-200 focus:border-zinc-950 py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 placeholder:font-normal outline-none transition-colors rounded-none appearance-none"
              :disabled="isProcessing"
            />
          </div>

          <div class="relative group">
            <label 
              for="password" 
              class="block text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase mb-2"
            >
              密码
            </label>
            <input 
              id="password"
              v-model="loginData.password" 
              type="password"
              placeholder="输入你的密码"
              autocomplete="current-password"
              aria-required="true"
              class="w-full bg-transparent border-b border-zinc-200 focus:border-zinc-950 py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 placeholder:font-normal outline-none transition-colors rounded-none appearance-none"
              :disabled="isProcessing"
            />
          </div>

          <!-- [修复 2026-02-24] P1 修复：增加 A11y 语义，确保屏幕阅读器能及时播报错误 -->
          <div 
            v-if="errorMessage" 
            role="alert"
            aria-live="polite"
            class="text-[11px] font-mono font-bold text-red-500 tracking-wider uppercase animate-in fade-in slide-in-from-top-1"
          >
            * {{ errorMessage }}
          </div>

          <div class="pt-4">
            <button 
              type="submit"
              :disabled="isProcessing || !isFormValid"
              :aria-disabled="isProcessing || !isFormValid"
              class="w-full py-4 bg-zinc-950 text-white text-xs font-bold tracking-[0.2em] uppercase transition-all duration-300 active:scale-[0.98] active:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3 shadow-xl shadow-zinc-950/5"
            >
              <!-- [修复 2026-02-23] 逻辑自洽：监听 usePow 提供的 isCalculating 状态 -->
              <template v-if="powProvider.isCalculating.value">
                <span class="animate-pulse flex items-center">
                  <!-- [修复 2026-02-24] P1 修复：隐藏装饰性 Emoji，避免干扰读屏 -->
                  <span class="mr-2" aria-hidden="true">🔒</span> 安全校验中...
                </span>
              </template>
              <template v-else-if="loading">
                <span class="animate-pulse">登录中...</span>
              </template>
              <template v-else>
                进行 <span class="text-zinc-500">→</span>
              </template>
            </button>
          </div>
        </form>

        <footer class="mt-12 flex justify-between items-center border-t border-zinc-100 pt-8">
          <router-link to="/register" class="text-[10px] font-bold tracking-widest uppercase text-zinc-400 hover:text-zinc-950 transition-colors py-2 px-1">
            注册
          </router-link>
          <router-link to="/" class="text-[10px] font-bold tracking-widest uppercase text-zinc-400 hover:text-zinc-950 transition-colors py-2 px-1">
            取消
          </router-link>
        </footer>

      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { login } from '@/api/auth'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import { usePow } from '@/composables/usePow'
import { useNotification } from '@/composables/useNotification' 

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const siteStore = useSiteStore()
const { initNotification } = useNotification()
const powProvider = usePow()

const loading = ref(false)
const errorMessage = ref('')
const loginData = reactive({ username: '', password: '' })

// 统一的处理状态：API Loading 或 PoW 计算中
const isProcessing = computed(() => loading.value || powProvider.isCalculating.value)

const isFormValid = computed(() => {
  return loginData.username.trim().length > 0 && 
         loginData.password.trim().length > 0
})

//[修复 2026-02-23] 物理安全性：引入 AbortController 防止重复提交
let abortController: AbortController | null = null

onMounted(() => {
  // 性能优化：延迟预热，避免阻塞首屏渲染
  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => powProvider.prewarm());
  } else {
    setTimeout(() => powProvider.prewarm(), 1000);
  }
})

onUnmounted(() => {
  if (abortController) abortController.abort()
})

/**
 *[修复 2026-02-24] P0 修复：开放重定向防御
 * 逻辑自洽：只允许站内相对路径跳转，物理拦截钓鱼链接
 */
const getSafeRedirect = (target: unknown): string => {
  if (typeof target !== 'string') return '/'
  // 必须以 / 开头，且不能以 // 开头（防止 //google.com 协议相对路径绕过）
  if (target.startsWith('/') && !target.startsWith('//')) {
    return target
  }
  return '/'
}

const handleLogin = async () => {
  errorMessage.value = ''
  
  if (!isFormValid.value || isProcessing.value) return

  //[修复 2026-02-23] 竞态防护：物理切断上一次未完成的登录请求
  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const currentSignal = currentController.signal

  loading.value = true
  
  try {
    /**
     * [修复 2026-02-23] 架构演进：废弃冗余的 PoW 手动运算
     * 逻辑自洽：登录接口作为核心高危操作，已在底层配置 requiresPow: true
     */
    
    //[修改日期 2026-02-28 23]
    // 修改理由：性能最大化。移除显式 requiresPow: true 的冗余声明（底层 api 已经强绑定），
    // 并且内联对象减少局部变量引用，优化内存生命周期。
    const userData = await login(
      { username: loginData.username, password: loginData.password }, 
      { signal: currentSignal }
    )

    // 竞态检查
    if (!currentSignal.aborted) {
      if (!userData || !userData.username) {
        throw new Error("服务器响应格式异常")
      }

      // [修复 2026-02-24] P0 修复：在路由跳转前物理置空控制器，防止幽灵引用
      if (abortController === currentController) {
        abortController = null
      }

      userStore.setUserInfo(userData)
      // 安全性：内存敏感数据清理
      loginData.password = ''

      // 性能最大化：提前触发 SignalR 模式切换
      initNotification(true).catch(() => {});

      await router.push(getSafeRedirect(route.query.redirect))
    }

  } catch (error: any) {
    // 忽略主动取消请求和 Axios 的 Cancel 错误
    if (error?.name === 'AbortError' || error?.message === 'canceled') return

    // [修改日期 2026-02-28 23]
    // 修改理由：精简组件层的错误捕获（O(1)理念），并增强业务提示准确性。
    // [修复 2026-02-24] P0 修复：防御性错误对象解析
    // 逻辑自洽：不再假定 error 一定是标准 Error 对象，且拦截器已将外壳剥离。
    const msg = error?.message || String(error)
    
    // 对错误进行安全与精准的归类提示
    if (msg.includes('POW_CALCULATION_TIMEOUT')) {
      errorMessage.value = '环境安全校验超时，请检查设备性能或刷新重试'
    } else if (msg.includes('Account Locked') || msg.includes('锁定') || msg.includes('受限')) {
      errorMessage.value = '该账户已被安全锁定，请联系管理员解锁'
    } else if (msg.includes('Forbidden') || msg.includes('权限不足')) {
      errorMessage.value = '此账号无系统登录权限'
    } else if (msg.includes('Unauthorized') || msg.includes('401')) {
      errorMessage.value = '用户名或密码错误，请重新输入'
    } else if (msg.includes('Network Error') || msg.includes('timeout')) {
      errorMessage.value = '网络连接异常，请检查您的网络设置'
    } else if (msg.includes('格式异常')) {
      errorMessage.value = '系统数据异常，请刷新页面后重试'
    } else {
      // 捕获不可预见的通用错误
      errorMessage.value = msg || '登录服务暂不可用，请稍后再试'
    }
    
    console.error('[Login Error]', error)
  } finally {
    // 仅当当前请求仍为活跃请求时，才重置 loading 状态
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}
</script>

<style scoped>
@reference "@/assets/main.css";

input {
  max-width: 100%;
}

/* 覆盖浏览器默认的自动填充样式，保持设计一致性 */
input:-webkit-autofill,
input:-webkit-autofill:hover, 
input:-webkit-autofill:focus, 
input:-webkit-autofill:active{
    -webkit-box-shadow: 0 0 0 30px white inset !important;
    -webkit-text-fill-color: #18181b !important;
    transition: background-color 5000s ease-in-out 0s;
}
</style>