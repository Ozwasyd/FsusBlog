<script setup lang="ts">
import { t } from '../siteLocale'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ElAlert,
  ElButton,
  ElCopyableDetail,
  ElDangerZone,
  ElEmptyState,
  ElFormSection,
  ElInlineActions,
  ElInput,
  ElRiskNotice,
  ElSettingsSection,
  ElTag,
  ElTaskPageHeader,
} from '@ozwasyd/element-plus'
import { beginMfaSetup, completeMfaSetup, disableMfa, mfaProfile, regenerateMfaRecoveryCodes, validMfaFactor, type MfaSetup } from '../../../Contracts/mfa'
import { ApiError } from '../../../Contracts/client'
import { proveMfaSetup } from '../../../Contracts/passkey'
import { currentSession, identityEpoch, refreshSession } from '../session'
import { announceSiteAuthChange, readSiteAuthority, withSiteAuthMutation } from '../site-refresh-coordination'
import SiteDisplayName from './SiteDisplayName.vue'
import SitePasskeys from './SitePasskeys.vue'
import SiteRecoveryKey from './SiteRecoveryKey.vue'
import SiteSessions from './SiteSessions.vue'

const lifetime = new AbortController()
const profile = ref<{ verifiedAt: Date | null } | null>(null)
const setup = ref<MfaSetup | null>(null)
const recovery = ref<string[]>([])
const regenerated = ref<string[]>([])
const regenerateOpen = ref(false)
const regenerateCode = ref('')
const code = ref('')
const busy = ref(false)
const error = ref('')
let regeneration: AbortController | undefined
let loadedAccountKey = ''

function hideRecoveryCodes() {
  recovery.value = []
  regenerated.value = []
}

function closeRegeneration() {
  regeneration?.abort()
  regeneration = undefined
  regenerateOpen.value = false
  regenerateCode.value = ''
  regenerated.value = []
}

function leavePage() {
  closeRegeneration()
  hideRecoveryCodes()
}

watch(identityEpoch, closeRegeneration, { flush: 'sync' })
onMounted(() => window.addEventListener('pagehide', leavePage))
onUnmounted(() => {
  lifetime.abort()
  window.removeEventListener('pagehide', leavePage)
  leavePage()
})

watch(() => {
  const session = currentSession.value
  return session ? `${session.name}\0${session.generation}` : ''
}, async (accountKey, previousKey) => {
  if (!accountKey || (previousKey && previousKey.split('\0')[0] !== accountKey.split('\0')[0])) {
    profile.value = null
    setup.value = null
    hideRecoveryCodes()
    code.value = ''
    error.value = ''
    loadedAccountKey = ''
  }
  if (!accountKey || accountKey === loadedAccountKey) return
  const epoch = identityEpoch.value
  try {
    const result = await mfaProfile(lifetime.signal)
    if (!lifetime.signal.aborted && identityEpoch.value === epoch) {
      profile.value = result
      loadedAccountKey = accountKey
    }
  } catch (failure) {
    if (lifetime.signal.aborted || identityEpoch.value !== epoch) return
    if (!(failure instanceof ApiError) || failure.status !== 404 && failure.status !== 401)
      error.value = t('account.message22')
  }
}, { immediate: true })

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch { if (!lifetime.signal.aborted) error.value = t('account.message23') }
  finally { if (!lifetime.signal.aborted) busy.value = false }
}

async function start() {
  await run(async () => {
    const epoch = identityEpoch.value
    const proof = await proveMfaSetup(lifetime.signal)
    const pending = await beginMfaSetup(proof, lifetime.signal)
    if (!lifetime.signal.aborted && identityEpoch.value === epoch) setup.value = pending
  })
}

async function verify() {
  if (!setup.value || !/^\d{6}$/.test(code.value.trim())) return
  await run(async () => {
    const epoch = identityEpoch.value
    const entered = code.value.trim()
    const codes = await changeSecuritySession(epoch, signal => completeMfaSetup(entered, signal))
    if (lifetime.signal.aborted || identityEpoch.value !== epoch) return
    recovery.value = codes
    code.value = ''
    setup.value = null
    profile.value = await mfaProfile(lifetime.signal)
    await refreshSession(lifetime.signal, false)
  })
}

