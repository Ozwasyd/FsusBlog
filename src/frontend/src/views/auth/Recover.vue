<template>
  <div class="auth-page-content w-full max-w-md">
    <section class="w-full max-w-md" aria-labelledby="recover-title">
      <header class="mb-8 sm:mb-10">
        <h1
          id="recover-title"
          class="text-3xl font-extrabold leading-tight text-[var(--fsusblog-text-primary)] sm:text-4xl"
        >
          恢复访问
        </h1>
        <p
          class="mt-3 max-w-sm text-sm leading-7 text-[var(--fsusblog-text-secondary)]"
        >
          验证 Recovery Key 后，绑定新的通行密钥继续使用账号。
        </p>
      </header>

      <form class="space-y-6" novalidate @submit.prevent>
        <section
          aria-labelledby="recovery-key-title"
          class="space-y-4 rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-5"
        >
          <div>
            <h2
              id="recovery-key-title"
              class="text-sm font-semibold text-[var(--fsusblog-text-primary)]"
            >
              Recovery Key
            </h2>
            <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
              Recovery Key 是账号恢复凭据，不是 TOTP
              恢复码。验证后可绑定新的通行密钥。
            </p>
          </div>

          <div class="relative group">
            <label
              for="recovery-user-id"
              class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]"
            >
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
            <label
              for="recovery-key"
              class="mb-2 block text-xs font-semibold text-[var(--fsusblog-text-secondary)]"
            >
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
            <p
              id="recovery-key-help"
              class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]"
            >
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
            Recovery Key 已验证，恢复会话有效至
            {{ recoverySessionExpiresAt }}。请继续绑定新的通行密钥。
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

      <footer
        class="mt-10 flex items-center justify-between border-t border-[var(--fsusblog-panel-border)] pt-6"
      >
        <router-link
          to="/login"
          class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
          :class="focusRingClass"
        >
          返回登录
        </router-link>
        <router-link
          to="/"
          class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-semibold text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
          :class="focusRingClass"
        >
          取消
        </router-link>
      </footer>
    </section>

    <PasskeyRegisterModal
      v-model:visible="recoveryPasskeyVisible"
      :recovery-session-token="recoverySessionToken"
      @success="handleRecoveryPasskeyRegistered"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { verifyRecoveryKey } from '@/api/auth'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { toAppError } from '@/utils/appError'

const focusRingClass = themeTokens.focusRing
const recoveryUserId = ref('')
const recoveryKeyInput = ref('')
const recoveryRevokePasskeys = ref(true)
const recoveryKeyLoading = ref(false)
const recoveryKeyError = ref('')
const recoverySessionToken = ref('')
const recoverySessionExpiresAt = ref('')
const recoveryPasskeyVisible = ref(false)

const canVerifyRecoveryKey = computed(
  () =>
    Number.parseInt(recoveryUserId.value, 10) > 0 &&
    recoveryKeyInput.value.trim().length > 0 &&
    !recoveryKeyLoading.value,
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
      revokePasskeys: recoveryRevokePasskeys.value,
    })
    recoveryKeyInput.value = ''
    recoverySessionToken.value = response.recoverySessionToken
    recoverySessionExpiresAt.value = new Date(
      response.expiresAt,
    ).toLocaleString()
  } catch (error) {
    recoveryKeyError.value =
      toAppError(error, 'Recovery Key 验证失败，请检查后重试').message ||
      'Recovery Key 验证失败，请检查后重试'
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
