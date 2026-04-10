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
              :class="usernameLabelClass"
            >
              用户名
            </label>
            <input 
              id="username"
              v-model="registerData.username"
              type="text"
              placeholder="3-20位中英文字符"
              class="w-full bg-transparent border-b py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :class="usernameInputClass"
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
              :class="passwordLabelClass"
            >
              密码
            </label>
            <input 
              id="password"
              v-model="registerData.password"
              type="password"
              placeholder="最少六个字符"
              class="w-full bg-transparent border-b py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :class="passwordInputClass"
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
              :class="confirmPasswordLabelClass"
            >
              确认密码
            </label>
            <input 
              id="confirm-password"
              v-model="registerData.confirmPassword"
              type="password"
              placeholder="再次输入你的密码"
              class="w-full bg-transparent border-b py-3 text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none transition-colors rounded-none appearance-none"
              :class="confirmPasswordInputClass"
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
                  @click.prevent="handleGuidelinesActivator"
                  class="text-zinc-950 border-b border-zinc-950 hover:bg-zinc-950 hover:text-white transition-all ml-1 pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-2"
                  role="button"
                  tabindex="0"
                  @keydown.prevent="handleGuidelinesActivator"
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
              <span :class="submitButtonPulseClass">
                <span v-if="showSubmitLockIcon" class="mr-2" aria-hidden="true">🔒</span>
                {{ submitButtonText }}
                <span v-if="showSubmitArrow" class="text-zinc-500 ml-1" aria-hidden="true">→</span>
              </span>
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
import { useAuthRegister } from '@/composables/useAuthRegister'
import PolicyModal from '@/components/PolicyModal.vue'

const {
  siteStore,
  localError,
  isAgreed,
  showGuidelines,
  registerData,
  isProcessing,
  usernameHint,
  usernameLabelClass,
  usernameInputClass,
  passwordHint,
  passwordLabelClass,
  passwordInputClass,
  confirmPasswordHint,
  confirmPasswordLabelClass,
  confirmPasswordInputClass,
  isFormValid,
  submitButtonText,
  submitButtonPulseClass,
  showSubmitLockIcon,
  showSubmitArrow,
  handleGuidelinesActivator,
  handleRegister
} = useAuthRegister()
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
