<template>
  <FsusDialog
    :model-value="visible"
    :title="copy.dialogTitle"
    class="passkey-register-dialog"
    modal-class="passkey-register-overlay"
    width="min(92vw, 28rem)"
    destroy-on-close
    :show-close="false"
    @update:model-value="(val: boolean) => !val && handleClose()"
  >
    <div class="passkey-register-modal">
      <p class="sr-only" role="status" aria-live="polite">{{ stepStatusText }}</p>

      <div class="passkey-register-modal__body">
        <!-- 步骤 1：设备名称 -->
        <template v-if="step === 'name'">
          <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-6">
            {{ stepNameHint }}
          </p>

          <div>
            <label for="passkey-register-name" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">{{ copy.deviceNameLabel }}</label>
            <el-input
              id="passkey-register-name"
              ref="nameInput"
              v-model="friendlyName"
              type="text"
              autocomplete="webauthn"
              :placeholder="copy.deviceNamePlaceholder"
              :disabled="loading"
              maxlength="64"
              show-word-limit
              @keyup.enter="onNameNext"
            />
          </div>
        </template>

        <!-- 步骤 2：MFA 验证（仅当用户已启用 TOTP 时） -->
        <template v-else-if="step === 'mfa'">
          <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-6">
            {{ copy.mfaStepHint }}
          </p>

          <div class="space-y-4">
            <div>
              <label for="passkey-register-mfa-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">{{ copy.mfaCodeLabel }}</label>
              <el-input
                id="passkey-register-mfa-code"
                ref="mfaCodeInput"
                v-model="mfaCode"
                type="text"
                autocomplete="one-time-code"
                inputmode="numeric"
                :placeholder="copy.mfaCodePlaceholder"
                :disabled="loading"
                @keyup.enter="onMfaVerify"
              />
            </div>
            <div>
              <label for="passkey-register-recovery-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">{{ copy.mfaRecoveryCodeLabel }}</label>
              <el-input
                id="passkey-register-recovery-code"
                v-model="mfaRecoveryCode"
                type="text"
                autocomplete="one-time-code"
                :placeholder="copy.mfaRecoveryCodePlaceholder"
                :disabled="loading"
                @keyup.enter="onMfaVerify"
              />
            </div>
          </div>
        </template>

        <!-- 步骤 3：等待认证器 -->
        <template v-else-if="step === 'ceremony'">
          <div class="flex flex-col items-center gap-4 py-8">
            <div class="h-3 w-32">
              <el-skeleton animated :rows="1" />
            </div>
            <p class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ copy.waitingAuthenticator }}</p>
          </div>
        </template>

        <!-- 步骤 4：成功 -->
        <template v-else-if="step === 'success'">
          <div class="flex flex-col items-center gap-3 py-4">
            <div class="w-12 h-12 rounded-[var(--fsus-radius-panel)] bg-[var(--fsusblog-text-primary)] flex items-center justify-center">
              <Check class="w-6 h-6 text-[var(--fsusblog-page-bg)]" aria-hidden="true" />
            </div>
            <p class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">{{ copy.successTitle }}</p>
            <p class="text-[12px] text-[var(--fsusblog-text-muted)]">{{ copy.successHint }}</p>
          </div>
        </template>

        <div v-if="errorMessage" role="alert" class="mt-4 text-[11px] font-medium text-[var(--fsusblog-color-error)]">{{ errorMessage }}</div>
      </div>
    </div>

    <template #footer>
      <div class="passkey-register-modal__footer">
        <template v-if="step === 'success'">
          <el-button class="passkey-register-modal__button" type="primary" @click="handleClose">{{ copy.closeCta }}</el-button>
        </template>
        <template v-else-if="step === 'ceremony'" />
        <template v-else>
          <el-button class="passkey-register-modal__button" @click="handleClose" :disabled="loading">{{ copy.cancelCta }}</el-button>
          <el-button
            v-if="step === 'name'"
            class="passkey-register-modal__button"
            type="primary"
            :loading="loading"
            :disabled="loading"
            @click="onNameNext"
          >
            {{ needsMfa ? copy.nextCta : copy.registerCta }}
          </el-button>
          <el-button
            v-if="step === 'mfa'"
            class="passkey-register-modal__button"
            type="primary"
            :loading="loading"
            :disabled="loading || (!mfaCode.trim() && !mfaRecoveryCode.trim())"
            @click="onMfaVerify"
          >
            {{ loading ? copy.verifying : copy.verifyCta }}
          </el-button>
        </template>
      </div>
    </template>
  </FsusDialog>
</template>

