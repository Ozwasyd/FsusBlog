<script setup lang="ts">
import { t } from '../siteLocale'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ElAlert,
  ElButton,
  ElCopyableDetail,
  ElEmptyState,
  ElInlineActions,
  ElInput,
  ElRiskNotice,
  ElTag,
  ElTaskPageHeader,
} from '@ozwasyd/element-plus'
import { beginMfaSetup, completeMfaSetup, disableMfa, mfaProfile, regenerateMfaRecoveryCodes, validMfaFactor, type MfaSetup } from '../../../Contracts/mfa'
import { ApiError } from '../../../Contracts/client'
import { proveMfaSetup } from '../../../Contracts/passkey'
import { currentSession, identityEpoch, refreshSession } from '../session'
import { announceSiteAuthChange, readSiteAuthority, withSiteAuthMutation } from '../site-refresh-coordination'
import SecuritySectionCard from '../components/SecuritySectionCard.vue'
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

    <div v-if="!currentSession" class="security-empty-surface">
      <ElEmptyState size="compact" :title="t('account.message113')">
        <p class="security-signed-out">
          <RouterLink class="security-login-link" to="/login">{{ t('account.message2') }}</RouterLink>
          {{ ' ' }}{{ t('account.message3') }}
        </p>
      </ElEmptyState>
    </div>

    <div v-else class="account-security-sections">
      <SiteDisplayName />

      <SecuritySectionCard
        heading-id="account-mfa-heading"
        :title="t('account.mfaSection')"
        :description="profile?.verifiedAt ? t('account.message5') : profile ? t('account.mfaDisabledSummary') : undefined"
        :has-body="Boolean(error || profile?.verifiedAt || setup || (!profile && !error))"
      >
        <template #badge>
          <ElTag v-if="profile?.verifiedAt" size="small" type="success" disable-transitions>
            {{ t('account.mfaEnabledTag') }}
          </ElTag>
          <ElTag v-else-if="profile" size="small" type="info" disable-transitions>
            {{ t('account.mfaDisabledTag') }}
          </ElTag>
        </template>

        <template v-if="(profile?.verifiedAt && !regenerateOpen && !regenerated.length) || (profile && !profile.verifiedAt && !setup)" #actions>
          <ElButton
            v-if="profile?.verifiedAt && !regenerateOpen && !regenerated.length"
            :disabled="busy"
            @click="regenerateOpen = true"
          >{{ t('account.message9') }}</ElButton>
          <ElButton
            v-else-if="profile && !profile.verifiedAt && !setup"
            :loading="busy"
            @click="start"
          >{{ t('account.message20') }}</ElButton>
        </template>

        <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />

        <template v-if="profile?.verifiedAt">
          <div v-if="recovery.length || regenerated.length" class="security-subpanel" aria-live="polite">
            <h3 class="security-subpanel-title">{{ t('account.message6') }}</h3>
            <ElRiskNotice type="warning">{{ t('account.message7') }}</ElRiskNotice>
            <ul class="recovery-code-grid" role="list">
              <li v-for="item in regenerated.length ? regenerated : recovery" :key="item"><code>{{ item }}</code></li>
            </ul>
            <ElInlineActions class="security-inline-start" density="compact">
              <ElButton @click="hideRecoveryCodes">{{ t('account.message8') }}</ElButton>
            </ElInlineActions>
          </div>

          <div v-if="regenerateOpen" class="security-subpanel">
            <ElRiskNotice type="warning">{{ t('account.message10') }}</ElRiskNotice>
            <form class="security-form" @submit.prevent="regenerate">
              <div class="security-field">
                <label for="regenerate-mfa-code">{{ t('account.message11') }}</label>
                <ElInput
                  id="regenerate-mfa-code"
                  v-model="regenerateCode"
                  type="password"
                  autocomplete="one-time-code"
                  v-bind="{ autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'done' }"
                  :disabled="busy"
                />
              </div>
              <ElInlineActions class="security-inline-start" density="compact">
                <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!validMfaFactor(regenerateCode)">
                  {{ t('account.message12') }}
                </ElButton>
                <ElButton :disabled="busy" @click="closeRegeneration">
                  {{ t('account.message13') }}
                </ElButton>
              </ElInlineActions>
            </form>
          </div>

          <div class="security-disable-block">
            <div class="security-subpanel-head">
              <h3 id="disable-mfa-heading" class="security-subpanel-title">{{ t('account.mfaDangerTitle') }}</h3>
              <p id="disable-mfa-hint" class="security-subpanel-copy">{{ t('account.mfaDisableSummary') }}</p>
            </div>
            <form class="security-inline-form" aria-labelledby="disable-mfa-heading" @submit.prevent="disable">
              <div class="security-field">
                <label for="disable-mfa-code">{{ t('account.message14') }}</label>
                <div class="security-inline-row">
                  <ElInput
                    id="disable-mfa-code"
                    v-model="code"
                    autocomplete="one-time-code"
                    v-bind="{
                      autocorrect: 'off',
                      autocapitalize: 'none',
                      spellcheck: 'false',
                      enterkeyhint: 'done',
                      'aria-describedby': 'disable-mfa-hint',
                    }"
                    :disabled="busy"
                  />
                  <ElButton native-type="submit" type="danger" plain :loading="busy" :disabled="!validMfaFactor(code)">
                    {{ t('account.message15') }}
                  </ElButton>
                </div>
              </div>
            </form>
          </div>
        </template>

        <div v-else-if="setup" class="security-subpanel">
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
                v-bind="{ inputmode: 'numeric', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'done' }"
                :disabled="busy"
              />
            </div>
            <ElInlineActions class="security-inline-start" density="compact">
              <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!/^\d{6}$/.test(code.trim())">
                {{ t('account.message18') }}
              </ElButton>
              <ElButton :disabled="busy" @click="setup = null; code = ''">
                {{ t('account.message19') }}
              </ElButton>
            </ElInlineActions>
          </form>
        </div>

        <p v-else-if="!profile && !error" class="security-muted">{{ t('account.message21') }}</p>
      </SecuritySectionCard>

      <SitePasskeys />
      <SiteRecoveryKey />
      <SiteSessions />
    </div>
  </main>
