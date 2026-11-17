<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
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
import AdminArticleInventory from './AdminArticleInventory.vue'
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
const failure = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
const operations = shallowRef<AdminOperationsStatus | null>(null)
const operationsBusy = ref(false)
const operationsFailure = ref<MessageKey | ''>('')
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

async function run(task: () => Promise<void>, onFailure: MessageKey) {
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
  }, 'admin.accessCheckFailed')
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
  const active = authority.value
  if (active?.status !== 'active' || !permits('audit.read') || busy.value || operationsBusy.value) return
  clearOperations()
  const check = new AbortController()
  operationsRequest = check
  operationsBusy.value = true
  const live = () => authority.value === active && !check.signal.aborted
  const same = (observed: AdminAuthority) => observed.status === 'active' &&
    observed.session.permissionSession === active.session.permissionSession
  try {
    const status = await readAdminOperations(active.session, check.signal)
    if (!live()) return
    const observed = await readAdminAuthority(check.signal)
    if (!live()) return
    if (!same(observed)) setAuthority(observed)
    else operations.value = status
  } catch (error) {
    if (!live()) return
    if (error instanceof ApiError && error.status === 401) {
      const observed = await readAdminAuthority(check.signal).catch(() => null)
      if (!live()) return
      if (observed?.status === 'signed-out') { handleSessionLoss(error); return }
      if (observed && !same(observed)) { setAuthority(observed); return }
    }
    operationsFailure.value = error instanceof ApiError && error.status === 403
      ? 'admin.operationsForbidden'
      : 'admin.operationsFailed'
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
  failure.value = 'admin.sessionLost'
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
    notice.value = 'admin.passkeyCreated'
  }, 'admin.passkeyCreateFailed')
}

function logIn() {
  if (authority.value?.status !== 'signed-out' || !canUsePasskeys) return
  return run(async () => {
    notice.value = ''
    closeBootstrap()
    const session = await signInAdmin(lifetime.signal)
    if (!lifetime.signal.aborted) setAuthority({ status: 'active', session })
  }, 'admin.passkeyLoginFailed')
}

function logOut() {
  if (authority.value?.status !== 'active') return
  return run(async () => {
    notice.value = ''
    setAuthority(null)
    await signOutAdmin(lifetime.signal)
    if (!lifetime.signal.aborted) setAuthority({ status: 'signed-out' })
  }, 'admin.logoutUnconfirmed')
}
</script>

