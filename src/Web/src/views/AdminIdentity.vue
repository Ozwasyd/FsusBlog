<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import AdminModerationControls from './AdminModerationControls.vue'
import AdminTaxonomy from './AdminTaxonomy.vue'
import AdminSitePages from './AdminSitePages.vue'
import AdminSessionHistory from './AdminSessionHistory.vue'
import AdminCluster from './AdminCluster.vue'
import AdminRiskReadiness from './AdminRiskReadiness.vue'
import AdminAppearance from './AdminAppearance.vue'
import AdminInbox from './AdminInbox.vue'
import AdminArticleRollback from './AdminArticleRollback.vue'
import { ApiError } from '../../../Contracts/aeds'
import {
  bootstrapAdminPasskey,
  readAdminAuthority,
  readAdminEffectivePermissions,
  readAdminOperations,
  signInAdmin,
  signOutAdmin,
  validAdminBootstrapToken,
  type AdminAuthority,
  type AdminOperationsStatus,
  type AdminPermission,
  type AdminSession,
} from '../../../Contracts/admin-identity'

const adminUsesHttps = globalThis.location?.protocol === 'https:'
const permissionLease = 60_000
const permissionRefresh = 45_000
const lifetime = new AbortController()
const authority = shallowRef<AdminAuthority | null>(null)
const bootstrapOpen = ref(false)
const ticket = ref('')
const ticketValid = computed(() => validAdminBootstrapToken(ticket.value.trim()))
const canUsePasskeys = globalThis.isSecureContext && typeof PublicKeyCredential === 'function'
const busy = ref(false)
const failure = ref('')
const notice = ref('')
const operations = shallowRef<AdminOperationsStatus | null>(null)
const operationsBusy = ref(false)
const operationsFailure = ref('')
const permissionAuthority = shallowRef(new AbortController())
const permissionEpoch = ref(0)
const permissions = shallowRef<readonly AdminPermission[] | null>(null)
const permissionsPending = ref(false)
const permissionsFailure = ref(false)
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let operationsRequest: AbortController | undefined
let permissionsRequest: AbortController | undefined
let permissionLeaseTimer: ReturnType<typeof setTimeout> | undefined
let permissionRefreshTimer: ReturnType<typeof setTimeout> | undefined

function setAuthority(next: AdminAuthority | null) {
  clearTimeout(expiryTimer)
  clearPermissions()
  permissionsFailure.value = false
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
  if (next?.status === 'active') void checkPermissions(next.session)
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
  clearPermissions()
  document.removeEventListener('visibilitychange', whenVisible)
})

function setPermissions(next: readonly AdminPermission[] | null) {
  const previous = permissions.value
  if (previous === next || (previous && next && previous.length === next.length && previous.every((grant, i) => next[i] === grant))) return
  clearOperations()
  permissionAuthority.value.abort()
  permissionAuthority.value = new AbortController()
  permissionEpoch.value++
  permissions.value = next
}

function clearPermissions() {
  permissionsRequest?.abort()
  permissionsRequest = undefined
  permissionsPending.value = false
  clearTimeout(permissionLeaseTimer)
  clearTimeout(permissionRefreshTimer)
  setPermissions(null)
}

function permits(grant: AdminPermission): boolean {
  return authority.value?.status === 'active' && permissions.value?.includes(grant) === true
}

async function checkPermissions(session: AdminSession) {
  if (lifetime.signal.aborted || permissionsRequest || authority.value?.status !== 'active' || authority.value.session !== session) return
  const check = new AbortController()
  permissionsRequest = check
  permissionsPending.value = true
  permissionsFailure.value = false
  const reportedAt = Date.now()
  try {
    const grants = await readAdminEffectivePermissions(session, check.signal)
    if (check.signal.aborted) return
    const remaining = Math.min(reportedAt + permissionLease, session.expiresAt) - Date.now()
    if (remaining <= 0) throw new Error('Administrator permissions expired while loading.')
    setPermissions(grants)
    clearTimeout(permissionLeaseTimer)
    clearTimeout(permissionRefreshTimer)
    permissionLeaseTimer = setTimeout(() => {
      clearPermissions()
      permissionsFailure.value = true
    }, remaining)
    if (session.expiresAt > reportedAt + permissionRefresh) {
      permissionRefreshTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') void checkPermissions(session)
      }, Math.max(0, reportedAt + permissionRefresh - Date.now()))
    }
  } catch (error) {
    if (check.signal.aborted || handleSessionLoss(error)) return
    clearPermissions()
    permissionsFailure.value = true
  } finally {
    if (permissionsRequest === check) {
      permissionsRequest = undefined
      permissionsPending.value = false
    }
  }
}

