<template>
  <el-dialog
    :model-value="visible"
    :title="copy.dialogTitle"
    width="min(92vw, 24rem)"
    destroy-on-close
    :show-close="false"
    @update:model-value="(val: boolean) => !val && handleCancel()"
  >
    <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-6">
      {{ description || copy.defaultDescription }}
    </p>

    <div class="space-y-4">
      <div>
        <label for="mfa-challenge-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">{{ copy.codeLabel }}</label>
        <el-input
          id="mfa-challenge-code"
          ref="codeInput"
          v-model="code"
          type="text"
          autocomplete="one-time-code"
          inputmode="numeric"
          :placeholder="copy.codePlaceholder"
          :disabled="loading"
          @keyup.enter="handleConfirm"
        />
      </div>

      <div>
        <label for="mfa-challenge-recovery-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">{{ copy.recoveryCodeLabel }}</label>
        <el-input
          id="mfa-challenge-recovery-code"
          v-model="recoveryCode"
          type="text"
          autocomplete="one-time-code"
          :placeholder="copy.recoveryCodePlaceholder"
          :disabled="loading"
          @keyup.enter="handleConfirm"
        />
      </div>
    </div>

    <div v-if="errorMessage" role="alert" class="mt-4 text-[11px] font-medium text-[var(--fsusblog-color-error)]">
      {{ errorMessage }}
    </div>

    <template #footer>
      <div class="dialog-footer flex justify-end gap-5 mt-4">
        <el-button @click="handleCancel" :disabled="loading">{{ copy.cancelCta }}</el-button>
        <el-button
          type="primary"
          :disabled="loading || (!code.trim() && !recoveryCode.trim())"
          @click="handleConfirm"
          :loading="loading"
        >
          {{ loading ? copy.verifying : copy.verifyCta }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { FSUSBLOG_SECURITY_COPY } from '@/copy'

const copy = FSUSBLOG_SECURITY_COPY.mfaChallenge

const props = withDefaults(defineProps<{
  visible: boolean
  loading?: boolean
  description?: string
  errorMessage?: string
}>(), {
  loading: false,
  description: '',
  errorMessage: ''
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  confirm: [payload: { code?: string; recoveryCode?: string }]
  cancel: []
}>()

const code = ref('')
const recoveryCode = ref('')
const codeInput = ref<any>(null)

const handleCancel = () => {
  emit('update:visible', false)
  emit('cancel')
}

const handleConfirm = () => {
  emit('confirm', {
    code: code.value.trim() || undefined,
    recoveryCode: recoveryCode.value.trim() || undefined
  })
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      code.value = ''
      recoveryCode.value = ''
      return
    }
    await nextTick()
    codeInput.value?.focus()
  }
)
</script>