async function disable() {
  const method = validMfaFactor(code.value)
  if (!method) return
  await run(async () => {
    const epoch = identityEpoch.value
    await changeSecuritySession(epoch, signal => disableMfa(method, signal))
    if (lifetime.signal.aborted || identityEpoch.value !== epoch) return
    code.value = ''
    hideRecoveryCodes()
    profile.value = await mfaProfile(lifetime.signal)
    await refreshSession(lifetime.signal, false)
  })
}

async function regenerate() {
  const factor = validMfaFactor(regenerateCode.value)
  const expected = currentSession.value?.siteSessionId
  if (busy.value || !factor || !expected || !profile.value?.verifiedAt) return
  const epoch = identityEpoch.value
  const request = new AbortController()
  const signal = AbortSignal.any([request.signal, lifetime.signal])
  regeneration = request
  const isLive = () => !signal.aborted && identityEpoch.value === epoch && currentSession.value?.siteSessionId === expected
  busy.value = true
  error.value = ''
  regenerateCode.value = ''
  hideRecoveryCodes()
  try {
    const codes = await withSiteAuthMutation(signal, async () => {
      const current = await readSiteAuthority(signal)
      if (!isLive() || current?.siteSessionId !== expected) throw new ApiError('The current browser session changed.', 409)
      const issued = await regenerateMfaRecoveryCodes(factor, expected, signal)
      if (!isLive() || (await readSiteAuthority(signal))?.siteSessionId !== expected)
        throw new ApiError('The current browser session changed.', 409)
      return issued
    })
    if (!isLive()) return
    regenerateOpen.value = false
    regenerated.value = codes
  } catch {
    if (isLive()) error.value = t('account.message24')
  } finally {
    if (regeneration === request) regeneration = undefined
    if (!lifetime.signal.aborted) busy.value = false
  }
}

function changeSecuritySession<T>(epoch: number, change: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const expected = currentSession.value?.siteSessionId
  const signal = lifetime.signal
  return withSiteAuthMutation(signal, async () => {
    signal.throwIfAborted()
    const current = await readSiteAuthority(signal)
    if (identityEpoch.value !== epoch || !expected || current?.siteSessionId !== expected)
      throw new ApiError('The current browser session changed.', 409)
    const result = await change(signal)
    announceSiteAuthChange()
    return result
  })
}
</script>

