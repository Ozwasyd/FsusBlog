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
        aria-labelledby="register-title"
      >
        <header class="mb-8 sm:mb-10">
          <h1 id="register-title" class="text-3xl font-extrabold leading-tight text-[#0F0F11] sm:text-4xl dark:text-[#FCFCFC]">
            注册账户
          </h1>
          <p class="mt-3 max-w-sm text-sm leading-7 text-[#52525B] dark:text-[#A1A1AA]">
            创建账户后即可参与评论与站内互动。
          </p>
        </header>

        <form class="space-y-6" novalidate @submit.prevent="handleRegister">
          <div class="relative group">
            <label
              for="username"
              class="mb-2 block text-xs font-semibold transition-colors"
              :class="usernameLabelClass"
            >
              用户名
            </label>
            <input
              id="username"
              v-model="registerData.username"
              name="username"
              type="text"
              placeholder="3-20位中英文字符"
              class="w-full rounded-[8px] border bg-[#FCFCFC] px-4 py-3 text-sm font-medium text-[#18181B] outline-none transition-colors placeholder:text-[#A1A1AA] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#18181B] dark:text-[#FCFCFC] dark:placeholder:text-[#71717A]"
              :class="usernameInputClass"
              :disabled="isProcessing"
              required
              aria-required="true"
              :aria-invalid="Boolean(usernameHint)"
              aria-describedby="username-hint"
              autocomplete="username"
              autofocus
            />
            <p
              v-if="usernameHint"
              id="username-hint"
              aria-live="polite"
              class="mt-2 text-xs font-semibold text-[#E5484D] animate-in fade-in slide-in-from-top-1"
            >
              {{ usernameHint }}
            </p>
          </div>

          <div class="relative group">
            <label
              for="password"
              class="mb-2 block text-xs font-semibold transition-colors"
              :class="passwordLabelClass"
            >
              密码
            </label>
            <input
              id="password"
              v-model="registerData.password"
              name="password"
              type="password"
              placeholder="最少六个字符"
              class="w-full rounded-[8px] border bg-[#FCFCFC] px-4 py-3 text-sm font-medium text-[#18181B] outline-none transition-colors placeholder:text-[#A1A1AA] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#18181B] dark:text-[#FCFCFC] dark:placeholder:text-[#71717A]"
              :class="passwordInputClass"
              :disabled="isProcessing"
              required
              aria-required="true"
              :aria-invalid="Boolean(passwordHint)"
              aria-describedby="password-hint"
              autocomplete="new-password"
            />
            <p
              v-if="passwordHint"
              id="password-hint"
              aria-live="polite"
              class="mt-2 text-xs font-semibold text-[#E5484D] animate-in fade-in slide-in-from-top-1"
            >
              {{ passwordHint }}
            </p>
          </div>

          <div class="relative group">
            <label
              for="confirm-password"
              class="mb-2 block text-xs font-semibold transition-colors"
              :class="confirmPasswordLabelClass"
            >
              确认密码
            </label>
            <input
              id="confirm-password"
              v-model="registerData.confirmPassword"
              name="confirmPassword"
              type="password"
              placeholder="再次输入你的密码"
              class="w-full rounded-[8px] border bg-[#FCFCFC] px-4 py-3 text-sm font-medium text-[#18181B] outline-none transition-colors placeholder:text-[#A1A1AA] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#18181B] dark:text-[#FCFCFC] dark:placeholder:text-[#71717A]"
              :class="confirmPasswordInputClass"
              :disabled="isProcessing"
              required
              aria-required="true"
              :aria-invalid="Boolean(confirmPasswordHint)"
              aria-describedby="confirm-password-hint"
              autocomplete="new-password"
            />
            <p
              v-if="confirmPasswordHint"
              id="confirm-password-hint"
              aria-live="polite"
              class="mt-2 text-xs font-semibold text-[#E5484D] animate-in fade-in slide-in-from-top-1"
            >
              {{ confirmPasswordHint }}
            </p>
          </div>

          <label for="agreement" class="flex cursor-pointer select-none items-start gap-3 pt-1 text-sm leading-6 text-[#52525B] dark:text-[#A1A1AA]">
            <input
              id="agreement"
              v-model="isAgreed"
              name="agreement"
              type="checkbox"
              :disabled="isProcessing"
              class="mt-1 h-4 w-4 shrink-0 rounded-[6px] border-[#D4D4D8] text-[#0F0F11] focus:ring-2 focus:ring-[#2A599C] focus:ring-offset-2 focus:ring-offset-[#F7F7F8] dark:border-[#3F3F46] dark:bg-[#18181B] dark:focus:ring-[#7EA7E0] dark:focus:ring-offset-[#0F0F11]"
              aria-required="true"
            />
            <span>
              我已阅读并同意
              <button
                type="button"
                class="ml-1 rounded-[6px] border-b border-[#2A599C] pb-0.5 font-semibold text-[#2A599C] outline-none transition-colors hover:text-[#0F0F11] focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:text-[#7EA7E0] dark:hover:text-[#FCFCFC] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
                @click="handleGuidelinesActivator"
              >
                平台使用规范
              </button>
            </span>
          </label>

          <div
            v-if="localError"
            id="register-error"
            role="alert"
            aria-live="polite"
            class="rounded-[8px] border border-[#FAD1D1] bg-[#FFF7F7] px-4 py-3 text-sm font-semibold text-[#E5484D] animate-in fade-in dark:border-[#7F1D1D] dark:bg-[#2A1212]"
          >
            {{ localError }}
          </div>

          <div class="pt-4">
            <button
              type="submit"
              :disabled="isProcessing || !isFormValid"
              :aria-disabled="isProcessing || !isFormValid"
              aria-describedby="register-error"
              class="flex w-full items-center justify-center rounded-[8px] bg-[#0F0F11] px-5 py-4 text-sm font-bold text-white shadow-[0_32px_64px_rgba(0,0,0,0.08)] transition-all duration-300 hover:bg-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FCFCFC] dark:text-[#0F0F11] dark:hover:bg-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
            >
              <span :class="submitButtonPulseClass">
                {{ submitButtonText }}
              </span>
            </button>
          </div>
        </form>

        <footer class="mt-10 flex items-center justify-between border-t border-[#E4E4E7] pt-6 dark:border-[#27272A]">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-[#A1A1AA] dark:text-[#71717A]">已有账号？</span>
            <router-link to="/login" class="rounded-[8px] py-1 text-sm font-semibold text-[#8E8E93] transition-colors hover:text-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:text-[#A1A1AA] dark:hover:text-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]">
              现在登录
            </router-link>
          </div>
          <router-link to="/" class="rounded-[8px] px-1 py-2 text-sm font-semibold text-[#8E8E93] transition-colors hover:text-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:text-[#A1A1AA] dark:hover:text-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]">
            回到主页
          </router-link>
        </footer>
      </section>
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
  -webkit-box-shadow: 0 0 0 30px #fcfcfc inset !important;
  -webkit-text-fill-color: #18181b !important;
  transition: background-color 5000s ease-in-out 0s;
}
</style>
