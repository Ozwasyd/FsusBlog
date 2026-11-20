<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { WireLimits } from '../../../Contracts/wire.generated'
import { readAdminAuthority } from '../../../Contracts/admin-identity'
import { passkeyAvailable } from '../../../Contracts/passkey'
import { readerRegistrationAvailable } from '../../../Contracts/reader-registration'
import { validMfaFactor } from '../../../Contracts/mfa'
import { siteRefreshAvailable } from '../../../Contracts/site-refresh'
import { markAdminSessionHint } from '../authorSession'
import { cancelMfaLogin, currentSession, registerFirstPasskey, signInWithMfa, signInWithPasskey } from '../session'
import SiteRecoveryLogin from './SiteRecoveryLogin.vue'

function safeRedirect(raw: unknown, role: 'admin' | 'reader'): string | null {
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : ''
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  const isAdminPath = value === '/admin' || value.startsWith('/admin/')
  if (role === 'admin') return isAdminPath ? value : null
  return !isAdminPath && value !== '/login' && value !== '/register' ? value : null
}

const route = useRoute()
const router = useRouter()
const setupOpen = ref(false)
const ticket = ref('')
const validTicket = computed(() => /^[A-Za-z0-9_-]+$/.test(ticket.value.trim()) && ticket.value.trim().length <= WireLimits.TicketBytes)
const busy = ref(false)
const recoveryBusy = ref(false)
const recoveryAvailable = ref(false)
const recoveryOpen = ref(false)
const recoveryRef = ref<InstanceType<typeof SiteRecoveryLogin>>()
const failure = ref<MessageKey | ''>('')
const registered = ref(false)
const checkingPasskeys = ref(true)
const hasPasskeys = ref(false)
const canRegister = ref(false)
const hasPersistentPasskeys = ref(false)
const rememberMe = ref(false)
const adminActive = ref(false)
const pending = ref<string | null>(null)
const factor = ref('')
const lifetime = new AbortController()
const adminRedirect = computed(() => safeRedirect(route.query.redirect, 'admin'))
const readerRedirect = computed(() => safeRedirect(route.query.redirect, 'reader'))
const wantsAdmin = computed(() => adminRedirect.value !== null)
const alreadySignedIn = computed(() => wantsAdmin.value ? adminActive.value : Boolean(currentSession.value || adminActive.value))

onUnmounted(() => {
  lifetime.abort()
  if (pending.value) cancelMfaLogin(pending.value)
})
onMounted(async () => {
  void readAdminAuthority(lifetime.signal).then(authority => {
    if (lifetime.signal.aborted) return
    adminActive.value = authority.status === 'active'
    markAdminSessionHint(adminActive.value)
  }).catch(() => {})
  try { hasPasskeys.value = await passkeyAvailable(lifetime.signal) }
  catch { hasPasskeys.value = false }
  finally { checkingPasskeys.value = false }
  if (!hasPasskeys.value || lifetime.signal.aborted) return
  void readerRegistrationAvailable(lifetime.signal).then(available => {
    if (!lifetime.signal.aborted) canRegister.value = available
  }).catch(() => {})
  try {
    const available = await siteRefreshAvailable(lifetime.signal)
    if (!lifetime.signal.aborted) hasPersistentPasskeys.value = available
  } catch { hasPersistentPasskeys.value = false }
})

function toggleRecovery() {
  if (recoveryOpen.value) {
    recoveryRef.value?.clearRecovery()
    return
  }
  setupOpen.value = false
  ticket.value = ''
  failure.value = ''
  recoveryRef.value?.openRecovery()
}

function toggleSetup() {
  const next = !setupOpen.value
  if (next) recoveryRef.value?.clearRecovery()
  setupOpen.value = next
  ticket.value = ''
  failure.value = ''
}

