<template>
  <div class="min-h-screen flex flex-col bg-white subpixel-antialiased w-full overflow-x-hidden">
    
    <nav class="h-16 sm:h-20 flex items-center px-6 sm:px-8 shrink-0">
      <router-link to="/" class="text-lg sm:text-xl font-bold tracking-tight text-zinc-950 hover:text-zinc-500 transition-colors duration-300">
        {{ siteStore.siteInfo.title }}
      </router-link>
    </nav>

    <main class="grow flex items-center justify-center px-6 pb-20 sm:pb-32">
      <div class="w-full max-w-sm animate-in fade-in slide-in-from-bottom-4 duration-700">
        
        <header class="mb-10 sm:mb-12">
          <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-zinc-950">
            注册账户
          </h1>
        </header>

        <form @submit.prevent="handleRegister" class="space-y-7" novalidate>
          
          <div class="relative group">
            <label 
              for="username"
              class="block text-[10px] font-bold tracking-[0.2em] uppercase mb-2 transition-colors"
              :class="usernameHint ? 'text-red-500' : 'text-zinc-400'"
            >
              用户名
            </label>
            <input 
              id="username"
              v-model="registerData.username"
              type="text"
              placeholder="3-20位中英文字符"
              class="w-full bg-transparent border-b py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :class="usernameHint ? 'border-red-500 focus:border-red-500' : 'border-zinc-200 focus:border-zinc-950'"
              :disabled="isProcessing"
              required
              aria-required="true"
              autofocus
            />
            <!--[修改日期 2026-03-01] 实时校验反馈，利用绝对定位嵌入 form 的 gap 缝隙中，零布局抖动 -->
            <p v-if="usernameHint" class="absolute -bottom-5 left-0 text-[10px] font-bold tracking-wider text-red-500 animate-in fade-in slide-in-from-top-1">
              {{ usernameHint }}
            </p>
          </div>

          <div class="relative group">
            <label 
              for="password"
              class="block text-[10px] font-bold tracking-[0.2em] uppercase mb-2 transition-colors"
              :class="passwordHint ? 'text-red-500' : 'text-zinc-400'"
            >
              密码
            </label>
            <input 
              id="password"
              v-model="registerData.password"
              type="password"
              placeholder="最少六个字符"
              class="w-full bg-transparent border-b py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :class="passwordHint ? 'border-red-500 focus:border-red-500' : 'border-zinc-200 focus:border-zinc-950'"
              :disabled="isProcessing"
              required
              aria-required="true"
              autocomplete="new-password"
            />
            <p v-if="passwordHint" class="absolute -bottom-5 left-0 text-[10px] font-bold tracking-wider text-red-500 animate-in fade-in slide-in-from-top-1">
              {{ passwordHint }}
            </p>
          </div>

          <div class="relative group">
            <label 
              for="confirm-password"
              class="block text-[10px] font-bold tracking-[0.2em] uppercase mb-2 transition-colors"
              :class="confirmPasswordHint ? 'text-red-500' : 'text-zinc-400'"
            >
              确认密码
            </label>
            <input 
              id="confirm-password"
              v-model="registerData.confirmPassword"
              type="password"
              placeholder="再次输入你的密码"
              class="w-full bg-transparent border-b py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :class="confirmPasswordHint ? 'border-red-500 focus:border-red-500' : 'border-zinc-200 focus:border-zinc-950'"
              :disabled="isProcessing"
              required
              aria-required="true"
              autocomplete="new-password"
            />
            <p v-if="confirmPasswordHint" class="absolute -bottom-5 left-0 text-[10px] font-bold tracking-wider text-red-500 animate-in fade-in slide-in-from-top-1">
              {{ confirmPasswordHint }}
            </p>
          </div>

          <div class="flex items-start pt-2">
            <div class="flex items-center h-5">
              <input 
                id="agreement" 
                type="checkbox" 
                v-model="isAgreed"
                :disabled="isProcessing"
                class="w-4 h-4 shrink-0 border border-zinc-300 rounded-none bg-transparent checked:bg-zinc-950 checked:border-zinc-950 focus:ring-0 cursor-pointer transition-all appearance-none relative checked:after:content-['✓'] checked:after:text-white checked:after:text-[10px] checked:after:absolute checked:after:left-0.5 checked:after:-top-px"
                aria-required="true"
              />
            </div>
            <div class="ml-3 text-[10px] sm:text-[11px] leading-5">
              <label for="agreement" class="font-bold text-zinc-400 uppercase tracking-widest cursor-pointer select-none">
                我已阅读并同意 
                <span 
                  @click.prevent="showGuidelines = true" 
                  class="text-zinc-950 border-b border-zinc-950 hover:bg-zinc-950 hover:text-white transition-all ml-1 pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-2"
                  role="button"
                  tabindex="0"
                  @keydown.enter.prevent="showGuidelines = true"
                  @keydown.space.prevent="showGuidelines = true"
                >
                  平台使用规范
                </span>
              </label>
            </div>
          </div>

          <!-- 移除了原有的 margin 以匹配新的间距 -->
          <div 
            v-if="localError" 
            role="alert"
            aria-live="polite"
            class="text-[11px] font-mono font-bold text-red-500 tracking-wider uppercase animate-in fade-in"
          >
            * {{ localError }}
          </div>

          <div class="pt-4">
            <button 
              type="submit"
              :disabled="isProcessing || !isFormValid"
              :aria-disabled="isProcessing || !isFormValid"
              class="w-full py-4 bg-zinc-950 text-white text-xs font-bold tracking-[0.2em] uppercase transition-all duration-300 active:scale-[0.98] active:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3 shadow-xl shadow-zinc-950/5"
            >
              <template v-if="powProvider.isCalculating.value">
                <span class="animate-pulse flex items-center">
                  <span class="mr-2" aria-hidden="true">🔒</span> 安全加固校验中...
                </span>
              </template>
              <template v-else-if="loading">
                <span class="animate-pulse">正在同步账户数据...</span>
              </template>
              <template v-else>
                立即注册 <span class="text-zinc-500 ml-1" aria-hidden="true">→</span>
              </template>
            </button>
          </div>
        </form>

        <footer class="mt-12 flex justify-between items-center border-t border-zinc-100 pt-8">
          <div class="flex flex-col gap-1">
            <span class="text-[9px] text-zinc-300 uppercase tracking-widest font-bold">已有账号?</span>
            <router-link to="/login" class="text-[10px] font-bold tracking-widest uppercase text-zinc-400 hover:text-zinc-950 transition-colors py-1">
              现在登录
            </router-link>
          </div>
          <router-link to="/" class="text-[10px] font-bold tracking-widest uppercase text-zinc-400 hover:text-zinc-950 transition-colors py-2 px-1">
            回到主页
          </router-link>
        </footer>

      </div>
    </main>

    <PolicyModal v-model:visible="showGuidelines" type="guidelines" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { register, type RegisterDto } from '@/api/auth'
