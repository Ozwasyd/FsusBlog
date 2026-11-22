<script setup lang="ts">
import { t } from '../siteLocale'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  ElAlert,
  ElButton,
  ElCopyableDetail,
  ElDestructiveActionPanel,
  ElInlineActions,
  ElInput,
  ElRiskNotice,
  ElSettingsSection,
  ElTag,
} from '@ozwasyd/element-plus'
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
  <ElSettingsSection
    v-if="available && currentSession"
    class="site-recovery-key"
    ariaLabelledby="site-recovery-key-heading"
    :description="t('account.message55')"
    density="compact"
  >
    <template #title>
      <span id="site-recovery-key-heading">{{ t('account.message54') }}</span>
    </template>
    <template #actions>
      <ElInlineActions class="recovery-header-actions" density="compact">
        <ElTag v-if="active !== null" size="small" :type="active ? 'success' : 'info'">
          {{ t(active ? 'account.recoveryActiveTag' : 'account.recoveryUnsetTag') }}
        </ElTag>
        <ElButton
          v-if="active !== null && !issued && !removing"
          type="primary"
          native-type="button"
          :loading="busy"
          @click="issue"
        >{{ active ? t('account.message61') : t('account.message62') }}</ElButton>
        <ElButton
          v-else-if="active === null && failure"
          native-type="button"
          :loading="busy"
          @click="refresh"
        >{{ t('account.message63') }}</ElButton>
      </ElInlineActions>
    </template>

    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />

    <div v-if="issued" class="recovery-key-receipt" aria-live="polite">
      <ElRiskNotice type="warning">{{ t('account.message56') }}</ElRiskNotice>
      <ElCopyableDetail :value="issued">
        <span data-testid="site-recovery-key">{{ issued }}</span>
      </ElCopyableDetail>
      <ElInlineActions class="recovery-inline-start" density="compact">
        <ElButton native-type="button" @click="hideKey">{{ t('account.message57') }}</ElButton>
      </ElInlineActions>
    </div>

    <template v-else-if="active">
      <p class="recovery-hint">{{ t('account.message60') }}</p>

      <ElDestructiveActionPanel
        v-if="currentSession.siteSessionId"
        :title="t('account.message43')"
        :description="t('account.message58')"
        density="compact"
      >
        <template v-if="!removing" #actions>
          <ElButton native-type="button" type="danger" plain :disabled="busy" @click="removing = true">
            {{ t('account.message43') }}
          </ElButton>
        </template>

        <form v-if="removing" class="recovery-remove-form" @submit.prevent="removeCurrent">
          <div class="recovery-field">
            <label for="site-passkey-removal-key">{{ t('account.message59') }}</label>
            <ElInput
              id="site-passkey-removal-key"
              v-model="removalKey"
              type="password"
              autocomplete="off"
              v-bind="{ autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' }"
              :disabled="busy"
            />
          </div>
          <ElInlineActions class="recovery-inline-start" density="compact">
            <ElButton
              native-type="submit"
              type="danger"
              :loading="busy"
              :disabled="busy || !validSiteRecoveryKey(removalKey.trim())"
            >{{ t('account.message41') }}</ElButton>
            <ElButton native-type="button" :disabled="busy" @click="closeRemoval">{{ t('account.message39') }}</ElButton>
          </ElInlineActions>
        </form>
      </ElDestructiveActionPanel>
    </template>
  </ElSettingsSection>
</template>

<style scoped>
.site-recovery-key {
  min-width: 0;
}

.recovery-hint {
  margin: 0;
  font-size: var(--el-font-size-small);
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.recovery-key-receipt {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 10px);
  background: var(--el-bg-color);
}

.recovery-remove-form {
  display: grid;
  gap: 10px;
  margin-block-start: 10px;
  max-inline-size: 26rem;
}

.recovery-field {
  display: grid;
  gap: 6px;
  min-inline-size: 0;
}

.recovery-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
  line-height: 1.4;
}

.recovery-inline-start {
  justify-content: flex-start;
}

.recovery-header-actions {
  align-items: center;
}
</style>
