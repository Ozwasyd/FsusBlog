<template>
  <FsusDialog
    :model-value="visible"
    :title="title"
    width="min(92vw, 28rem)"
    destroy-on-close
    :show-close="false"
    @update:model-value="(val: boolean) => !val && close()"
  >
    <p class="sr-only" role="status" aria-live="polite">{{ setupStepStatusText }}</p>

    <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-5">
      {{ copy.intro }}
    </p>

    <div class="space-y-6">
      <!-- 二维码区域 -->
      <div v-if="otpAuthUrl && !recoveryCodes.length" class="flex flex-col items-center py-4">
        <div class="p-4 bg-[var(--fsusblog-panel-bg)] rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border)] shadow-none">
          <qrcode-vue
            :value="otpAuthUrl"
            :size="160"
            level="H"
            render-as="svg"
            foreground="var(--fsusblog-text-primary)"
          />
        </div>
        <div class="mt-4 text-[11px] font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal">{{ copy.scanHint }}</div>
      </div>

      <div>
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="text-xs font-medium text-[var(--fsusblog-text-secondary)] normal-case tracking-normal">{{ copy.manualKeyLabel }}</div>
          <el-button
            v-if="secret"
            size="small"
            link
            :icon="CopyDocument"
            @click="copySecret"
          >
            {{ copy.copyCta }}
          </el-button>
        </div>
        <div class="px-3 py-2 bg-[var(--fsusblog-panel-bg)] border border-[var(--fsusblog-panel-border)] rounded-[var(--fsus-radius-control)] text-[12px] tabular-nums text-[var(--fsusblog-text-secondary)] break-all">{{ secret || '-' }}</div>
      </div>

      <div v-if="otpAuthUrl" class="flex flex-wrap items-center gap-3">
        <el-button
          size="small"
          :icon="CopyDocument"
          @click="copyOtpAuthUrl"
        >
          {{ copy.copyOtpAuthUrlCta }}
        </el-button>
      </div>

      <div v-if="!recoveryCodes.length">
        <label for="mfa-setup-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">{{ copy.codeLabel }}</label>
        <el-input
          id="mfa-setup-code"
          :model-value="setupCode"
          @update:model-value="(val: string | number) => emit('update:setupCode', String(val))"
          type="text"
          autocomplete="one-time-code"
          inputmode="numeric"
          :placeholder="copy.codePlaceholder"
          :disabled="loading"
          @keyup.enter="$emit('verify')"
        />
      </div>

      <div v-else>
        <div class="text-xs font-medium text-[var(--fsusblog-text-secondary)] mb-2">{{ copy.recoveryCodesTitle }}</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div
            v-for="code in recoveryCodes"
            :key="code"
            class="px-3 py-2 bg-[var(--fsusblog-panel-bg)] border border-[var(--fsusblog-panel-border)] rounded-[var(--fsus-radius-control)] text-[12px] tabular-nums text-[var(--fsusblog-text-secondary)]"
          >
            {{ code }}
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-3">
          <el-button size="small" @click="copyRecoveryCodes">{{ copy.copyRecoveryCodesCta }}</el-button>
          <el-button size="small" @click="downloadRecoveryCodes">{{ copy.downloadRecoveryCodesCta }}</el-button>
        </div>
        <el-checkbox v-model="recoveryCodesAcknowledged" class="mt-4">
          {{ copy.savedRecoveryCodesCheckbox }}
        </el-checkbox>
      </div>
    </div>

    <div v-if="errorMessage" role="alert" class="mt-4 text-[11px] font-medium text-[var(--fsusblog-color-error)]">{{ errorMessage }}</div>

    <template #footer>
      <div class="dialog-footer flex justify-end gap-5 mt-4">
        <el-button @click="close" :disabled="loading">
          {{ recoveryCodes.length ? copy.closeCta : copy.cancelCta }}
        </el-button>
        <el-button
          v-if="!recoveryCodes.length"
          type="primary"
          :disabled="loading || !setupCode.trim()"
          @click="$emit('verify')"
          :loading="loading"
        >
          {{ loading ? copy.verifying : copy.bindingCta }}
        </el-button>
      </div>
    </template>
  </FsusDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import FsusDialog from '@/components/ui/FsusDialog.vue'
import QrcodeVue from 'qrcode.vue'
import { toast } from '@/fsusui/feedback'
import { CopyDocument } from '@/fsusui/icons'
import { FSUSBLOG_SECURITY_COPY } from '@/copy'

const copy = FSUSBLOG_SECURITY_COPY.mfaSetup

const props = withDefaults(defineProps<{
  visible: boolean
  title?: string
  loading: boolean
  secret: string
  otpAuthUrl: string
  setupCode: string
  recoveryCodes: string[]
  errorMessage: string
}>(), {
  title: FSUSBLOG_SECURITY_COPY.mfaSetup.defaultTitle
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'update:setupCode': [value: string]
  verify: []
}>()

const recoveryCodesAcknowledged = ref(false)
const recoveryCodesText = computed(() => props.recoveryCodes.join('\n'))

watch(recoveryCodesText, () => {
  recoveryCodesAcknowledged.value = false
})

const close = () => {
  if (props.recoveryCodes.length > 0 && !recoveryCodesAcknowledged.value) {
    toast.warning(copy.saveRecoveryCodesFirstWarning)
    return
  }

  emit('update:visible', false)
}

const copyRecoveryCodes = async (): Promise<void> => {
  if (!recoveryCodesText.value) {
    return
  }

  await copyText(recoveryCodesText.value, copy.recoveryCodesCopied, copy.recoveryCodesCopyFailed)
}

const copySecret = async (): Promise<void> => {
  if (!props.secret) {
    return
  }

  await copyText(props.secret, copy.secretCopied, copy.secretCopyFailed)
}

const copyOtpAuthUrl = async (): Promise<void> => {
  if (!props.otpAuthUrl) {
    return
  }

  await copyText(props.otpAuthUrl, copy.otpAuthUrlCopied, copy.otpAuthUrlCopyFailed)
}

const copyText = async (text: string, successMessage: string, failureMessage: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(successMessage)
  } catch {
    toast.error(failureMessage)
  }
}

const downloadRecoveryCodes = (): void => {
  const blob = new Blob([`${recoveryCodesText.value}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `fsusblog-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`
  anchor.rel = 'noopener'
  anchor.click()
  URL.revokeObjectURL(url)
  toast.success(copy.recoveryCodesDownloaded)
}

const setupStepStatusText = computed(() => {
  if (props.recoveryCodes.length > 0) {
    return copy.statusBindingComplete
  }

  if (props.loading) {
    return copy.statusBindingInProgress
  }

  if (props.otpAuthUrl) {
    return copy.statusBindingSteps
  }

  return copy.statusPreparing
})
</script>
