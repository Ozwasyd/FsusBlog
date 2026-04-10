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
              <span :class="submitButtonPulseClass">
                <span v-if="showSubmitLockIcon" class="mr-2" aria-hidden="true">🔒</span>
                {{ submitButtonText }}
                <span v-if="showSubmitArrow" class="text-zinc-500">→</span>
              </span>
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
import { useAuthLogin } from '@/composables/useAuthLogin'

const {
  siteStore,
  errorMessage,
  loginData,
  isProcessing,
  isFormValid,
  submitButtonText,
  submitButtonPulseClass,
  showSubmitLockIcon,
  showSubmitArrow,
  handleLogin
} = useAuthLogin()
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
