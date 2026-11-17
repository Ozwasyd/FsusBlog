<script setup lang="ts">
import { t } from '../siteLocale'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { beginMfaSetup, completeMfaSetup, disableMfa, mfaProfile, regenerateMfaRecoveryCodes, validMfaFactor, type MfaSetup } from '../../../Contracts/mfa'
import { ApiError } from '../../../Contracts/client'
import { proveMfaSetup } from '../../../Contracts/passkey'
import { currentSession, identityEpoch, refreshSession } from '../session'
import { announceSiteAuthChange, readSiteAuthority, withSiteAuthMutation } from '../site-refresh-coordination'
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

watch(currentSession, async (session, previous) => {
  if (!session || (previous && previous.name !== session.name)) {
    profile.value = null
    setup.value = null
    hideRecoveryCodes()
    code.value = ''
    error.value = ''
  }
  if (!session) return
  const epoch = identityEpoch.value
  try {
    const result = await mfaProfile(lifetime.signal)
    if (!lifetime.signal.aborted && identityEpoch.value === epoch) profile.value = result
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
  <main class="auth-page">
    <h1>{{ t('account.message1') }}</h1>
    <p v-if="!currentSession"><RouterLink to="/login">{{ t('account.message2') }}</RouterLink> {{ t('account.message3') }}</p>
    <section v-else class="auth-form" :aria-label="t('account.message4')">
    <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="profile?.verifiedAt">
      <p>{{ t('account.message5') }}</p>
      <div v-if="recovery.length || regenerated.length">
        <h3>{{ t('account.message6') }}</h3>
        <p>{{ t('account.message7') }}</p>
        <ul><li v-for="item in regenerated.length ? regenerated : recovery" :key="item"><code>{{ item }}</code></li></ul>
        <ElButton native-type="button" @click="hideRecoveryCodes">{{ t('account.message8') }}</ElButton>
      </div>
      <ElButton v-if="!regenerateOpen && !regenerated.length" native-type="button" :disabled="busy" @click="regenerateOpen = true">
        {{ t('account.message9') }}
      </ElButton>
      <form v-else-if="regenerateOpen" class="auth-form" @submit.prevent="regenerate">
        <p>{{ t('account.message10') }}</p>
        <label for="regenerate-mfa-code">{{ t('account.message11') }}</label>
        <ElInput id="regenerate-mfa-code" v-model="regenerateCode" type="password" autocomplete="one-time-code" :disabled="busy" />
        <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!validMfaFactor(regenerateCode)">{{ t('account.message12') }}</ElButton>
        <ElButton native-type="button" :disabled="busy" @click="closeRegeneration">{{ t('account.message13') }}</ElButton>
      </form>
      <form class="auth-form" @submit.prevent="disable">
        <label for="disable-mfa-code">{{ t('account.message14') }}</label>
        <ElInput id="disable-mfa-code" v-model="code" autocomplete="one-time-code" :disabled="busy" />
        <ElButton native-type="submit" :loading="busy" :disabled="!validMfaFactor(code)">{{ t('account.message15') }}</ElButton>
      </form>
    </template>
    <form v-else-if="setup" class="auth-form" @submit.prevent="verify">
      <div>
        <p>{{ t('account.message16') }}</p>
        <code data-testid="mfa-seed">{{ setup.seed }}</code>
      </div>
      <label for="setup-mfa-code">{{ t('account.message17') }}</label>
      <ElInput id="setup-mfa-code" v-model="code" autocomplete="one-time-code" :disabled="busy" />
      <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!/^\d{6}$/.test(code.trim())">{{ t('account.message18') }}</ElButton>
      <ElButton native-type="button" :disabled="busy" @click="setup = null; code = ''">{{ t('account.message19') }}</ElButton>
    </form>
    <ElButton v-else-if="profile" native-type="button" :loading="busy" @click="start">{{ t('account.message20') }}</ElButton>
    <p v-else-if="!error">{{ t('account.message21') }}</p>
    </section>
    <SitePasskeys v-if="currentSession" />
    <SiteRecoveryKey v-if="currentSession" />
    <SiteSessions />
  </main>
</template>
