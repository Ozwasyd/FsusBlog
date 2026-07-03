<template>
  <div class="auth-page-content w-full max-w-md">
      <section
        class="w-full max-w-md"
        aria-labelledby="login-title"
      >
        <header class="mb-8 sm:mb-10">
          <h1 id="login-title" class="text-3xl font-extrabold leading-tight text-[var(--fsusblog-text-primary)] sm:text-4xl">
            {{ copy.title }}
          </h1>
          <p class="mt-3 max-w-sm text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
            {{ copy.description }}
          </p>
        </header>

        <form v-if="!requiresMfa" class="space-y-6" novalidate @submit.prevent>
          <div class="grid gap-3">
            <el-checkbox
              id="anonymous-remember-me"
              v-model="rememberMe"
              name="rememberMe"
              :disabled="passkeyLoading"
            >
              {{ copy.rememberMe }}
            </el-checkbox>
            <el-button
              type="primary"
              :disabled="passkeyLoading"
              :loading="passkeyLoading"
              @click="handlePasskeyLogin"
            >
              <template #icon>
                <el-icon aria-hidden="true">
                  <Key />
                </el-icon>
              </template>
              {{ passkeyLoading ? copy.passkeyLoading : copy.passkeyButton }}
            </el-button>
            <p class="text-xs leading-6 text-[var(--fsusblog-text-muted)]">
              {{ copy.passkeyHint }}
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
              {{ copy.passkeyFailureHint }}
            </p>
          </div>

          <router-link
            to="/recover"
            class="inline-flex min-h-9 items-center rounded-[var(--fsus-radius-control)] px-1 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
            :class="focusRingClass"
          >
            {{ copy.recoverLink }}
          </router-link>
        </form>

        <form v-else class="space-y-6" novalidate aria-labelledby="mfa-title" @submit.prevent="handleMfaVerify">
          <div class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-5 py-4">
            <p id="mfa-title" class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">{{ copy.mfaRequiredTitle }}</p>
            <p class="mt-1 text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
              {{ copy.mfaRequiredHint }}
            </p>
          </div>

          <el-radio-group v-model="mfaMode" class="w-full" :aria-label="copy.mfaAriaLabel">
            <el-radio-button value="totp">{{ copy.mfaModeTOTP }}</el-radio-button>
            <el-radio-button value="recovery">{{ copy.mfaModeRecovery }}</el-radio-button>
          </el-radio-group>

          <div v-if="mfaMode === 'totp'" class="relative group">
            <label for="mfa-code" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
              {{ copy.mfaCodeLabel }}
            </label>
            <el-input
              id="mfa-code"
              v-model="mfaCode"
              name="mfaCode"
              type="text"
              inputmode="numeric"
              :placeholder="copy.mfaCodePlaceholder"
              autocomplete="one-time-code"
              :aria-invalid="Boolean(errorMessage)"
              aria-describedby="mfa-error"
              :disabled="isProcessing"
            />
          </div>

          <div v-else class="relative group">
            <label for="mfa-recovery" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
              {{ copy.mfaRecoveryLabel }}
            </label>
            <el-input
              id="mfa-recovery"
              v-model="mfaRecoveryCode"
              name="mfaRecoveryCode"
              type="text"
              :placeholder="copy.mfaRecoveryPlaceholder"
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
              {{ copy.mfaSubmit }}
            </el-button>
          </div>
        </form>

        <footer class="mt-10 flex items-center justify-between border-t border-[var(--fsusblog-panel-border)] pt-6">
          <router-link to="/register" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
            {{ copy.registerLink }}
          </router-link>
          <router-link to="/" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
            {{ copy.cancelLink }}
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
import { FSUSBLOG_AUTH_COPY } from '@/copy'

const focusRingClass = themeTokens.focusRing
const copy = FSUSBLOG_AUTH_COPY.login

const {
  errorMessage,
  rememberMe,
  isProcessing,
  handleMfaVerify,
  requiresMfa,
  mfaMode,
  mfaCode,
  mfaRecoveryCode
} = useAuthLogin()

const { loading: passkeyLoading, error: passkeyError, loginWithPasskey } = usePasskeyLogin()

const handlePasskeyLogin = () => loginWithPasskey(rememberMe.value)
</script>
