<script setup lang="ts">
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

const props = defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const available = ref(false)
const stage = ref<'closed' | 'key' | 'verified' | 'complete' | 'finished'>('closed')
const key = ref('')
const keyValid = computed(() => validSiteRecoveryKey(key.value.trim()))
const busy = ref(false)
const failure = ref('')
const lifetime = new AbortController()
let operation: AbortController | undefined
let attestation: Uint8Array<ArrayBuffer> | undefined

function setBusy(value: boolean) {
  busy.value = value
  emit('busy', value)
}

function dropAttestation() {
  attestation?.fill(0)
  attestation = undefined
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

watch(identityEpoch, clearRecovery, { flush: 'sync' })
onMounted(async () => {
  window.addEventListener('pagehide', clearRecovery)
  try {
    const enabled = await siteRecoveryAvailable(lifetime.signal)
    if (!lifetime.signal.aborted) available.value = enabled
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
      failure.value = 'Could not confirm the replacement. Retry to submit the same Passkey.'
    } else if (stage.value === 'verified' && !(error instanceof ApiError && [401, 403, 404, 410].includes(error.status))) {
      failure.value = 'Could not create the replacement Passkey. Try again.'
    } else {
      dropAttestation()
      stage.value = 'key'
      failure.value = 'Could not recover this account. Check your Recovery Key and try again.'
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
  <section v-if="available" class="site-recovery-login" aria-label="Passkey recovery">
    <ElButton v-if="stage === 'closed'" native-type="button" :disabled="disabled" @click="stage = 'key'">
      Recover with Recovery Key
    </ElButton>
    <ElAlert v-else-if="stage === 'finished'" title="Passkey replaced. Log in with your new Passkey." type="success" :closable="false" show-icon />
    <form v-else class="recovery-login-form" @submit.prevent="replacePasskey">
      <p>Replace the lost Passkey, then log in with the new Passkey and any configured authenticator verification.</p>
      <template v-if="stage === 'key'">
        <label for="site-recovery-login-key">Recovery Key</label>
        <ElInput id="site-recovery-login-key" v-model="key" type="password" autocomplete="off" :disabled="busy || disabled" />
      </template>
      <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
      <ElButton type="primary" native-type="submit" :loading="busy" :disabled="disabled || (stage === 'key' && !keyValid && !busy)">
        {{ stage === 'complete' && failure ? 'Retry Passkey replacement' : 'Replace Passkey' }}
      </ElButton>
      <ElButton class="recovery-cancel" native-type="button" @click="clearRecovery">Cancel recovery</ElButton>
    </form>
  </section>
</template>

<style scoped>
.site-recovery-login { margin-block: 1.5rem; }
.recovery-login-form { display: grid; gap: 0.75rem; }
.recovery-cancel { margin-inline-start: 0; }
</style>
