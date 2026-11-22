<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  beginSitePasskeyReplacement,
  completeSitePasskeyReplacement,
  siteRecoveryAvailable,
  validSiteRecoveryKey,
  verifySiteRecoveryKey,
} from '../../../Contracts/recovery-key'
import { identityEpoch } from '../session'

const props = withDefaults(defineProps<{ disabled: boolean; hideTrigger?: boolean; initialAvailable?: boolean }>(), {
  hideTrigger: false,
  initialAvailable: undefined,
})
const emit = defineEmits<{
  busy: [value: boolean]
  available: [value: boolean]
  open: [value: boolean]
}>()
const available = ref(props.initialAvailable ?? false)
const stage = ref<'closed' | 'key' | 'verified' | 'complete' | 'finished'>('closed')
const key = ref('')
const keyValid = computed(() => validSiteRecoveryKey(key.value.trim()))
const busy = ref(false)
const failure = ref<MessageKey | ''>('')
const lifetime = new AbortController()
let operation: AbortController | undefined
let attestation: Uint8Array<ArrayBuffer> | undefined

watch(stage, value => emit('open', value !== 'closed' && value !== 'finished'), { flush: 'sync' })

function setBusy(value: boolean) {
  busy.value = value
  emit('busy', value)
}

function dropAttestation() {
  attestation?.fill(0)
  attestation = undefined
}

function openRecovery() {
  if (!available.value || props.disabled || busy.value) return
  failure.value = ''
  stage.value = 'key'
}

function clearRecovery() {
  operation?.abort()
  operation = undefined
  key.value = ''
  dropAttestation()
  stage.value = 'closed'
  failure.value = ''
  setBusy(false)
}

defineExpose({ openRecovery, clearRecovery })

watch(identityEpoch, clearRecovery, { flush: 'sync' })
onMounted(async () => {
  window.addEventListener('pagehide', clearRecovery)
  if (props.initialAvailable !== undefined) {
    emit('available', props.initialAvailable)
    return
  }
  try {
    const enabled = await siteRecoveryAvailable(lifetime.signal)
    if (!lifetime.signal.aborted) {
      available.value = enabled
      emit('available', enabled)
    }
  } catch {
    // Recovery is opt-in. Keep the existing login controls available if the check fails.
  }
})
onUnmounted(() => {
  lifetime.abort()
  window.removeEventListener('pagehide', clearRecovery)
  clearRecovery()
})

function canRetryCompletion(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 408 || error.status === 429
}

async function replacePasskey() {
  if (stage.value === 'closed' || stage.value === 'finished' || props.disabled || busy.value ||
      (stage.value === 'key' && !keyValid.value)) return
  const attempt = new AbortController()
  const signal = attempt.signal
  operation = attempt
  failure.value = ''
  setBusy(true)
  try {
    if (stage.value === 'key') {
      const typed = key.value.trim()
      key.value = ''
      await verifySiteRecoveryKey(typed, signal)
      if (signal.aborted) return
      stage.value = 'verified'
    }
    if (stage.value === 'verified') {
      const created = await beginSitePasskeyReplacement(signal)
      if (signal.aborted) {
        created.fill(0)
        return
      }
      attestation = created
      stage.value = 'complete'
    }
    if (!attestation) return
    await completeSitePasskeyReplacement(attestation, signal)
    if (signal.aborted) return
    dropAttestation()
    stage.value = 'finished'
  } catch (error) {
    if (signal.aborted) return
    if (stage.value === 'complete' && canRetryCompletion(error)) {
      failure.value = 'login.recovery.unconfirmed'
    } else if (stage.value === 'verified' && !(error instanceof ApiError && [401, 403, 404, 410].includes(error.status))) {
      failure.value = 'login.recovery.createFailed'
    } else {
      dropAttestation()
      stage.value = 'key'
      failure.value = 'login.recovery.failed'
    }
  } finally {
    if (operation === attempt) {
      operation = undefined
      setBusy(false)
    }
  }
}
</script>

<template>
  <section v-if="available && (!hideTrigger || stage !== 'closed')" class="site-recovery-login"
    :class="{ 'is-embedded': hideTrigger }" :aria-label="t('login.recovery.label')">
    <ElButton v-if="!hideTrigger && stage === 'closed'" text native-type="button" :disabled="disabled" @click="stage = 'key'">
      {{ t('login.recovery.open') }}
    </ElButton>
    <ElAlert v-else-if="stage === 'finished'" :title="t('login.recovery.finished')" type="success" :closable="false" show-icon />
    <form v-else-if="stage !== 'closed'" class="recovery-login-form auth-secondary-panel" @submit.prevent="replacePasskey">
      <p class="auth-secondary-hint">{{ t('login.recovery.explanation') }}</p>
      <div v-if="stage === 'key'" class="auth-secondary-field">
        <label for="site-recovery-login-key">{{ t('login.recovery.key') }}</label>
        <ElInput
          id="site-recovery-login-key"
          v-model="key"
          type="password"
          autocomplete="off"
          v-bind="{ autocorrect: 'off', autocapitalize: 'none', spellcheck: false }"
          :disabled="busy || disabled"
        />
      </div>
      <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
      <div class="auth-secondary-actions">
        <ElButton type="primary" native-type="submit" :loading="busy" :disabled="disabled || (stage === 'key' && !keyValid && !busy)">
          {{ t(stage === 'complete' && failure ? 'login.recovery.retry' : 'login.recovery.replace') }}
        </ElButton>
        <ElButton class="recovery-cancel" native-type="button" @click="clearRecovery">{{ t('login.recovery.cancel') }}</ElButton>
      </div>
    </form>
  </section>
</template>

<style scoped>
.site-recovery-login { margin-block: 1.5rem; }
.site-recovery-login.is-embedded { margin-block: 0 1.5rem; }
.recovery-cancel { margin-inline-start: 0; }
</style>