import { usePow } from '@/composables/usePow'
import { useSiteStore } from '@/store/site'
import { toast } from '@/utils/toast' 
import PolicyModal from '@/components/PolicyModal.vue'
import { validateCommentContent } from '@/utils/contentFilter'

const router = useRouter()
const siteStore = useSiteStore()
const powProvider = usePow()

const loading = ref(false)
const localError = ref('')
const isAgreed = ref(false)
const showGuidelines = ref(false)

const registerData = reactive<RegisterDto>({
  username: '',
  password: '',
  confirmPassword: '' 
})

let abortController: AbortController | null = null

const isProcessing = computed(() => loading.value || powProvider.isCalculating.value)

//[修改日期 2026-02-28 23]
// 修改理由：物理对齐后端正则契约。后端仅允许纯中文或纯英文，
// 废弃原先允许数字和符号的正则，彻底阻断在验证模型层触发 400 错误的可能。
const USERNAME_REGEX = /^[\u4e00-\u9fa5a-zA-Z]+$/

// =================================================================================
//[修改日期 2026-03-01] 
// 极致 UX 优化：O(1) 的实时表单状态反馈。
// 逻辑自洽：仅在用户开始输入后且格式错误时显示，返回静态字符串指针，避免堆内存分配。
// =================================================================================
const usernameHint = computed(() => {
  const val = registerData.username.trim()
  if (!val) return '' // 未输入时不提示
  if (val.length < 3 || val.length > 20) return '* 长度需在 3-20 个字符之间'
  if (!USERNAME_REGEX.test(val)) return '* 仅允许包含纯中文或纯英文'
  return ''
})