function clearOperations() {
  operationsRequest?.abort()
  operationsRequest = undefined
  operations.value = null
  operationsBusy.value = false
  operationsFailure.value = ''
}

async function checkOperations() {
  if (!permits('audit.read') || busy.value || operationsBusy.value) return
  clearOperations()
  const check = new AbortController()
  operationsRequest = check
  operationsBusy.value = true
  try {
    const status = await readAdminOperations(check.signal)
    if (!check.signal.aborted) operations.value = status
  } catch (error) {
    if (check.signal.aborted) return
    if (!handleSessionLoss(error)) {
      operationsFailure.value = error instanceof ApiError && error.status === 403
        ? 'You do not have permission to view operations status.'
        : 'Could not check operations status. Try again.'
    }
  } finally {
    if (operationsRequest === check) {
      operationsRequest = undefined
      operationsBusy.value = false
    }
  }
}

function handleSessionLoss(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  setAuthority({ status: 'signed-out' })
  failure.value = 'Your administrator session expired or was revoked. Log in again.'
  return true
}

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
  <main class="auth-page" :class="{ 'admin-workspace': authority?.status === 'active' }">
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
    <section v-if="authority?.status === 'active'" class="auth-form" aria-labelledby="admin-permissions-heading">
      <h2 id="admin-permissions-heading">Effective permissions</h2>
      <ul v-if="permissions">
        <li v-for="grant in permissions" :key="grant">{{ grant }}</li>
      </ul>
      <template v-else-if="permissionsFailure">
        <ElAlert title="Could not verify effective permissions. Reload to try again." type="error" :closable="false" show-icon />
        <ElButton native-type="button" :loading="busy || permissionsPending" @click="refresh">Reload effective permissions</ElButton>
      </template>
      <p v-else-if="permissionsPending" role="status">Checking effective permissions…</p>
    </section>
    <AdminSessionHistory v-if="permits('admin.manage') && authority?.status === 'active'" :key="permissionEpoch" :session="authority.session"
      :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminModerationControls v-if="permits('comment.moderate')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminInbox v-if="permits('admin.manage')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <section v-if="permits('audit.read')" class="auth-form admin-operations" aria-labelledby="admin-operations-heading">
      <h2 id="admin-operations-heading">Operations status</h2>
      <ElButton native-type="button" :disabled="busy" :loading="operationsBusy" @click="checkOperations">Check operations status</ElButton>
      <ElAlert v-if="operationsFailure" :title="operationsFailure" type="error" :closable="false" show-icon />
      <div aria-live="polite">
        <dl v-if="operations">
          <dt>Public snapshot</dt>
          <dd>{{ operations.snapshotReady ? 'Ready' : 'Not ready' }}</dd>
          <dt>Publication watermark</dt>
          <dd>{{ operations.publicationWatermark.toString() }}</dd>
          <dt>Pending publication events</dt>
          <dd>{{ operations.pendingPublicationEvents.toString() }}</dd>
          <template v-if="operations.oldestPendingAt !== null">
            <dt>Oldest pending publication event</dt>
            <dd>
              <time :datetime="new Date(operations.oldestPendingAt).toISOString()">{{ new Date(operations.oldestPendingAt).toLocaleString() }}</time>
            </dd>
          </template>
        </dl>
      </div>
    </section>
    <AdminTaxonomy v-if="permits('article.write')" :key="permissionEpoch" @session-lost="handleSessionLoss" />
    <AdminArticleRollback v-if="permits('article.write')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminAppearance v-if="authority?.status === 'active' && authority.session.appearanceEnabled && permits('system.config')" :key="permissionEpoch"
      :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminCluster v-if="authority?.status === 'active' && permits('system.config')" :key="permissionEpoch"
      :session="authority.session" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminRiskReadiness v-if="adminUsesHttps && authority?.status === 'active' && permits('system.config')" :key="permissionEpoch"
      :session="authority.session" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminSitePages v-if="permits('system.config')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <p v-if="authority?.status === 'unavailable'">Administrator access is unavailable on this origin.</p>
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
    <p v-else-if="authority === null && busy" role="status">Checking administrator access…</p>
    <ElButton v-else-if="authority === null" native-type="button" @click="refresh">Reload administrator access</ElButton>
  </main>
</template>

<style scoped>
.admin-bootstrap-form { display: grid; gap: 0.75rem; }
.admin-setup-button { margin-inline-start: 0; }
.admin-workspace { width: min(68rem, calc(100% - 2 * var(--fsusblog-page-gutter))); }
.admin-workspace .auth-form { max-width: 40rem; }
.admin-operations { margin-block-start: 1.5rem; }
</style>