<script setup lang="ts">
import { Check } from '@/fsusui/icons'
import { computed, nextTick, ref, watch } from 'vue'
import { beginRecoveryPasskeyRegistration, completeRecoveryPasskeyRegistration, passkeyRegisterBegin, passkeyRegisterComplete, startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import FsusDialog from '@/components/ui/FsusDialog.vue'
import { FSUSBLOG_SECURITY_COPY } from '@/copy'
import { startPasskeyRegistration, type PasskeyRegistrationResult } from '@/services/passkeyCeremony'

type Step = 'name' | 'mfa' | 'ceremony' | 'success'

const copy = FSUSBLOG_SECURITY_COPY.passkeyRegister

const props = withDefaults(defineProps<{
  visible: boolean
  /** 如果用户已启用 TOTP，需要先做 MFA 验证 */
  needsMfa?: boolean
  /** Recovery Key 验证后签发的短会话，用于未登录恢复流程绑定新 Passkey */
  recoverySessionToken?: string
}>(), {
  needsMfa: false
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  success: []
}>()

const step = ref<Step>('name')
const friendlyName = ref('')
const mfaCode = ref('')
const mfaRecoveryCode = ref('')
const loading = ref(false)
const errorMessage = ref('')
const nameInput = ref<HTMLElement | null>(null)
const mfaCodeInput = ref<HTMLElement | null>(null)
const stepStatusText = computed(() => {
  if (step.value === 'name') return copy.stepStatusName
  if (step.value === 'mfa') return copy.stepStatusMfa
  if (step.value === 'ceremony') return copy.stepStatusCeremony
  return copy.stepStatusSuccess
})
const stepNameHint = computed(() =>
  props.recoverySessionToken ? copy.stepNameHintWithSession : copy.stepNameHintStandalone
)

watch(() => props.visible, (val) => {
  if (val) {
    step.value = 'name'
    friendlyName.value = ''
    mfaCode.value = ''
    mfaRecoveryCode.value = ''
    errorMessage.value = ''
    nextTick(() => (nameInput.value as any)?.focus?.())
  }
})

watch(step, (s) => {
  if (s === 'mfa') {
    nextTick(() => (mfaCodeInput.value as any)?.focus?.())
  }
})

const handleClose = () => {
  if (step.value === 'success') emit('success')
  emit('update:visible', false)
}

const onNameNext = async () => {
  if (!props.recoverySessionToken && props.needsMfa) {
    step.value = 'mfa'
  } else {
    await runCeremony(undefined)
  }
}

const onMfaVerify = async () => {
  loading.value = true
  errorMessage.value = ''
  try {
    const challengeResult = await startMfaChallenge('passkey_register')
    const challengeToken = challengeResult.proofToken ?? (challengeResult as any).challengeToken

    const verifyResult = await verifyMfaChallenge({
      challengeToken: challengeToken,
      code: mfaCode.value.trim() || undefined,
      recoveryCode: mfaRecoveryCode.value.trim() || undefined,
      action: 'passkey_register'
    })

    if (!verifyResult.proofToken) {
      errorMessage.value = copy.mfaCodeInvalid
      return
    }

    await runCeremony(verifyResult.proofToken)
  } catch (e: any) {
    errorMessage.value = e?.response?.data?.message ?? copy.mfaVerifyFailed
  } finally {
    loading.value = false
  }
}

const runCeremony = async (mfaProofToken: string | undefined) => {
  loading.value = true
  errorMessage.value = ''
  step.value = 'ceremony'
  try {
    const beginResp = props.recoverySessionToken
      ? await beginRecoveryPasskeyRegistration(props.recoverySessionToken)
      : await passkeyRegisterBegin()
    const sessionKey = (beginResp as any).sessionKey || (beginResp as any).SessionKey
    const options = (beginResp as any).options || (beginResp as any).Options

    if (!sessionKey || !options) {
      throw new Error(copy.invalidCeremonySession)
    }

    let attestation: PasskeyRegistrationResult
    try {
      attestation = await startPasskeyRegistration(options)
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        step.value = props.needsMfa ? 'mfa' : 'name'
        return
      }
      throw e
    }

    if (props.recoverySessionToken) {
      await completeRecoveryPasskeyRegistration({
        recoverySessionToken: props.recoverySessionToken,
        sessionKey,
        attestation,
        friendlyName: friendlyName.value.trim() || undefined
      })
    } else {
      await passkeyRegisterComplete({
        sessionKey,
        attestation,
        friendlyName: friendlyName.value.trim() || undefined,
        mfaProofToken
      })
    }

    step.value = 'success'
  } catch (e: any) {
    errorMessage.value = e?.message || copy.registerFailed
    step.value = props.needsMfa ? 'mfa' : 'name'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
:global(.fsusblog-dialog.passkey-register-dialog) {
  max-height: min(82dvh, 34rem);
}

:global(.passkey-register-dialog .el-dialog__header) {
  padding: 1.25rem 1.5rem 0.75rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
}

:global(.passkey-register-dialog .el-dialog__body) {
  padding: 0;
}

:global(.passkey-register-dialog .el-dialog__footer) {
  padding: 0;
  border-top: 1px solid var(--fsusblog-panel-border);
}

:global(.passkey-register-dialog .fsus-dialog__footer) {
  border-top: 0;
  padding-top: 0;
}

.passkey-register-modal__body {
  padding: 1.25rem 1.5rem;
}

.passkey-register-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
}

.passkey-register-modal__button {
  min-height: 2.5rem;
  padding-inline: 1.1rem;
}

@media (max-width: 640px) {
  :global(.fsusblog-dialog.passkey-register-dialog) {
    width: calc(100vw - 2rem);
    max-height: calc(100dvh - 2rem);
  }

  .passkey-register-modal__body {
    padding: 1rem;
  }

  .passkey-register-modal__footer {
    justify-content: stretch;
    padding: 0.875rem 1rem 1rem;
  }

  .passkey-register-modal__button {
    flex: 1 1 0;
  }
}
</style>