<template>
  <main class="auth-page" :class="{ 'admin-workspace': authority?.status === 'active' }">
    <h1>{{ t('admin.access') }}</h1>
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="t(notice)" type="success" :closable="false" show-icon />

    <section v-if="authority?.status === 'active'" class="auth-form" aria-labelledby="admin-session-heading">
      <h2 id="admin-session-heading">{{ t('admin.session') }}</h2>
      <dl>
        <dt>{{ t('admin.handle') }}</dt>
        <dd>{{ authority.session.handle }}</dd>
        <dt>{{ t('admin.expires') }}</dt>
        <dd><time :datetime="new Date(authority.session.expiresAt).toISOString()">{{ new Date(authority.session.expiresAt).toLocaleString() }}</time></dd>
      </dl>
      <ElButton native-type="button" :loading="busy" @click="logOut">{{ t('admin.logout') }}</ElButton>
    </section>
    <section v-if="authority?.status === 'active'" class="auth-form" aria-labelledby="admin-permissions-heading">
      <h2 id="admin-permissions-heading">{{ t('admin.effectivePermissions') }}</h2>
      <ul v-if="permissions">
        <li v-for="grant in permissions" :key="grant">{{ grant }}</li>
      </ul>
      <template v-else-if="permissionsFailure">
        <ElAlert :title="t('admin.permissionsFailed')" type="error" :closable="false" show-icon />
        <ElButton native-type="button" :loading="busy || permissionsPending" @click="refresh">{{ t('admin.reloadPermissions') }}</ElButton>
      </template>
      <p v-else-if="permissionsPending" role="status">{{ t('admin.checkingPermissions') }}</p>
    </section>
    <AdminSessionHistory v-if="permits('admin.manage') && authority?.status === 'active'" :key="permissionEpoch" :session="authority.session"
      :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminModerationControls v-if="permits('comment.moderate')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminInbox v-if="permits('admin.manage')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <section v-if="permits('audit.read')" class="auth-form admin-operations" aria-labelledby="admin-operations-heading">
      <h2 id="admin-operations-heading">{{ t('admin.operationsStatus') }}</h2>
      <ElButton native-type="button" :disabled="busy" :loading="operationsBusy" @click="checkOperations">{{ t('admin.checkOperations') }}</ElButton>
      <ElAlert v-if="operationsFailure" :title="t(operationsFailure)" type="error" :closable="false" show-icon />
      <div aria-live="polite">
        <dl v-if="operations">
          <dt>{{ t('admin.publicSnapshot') }}</dt>
          <dd>{{ operations.snapshotReady ? t('admin.ready') : t('admin.notReady') }}</dd>
          <dt>{{ t('admin.publicationWatermark') }}</dt>
          <dd>{{ operations.publicationWatermark.toString() }}</dd>
          <dt>{{ t('admin.pendingEvents') }}</dt>
          <dd>{{ operations.pendingPublicationEvents.toString() }}</dd>
          <template v-if="operations.oldestPendingAt !== null">
            <dt>{{ t('admin.oldestPendingEvent') }}</dt>
            <dd>
              <time :datetime="new Date(operations.oldestPendingAt).toISOString()">{{ new Date(operations.oldestPendingAt).toLocaleString() }}</time>
            </dd>
          </template>
        </dl>
      </div>
    </section>
    <AdminTaxonomy v-if="permits('article.write')" :key="permissionEpoch" @session-lost="handleSessionLoss" />
    <AdminArticleInventory v-if="permits('article.write')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminArticleRollback v-if="permits('article.write')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminAppearance v-if="authority?.status === 'active' && authority.session.appearanceEnabled && permits('system.config')" :key="permissionEpoch"
      :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminCluster v-if="authority?.status === 'active' && permits('system.config')" :key="permissionEpoch"
      :session="authority.session" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminRiskReadiness v-if="adminUsesHttps && authority?.status === 'active' && permits('system.config')" :key="permissionEpoch"
      :session="authority.session" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <AdminSitePages v-if="permits('system.config')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
    <p v-if="authority?.status === 'unavailable'">{{ t('admin.accessUnavailable') }}</p>
    <template v-else-if="authority?.status === 'signed-out'">
      <p v-if="!canUsePasskeys">{{ t('admin.securePasskeyRequired') }}</p>
      <div v-else class="auth-form">
        <ElButton native-type="button" type="primary" :loading="busy" @click="logIn">{{ t('admin.login') }}</ElButton>
        <ElButton v-if="!bootstrapOpen" class="admin-setup-button" native-type="button" :disabled="busy" @click="bootstrapOpen = true">
          {{ t('admin.setupPasskey') }}
        </ElButton>
        <form v-else class="admin-bootstrap-form" @submit.prevent="enroll">
          <label for="admin-bootstrap-key">{{ t('admin.bootstrapKey') }}</label>
          <ElInput id="admin-bootstrap-key" v-model="ticket" type="password" autocomplete="off" :disabled="busy" />
          <ElButton native-type="submit" :loading="busy" :disabled="!ticketValid">{{ t('admin.createPasskey') }}</ElButton>
          <ElButton native-type="button" :disabled="busy" @click="closeBootstrap">{{ t('admin.cancelSetup') }}</ElButton>
        </form>
      </div>
    </template>
    <p v-else-if="authority === null && busy" role="status">{{ t('admin.checkingAccess') }}</p>
    <ElButton v-else-if="authority === null" native-type="button" @click="refresh">{{ t('admin.reloadAccess') }}</ElButton>
  </main>
</template>

<style scoped>
.admin-bootstrap-form { display: grid; gap: 0.75rem; }
.admin-setup-button { margin-inline-start: 0; }
.admin-workspace { width: min(68rem, calc(100% - 2 * var(--fsusblog-page-gutter))); }
.admin-workspace .auth-form { max-width: 40rem; }
.admin-operations { margin-block-start: 1.5rem; }
</style>
