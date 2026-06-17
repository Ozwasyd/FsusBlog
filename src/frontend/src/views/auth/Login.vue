<template>
  <div class="auth-page-content w-full max-w-md">
      <section
        class="w-full max-w-md"
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

        <form v-if="anonymousIdentityMode && !requiresMfa" class="space-y-6" novalidate @submit.prevent>
          <div class="grid gap-3">
            <el-checkbox
              id="anonymous-remember-me"
              v-model="rememberMe"
              name="rememberMe"
              :disabled="passkeyLoading"
            >
              记住本设备
            </el-checkbox>
            <el-button
              type="primary"
              :disabled="passkeyLoading"
              :loading="passkeyLoading"
              @click="handlePasskeyLogin"
            >
              <template #icon>
                <el-icon>
                  <Key />
                </el-icon>
              </template>
              {{ passkeyLoading ? '请按照设备提示操作...' : '使用通行密钥登录' }}
            </el-button>
            <p class="text-xs leading-6 text-[var(--fsusblog-text-muted)]">
              匿名身份不绑定邮箱或手机号；请使用已绑定的设备、安全密钥，或用 Recovery Key 恢复访问。
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
              如果验证失败，请检查浏览器是否允许通行密钥，或使用 Recovery Key 恢复访问。
            </p>
          </div>

          <router-link
            to="/recover"
            class="inline-flex rounded-[var(--fsus-radius-control)] py-1 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
            :class="focusRingClass"
          >
            使用 Recovery Key 恢复访问
          </router-link>
        </form>

        <form v-else-if="!anonymousIdentityMode && !requiresMfa" class="space-y-6" novalidate @submit.prevent="handleLogin">
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
              需要已绑定的设备或安全密钥；如果验证失败，请检查浏览器是否允许通行密钥。
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
              请检查浏览器是否允许通行密钥。
            </p>
          </div>
        </form>

        <form v-else class="space-y-6" novalidate aria-labelledby="mfa-title" @submit.prevent="handleMfaVerify">
          <div class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-5 py-4">
            <p id="mfa-title" class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">需要二次验证</p>
            <p class="mt-1 text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
              请输入验证码或恢复码。
            </p>
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
          <router-link to="/register" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
            注册
          </router-link>
          <router-link to="/" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
            取消
          </router-link>
        </footer>
      </section>

  </div>
</template>

<script setup lang="ts">
import { Key } from '@/fsusui/icons'
import { useAuthLogin } from '@/composables/useAuthLogin'
import { usePasskeyLogin } from '@/composables/usePasskeyLogin'
import { themeTokens } from '@/ui-tokens/themeTokens'

const focusRingClass = themeTokens.focusRing

const {
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
const anonymousIdentityMode = true

const handlePasskeyLogin = () => loginWithPasskey(rememberMe.value)
</script>