const passwordHint = computed(() => {
  const val = registerData.password
  if (!val) return ''
  if (val.length < 6) return '* 密码至少需要 6 个字符'
  return ''
})

const confirmPasswordHint = computed(() => {
  const val = registerData.confirmPassword
  if (!val) return ''
  if (val !== registerData.password) return '* 两次输入的密码不一致'
  return ''
})

const isFormValid = computed(() => {
  return (
    !usernameHint.value && registerData.username.trim() !== '' &&
    !passwordHint.value && registerData.password !== '' &&
    !confirmPasswordHint.value && registerData.confirmPassword !== '' &&
    isAgreed.value
  )
})

//[修改日期 2026-02-28 23]
// 修改理由：废弃 extractErrorMessage 函数。
// 底层 Axios 拦截器已实现数据脱壳与错误对象的标准化，保留该函数会产生多余的闭包和属性探测开销。

onMounted(() => {
  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => powProvider.prewarm());
  } else {
    setTimeout(() => powProvider.prewarm(), 1000);
  }
})

onUnmounted(() => {
  if (abortController) abortController.abort()
})

const handleRegister = async () => {
  if (!isFormValid.value || isProcessing.value) return
  
  localError.value = ''
  
  // 保留作为最终兜底安全网
  if (registerData.password !== registerData.confirmPassword) {
    localError.value = '两次输入的密码不一致。'
    return
  }

  const nameCheck = validateCommentContent(registerData.username);
  if (!nameCheck.isValid) {
    localError.value = `用户名违规：${nameCheck.message}`;
    return;
  }

  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const currentSignal = currentController.signal

  loading.value = true
  
  try {
    //[修改日期 2026-02-28 23]
    // 修改理由：纠正致命的契约断层。C# 11 的 `required` 关键字在底层强制拦截缺失字段，
    // 导致无响应体的 400 Bad Request。废弃“节省带宽”的反模式，直接透传完整 DTO。
    // 同时移除重复且冗余的 requiresPow 声明。
    await register({
      username: registerData.username.trim(),
      password: registerData.password,
      confirmPassword: registerData.confirmPassword
    }, { signal: currentSignal })

    if (!currentSignal.aborted) {
      toast.success('账户注册成功')
      
      if (abortController === currentController) {
        abortController = null
      }
      
      router.push('/login')
    }
  } catch (error: any) {
    // 忽略主动取消请求和 Axios 的 Cancel 错误
    if (error?.name === 'AbortError' || error?.message === 'canceled') return
    
    //[修改日期 2026-02-28 23]
    // 修改理由：全面贯彻 Login 组件中的 O(1) 错误处理理念。
    const msg = error?.message || String(error)
    
    if (msg.includes('POW_CALCULATION_TIMEOUT')) {
      localError.value = '安全组件响应超时，请刷新页面重试'
    } else if (msg.includes('Network Error') || msg.includes('timeout')) {
      localError.value = '网络连接异常，请检查您的网络设置'
    } else if (msg.includes('已存在') || msg.includes('占用')) {
      localError.value = '该用户名已被注册，请尝试其他名称'
    } else {
      localError.value = msg || '注册服务暂不可用，请稍后再试'
    }
    
    console.error('[Register Error]', error)
  } finally {
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}
</script>

<style scoped>
@reference "@/assets/main.css";

input:-webkit-autofill,
input:-webkit-autofill:hover, 
input:-webkit-autofill:focus, 
input:-webkit-autofill:active {
    -webkit-box-shadow: 0 0 0 30px white inset !important;
    -webkit-text-fill-color: #18181b !important;
    transition: background-color 5000s ease-in-out 0s;
}
</style>