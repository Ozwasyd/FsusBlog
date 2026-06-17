<template>
  <div class="auth-page-shell min-h-screen w-full overflow-x-hidden">
    <nav class="mx-auto flex h-16 w-full max-w-6xl items-center px-5 sm:h-20 sm:px-8">
      <router-link
        to="/"
        class="flex min-w-0 items-center gap-2 rounded-[var(--fsus-radius-control)] text-lg font-bold text-[var(--fsusblog-text-primary)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
        :class="focusRingClass"
      >
        <img v-if="loginBrandImageUrl" :src="loginBrandImageUrl" :alt="siteStore.siteInfo.title" class="h-9 max-w-[12rem] object-contain" />
        <span v-else class="truncate">{{ siteStore.siteInfo.title }}</span>
      </router-link>
    </nav>

    <main class="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-start px-5 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16">
      <section
        class="w-full max-w-md"
        aria-labelledby="register-title"
      >
        <header class="mb-8 sm:mb-10">
          <h1 id="register-title" class="text-3xl font-extrabold leading-tight text-[var(--fsusblog-text-primary)] sm:text-4xl">
            注册账户
          </h1>
          <p class="mt-3 max-w-sm text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
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
            <el-input
              id="username"
              v-model="registerData.username"
              name="username"
              type="text"
              placeholder="3-20位中文或英文字母"
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
              class="mt-2 text-xs font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
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
            <el-input
              id="password"
              v-model="registerData.password"
              name="password"
              type="password"
              show-password
              placeholder="8-128 个字符"
              maxlength="128"
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
              class="mt-2 text-xs font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
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
            <el-input
              id="confirm-password"
              v-model="registerData.confirmPassword"
              name="confirmPassword"
              type="password"
              show-password
              placeholder="再次输入你的密码"
              maxlength="128"
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
              class="mt-2 text-xs font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
            >
              {{ confirmPasswordHint }}
            </p>
          </div>

          <div class="pt-1">
            <el-checkbox
              id="agreement"
              v-model="isAgreed"
              name="agreement"
              :disabled="isProcessing"
              aria-required="true"
            >
              我已阅读并同意
              <el-button
                text
                inline-action
                class="register-guidelines-button"
                type="primary"
                size="large"
                @click.stop.prevent="handleGuidelinesActivator"
              >
                站点使用规范
              </el-button>
            </el-checkbox>
          </div>

          <div
            v-if="localError"
            id="register-error"
            role="alert"
            aria-live="polite"
            class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in"
          >
            {{ localError }}
          </div>

          <div class="grid pt-4">
            <el-button
              type="primary"
              native-type="submit"
              :disabled="isProcessing || !isFormValid"
              :loading="isProcessing"
              :aria-disabled="isProcessing || !isFormValid"
              aria-describedby="register-error"
            >
              {{ submitButtonText }}
            </el-button>
          </div>
        </form>

        <footer class="mt-10 flex items-center justify-between border-t border-[var(--fsusblog-panel-border)] pt-6">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-[var(--fsusblog-text-muted)]">已有账号？</span>
            <router-link to="/login" class="rounded-[var(--fsus-radius-control)] py-1 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
              现在登录
            </router-link>
          </div>
          <router-link to="/" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
            回到主页
          </router-link>
        </footer>
      </section>
    </main>

    <PolicyModal v-model:visible="showGuidelines" type="guidelines" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAuthRegister } from '@/composables/useAuthRegister'
import PolicyModal from '@/components/PolicyModal.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'

const focusRingClass = themeTokens.focusRing

const {
  siteStore,
  localError,
  isAgreed,
  showGuidelines,
  registerData,
  isProcessing,
  usernameHint,
  usernameLabelClass,
  passwordHint,
  passwordLabelClass,
  confirmPasswordHint,
  confirmPasswordLabelClass,
  isFormValid,
  submitButtonText,
  handleGuidelinesActivator,
  handleRegister
} = useAuthRegister()

const loginBrandImageUrl = computed(() =>
  siteStore.siteInfo.loginLogoUrl?.trim()
  || siteStore.siteInfo.loginIconUrl?.trim()
  || siteStore.siteInfo.siteWordmarkUrl?.trim()
  || siteStore.siteInfo.siteLogoUrl?.trim()
  || ''
)
</script>

<style scoped>
@reference "@/assets/main.css";

.auth-page-shell {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
}

:deep(.register-guidelines-button.el-button) {
  min-height: 36px;
  align-items: center;
}
</style>
