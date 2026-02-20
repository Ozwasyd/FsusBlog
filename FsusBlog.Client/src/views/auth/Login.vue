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

        <form @submit.prevent="handleLogin" class="space-y-8">
          
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
              class="w-full bg-transparent border-b border-zinc-200 focus:border-zinc-950 py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 placeholder:font-normal outline-none transition-colors rounded-none appearance-none"
              :disabled="isProcessing"
            />
          </div>

          <div 
            v-if="errorMessage || powError" 
            class="text-[11px] font-mono font-bold text-red-500 tracking-wider uppercase animate-in fade-in slide-in-from-top-1"
          >
            * {{ errorMessage || powError }}
          </div>

          <div class="pt-4">
            <button 
              type="submit"
              :disabled="isProcessing || !isFormValid"
              class="w-full py-4 bg-zinc-950 text-white text-xs font-bold tracking-[0.2em] uppercase transition-all duration-300 active:scale-[0.98] active:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3 shadow-xl shadow-zinc-950/5"
            >
              <template v-if="isPowCalculating">
                <span class="animate-pulse flex items-center">
                  <span class="mr-2">🔒</span> 安全校验中...
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
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { login, getPowChallenge } from '@/api/auth'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import { usePow } from '@/composables/usePow'
import { getBrowserFp } from '@/utils/fingerprint' 
import { useNotification } from '@/composables/useNotification' // 🌟 引入通知 Hook 实现性能最大化

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const siteStore = useSiteStore()
const { initNotification } = useNotification() // 实例化通知服务

// 解构 usePow (由于状态是全局 Ref，这里解构是安全的，但为了清晰，我们重命名)
const { calculate, isCalculating: isPowCalculating, error: powError, prewarm } = usePow()

const loading = ref(false)
const errorMessage = ref('')
const loginData = reactive({ username: '', password: '' })

// 统一的处理状态：API Loading 或 PoW 计算中
const isProcessing = computed(() => loading.value || isPowCalculating.value)

// 表单校验：移除过于严格的正则，改用非空检查，兼容性更好
const isFormValid = computed(() => {
  return loginData.username.trim().length > 0 && 
         loginData.password.trim().length > 0
})

// 性能优化：延迟预热，避免阻塞首屏渲染
onMounted(() => {
  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => prewarm());
  } else {
    setTimeout(() => prewarm(), 1000);
  }
})

const handleLogin = async () => {
  // 重置错误状态
  errorMessage.value = ''
  
  if (!isFormValid.value || isProcessing.value) return

  loading.value = true
  
  try {
    // 1. 确定指纹：锁定本次登录流程的唯一指纹 (物理隔离)
    // 逻辑自洽：这个变量将贯穿 Calculate 和 Login API，确保后端验证一致
    const fp = getBrowserFp()
    
    // 2. 获取挑战 (API 请求)
    // 🌟 性能最大化：通过类型断言注入 _t 缓存穿透，保持与 useNotification 一致的风格
    const res = await getPowChallenge({ 
      action: 'login',
      _t: Date.now()
    } as any) as any
    
    // 适配 Axios 拦截器解包逻辑 (兼容直接返回 data 或返回 response)
    const challenge = res.data || res

    if (!challenge || !challenge.salt) {
      throw new Error("安全服务连接失败，请刷新重试")
    }

    // 3. 字段对齐：构造 PoW 计算所需的元数据
    const difficulty = Number(challenge.difficulty) || 4 // 默认兜底
    
    // 4. 执行计算 (调用 Worker)
    // 此时 isPowCalculating 会自动变为 true，按钮显示 "安全校验中..."
    const powResult = await calculate(challenge.salt, fp, difficulty)

    // 5. 提交登录：整合所有凭证
    // 安全性保障：必须将计算时使用的 fp 传给后端，否则哈希验算必挂
    const payload = {
      username: loginData.username,
      password: loginData.password,
      powSalt: challenge.salt,
      difficulty: difficulty,
      powTimestamp: challenge.timestamp,
      powSignature: challenge.signature,
      powNonce: powResult.nonce,
      browserFp: fp 
    }
    
    const userData = await login(payload)
    
    if (!userData || !userData.username) {
      throw new Error("服务器响应格式异常")
    }

    // 6. 登录成功状态写入
    // 逻辑自洽：setUserInfo 会同步设置 isAuthChecked=true，从而熔断后续路由守卫的重复请求
    userStore.setUserInfo(userData)

    // 7. 性能最大化：提前触发 SignalR 模式切换
    // 不使用 await，让其在后台静默启动（从游客模式切回认证模式），无需等待路由跳转
    initNotification(true);

    // 8. 页面跳转
    await router.push((route.query.redirect as string) || '/')

  } catch (error: any) {
    // 错误处理逻辑自洽
    if (error.message === 'ALREADY_CALCULATING') {
      // 忽略并发点击
      return
    }
    
    if (error.message === 'POW_CALCULATION_TIMEOUT') {
      errorMessage.value = '环境校验超时，请检查设备性能或刷新重试'
    } else {
      // 优先显示后端返回的 message (适配拦截器抛出的 Error 结构)
      errorMessage.value = error.response?.data?.message || error.message || '登录服务暂不可用'
    }
    console.error('[Login Error]', error)
  } finally {
    // 无论成功失败，重置 loading 状态
    // 注意：isPowCalculating 会由 usePow 内部自动重置
    loading.value = false
  }
}
</script>

<style scoped>
@reference "@/assets/main.css";

/* 强制锁死移动端横向溢出 */
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