</template>

<style scoped lang="scss">
@use '../security-panels' as panels;
@use '../shared-fields' as fields;

.account-security {
  display: grid;
  align-content: start;
  gap: var(--fsus-space-4);
  min-inline-size: 0;
}

.account-security-sections {
  display: grid;
  gap: var(--fsus-space-4);
  min-inline-size: 0;
}

.security-empty-surface {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--el-bg-color);
  padding: var(--fsus-space-5);
}

.security-signed-out,
.security-hint,
.security-muted {
  margin: 0;
  font-size: var(--el-font-size-small);
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.security-login-link {
  color: var(--fsus-scholarly-blue);
  font-weight: 500;
  text-decoration: none;
}

.security-login-link:hover {
  text-decoration: underline;
  text-underline-offset: 4px;
}

@include panels.surface('.security-subpanel', '.security-disable-block');

.security-subpanel + .security-disable-block {
  padding-block-start: var(--fsus-space-3);
  border-block-start: 1px solid var(--el-border-color-lighter);
}

@include panels.headings('.security-subpanel');

.recovery-code-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--fsus-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.recovery-code-grid li {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--el-bg-color);
  font-family: var(--el-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--el-font-size-small);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  user-select: all;
}

.security-form {
  display: grid;
  gap: var(--fsus-space-3);
  max-inline-size: 28rem;
}

.security-inline-form {
  display: grid;
  gap: var(--fsus-space-2);
  max-inline-size: 32rem;
}

.security-field {

  @include fields.account-field;
}

.security-field label {

  @include fields.account-label;
}

.security-inline-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: safe center;
  gap: var(--fsus-space-2);
}

.security-inline-start {
  justify-content: flex-start;
}

@media (max-width: 30rem) {
  .security-inline-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
