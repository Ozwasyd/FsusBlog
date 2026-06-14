<template>
  <div class="auth-page-shell min-h-screen w-full overflow-x-hidden">
    <nav class="mx-auto flex h-16 w-full max-w-6xl items-center px-5 sm:h-20 sm:px-8">
      <router-link
        to="/"
        class="flex min-w-0 items-center gap-2 rounded-[var(--fsus-radius-control)] text-lg font-bold text-[var(--fsusblog-text-primary)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] "
      >
        <img v-if="loginBrandImageUrl" :src="loginBrandImageUrl" :alt="siteStore.siteInfo.title" class="h-9 max-w-[12rem] object-contain" />
        <span v-else class="truncate">{{ siteStore.siteInfo.title }}</span>
      </router-link>
    </nav>

    <main class="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-start px-5 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16">
      <section
        class="w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-[var(--fsus-motion-control-fast)]"
        aria-labelledby="login-title"
      >
        <header class="mb-8 sm:mb-10">
          <h1 id="login-title" class="text-3xl font-extrabold leading-tight text-[var(--fsusblog-text-primary)] sm:text-4xl">
            登录
          </h1>
          <p class="mt-3 max-w-sm text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
            登录后可继续写作、管理评论和维护站点。
          </p>
        </header>

        <form v-if="!requiresMfa" class="space-y-6" novalidate @submit.prevent="handleLogin">
          <div class="relative group">
            <label for="username" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
              用户名
            </label>
            <el-input
              id="username"
              v-model="loginData.username"
              name="username"
              type="text"
              placeholder="输入你的用户名"
              autocomplete="username"
              autofocus
              aria-required="true"
              :disabled="isProcessing"
            />
          </div>

          <div class="relative group">
            <label for="password" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
              密码
            </label>
            <el-input
              id="password"
              v-model="loginData.password"
              name="password"
              type="password"
              show-password
              placeholder="输入你的密码"
              autocomplete="current-password"
              aria-required="true"
              :aria-invalid="Boolean(errorMessage)"
              aria-describedby="login-error"
              :disabled="isProcessing"
            />
          </div>

          <div class="min-h-11">
            <el-checkbox
              id="remember-me"
              v-model="rememberMe"
              name="rememberMe"
              :disabled="isProcessing"
            >
              记住我
            </el-checkbox>
          </div>

          <div
            v-if="errorMessage"
            id="login-error"
            role="alert"
            aria-live="polite"
            class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
          >
            {{ errorMessage }}
          </div>

          <div class="grid pt-4">
            <el-button
              type="primary"
              native-type="submit"
              :disabled="isProcessing || !isFormValid"
              :loading="isProcessing"
              :aria-disabled="isProcessing || !isFormValid"
            >
              {{ submitButtonText }}
            </el-button>
          </div>

          <!-- 通行密钥登录分隔线 -->
          <div class="my-2 flex items-center gap-4" aria-hidden="true">
            <div class="h-px flex-1 bg-[var(--fsusblog-panel-bg-soft)]" />
            <span class="text-xs font-medium text-[var(--fsusblog-text-muted)]">或</span>
            <div class="h-px flex-1 bg-[var(--fsusblog-panel-bg-soft)]" />
          </div>

          <div class="grid">
            <el-button
              :disabled="passkeyLoading"
              :loading="passkeyLoading"
              @click="handlePasskeyLogin"
            >
              <template #icon>
                <el-icon>
                  <Key />
                </el-icon>
              </template>
              {{ passkeyLoading ? '请按照提示操作...' : '使用通行密钥登录' }}
            </el-button>
            <p class="mt-3 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
              需要已绑定的设备或安全密钥；如果验证失败，可继续使用密码登录。
            </p>
          </div>

          <div
            v-if="passkeyError"
            role="alert"
            aria-live="polite"
            class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
          >
            {{ passkeyError }}
            <p class="mt-2 text-xs leading-6">
              请检查浏览器是否允许通行密钥，或改用用户名密码登录。
            </p>
          </div>
        </form>

        <form v-else class="space-y-6" novalidate aria-labelledby="mfa-title" @submit.prevent="handleMfaVerify">
          <div id="mfa-title" class="rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)]/80 px-5 py-4 text-sm leading-7 text-[var(--fsusblog-text-secondary)] shadow-[var(--fsus-shadow-panel-light)] backdrop-blur-[var(--fsus-backdrop-blur)]">
            需要进行多因素验证。请输入 Google Authenticator 验证码，或使用恢复码。
          </div>

          <el-radio-group v-model="mfaMode" class="w-full" aria-label="选择验证方式">
            <el-radio-button value="totp">验证码</el-radio-button>
            <el-radio-button value="recovery">恢复码</el-radio-button>
          </el-radio-group>

          <div v-if="mfaMode === 'totp'" class="relative group">
            <label for="mfa-code" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
              MFA 验证码
            </label>
            <el-input
              id="mfa-code"
              v-model="mfaCode"
              name="mfaCode"
              type="text"
              inputmode="numeric"
              placeholder="6位验证码"
              autocomplete="one-time-code"
              :aria-invalid="Boolean(errorMessage)"
              aria-describedby="mfa-error"
              :disabled="isProcessing"
            />
          </div>

          <div v-else class="relative group">
            <label for="mfa-recovery" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
              恢复码
            </label>
            <el-input
              id="mfa-recovery"
              v-model="mfaRecoveryCode"
              name="mfaRecoveryCode"
              type="text"
              placeholder="恢复码"
              autocomplete="one-time-code"
              :aria-invalid="Boolean(errorMessage)"
              aria-describedby="mfa-error"
              :disabled="isProcessing"
            />
          </div>

          <div
            v-if="errorMessage"
            id="mfa-error"
            role="alert"
            aria-live="polite"
            class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-semibold text-[var(--fsusblog-color-error)]"
          >
            {{ errorMessage }}
          </div>

          <div class="grid pt-4">
            <el-button
              type="primary"
              native-type="submit"
              :disabled="isProcessing"
            >
              完成验证
            </el-button>
          </div>
        </form>

        <footer class="mt-10 flex items-center justify-between border-t border-[var(--fsusblog-panel-border)] pt-6">
          <router-link to="/register" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] ">
            注册
          </router-link>
          <router-link to="/" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] ">
            取消
          </router-link>
        </footer>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Key } from '@/fsusui/icons'
import { useAuthLogin } from '@/composables/useAuthLogin'
import { usePasskeyLogin } from '@/composables/usePasskeyLogin'

const {
  siteStore,
  errorMessage,
  loginData,
  rememberMe,
  isProcessing,
  isFormValid,
  submitButtonText,
  handleLogin,
  handleMfaVerify,
  requiresMfa,
  mfaMode,
  mfaCode,
  mfaRecoveryCode
} = useAuthLogin()

const { loading: passkeyLoading, error: passkeyError, loginWithPasskey } = usePasskeyLogin()

const loginBrandImageUrl = computed(() =>
  siteStore.siteInfo.loginLogoUrl?.trim()
  || siteStore.siteInfo.loginIconUrl?.trim()
  || siteStore.siteInfo.siteWordmarkUrl?.trim()
  || siteStore.siteInfo.siteLogoUrl?.trim()
  || ''
)

const handlePasskeyLogin = () => loginWithPasskey(rememberMe.value)
</script>

<style scoped>
@reference "@/assets/main.css";

.auth-page-shell {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
}
</style>
