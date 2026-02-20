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

        <form @submit.prevent="handleRegister" class="space-y-7">
          
          <div class="relative">
            <label class="block text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase mb-2">
              用户名
            </label>
            <input 
              v-model="registerData.username"
              type="text"
              placeholder="3-20位中英文字符"
              class="w-full bg-transparent border-b border-zinc-200 focus:border-zinc-950 py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :disabled="isProcessing"
              required
            />
          </div>

          <div class="relative">
            <label class="block text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase mb-2">
              密码
            </label>
            <input 
              v-model="registerData.password"
              type="password"
              placeholder="最少六个字符"
              class="w-full bg-transparent border-b border-zinc-200 focus:border-zinc-950 py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :disabled="isProcessing"
              required
            />
          </div>

          <div class="relative">
            <label class="block text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase mb-2">
              确认密码
            </label>
            <input 
              v-model="registerData.confirmpassword"
              type="password"
              placeholder="再次输入你的密码"
              class="w-full bg-transparent border-b border-zinc-200 focus:border-zinc-950 py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :disabled="isProcessing"
              required
            />
          </div>

          <div class="flex items-start pt-2">
            <div class="flex items-center h-5">
              <input 
                id="agreement" 
                type="checkbox" 
                v-model="isAgreed"
                :disabled="isProcessing"
                class="w-4 h-4 shrink-0 border border-zinc-300 rounded-none bg-transparent checked:bg-zinc-950 checked:border-zinc-950 focus:ring-0 cursor-pointer transition-all appearance-none relative checked:after:content-['✓'] checked:after:text-white checked:after:text-[10px] checked:after:absolute checked:after:left-0.5 checked:after:-top-px"
              />
            </div>
            <div class="ml-3 text-[10px] sm:text-[11px] leading-5">
              <label for="agreement" class="font-bold text-zinc-400 uppercase tracking-widest cursor-pointer select-none">
                我已阅读并同意 
                <span 
                  @click.prevent="showGuidelines = true" 
                  class="text-zinc-950 border-b border-zinc-950 hover:bg-zinc-950 hover:text-white transition-all ml-1 pb-0.5"
                >
                  平台使用规范
                </span>
              </label>
            </div>
          </div>

          <div 
            v-if="localError || powError" 
            class="text-[10px] font-mono font-bold text-red-500 tracking-wider uppercase animate-in fade-in"
          >
            * {{ localError || powError }}
          </div>

          <div class="pt-4">
            <button 
              type="submit"
              :disabled="isProcessing || !isFormValid"
              class="w-full py-4 bg-zinc-950 text-white text-xs font-bold tracking-[0.2em] uppercase transition-all duration-300 active:scale-[0.98] active:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3 shadow-xl shadow-zinc-950/5"
            >
              <template v-if="isPowCalculating">
                <span class="animate-pulse flex items-center">
                  <span class="mr-2">🔒</span> 安全加固校验中...
                </span>
              </template>
              <template v-else-if="loading">
                <span class="animate-pulse">正在同步账户数据...</span>
              </template>
              <template v-else>
                立即注册 <span class="text-zinc-500 ml-1">→</span>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { register, getPowChallenge, type RegisterDto } from '@/api/auth'
import { usePow } from '@/composables/usePow'
import { useSiteStore } from '@/store/site'
import { toast } from '@/utils/toast' 
import PolicyModal from '@/components/PolicyModal.vue'

const router = useRouter()
const siteStore = useSiteStore()

const { calculate, isCalculating: isPowCalculating, error: powError, prewarm } = usePow()

const loading = ref(false)
const localError = ref('')
const isAgreed = ref(false)
const showGuidelines = ref(false)

const registerData = reactive<RegisterDto>({
  username: '',
  password: '',
  confirmpassword: ''
})

const isProcessing = computed(() => loading.value || isPowCalculating.value)

// 逻辑自洽：增加中英文正则校验
const isFormValid = computed(() => {
  const { username, password, confirmpassword } = registerData
  const usernameRegex = /^[\u4e00-\u9fa5a-zA-Z]+$/
  
  return (
    username.trim().length >= 3 &&
    username.trim().length <= 20 &&
    usernameRegex.test(username.trim()) &&
    password.length >= 6 &&
    password === confirmpassword &&
    isAgreed.value
  )
})

onMounted(() => {
  prewarm()
})

const handleRegister = async () => {
  if (!isFormValid.value || isProcessing.value) return
  
  localError.value = ''
  
  if (registerData.password !== registerData.confirmpassword) {
    localError.value = '两次输入的密码不一致。'
    return
  }

  loading.value = true
  
  try {
    const browserFp = btoa(window.navigator.userAgent).substring(0, 16) + window.screen.width
    const res = await getPowChallenge() as any
    
    const challenge = {
      powSalt: res.salt || res.Salt || res.powSalt,
      powSignature: res.signature || res.Signature || res.powSignature,
      difficulty: res.difficulty || res.Difficulty,
      powTimestamp: res.timestamp || res.Timestamp || res.powTimestamp
    }

    if (!challenge.powSalt) {
       throw new Error("无法获取安全挑战 (Salt Missing)")
    }
    
    const powResult = await calculate(challenge.powSalt, browserFp, challenge.difficulty)

    await register({
      ...registerData,
      username: registerData.username.trim(), // 性能与规范：清洗首尾空格
      ...challenge,
      powNonce: powResult.nonce,
      browserFp: browserFp
    })

    toast.success('账户注册成功')
    router.push('/login')
  } catch (error: any) {
    if (error.message === 'ALREADY_CALCULATING') return
    
    if (error.message === 'POW_CALCULATION_TIMEOUT') {
      localError.value = '安全组件响应超时，请刷新页面重试'
    } else {
      const status = error.response?.status
      if (status === 401) {
        localError.value = '验证已失效，请重新点击注册'
      } else {
        localError.value = error.message || '注册服务暂不可用'
      }
    }
  } finally {
    loading.value = false
  }
}
</script>