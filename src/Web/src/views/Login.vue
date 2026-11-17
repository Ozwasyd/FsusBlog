<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { WireLimits } from '../../../Contracts/wire.generated'
import { ApiError } from '../../../Contracts/client'
import { passkeyAvailable } from '../../../Contracts/passkey'
import { validMfaFactor } from '../../../Contracts/mfa'
import { siteRefreshAvailable } from '../../../Contracts/site-refresh'
import { cancelMfaLogin, currentSession, registerFirstPasskey, signIn, signInWithMfa, signInWithPasskey } from '../session'
import SiteRecoveryLogin from './SiteRecoveryLogin.vue'

const ticket = ref('')
const validTicket = computed(() => /^[A-Za-z0-9_-]+$/.test(ticket.value.trim()) && ticket.value.trim().length <= WireLimits.TicketBytes)
const busy = ref(false)
const recoveryBusy = ref(false)
const failure = ref<MessageKey | ''>('')
const registered = ref(false)
const hasPasskeys = ref(false)
const hasPersistentPasskeys = ref(false)
const rememberMe = ref(false)
const pending = ref<string | null>(null)
const factor = ref('')
const canContinue = computed(() => currentSession.value?.canAuthor)
const router = useRouter()
const lifetime = new AbortController()
onUnmounted(() => {
  lifetime.abort()
  if (pending.value) cancelMfaLogin(pending.value)
})
onMounted(async () => {
  try { hasPasskeys.value = await passkeyAvailable(lifetime.signal) }
  catch { hasPasskeys.value = false }
  if (!hasPasskeys.value || lifetime.signal.aborted) return
  try {
    const available = await siteRefreshAvailable(lifetime.signal)
    if (!lifetime.signal.aborted) hasPersistentPasskeys.value = available
  } catch { hasPersistentPasskeys.value = false }
})

async function submit() {
  if (busy.value || recoveryBusy.value || !validTicket.value) return
  busy.value = true
  failure.value = ''
  registered.value = false
  try {
    await signIn(ticket.value.trim(), lifetime.signal)
    if (!lifetime.signal.aborted && currentSession.value) {
      await router.replace({ name: 'write' })
    }
  } catch (error) {
    if (!lifetime.signal.aborted) {
      failure.value = error instanceof ApiError && error.status === 401
        ? 'login.keyRejected'
        : 'login.failed'
    }
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}

async function usePasskey(register: boolean) {
  if (busy.value || recoveryBusy.value || (register && !validTicket.value)) return
  busy.value = true
  failure.value = ''
  registered.value = false
  try {
    if (register) {
      const oneTimeKey = ticket.value.trim()
      ticket.value = ''
      await registerFirstPasskey(oneTimeKey, lifetime.signal)
      if (!lifetime.signal.aborted) registered.value = true
    } else {
      pending.value = await signInWithPasskey(lifetime.signal, hasPersistentPasskeys.value && rememberMe.value)
      if (!lifetime.signal.aborted && currentSession.value)
        await router.replace({ name: currentSession.value.canAuthor ? 'write' : 'home' })
    }
  } catch {
    if (!lifetime.signal.aborted)
      failure.value = register ? 'login.createFailed' : 'login.passkeyFailed'
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}
async function verifyFactor() {
  const method = validMfaFactor(factor.value)
  if (busy.value || !pending.value || !method) return
  busy.value = true
  failure.value = ''
  try {
    await signInWithMfa(pending.value, method, lifetime.signal)
    if (!lifetime.signal.aborted && currentSession.value) {
      factor.value = ''
      pending.value = null
      await router.replace({ name: currentSession.value.canAuthor ? 'write' : 'home' })
    }
  } catch {
    if (!lifetime.signal.aborted) failure.value = 'login.factorFailed'
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}

function cancelFactor() {
  if (pending.value) cancelMfaLogin(pending.value)
  pending.value = null
  factor.value = ''
  failure.value = ''
}
</script>

<template>
  <div class="auth-heading">
    <h1>{{ t('page.login') }}</h1>
    <p>{{ t('login.subtitle') }}</p>
  </div>
  <template v-if="currentSession">
    <p v-if="canContinue"><RouterLink :to="{ name: 'write' }">{{ t('login.continue') }}</RouterLink></p>
    <RouterLink to="/user/identity/mfa">{{ t('login.security') }}</RouterLink>
  </template>
  <form v-else-if="pending" class="auth-form" @submit.prevent="verifyFactor">
    <label for="login-factor">{{ t('login.factor') }}</label>
    <ElInput id="login-factor" v-model="factor" autocomplete="one-time-code" :disabled="busy" />
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!validMfaFactor(factor)">{{ t('login.verify') }}</ElButton>
    <ElButton native-type="button" :disabled="busy" @click="cancelFactor">{{ t('login.restart') }}</ElButton>
  </form>
  <form v-else class="auth-form" @submit.prevent="submit">
    <ElButton v-if="hasPasskeys" native-type="button" size="large" :disabled="busy || recoveryBusy" @click="usePasskey(false)">
      {{ t('login.passkey') }}
    </ElButton>
    <ElCheckbox v-if="hasPersistentPasskeys" :model-value="rememberMe" :disabled="busy || recoveryBusy"
      @update:model-value="rememberMe = $event === true">
      {{ t('login.remember') }}
    </ElCheckbox>
    <ElAlert v-if="registered" :title="t('login.created')" type="success" :closable="false" show-icon />
    <label for="owner-key">{{ t('login.ownerKey') }}</label>
    <ElInput
      id="owner-key"
      v-model="ticket"
      type="password"
      autocomplete="current-password"
      size="large"
      :disabled="busy || recoveryBusy"
    />
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <ElButton native-type="submit" size="large" type="primary" :loading="busy" :disabled="!validTicket || recoveryBusy">
      {{ t('page.login') }}
    </ElButton>
    <ElButton v-if="hasPasskeys" native-type="button" size="large" :disabled="busy || recoveryBusy || !validTicket" @click="usePasskey(true)">
      {{ t('login.createPasskey') }}
    </ElButton>
  </form>
  <SiteRecoveryLogin v-if="!currentSession && !pending" :disabled="busy" @busy="recoveryBusy = $event" />
  <div class="auth-footer"><RouterLink to="/">{{ t('login.cancel') }}</RouterLink></div>
</template>
