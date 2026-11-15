<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { issueSiteRecoveryKey, removeCurrentSitePasskey, siteRecoveryAvailable, siteRecoveryStatus, validSiteRecoveryKey } from '../../../Contracts/recovery-key'
import { credentialEpoch, currentSession, identityEpoch, refreshSession } from '../session'
import { announceSiteAuthChange, readSiteAuthority, withSiteAuthMutation } from '../site-refresh-coordination'

const available = ref(false)
const active = ref<boolean | null>(null)
const issued = ref('')
const removing = ref(false)
const removalKey = ref('')
const busy = ref(false)
const failure = ref('')
const lifetime = new AbortController()
let request: AbortController | undefined
let mounted = false

function reset() {
  request?.abort()
  request = undefined
  available.value = false
  active.value = null
  issued.value = ''
  closeRemoval()
  busy.value = false
  failure.value = ''
}

watch(credentialEpoch, () => {
  reset()
  if (mounted && currentSession.value) void refresh()
}, { flush: 'sync' })

function hideKey() { issued.value = '' }

function closeRemoval() {
  removing.value = false
  removalKey.value = ''
}

function removeCurrent() {
  const expected = currentSession.value?.siteSessionId
  const epoch = identityEpoch.value
  const key = removalKey.value.trim()
  if (!removing.value || !active.value || !expected || !validSiteRecoveryKey(key)) return
  return run(async signal => {
    removalKey.value = ''
    const isLive = () => !signal.aborted && identityEpoch.value === epoch && currentSession.value?.siteSessionId === expected
    await withSiteAuthMutation(signal, async () => {
      const current = await readSiteAuthority(signal)
      if (!isLive() || current?.siteSessionId !== expected)
        throw new ApiError('The current browser session changed.', 409)
      await removeCurrentSitePasskey(key, expected, signal).catch(async error => {
        if (isLive()) await refreshSession(signal, false).catch(() => {})
        throw error
      })
      if (!isLive()) return
      announceSiteAuthChange()
      await refreshSession(signal, false)
    })
  }, () => {
    failure.value = 'Could not confirm Passkey removal. Check your Recovery Key and try again.'
  })
}

function restoreStatus(event: PageTransitionEvent) {
  if (event.persisted && currentSession.value) void refresh()
}

onMounted(() => {
  mounted = true
  window.addEventListener('pagehide', reset)
  window.addEventListener('pageshow', restoreStatus)
  if (currentSession.value) void refresh()
})

onUnmounted(() => {
  mounted = false
  lifetime.abort()
  window.removeEventListener('pagehide', reset)
  window.removeEventListener('pageshow', restoreStatus)
  reset()
})

async function run(task: (signal: AbortSignal) => Promise<void>, onFailure: (error: unknown) => void) {
  if (!currentSession.value || busy.value || lifetime.signal.aborted) return
  const operation = new AbortController()
  request = operation
  busy.value = true
  failure.value = ''
  try { await task(operation.signal) }
  catch (error) { if (!operation.signal.aborted) onFailure(error) }
  finally {
    if (request === operation) {
      request = undefined
      busy.value = false
    }
  }
}

function refresh() {
  return run(async signal => {
    const enabled = await siteRecoveryAvailable(signal)
    if (!enabled || signal.aborted) return
    available.value = true
    const state = await siteRecoveryStatus(signal)
    if (!signal.aborted) active.value = state
  }, error => {
    if (error instanceof ApiError && (error.status === 401 || error.status === 404)) available.value = false
    else failure.value = 'Could not check Recovery Key status. Try again.'
  })
}

function issue() {
  if (active.value === null || issued.value) return
  const operation = active.value ? 2 : 1
  return run(async signal => {
    const key = await issueSiteRecoveryKey(operation, signal)
    if (signal.aborted) return
    active.value = true
    issued.value = key
  }, () => {
    active.value = null
    failure.value = 'Could not confirm issuance. Check Recovery Key status before trying again.'
  })
}
</script>

<template>
  <section v-if="available && currentSession" class="auth-form site-recovery-key" aria-labelledby="site-recovery-key-heading">
    <h2 id="site-recovery-key-heading">Recovery Key</h2>
    <p>Use a Recovery Key to replace your Passkey if you lose access to it.</p>
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
    <div v-if="issued" class="recovery-key-receipt" aria-live="polite">
      <p>Save this key now. It is shown only once.</p>
      <code data-testid="site-recovery-key">{{ issued }}</code>
      <ElButton native-type="button" @click="hideKey">Hide Recovery Key</ElButton>
    </div>
    <form v-else-if="removing" class="auth-form" @submit.prevent="removeCurrent">
      <p>Removing the current Passkey will sign you out. Keep your Recovery Key so you can recover access.</p>
      <label for="site-passkey-removal-key">Recovery Key to confirm removal</label>
      <ElInput id="site-passkey-removal-key" v-model="removalKey" type="password" autocomplete="off" :disabled="busy" />
      <ElButton native-type="submit" type="danger" :loading="busy" :disabled="busy || !validSiteRecoveryKey(removalKey.trim())">
        Remove with Passkey
      </ElButton>
      <ElButton native-type="button" :disabled="busy" @click="closeRemoval">Cancel</ElButton>
    </form>
    <template v-else-if="active !== null">
      <p v-if="active">Replacing the Recovery Key invalidates the previous key.</p>
      <ElButton type="primary" native-type="button" :loading="busy" @click="issue">
        {{ active ? 'Replace Recovery Key' : 'Create Recovery Key' }}
      </ElButton>
      <ElButton v-if="active && currentSession.siteSessionId" native-type="button" :disabled="busy"
        @click="removing = true">Remove current Passkey</ElButton>
    </template>
    <ElButton v-else-if="failure" native-type="button" :loading="busy" @click="refresh">Check Recovery Key status</ElButton>
  </section>
</template>

<style scoped>
.site-recovery-key { margin-block-start: 1.5rem; }
.recovery-key-receipt { display: grid; gap: 0.75rem; }
.recovery-key-receipt code { overflow-wrap: anywhere; user-select: all; }
</style>