async function usePasskey(register: boolean) {
  if (!hasPasskeys.value || busy.value || recoveryBusy.value || (register && (!setupOpen.value || !validTicket.value))) return
  busy.value = true
  failure.value = ''
  registered.value = false
  try {
    if (register) {
      const oneTimeKey = ticket.value.trim()
      ticket.value = ''
      await registerFirstPasskey(oneTimeKey, lifetime.signal)
      if (!lifetime.signal.aborted) {
        setupOpen.value = false
        registered.value = true
      }
    } else {
      const result = await signInWithPasskey(lifetime.signal, hasPersistentPasskeys.value && rememberMe.value)
      if (lifetime.signal.aborted) return
      if (result.kind === 'mfa') {
        pending.value = result.token
      } else if (result.kind === 'admin') {
        adminActive.value = true
        await router.replace(adminRedirect.value ?? { name: 'admin-site' })
      } else if (result.kind === 'reader' && currentSession.value) {
        await router.replace(readerRedirect.value ?? { name: 'security' })
      }
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
      await router.replace(readerRedirect.value ?? { name: 'security' })
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
  <div v-if="alreadySignedIn" class="signed-in-links">
    <RouterLink v-if="adminActive" :to="adminRedirect ?? '/admin/site'">{{ t('login.adminWorkspace') }}</RouterLink>
    <RouterLink v-if="currentSession" :to="readerRedirect ?? '/user/identity/mfa'">{{ t('login.security') }}</RouterLink>
  </div>
  <form v-else-if="pending" class="auth-form" @submit.prevent="verifyFactor">
    <label for="login-factor">{{ t('login.factor') }}</label>
    <ElInput id="login-factor" v-model="factor" autocomplete="one-time-code" :disabled="busy" />
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!validMfaFactor(factor)">{{ t('login.verify') }}</ElButton>
    <ElButton native-type="button" :disabled="busy" @click="cancelFactor">{{ t('login.restart') }}</ElButton>
  </form>
  <template v-else>
    <div class="auth-form">
      <p v-if="checkingPasskeys" role="status">{{ t('login.checkingPasskeys') }}</p>
      <template v-else>
        <ElButton native-type="button" size="large" type="primary" :loading="busy && !setupOpen"
          :disabled="!hasPasskeys || busy || recoveryBusy" @click="usePasskey(false)">
          {{ t('login.passkey') }}
        </ElButton>
        <p v-if="!hasPasskeys" class="muted" role="status">{{ t('login.passkeyUnavailable') }}</p>
        <ElCheckbox v-if="hasPersistentPasskeys" :model-value="rememberMe" :disabled="busy || recoveryBusy"
          @update:model-value="rememberMe = $event === true">
          {{ t('login.remember') }}
        </ElCheckbox>
        <ElAlert v-if="registered" :title="t('login.created')" type="success" :closable="false" show-icon />
        <ElAlert v-if="failure && failure !== 'login.createFailed'" :title="t(failure)" type="error" :closable="false" show-icon />
      </template>
    </div>
    <div v-if="hasPasskeys && (recoveryAvailable || !registered)" class="login-secondary-actions">
      <ElButton v-if="recoveryAvailable" text native-type="button" class="login-secondary-trigger"
        :disabled="busy || recoveryBusy" v-bind="{ 'aria-expanded': recoveryOpen }" @click="toggleRecovery">
        {{ t('login.recovery.open') }}
      </ElButton>
      <ElButton v-if="!registered" text native-type="button" class="login-secondary-trigger"
        :disabled="busy || recoveryBusy" v-bind="{ 'aria-expanded': setupOpen }" @click="toggleSetup">
        {{ t('login.openSetup') }}
      </ElButton>
    </div>
    <SiteRecoveryLogin v-if="hasPasskeys" ref="recoveryRef" hide-trigger :disabled="busy"
      @busy="recoveryBusy = $event" @available="recoveryAvailable = $event" @open="recoveryOpen = $event" />
    <div v-if="hasPasskeys && !registered && setupOpen" class="passkey-setup">
      <form class="passkey-setup-form" @submit.prevent="usePasskey(true)">
        <p>{{ t('login.setupHelp') }}</p>
        <label for="passkey-setup-ticket">{{ t('login.setupTicket') }}</label>
        <ElInput id="passkey-setup-ticket" v-model="ticket" type="password" autocomplete="off" :disabled="busy || recoveryBusy" />
        <ElAlert v-if="failure === 'login.createFailed'" :title="t(failure)" type="error" :closable="false" show-icon />
        <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!validTicket || recoveryBusy">
          {{ t('login.createPasskey') }}
        </ElButton>
      </form>
    </div>
  </template>
  <div class="auth-footer login-footer">
    <RouterLink to="/">{{ t('login.cancel') }}</RouterLink>
    <RouterLink v-if="canRegister && !pending && !alreadySignedIn" :to="{ name: 'register' }">{{ t('page.register') }}</RouterLink>
  </div>
</template>

<style scoped>
.signed-in-links { display: flex; flex-wrap: wrap; gap: .75rem 1.25rem; margin-block: 1rem; }
.signed-in-links a { display: inline-flex; align-items: center; min-block-size: 44px; font-weight: 500; }
.login-footer { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .5rem 1rem; }
.login-footer a { display: inline-flex; align-items: center; min-block-size: 44px; color: var(--el-text-color-secondary); }
.login-footer a:hover { color: var(--el-text-color-primary); }
.login-secondary-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: .25rem 1rem;
  margin-block: 1rem 1.25rem;
}
.login-secondary-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
.login-secondary-trigger { min-block-size: 44px; padding-inline: .5rem; margin-inline: -.5rem; }
.passkey-setup { margin-block: 0 1.5rem; }
.passkey-setup-form { display: grid; gap: .75rem; }
.passkey-setup-form p { margin-block: .25rem; }
</style>
