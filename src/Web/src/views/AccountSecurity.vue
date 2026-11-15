<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { beginMfaSetup, completeMfaSetup, disableMfa, mfaProfile, regenerateMfaRecoveryCodes, validMfaFactor, type MfaSetup } from '../../../Contracts/mfa'
import { ApiError } from '../../../Contracts/client'
import { proveMfaSetup } from '../../../Contracts/passkey'
import { currentSession, identityEpoch, refreshSession } from '../session'
import { announceSiteAuthChange, readSiteAuthority, withSiteAuthMutation } from '../site-refresh-coordination'
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
      error.value = 'Could not load account security.'
  }
}, { immediate: true })

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch { if (!lifetime.signal.aborted) error.value = 'Could not verify your request. Use a fresh code and try again.' }
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
    if (isLive()) error.value = 'Could not replace recovery codes. Use a fresh code and try again.'
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
    <h1>Account security</h1>
    <p v-if="!currentSession"><RouterLink to="/login">Log in</RouterLink> to manage account security.</p>
    <section v-else class="auth-form" aria-label="Account security settings">
    <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="profile?.verifiedAt">
      <p>Authenticator verification is enabled.</p>
      <div v-if="recovery.length || regenerated.length">
        <h3>Recovery codes</h3>
        <p>Save these one-use codes in a safe place. They are shown only once.</p>
        <ul><li v-for="item in regenerated.length ? regenerated : recovery" :key="item"><code>{{ item }}</code></li></ul>
        <ElButton native-type="button" @click="hideRecoveryCodes">Hide recovery codes</ElButton>
      </div>
      <ElButton v-if="!regenerateOpen && !regenerated.length" native-type="button" :disabled="busy" @click="regenerateOpen = true">
        Regenerate recovery codes
      </ElButton>
      <form v-else-if="regenerateOpen" class="auth-form" @submit.prevent="regenerate">
        <p>Replacing recovery codes invalidates all previously saved codes.</p>
        <label for="regenerate-mfa-code">Authenticator or recovery code to regenerate</label>
        <ElInput id="regenerate-mfa-code" v-model="regenerateCode" type="password" autocomplete="one-time-code" :disabled="busy" />
        <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!validMfaFactor(regenerateCode)">Replace recovery codes</ElButton>
        <ElButton native-type="button" :disabled="busy" @click="closeRegeneration">Cancel regeneration</ElButton>
      </form>
      <form class="auth-form" @submit.prevent="disable">
        <label for="disable-mfa-code">Authenticator or recovery code</label>
        <ElInput id="disable-mfa-code" v-model="code" autocomplete="one-time-code" :disabled="busy" />
        <ElButton native-type="submit" :loading="busy" :disabled="!validMfaFactor(code)">Disable authenticator verification</ElButton>
      </form>
    </template>
    <form v-else-if="setup" class="auth-form" @submit.prevent="verify">
      <div>
        <p>Enter this secret manually in your authenticator app.</p>
        <code data-testid="mfa-seed">{{ setup.seed }}</code>
      </div>
      <label for="setup-mfa-code">Authenticator code</label>
      <ElInput id="setup-mfa-code" v-model="code" autocomplete="one-time-code" :disabled="busy" />
      <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!/^\d{6}$/.test(code.trim())">Enable verification</ElButton>
      <ElButton native-type="button" :disabled="busy" @click="setup = null; code = ''">Cancel setup</ElButton>
    </form>
    <ElButton v-else-if="profile" native-type="button" :loading="busy" @click="start">Set up authenticator</ElButton>
    <p v-else-if="!error">Authenticator verification is unavailable for this session.</p>
    </section>
    <SiteRecoveryKey v-if="currentSession" />
    <SiteSessions />
  </main>
</template>
