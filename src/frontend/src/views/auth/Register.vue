<template>
  <div class="auth-page-content w-full max-w-md">
      <section
        class="w-full max-w-md"
        aria-labelledby="register-title"
      >
        <header class="mb-8 sm:mb-10">
          <h1 id="register-title" class="text-3xl font-extrabold leading-tight text-[var(--fsusblog-text-primary)] sm:text-4xl">
            {{ copy.title }}
          </h1>
          <p class="mt-3 max-w-sm text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
            {{ copy.description }}
          </p>
        </header>

        <div class="space-y-6">
          <section
            v-if="step === 'account'"
            class="space-y-6"
            aria-labelledby="anonymous-account-title"
          >
            <div>
              <h2 id="anonymous-account-title" class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">
                {{ copy.publicHandleHeading }}
              </h2>
              <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                {{ copy.publicHandleHint }}
              </p>
            </div>

            <div class="relative group">
              <label for="public-handle" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
                {{ copy.publicHandleLabel }}
              </label>
              <el-input
                id="public-handle"
                v-model="publicHandle"
                name="publicHandle"
                type="text"
                :placeholder="copy.publicHandlePlaceholder"
                :disabled="isProcessing"
                :aria-invalid="Boolean(publicHandleHint)"
                aria-describedby="public-handle-hint"
                autocomplete="off"
                autofocus
              />
              <p
                v-if="publicHandleHint"
                id="public-handle-hint"
                aria-live="polite"
                class="mt-2 text-xs font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
              >
                {{ publicHandleHint }}
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
                {{ copy.agreementPrefix }}
                <el-button
                  text
                  inline-action
                  class="register-guidelines-button"
                  type="primary"
                  size="large"
                  @click.stop.prevent="handleGuidelinesActivator"
                >
                  {{ copy.guidelinesLink }}
                </el-button>
              </el-checkbox>
            </div>

            <div class="grid pt-4">
              <el-button
                type="primary"
                :disabled="!canCreateAnonymousAccount"
                :loading="loading"
                :aria-disabled="!canCreateAnonymousAccount"
                aria-describedby="register-error"
                @click="createAnonymousAccount"
              >
                {{ loading ? copy.submitButtonLoading : copy.submitButtonIdle }}
              </el-button>
            </div>
          </section>

          <section
            v-if="step === 'recovery' || step === 'passkey'"
            class="space-y-5"
            aria-labelledby="recovery-key-title"
          >
            <div>
              <h2 id="recovery-key-title" class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">
                {{ copy.recoveryKeyTitle }}
              </h2>
              <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                {{ copy.recoveryKeyHint }}
              </p>
            </div>

            <div
              class="rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg-soft)] p-4"
              aria-live="polite"
            >
              <p class="mb-2 text-[11px] font-semibold text-[var(--fsusblog-text-muted)]">
                {{ copy.recoveryKeyVersionPrefix }}{{ recoveryKeyVersion }}
              </p>
              <code class="block break-all font-mono text-sm leading-7 text-[var(--fsusblog-text-primary)]">
                {{ recoveryKeyPlaintext }}
              </code>
              <p v-if="recoveryKeyCreatedAt" class="mt-2 text-[11px] text-[var(--fsusblog-text-muted)]">
                {{ copy.recoveryKeyCreatedAtPrefix }}{{ recoveryKeyCreatedAt }}
              </p>
            </div>

            <div class="grid gap-3">
              <el-button :disabled="!recoveryKeyPlaintext" @click="copyRecoveryKey">
                {{ copy.copyRecoveryKeyCta }}
              </el-button>
              <el-checkbox
                id="recovery-key-saved"
                v-model="recoveryKeySaved"
                :disabled="!recoveryKeyPlaintext"
                aria-required="true"
              >
                {{ copy.recoveryKeySavedCheckbox }}
              </el-checkbox>
              <el-button
                type="primary"
                :disabled="!canRegisterPasskey"
                @click="openPasskeyRegistration"
              >
                {{ copy.registerPasskeyCta }}
              </el-button>
            </div>
          </section>

          <section
            v-if="step === 'complete'"
            class="space-y-5"
            aria-labelledby="anonymous-complete-title"
          >
            <div class="rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg-soft)] px-5 py-4">
              <h2 id="anonymous-complete-title" class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">
                {{ copy.passkeyBoundTitle }}
              </h2>
              <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                {{ copy.passkeyBoundHint }}
              </p>
            </div>
            <el-button type="primary" @click="finishOnboarding">
              {{ copy.enterAccountCta }}
            </el-button>
          </section>

          <div
            v-if="localError"
            id="register-error"
            role="alert"
            aria-live="polite"
            class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-semibold text-[var(--fsusblog-color-error)] animate-in fade-in"
          >
            {{ localError }}
          </div>
        </div>

        <footer class="mt-10 flex items-center justify-between border-t border-[var(--fsusblog-panel-border)] pt-6">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-[var(--fsusblog-text-muted)]">{{ copy.hasAccountLabel }}</span>
            <router-link to="/login" class="rounded-[var(--fsus-radius-control)] py-1 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
              {{ copy.loginLink }}
            </router-link>
          </div>
          <router-link to="/" class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none" :class="focusRingClass">
            {{ copy.cancelLink }}
          </router-link>
        </footer>
      </section>

    <PolicyModal v-model:visible="showGuidelines" type="guidelines" />
    <PasskeyRegisterModal
      v-model:visible="passkeyModalVisible"
      @success="onPasskeyRegistered"
    />
  </div>
</template>

<script setup lang="ts">
import { useAnonymousOnboarding } from '@/composables/useAnonymousOnboarding'
import PolicyModal from '@/components/PolicyModal.vue'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { FSUSBLOG_AUTH_COPY } from '@/copy'

const focusRingClass = themeTokens.focusRing
const copy = FSUSBLOG_AUTH_COPY.register

const {
  localError,
  publicHandle,
  publicHandleHint,
  isAgreed,
  showGuidelines,
  loading,
  step,
  recoveryKeyPlaintext,
  recoveryKeyVersion,
  recoveryKeyCreatedAt,
  recoveryKeySaved,
  passkeyModalVisible,
  isProcessing,
  canCreateAnonymousAccount,
  canRegisterPasskey,
  handleGuidelinesActivator,
  createAnonymousAccount,
  copyRecoveryKey,
  openPasskeyRegistration,
  onPasskeyRegistered,
  finishOnboarding
} = useAnonymousOnboarding()
</script>

<style scoped>
@reference "@/assets/main.css";

:deep(.register-guidelines-button.el-button) {
  min-height: 40px;
  align-items: center;
}
</style>
