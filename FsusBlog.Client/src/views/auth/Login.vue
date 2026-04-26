<template>
  <div class="min-h-screen w-full overflow-x-hidden bg-[#F7F7F8] text-[#0F0F11] subpixel-antialiased dark:bg-[#0F0F11] dark:text-[#FCFCFC]">
    <nav class="mx-auto flex h-16 w-full max-w-6xl items-center px-5 sm:h-20 sm:px-8">
      <router-link
        to="/"
        class="rounded-[8px] text-lg font-bold text-[#0F0F11] transition-colors hover:text-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:text-[#FCFCFC] dark:hover:text-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
      >
        {{ siteStore.siteInfo.title }}
      </router-link>
    </nav>

    <main class="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-start px-5 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16">
      <section
        class="w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-700"
        aria-labelledby="login-title"
      >
        <header class="mb-8 sm:mb-10">
          <h1 id="login-title" class="text-3xl font-extrabold leading-tight text-[#0F0F11] sm:text-4xl dark:text-[#FCFCFC]">
            登录
          </h1>
          <p class="mt-3 max-w-sm text-sm leading-7 text-[#52525B] dark:text-[#A1A1AA]">
            欢迎回来，请验证你的身份信息以继续。
          </p>
        </header>

        <form v-if="!requiresMfa" class="space-y-6" novalidate @submit.prevent="handleLogin">
          <div class="relative group">
            <label for="username" class="mb-2 block text-xs font-semibold text-[#52525B] dark:text-[#A1A1AA]">
              用户名
            </label>
            <input
              id="username"
              v-model="loginData.username"
              name="username"
              type="text"
              placeholder="输入你的用户名"
              autocomplete="username"
              autofocus
              aria-required="true"
              class="w-full rounded-[8px] border border-[#E4E4E7] bg-[#FCFCFC] px-4 py-3 text-sm font-medium text-[#18181B] outline-none transition-colors placeholder:text-[#A1A1AA] focus:border-[#2A599C] focus:ring-1 focus:ring-[#2A599C] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#27272A] dark:bg-[#18181B] dark:text-[#FCFCFC] dark:placeholder:text-[#71717A] dark:focus:border-[#7EA7E0] dark:focus:ring-[#7EA7E0]"
              :disabled="isProcessing"
            />
          </div>

          <div class="relative group">
            <label for="password" class="mb-2 block text-xs font-semibold text-[#52525B] dark:text-[#A1A1AA]">
              密码
            </label>
            <input
              id="password"
              v-model="loginData.password"
              name="password"
              type="password"
              placeholder="输入你的密码"
              autocomplete="current-password"
              aria-required="true"
              :aria-invalid="Boolean(errorMessage)"
              aria-describedby="login-error"
              class="w-full rounded-[8px] border border-[#E4E4E7] bg-[#FCFCFC] px-4 py-3 text-sm font-medium text-[#18181B] outline-none transition-colors placeholder:text-[#A1A1AA] focus:border-[#2A599C] focus:ring-1 focus:ring-[#2A599C] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#27272A] dark:bg-[#18181B] dark:text-[#FCFCFC] dark:placeholder:text-[#71717A] dark:focus:border-[#7EA7E0] dark:focus:ring-[#7EA7E0]"
              :disabled="isProcessing"
            />
          </div>

          <label for="remember-me" class="flex min-h-11 cursor-pointer select-none items-center gap-3 text-sm font-medium text-[#52525B] dark:text-[#A1A1AA]">
            <input
              id="remember-me"
              v-model="rememberMe"
              name="rememberMe"
              type="checkbox"
              class="h-4 w-4 rounded-[6px] border-[#D4D4D8] text-[#0F0F11] focus:ring-2 focus:ring-[#2A599C] focus:ring-offset-2 focus:ring-offset-[#F7F7F8] dark:border-[#3F3F46] dark:bg-[#18181B] dark:focus:ring-[#7EA7E0] dark:focus:ring-offset-[#0F0F11]"
              :disabled="isProcessing"
            />
            <span>记住我</span>
          </label>

          <div
            v-if="errorMessage"
            id="login-error"
            role="alert"
            aria-live="polite"
            class="rounded-[8px] border border-[#FAD1D1] bg-[#FFF7F7] px-4 py-3 text-sm font-semibold text-[#E5484D] animate-in fade-in slide-in-from-top-1 dark:border-[#7F1D1D] dark:bg-[#2A1212]"
          >
            {{ errorMessage }}
          </div>

          <div class="pt-4">
            <button
              type="submit"
              :disabled="isProcessing || !isFormValid"
              :aria-disabled="isProcessing || !isFormValid"
              class="flex w-full items-center justify-center rounded-[8px] bg-[#0F0F11] px-5 py-4 text-sm font-bold text-white shadow-[0_32px_64px_rgba(0,0,0,0.08)] transition-all duration-300 hover:bg-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FCFCFC] dark:text-[#0F0F11] dark:hover:bg-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
            >
              <span :class="submitButtonPulseClass">
                {{ submitButtonText }}
              </span>
            </button>
          </div>
        </form>

        <form v-else class="space-y-6" novalidate aria-labelledby="mfa-title" @submit.prevent="handleMfaVerify">
          <div id="mfa-title" class="rounded-[24px] border border-[#E4E4E7] bg-[#FCFCFC]/80 px-5 py-4 text-sm leading-7 text-[#52525B] shadow-[0_32px_64px_rgba(0,0,0,0.04)] backdrop-blur-xl dark:border-[#27272A] dark:bg-[#18181B]/80 dark:text-[#A1A1AA]">
            需要进行多因素验证。请输入 Google Authenticator 验证码，或使用恢复码。
          </div>

          <div class="relative group">
            <label for="mfa-code" class="mb-2 block text-xs font-semibold text-[#52525B] dark:text-[#A1A1AA]">
              MFA 验证码
            </label>
            <input
              id="mfa-code"
              v-model="mfaCode"
              name="mfaCode"
              type="text"
              inputmode="numeric"
              placeholder="6位验证码"
              autocomplete="one-time-code"
              :aria-invalid="Boolean(errorMessage)"
              aria-describedby="mfa-error"
              class="w-full rounded-[8px] border border-[#E4E4E7] bg-[#FCFCFC] px-4 py-3 text-sm font-medium text-[#18181B] outline-none transition-colors placeholder:text-[#A1A1AA] focus:border-[#2A599C] focus:ring-1 focus:ring-[#2A599C] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#27272A] dark:bg-[#18181B] dark:text-[#FCFCFC] dark:placeholder:text-[#71717A] dark:focus:border-[#7EA7E0] dark:focus:ring-[#7EA7E0]"
              :disabled="isProcessing"
            />
          </div>

          <div class="relative group">
            <label for="mfa-recovery" class="mb-2 block text-xs font-semibold text-[#52525B] dark:text-[#A1A1AA]">
              恢复码（可选）
            </label>
            <input
              id="mfa-recovery"
              v-model="mfaRecoveryCode"
              name="mfaRecoveryCode"
              type="text"
              placeholder="恢复码"
              autocomplete="one-time-code"
              :aria-invalid="Boolean(errorMessage)"
              aria-describedby="mfa-error"
              class="w-full rounded-[8px] border border-[#E4E4E7] bg-[#FCFCFC] px-4 py-3 text-sm font-medium text-[#18181B] outline-none transition-colors placeholder:text-[#A1A1AA] focus:border-[#2A599C] focus:ring-1 focus:ring-[#2A599C] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#27272A] dark:bg-[#18181B] dark:text-[#FCFCFC] dark:placeholder:text-[#71717A] dark:focus:border-[#7EA7E0] dark:focus:ring-[#7EA7E0]"
              :disabled="isProcessing"
            />
          </div>

          <div
            v-if="errorMessage"
            id="mfa-error"
            role="alert"
            aria-live="polite"
            class="rounded-[8px] border border-[#FAD1D1] bg-[#FFF7F7] px-4 py-3 text-sm font-semibold text-[#E5484D] dark:border-[#7F1D1D] dark:bg-[#2A1212]"
          >
            {{ errorMessage }}
          </div>

          <div class="pt-4">
            <button
              type="submit"
              :disabled="isProcessing"
              class="flex w-full items-center justify-center rounded-[8px] bg-[#0F0F11] px-5 py-4 text-sm font-bold text-white shadow-[0_32px_64px_rgba(0,0,0,0.08)] transition-all duration-300 hover:bg-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FCFCFC] dark:text-[#0F0F11] dark:hover:bg-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
            >
              完成验证
            </button>
          </div>
        </form>

        <footer class="mt-10 flex items-center justify-between border-t border-[#E4E4E7] pt-6 dark:border-[#27272A]">
          <router-link to="/register" class="rounded-[8px] px-1 py-2 text-sm font-semibold text-[#8E8E93] transition-colors hover:text-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:text-[#A1A1AA] dark:hover:text-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]">
            注册
          </router-link>
          <router-link to="/" class="rounded-[8px] px-1 py-2 text-sm font-semibold text-[#8E8E93] transition-colors hover:text-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:text-[#A1A1AA] dark:hover:text-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]">
            取消
          </router-link>
        </footer>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { useAuthLogin } from '@/composables/useAuthLogin'

const {
  siteStore,
  errorMessage,
  loginData,
  rememberMe,
  isProcessing,
  isFormValid,
  submitButtonText,
  submitButtonPulseClass,
  handleLogin,
  handleMfaVerify,
  requiresMfa,
  mfaCode,
  mfaRecoveryCode
} = useAuthLogin()
</script>

<style scoped>
@reference "@/assets/main.css";

input {
  max-width: 100%;
}

input:-webkit-autofill,
input:-webkit-autofill:hover, 
input:-webkit-autofill:focus, 
input:-webkit-autofill:active{
  -webkit-box-shadow: 0 0 0 30px #fcfcfc inset !important;
  -webkit-text-fill-color: #18181b !important;
  transition: background-color 5000s ease-in-out 0s;
}
</style>
