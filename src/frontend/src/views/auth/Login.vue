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

          <section
            aria-labelledby="recovery-key-title"
            class="space-y-4 rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-5"
          >
            <div>
              <h2 id="recovery-key-title" class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">
                使用 Recovery Key 恢复
              </h2>
              <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                Recovery Key 是账号恢复凭据，不是 TOTP 恢复码。验证后可绑定新的通行密钥。
              </p>
            </div>

            <div class="relative group">
              <label for="recovery-user-id" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
                账户编号
              </label>
              <el-input
                id="recovery-user-id"
                v-model="recoveryUserId"
                name="recoveryUserId"
                inputmode="numeric"
                placeholder="输入账户编号"
                autocomplete="off"
                aria-describedby="recovery-key-help"
                :disabled="recoveryKeyLoading"
              />
            </div>

            <div class="relative group">
              <label for="recovery-key" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
                Recovery Key
              </label>
              <el-input
                id="recovery-key"
                v-model="recoveryKeyInput"
                name="recoveryKey"
                type="textarea"
                :rows="3"
                placeholder="粘贴以 frk_ 开头的 Recovery Key"
                autocomplete="off"
                aria-required="true"
                :aria-invalid="Boolean(recoveryKeyError)"
                aria-describedby="recovery-key-help recovery-key-error"
                :disabled="recoveryKeyLoading"
              />
              <p id="recovery-key-help" class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                若 Recovery Key 丢失且没有可用通行密钥，账号可能无法恢复。
              </p>
            </div>

            <el-checkbox
              id="revoke-recovery-passkeys"
              v-model="recoveryRevokePasskeys"
              :disabled="recoveryKeyLoading"
            >
              恢复后撤销旧通行密钥
            </el-checkbox>

            <div
              v-if="recoveryKeyError"
              id="recovery-key-error"
              role="alert"
              aria-live="polite"
              class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-semibold text-[var(--fsusblog-color-error)]"
            >
              {{ recoveryKeyError }}
            </div>

            <div
              v-if="recoverySessionToken"
              role="status"
              aria-live="polite"
              class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg-soft)] px-4 py-3 text-xs leading-6 text-[var(--fsusblog-text-secondary)]"
            >
              Recovery Key 已验证，恢复会话有效至 {{ recoverySessionExpiresAt }}。请继续绑定新的通行密钥。
            </div>

            <div class="grid gap-3 pt-1">
              <el-button
                type="primary"
                :disabled="!canVerifyRecoveryKey"
                :loading="recoveryKeyLoading"
                @click="handleRecoveryKeyVerify"
              >
                验证 Recovery Key
              </el-button>
              <el-button
                v-if="recoverySessionToken"
                :disabled="recoveryKeyLoading"
                @click="recoveryPasskeyVisible = true"
              >
                绑定新的通行密钥
              </el-button>
            </div>
          </section>
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
    </main>

    <PasskeyRegisterModal
      v-model:visible="recoveryPasskeyVisible"
      :recovery-session-token="recoverySessionToken"
      @success="handleRecoveryPasskeyRegistered"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Key } from '@/fsusui/icons'
import { verifyRecoveryKey } from '@/api/auth'
import { useAuthLogin } from '@/composables/useAuthLogin'
import { usePasskeyLogin } from '@/composables/usePasskeyLogin'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { toAppError } from '@/utils/appError'

const focusRingClass = themeTokens.focusRing

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
const anonymousIdentityMode = true
const recoveryUserId = ref('')
const recoveryKeyInput = ref('')
const recoveryRevokePasskeys = ref(true)
const recoveryKeyLoading = ref(false)
const recoveryKeyError = ref('')
const recoverySessionToken = ref('')
const recoverySessionExpiresAt = ref('')
const recoveryPasskeyVisible = ref(false)

const loginBrandImageUrl = computed(() =>
  siteStore.siteInfo.loginLogoUrl?.trim()
  || siteStore.siteInfo.loginIconUrl?.trim()
  || siteStore.siteInfo.siteWordmarkUrl?.trim()
  || siteStore.siteInfo.siteLogoUrl?.trim()
  || ''
)

const handlePasskeyLogin = () => loginWithPasskey(rememberMe.value)
const canVerifyRecoveryKey = computed(() =>
  Number.parseInt(recoveryUserId.value, 10) > 0 &&
  recoveryKeyInput.value.trim().length > 0 &&
  !recoveryKeyLoading.value
)

const handleRecoveryKeyVerify = async (): Promise<void> => {
  if (!canVerifyRecoveryKey.value) {
    return
  }

  recoveryKeyLoading.value = true
  recoveryKeyError.value = ''
  recoverySessionToken.value = ''
  recoverySessionExpiresAt.value = ''

  try {
    const response = await verifyRecoveryKey({
      userId: Number.parseInt(recoveryUserId.value, 10),
      recoveryKey: recoveryKeyInput.value.trim(),
      revokeSessions: true,
      revokePasskeys: recoveryRevokePasskeys.value
    })
    recoveryKeyInput.value = ''
    recoverySessionToken.value = response.recoverySessionToken
    recoverySessionExpiresAt.value = new Date(response.expiresAt).toLocaleString()
  } catch (error) {
    recoveryKeyError.value = toAppError(error, 'Recovery Key 验证失败，请检查后重试').message
      || 'Recovery Key 验证失败，请检查后重试'
  } finally {
    recoveryKeyLoading.value = false
  }
}

const handleRecoveryPasskeyRegistered = (): void => {
  recoveryPasskeyVisible.value = false
  recoverySessionToken.value = ''
  recoverySessionExpiresAt.value = ''
}
</script>

<style scoped>
@reference "@/assets/main.css";

.auth-page-shell {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
}
</style>
