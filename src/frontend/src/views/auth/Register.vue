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
            创建匿名账号
          </h1>
          <p class="mt-3 max-w-sm text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
            不绑定邮箱或手机号。请保存 Recovery Key，并绑定通行密钥后再离开。
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
                匿名账号
              </h2>
              <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                公开称呼可选；留空时系统会生成匿名称呼。TOTP MFA 可在账户设置中作为高级 step-up 开启，TOTP 恢复码不是 Recovery Key。
              </p>
            </div>

            <div class="relative group">
              <label for="public-handle" class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]">
                公开称呼（可选）
              </label>
              <el-input
                id="public-handle"
                v-model="publicHandle"
                name="publicHandle"
                type="text"
                placeholder="3-20 位中文或英文字母"
                :disabled="isProcessing"
                :aria-invalid="Boolean(publicHandleHint)"
                aria-describedby="public-handle-hint"
                autocomplete="username"
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

            <div class="grid pt-4">
              <el-button
                type="primary"
                :disabled="!canCreateAnonymousAccount"
                :loading="loading"
                :aria-disabled="!canCreateAnonymousAccount"
                aria-describedby="register-error"
                @click="createAnonymousAccount"
              >
                {{ submitButtonText }}
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
                保存 Recovery Key
              </h2>
              <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                Recovery Key 只显示一次。若它丢失且没有可用通行密钥，账号可能无法恢复。
              </p>
            </div>

            <div
              class="rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg-soft)] p-4"
              aria-live="polite"
            >
              <p class="mb-2 text-[11px] font-semibold text-[var(--fsusblog-text-muted)]">
                Recovery Key v{{ recoveryKeyVersion }}
              </p>
              <code class="block break-all font-mono text-sm leading-7 text-[var(--fsusblog-text-primary)]">
                {{ recoveryKeyPlaintext }}
              </code>
              <p v-if="recoveryKeyCreatedAt" class="mt-2 text-[11px] text-[var(--fsusblog-text-muted)]">
                生成时间：{{ recoveryKeyCreatedAt }}
              </p>
            </div>

            <div class="grid gap-3">
              <el-button :disabled="!recoveryKeyPlaintext" @click="copyRecoveryKey">
                复制 Recovery Key
              </el-button>
              <el-checkbox
                id="recovery-key-saved"
                v-model="recoveryKeySaved"
                :disabled="!recoveryKeyPlaintext"
                aria-required="true"
              >
                我已保存 Recovery Key
              </el-checkbox>
              <el-button
                type="primary"
                :disabled="!canRegisterPasskey"
                @click="openPasskeyRegistration"
              >
                注册通行密钥
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
                通行密钥已绑定
              </h2>
              <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                后续登录请使用通行密钥；Recovery Key 仅用于账号恢复。
              </p>
            </div>
            <el-button type="primary" @click="finishOnboarding">
              进入账号中心
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
    <PasskeyRegisterModal
      v-model:visible="passkeyModalVisible"
      @success="onPasskeyRegistered"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAnonymousOnboarding } from '@/composables/useAnonymousOnboarding'
import PolicyModal from '@/components/PolicyModal.vue'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'

const focusRingClass = themeTokens.focusRing

const {
  siteStore,
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
  submitButtonText,
  handleGuidelinesActivator,
  createAnonymousAccount,
  copyRecoveryKey,
  openPasskeyRegistration,
  onPasskeyRegistered,
  finishOnboarding
} = useAnonymousOnboarding()

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
