<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import {
  bootstrapAdminPasskey,
  readAdminAuthority,
  signInAdmin,
  signOutAdmin,
  validAdminBootstrapToken,
  type AdminAuthority,
} from '../../../Contracts/admin-identity'

const lifetime = new AbortController()
const authority = shallowRef<AdminAuthority | null>(null)
const bootstrapOpen = ref(false)
const ticket = ref('')
const ticketValid = computed(() => validAdminBootstrapToken(ticket.value.trim()))
const canUsePasskeys = globalThis.isSecureContext && typeof PublicKeyCredential === 'function'
const busy = ref(false)
const failure = ref('')
const notice = ref('')
let expiryTimer: ReturnType<typeof setTimeout> | undefined

function setAuthority(next: AdminAuthority | null) {
  clearTimeout(expiryTimer)
  if (next?.status === 'active') {
    const remaining = next.session.expiresAt - Date.now()
    if (remaining <= 0) {
      authority.value = { status: 'signed-out' }
      return
    }
    expiryTimer = setTimeout(() => setAuthority(next), Math.min(remaining, 2_147_483_647))
    closeBootstrap()
  }
  authority.value = next
}

async function run(task: () => Promise<void>, onFailure: string) {
  if (busy.value || lifetime.signal.aborted) return
  busy.value = true
  failure.value = ''
  try { await task() }
  catch { if (!lifetime.signal.aborted) failure.value = onFailure }
  finally { if (!lifetime.signal.aborted) busy.value = false }
}

function refresh() {
  return run(async () => {
    setAuthority(null)
    const next = await readAdminAuthority(lifetime.signal)
    if (!lifetime.signal.aborted) setAuthority(next)
  }, 'Could not check administrator access. Try again.')
}

function whenVisible() {
  if (document.visibilityState === 'visible') void refresh()
}

onMounted(() => {
  void refresh()
  document.addEventListener('visibilitychange', whenVisible)
})
onUnmounted(() => {
  lifetime.abort()
  clearTimeout(expiryTimer)
  document.removeEventListener('visibilitychange', whenVisible)
})

function closeBootstrap() {
  bootstrapOpen.value = false
  ticket.value = ''
}

function enroll() {
  if (authority.value?.status !== 'signed-out' || !canUsePasskeys || !ticketValid.value) return
  return run(async () => {
    notice.value = ''
    const key = ticket.value.trim()
    ticket.value = ''
    await bootstrapAdminPasskey(key, lifetime.signal)
    if (lifetime.signal.aborted) return
    closeBootstrap()
    notice.value = 'Administrator Passkey created. Log in with it to continue.'
  }, 'Could not create the administrator Passkey. Check your one-time key and try again.')
}

function logIn() {
  if (authority.value?.status !== 'signed-out' || !canUsePasskeys) return
  return run(async () => {
    notice.value = ''
    closeBootstrap()
    const session = await signInAdmin(lifetime.signal)
    if (!lifetime.signal.aborted) setAuthority({ status: 'active', session })
  }, 'Could not log in with this administrator Passkey. Try again.')
}

function logOut() {
  if (authority.value?.status !== 'active') return
  return run(async () => {
    notice.value = ''
    setAuthority(null)
    await signOutAdmin(lifetime.signal)
    if (!lifetime.signal.aborted) setAuthority({ status: 'signed-out' })
  }, 'Could not confirm logout. Reload administrator access to check the session.')
}
</script>

<template>
  <main class="auth-page">
    <h1>Administrator access</h1>
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="notice" type="success" :closable="false" show-icon />

    <section v-if="authority?.status === 'active'" class="auth-form" aria-labelledby="admin-session-heading">
      <h2 id="admin-session-heading">Administrator session</h2>
      <dl>
        <dt>Administrator handle</dt>
        <dd>{{ authority.session.handle }}</dd>
        <dt>Expires</dt>
        <dd><time :datetime="new Date(authority.session.expiresAt).toISOString()">{{ new Date(authority.session.expiresAt).toLocaleString() }}</time></dd>
      </dl>
      <ElButton native-type="button" :loading="busy" @click="logOut">Log out of administrator session</ElButton>
    </section>
    <p v-else-if="authority?.status === 'unavailable'">Administrator access is unavailable on this origin.</p>
    <template v-else-if="authority?.status === 'signed-out'">
      <p v-if="!canUsePasskeys">Use a secure origin and a browser that supports Passkeys.</p>
      <div v-else class="auth-form">
        <ElButton native-type="button" type="primary" :loading="busy" @click="logIn">Log in as administrator</ElButton>
        <ElButton v-if="!bootstrapOpen" class="admin-setup-button" native-type="button" :disabled="busy" @click="bootstrapOpen = true">
          Set up administrator Passkey
        </ElButton>
        <form v-else class="admin-bootstrap-form" @submit.prevent="enroll">
          <label for="admin-bootstrap-key">One-time administrator bootstrap key</label>
          <ElInput id="admin-bootstrap-key" v-model="ticket" type="password" autocomplete="off" :disabled="busy" />
          <ElButton native-type="submit" :loading="busy" :disabled="!ticketValid">Create administrator Passkey</ElButton>
          <ElButton native-type="button" :disabled="busy" @click="closeBootstrap">Cancel setup</ElButton>
        </form>
      </div>
    </template>
    <p v-else-if="busy" role="status">Checking administrator access…</p>
    <ElButton v-else native-type="button" @click="refresh">Reload administrator access</ElButton>
  </main>
</template>

<style scoped>
.admin-bootstrap-form { display: grid; gap: 0.75rem; }
.admin-setup-button { margin-inline-start: 0; }
</style>
