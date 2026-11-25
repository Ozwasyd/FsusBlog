<script setup lang="ts">
import { t } from '../siteLocale'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { ElAlert, ElButton, ElCopyableDetail, ElInlineActions, ElInput, ElRiskNotice, ElTag } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { issueSiteRecoveryKey, removeCurrentSitePasskey, siteRecoveryAvailable, siteRecoveryStatus, validSiteRecoveryKey } from '../../../Contracts/recovery-key'
import SecuritySectionCard from '../components/SecuritySectionCard.vue'
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

watch([identityEpoch, credentialEpoch], ([nextIdentity], [prevIdentity]) => {
  if (!currentSession.value || nextIdentity !== prevIdentity) {
    reset()
    if (mounted && currentSession.value) void refresh()
    return
  }
  request?.abort()
  request = undefined
  busy.value = false
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
    failure.value = t('account.message64')
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
    else failure.value = t('account.message65')
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
    failure.value = t('account.message66')
  })
}
</script>

<template>
  <SecuritySectionCard v-if="available && currentSession" heading-id="site-recovery-key-heading" :title="t('login.recovery.key')"
    :description="active ? t('account.recoveryActiveSummary') : t('account.message55')"
    :has-body="Boolean(failure || issued || (active && currentSession.siteSessionId))">
    <template v-if="active !== null" #badge>
      <ElTag size="small" :type="active ? 'success' : 'info'" disable-transitions>{{ t(active ? 'admin.configured' : 'account.recoveryUnsetTag') }}</ElTag>
    </template>
    <template v-if="(active !== null && !issued && !removing) || (active === null && failure)" #actions>
      <ElButton v-if="active !== null && !issued && !removing" native-type="button" :loading="busy" @click="issue">{{ active ? t('account.message61') : t('account.message62') }}</ElButton>
      <ElButton v-else-if="active === null && failure" native-type="button" :loading="busy" @click="refresh">{{ t('account.message63') }}</ElButton>
    </template>
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
    <div v-if="issued" class="recovery-subpanel" aria-live="polite">
      <ElRiskNotice type="warning">{{ t('account.message56') }}</ElRiskNotice>
      <ElCopyableDetail :value="issued"><span data-testid="site-recovery-key">{{ issued }}</span></ElCopyableDetail>
      <ElInlineActions class="recovery-inline-start" density="compact">
        <ElButton native-type="button" @click="hideKey">{{ t('account.message57') }}</ElButton>
      </ElInlineActions>
    </div>
    <div v-else-if="active && currentSession.siteSessionId" class="recovery-action-block">
      <div class="recovery-subpanel-row">
        <div class="recovery-subpanel-head">
          <h3 id="recovery-remove-heading" class="recovery-subpanel-title">{{ t('account.recoveryRemoveTitle') }}</h3>
          <p class="recovery-subpanel-copy">{{ t('account.message58') }}</p>
        </div>
        <ElButton v-if="!removing" native-type="button" type="danger" plain :disabled="busy" @click="removing = true">{{ t('account.message43') }}</ElButton>
      </div>
      <form v-if="removing" class="recovery-remove-form" aria-labelledby="recovery-remove-heading" @submit.prevent="removeCurrent">
        <div class="recovery-field">
          <label for="site-passkey-removal-key">{{ t('account.message59') }}</label>
          <ElInput id="site-passkey-removal-key" v-model="removalKey" type="password" autocomplete="off"
            v-bind="{ autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'done' }" :disabled="busy" />
        </div>
        <ElInlineActions class="recovery-inline-start" density="compact">
          <ElButton native-type="submit" type="danger" :loading="busy" :disabled="busy || !validSiteRecoveryKey(removalKey.trim())">{{ t('account.message41') }}</ElButton>
          <ElButton native-type="button" :disabled="busy" @click="closeRemoval">{{ t('nav.cancel') }}</ElButton>
        </ElInlineActions>
      </form>
    </div>
  </SecuritySectionCard>
</template>

<style scoped lang="scss">
@use '../security-panels' as panels;
@use '../shared-fields' as fields;
@include panels.surface('.recovery-subpanel', '.recovery-action-block');
.recovery-subpanel-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--fsus-space-3); align-items: safe center; min-inline-size: 0; }
@include panels.headings('.recovery-subpanel');
.recovery-remove-form { display: grid; gap: var(--fsus-space-3); max-inline-size: 28rem; }
.recovery-field { @include fields.account-field; }
.recovery-field label { @include fields.account-label; }
.recovery-inline-start { justify-content: flex-start; }
@media (max-width: 639px) { .recovery-subpanel-row { grid-template-columns: minmax(0, 1fr); justify-items: start; } }
</style>