<template>
  <main class="account-security">
    <ElTaskPageHeader
      :title="t('account.message1')"
      :description="t('account.securitySummary')"
      density="compact"
    />

    <ElEmptyState v-if="!currentSession" size="compact" :title="t('account.message1')">
      <p class="security-signed-out">
        <RouterLink to="/login">{{ t('account.message2') }}</RouterLink> {{ t('account.message3') }}
      </p>
    </ElEmptyState>

    <div v-else class="account-security-sections">
      <SiteDisplayName />
      <ElSettingsSection
        ariaLabelledby="account-mfa-heading"
        :description="profile?.verifiedAt ? t('account.message5') : undefined"
        density="compact"
      >
        <template #title>
          <span id="account-mfa-heading">{{ t('account.mfaSection') }}</span>
        </template>
        <template #actions>
          <ElInlineActions class="security-header-actions" density="compact">
            <ElTag v-if="profile?.verifiedAt" size="small" type="success">{{ t('account.mfaEnabledTag') }}</ElTag>
            <ElButton
              v-if="profile?.verifiedAt && !regenerateOpen && !regenerated.length"
              native-type="button"
              :disabled="busy"
              @click="regenerateOpen = true"
            >{{ t('account.message9') }}</ElButton>
            <ElButton
              v-else-if="profile && !profile.verifiedAt && !setup"
              native-type="button"
              type="primary"
              :loading="busy"
              @click="start"
            >{{ t('account.message20') }}</ElButton>
          </ElInlineActions>
        </template>

        <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />

        <template v-if="profile?.verifiedAt">
          <div v-if="recovery.length || regenerated.length" class="security-receipt" aria-live="polite">
            <h3 class="security-receipt-title">{{ t('account.message6') }}</h3>
            <ElRiskNotice type="warning">{{ t('account.message7') }}</ElRiskNotice>
            <ul class="recovery-code-grid" role="list">
              <li v-for="item in regenerated.length ? regenerated : recovery" :key="item"><code>{{ item }}</code></li>
            </ul>
            <ElInlineActions class="security-inline-start" density="compact">
              <ElButton native-type="button" @click="hideRecoveryCodes">{{ t('account.message8') }}</ElButton>
            </ElInlineActions>
          </div>

          <ElFormSection v-if="regenerateOpen" density="compact">
            <ElRiskNotice type="warning">{{ t('account.message10') }}</ElRiskNotice>
            <form class="security-form" @submit.prevent="regenerate">
              <div class="security-field">
                <label for="regenerate-mfa-code">{{ t('account.message11') }}</label>
                <ElInput
                  id="regenerate-mfa-code"
                  v-model="regenerateCode"
                  type="password"
                  autocomplete="one-time-code"
                  v-bind="{ autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' }"
                  :disabled="busy"
                />
              </div>
              <ElInlineActions class="security-inline-start" density="compact">
                <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!validMfaFactor(regenerateCode)">
                  {{ t('account.message12') }}
                </ElButton>
                <ElButton native-type="button" :disabled="busy" @click="closeRegeneration">
                  {{ t('account.message13') }}
                </ElButton>
              </ElInlineActions>
            </form>
          </ElFormSection>

          <ElDangerZone :title="t('account.mfaDangerTitle')" title-tag="h3" density="compact">
            <form class="security-form" @submit.prevent="disable">
              <div class="security-field">
                <label for="disable-mfa-code">{{ t('account.message14') }}</label>
                <ElInput
                  id="disable-mfa-code"
                  v-model="code"
                  autocomplete="one-time-code"
                  v-bind="{ autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' }"
                  :disabled="busy"
                />
              </div>
              <ElInlineActions class="security-inline-start" density="compact">
                <ElButton native-type="submit" type="danger" plain :loading="busy" :disabled="!validMfaFactor(code)">
                  {{ t('account.message15') }}
                </ElButton>
              </ElInlineActions>
            </form>
          </ElDangerZone>
        </template>

        <ElFormSection v-else-if="setup" density="compact">
          <p class="security-hint">{{ t('account.message16') }}</p>
          <ElCopyableDetail :value="setup.seed">
            <span data-testid="mfa-seed">{{ setup.seed }}</span>
          </ElCopyableDetail>
          <form class="security-form" @submit.prevent="verify">
            <div class="security-field">
              <label for="setup-mfa-code">{{ t('account.message17') }}</label>
              <ElInput
                id="setup-mfa-code"
                v-model="code"
                autocomplete="one-time-code"
                v-bind="{ inputmode: 'numeric', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' }"
                :disabled="busy"
              />
            </div>
            <ElInlineActions class="security-inline-start" density="compact">
              <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!/^\d{6}$/.test(code.trim())">
                {{ t('account.message18') }}
              </ElButton>
              <ElButton native-type="button" :disabled="busy" @click="setup = null; code = ''">
                {{ t('account.message19') }}
              </ElButton>
            </ElInlineActions>
          </form>
        </ElFormSection>

        <p v-else-if="!profile && !error" class="security-muted">{{ t('account.message21') }}</p>
      </ElSettingsSection>

      <SitePasskeys />
      <SiteRecoveryKey />
      <SiteSessions />
    </div>
  </main>
</template>

<style scoped>
.account-security {
  display: grid;
  gap: var(--fsus-space-5);
  min-width: 0;
}

.account-security-sections {
  display: grid;
  gap: var(--fsus-space-5);
  min-width: 0;
}

.security-signed-out,
.security-hint,
.security-muted {
  margin: 0;
  font-size: var(--el-font-size-base);
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.security-receipt {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 10px);
  background: var(--el-bg-color);
}

.security-receipt-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--el-text-color-primary);
}

.recovery-code-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.recovery-code-grid li {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--el-fill-color-lighter);
  font-family: var(--el-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--el-font-size-small);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  user-select: all;
}

.security-form {
  display: grid;
  gap: 12px;
  max-inline-size: 26rem;
}

.security-field {
  display: grid;
  gap: 6px;
  min-inline-size: 0;
}

.security-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
  line-height: 1.4;
}

.security-inline-start {
  justify-content: flex-start;
}

.security-header-actions {
  align-items: center;
}
</style>
