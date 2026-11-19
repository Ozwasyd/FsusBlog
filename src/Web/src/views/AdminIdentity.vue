<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import AccountWorkspace from '../AccountWorkspace.vue'
import SiteAuthLayout from '../SiteAuthLayout.vue'
import { adminWorkspacePages, type AdminWorkspaceSection } from '../adminWorkspaceRoutes'
import {
  ElAlert,
  ElButton,
  ElEmptyState,
  ElInput,
  ElKeyValueGrid,
  ElKeyValueItem,
  ElSettingsSection,
  ElSkeleton,
  ElTag,
  ElTaskPageHeader,
} from '@ozwasyd/element-plus'
import AdminInteractionWorkspace from './AdminInteractionWorkspace.vue'
import AdminArticlesWorkspace from './AdminArticlesWorkspace.vue'
import AdminSiteTraffic from './AdminSiteTraffic.vue'
import AdminSitePages from './AdminSitePages.vue'
import AdminSessionHistory from './AdminSessionHistory.vue'
import AdminCluster from './AdminCluster.vue'
import AdminRiskReadiness from './AdminRiskReadiness.vue'
import AdminAppearance from './AdminAppearance.vue'
import AdminInbox from './AdminInbox.vue'
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

defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const route = useRoute()
const section = computed(() => adminWorkspacePages.find(page => page.name === route.name) ?? adminWorkspacePages[4])
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

const permissionLabels: Record<AdminPermission, MessageKey> = {
  'admin.manage': 'admin.permission.admin.manage',
  'article.write': 'admin.permission.article.write',
  'audit.read': 'admin.permission.audit.read',
  'comment.moderate': 'admin.permission.comment.moderate',
  'system.config': 'admin.permission.system.config',
}

function permits(grant: AdminPermission): boolean {
  return authority.value?.status === 'active' && permissions.value?.includes(grant) === true
}

function canOpen(page: AdminWorkspaceSection): boolean {
  switch (page) {
    case 'articles': return permits('article.write')
    case 'interaction': return permits('admin.manage') || permits('comment.moderate')
    case 'site': return permits('audit.read') || permits('system.config')
    case 'system': return permits('audit.read') || permits('system.config')
    case 'identity': return true
  }
}
const links = computed(() => adminWorkspacePages.filter(page => canOpen(page.section))
  .map(({ path, label }) => ({ to: path, label: t(label) })))
watch(section, (next) => { if (next.section !== 'system') clearOperations() })

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
  <AccountWorkspace v-if="authority?.status === 'active'" home="/admin/site" :label="t('admin.access')" :links="links"
    surface="task" :theme-mode="themeMode" @theme="emit('theme', $event)">
    <template #actions>
      <ElButton text native-type="button" :loading="busy" @click="logOut">{{ t('admin.logout') }}</ElButton>
    </template>
    <main class="admin-workspace">
      <ElTaskPageHeader :title="t(section.label)" density="compact" />
      <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
      <div v-if="section.section !== 'identity' && !canOpen(section.section)" class="admin-permission-gate">
        <ElAlert v-if="permissionsFailure" :title="t('admin.permissionsFailed')" type="error" :closable="false" show-icon />
        <ElButton v-if="permissionsFailure" native-type="button" :disabled="busy" @click="refresh">{{ t('admin.reloadPermissions') }}</ElButton>
        <div v-else-if="!permissions" class="admin-status-skeleton">
          <ElSkeleton :rows="3" animated />
          <p class="admin-status-text" role="status">{{ t('admin.checkingPermissions') }}</p>
        </div>
        <ElEmptyState v-else size="compact" :title="t('admin.workspace.denied')" role="status" />
      </div>
      <div class="admin-sections">
        <ElSettingsSection v-if="section.section === 'identity'" ariaLabelledby="admin-session-heading" density="compact">
          <template #title><span id="admin-session-heading">{{ t('admin.session') }}</span></template>
          <ElKeyValueGrid density="compact">
            <ElKeyValueItem :label="t('admin.handle')" :value="authority.session.handle" monospace />
            <ElKeyValueItem :label="t('admin.expires')">
              <time :datetime="new Date(authority.session.expiresAt).toISOString()">{{ new Date(authority.session.expiresAt).toLocaleString() }}</time>
            </ElKeyValueItem>
          </ElKeyValueGrid>
          <div class="admin-session-permissions">
            <span class="admin-session-permissions-label">{{ t('admin.effectivePermissions') }}</span>
            <div v-if="permissions" class="admin-permission-list">
              <ElTag v-for="grant in permissions" :key="grant" size="small" type="info" v-bind="{ title: grant }">{{ t(permissionLabels[grant]) }}</ElTag>
            </div>
            <div v-else-if="permissionsFailure" class="admin-inline-stack">
              <ElAlert :title="t('admin.permissionsFailed')" type="error" :closable="false" show-icon />
              <ElButton native-type="button" :loading="busy || permissionsPending" @click="refresh">{{ t('admin.reloadPermissions') }}</ElButton>
            </div>
            <div v-else-if="permissionsPending" class="admin-status-skeleton">
              <ElSkeleton :rows="1" animated />
              <p class="admin-status-text" role="status">{{ t('admin.checkingPermissions') }}</p>
            </div>
          </div>
        </ElSettingsSection>
        <AdminSessionHistory v-if="section.section === 'identity' && permits('admin.manage')" :key="permissionEpoch" :session="authority.session"
          :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminInteractionWorkspace
          v-if="section.section === 'interaction' && (permits('comment.moderate') || permits('admin.manage'))"
          :key="permissionEpoch"
          :session-signal="permissionAuthority.signal"
          :can-moderate="permits('comment.moderate')"
          :can-manage-inbox="permits('admin.manage')"
          @session-lost="handleSessionLoss"
        />
        <ElSettingsSection v-if="section.section === 'system' && permits('audit.read')" class="admin-operations"
          ariaLabelledby="admin-operations-heading" density="compact">
          <template #title><span id="admin-operations-heading">{{ t('admin.operationsStatus') }}</span></template>
          <template #actions>
            <ElButton native-type="button" :disabled="busy" :loading="operationsBusy" @click="checkOperations">{{ t('admin.checkOperations') }}</ElButton>
          </template>
          <ElAlert v-if="operationsFailure" :title="t(operationsFailure)" type="error" :closable="false" show-icon />
          <div aria-live="polite">
            <ElKeyValueGrid v-if="operations" density="compact">
              <ElKeyValueItem :label="t('admin.publicSnapshot')">
                <ElTag :type="operations.snapshotReady ? 'success' : 'warning'" size="small">
                  {{ operations.snapshotReady ? t('admin.ready') : t('admin.notReady') }}
                </ElTag>
              </ElKeyValueItem>
              <ElKeyValueItem :label="t('admin.publicationWatermark')" :value="operations.publicationWatermark.toString()" monospace />
              <ElKeyValueItem :label="t('admin.pendingEvents')" :value="operations.pendingPublicationEvents.toString()" monospace />
              <ElKeyValueItem v-if="operations.oldestPendingAt !== null" :label="t('admin.oldestPendingEvent')">
                <time :datetime="new Date(operations.oldestPendingAt).toISOString()">{{ new Date(operations.oldestPendingAt).toLocaleString() }}</time>
              </ElKeyValueItem>
            </ElKeyValueGrid>
          </div>
        </ElSettingsSection>
        <AdminArticlesWorkspace v-if="section.section === 'articles' && permits('article.write')" :key="permissionEpoch"
          :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminSiteTraffic v-if="section.section === 'site' && permits('audit.read')" :key="permissionEpoch"
          :session="authority.session" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminAppearance v-if="section.section === 'site' && authority?.status === 'active' && authority.session.appearanceEnabled && permits('system.config')" :key="permissionEpoch"
          :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminCluster v-if="section.section === 'system' && authority?.status === 'active' && permits('system.config')" :key="permissionEpoch"
          :session="authority.session" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminRiskReadiness v-if="section.section === 'system' && adminUsesHttps && authority?.status === 'active' && permits('system.config')" :key="permissionEpoch"
          :session="authority.session" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminSitePages v-if="section.section === 'site' && permits('system.config')" :key="permissionEpoch" :session-signal="permissionAuthority.signal" @session-lost="handleSessionLoss" />
      </div>
    </main>
  </AccountWorkspace>
  <SiteAuthLayout v-else :theme-mode="themeMode" @theme="emit('theme', $event)">
    <div class="admin-login-surface">
      <ElTaskPageHeader :title="t('admin.access')" />
      <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
      <ElAlert v-if="notice" :title="t(notice)" type="success" :closable="false" show-icon />
      <ElAlert v-if="authority?.status === 'unavailable'" :title="t('admin.accessUnavailable')" type="info" :closable="false" show-icon />
      <template v-else-if="authority?.status === 'signed-out'">
        <ElAlert v-if="!canUsePasskeys" :title="t('admin.securePasskeyRequired')" type="warning" :closable="false" show-icon />
        <div v-else class="admin-login-panel">
          <div class="admin-login-actions">
            <ElButton native-type="button" type="primary" :loading="busy" @click="logIn">{{ t('admin.login') }}</ElButton>
            <ElButton v-if="!bootstrapOpen" class="admin-setup-button" native-type="button" :disabled="busy" @click="bootstrapOpen = true">
              {{ t('admin.setupPasskey') }}
            </ElButton>
          </div>
          <form v-if="bootstrapOpen" class="admin-bootstrap-form" @submit.prevent="enroll">
            <label for="admin-bootstrap-key">{{ t('admin.bootstrapKey') }}</label>
            <ElInput id="admin-bootstrap-key" v-model="ticket" type="password" autocomplete="off" :disabled="busy" />
            <div class="admin-login-actions">
              <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!ticketValid">{{ t('admin.createPasskey') }}</ElButton>
              <ElButton native-type="button" :disabled="busy" @click="closeBootstrap">{{ t('admin.cancelSetup') }}</ElButton>
            </div>
          </form>
        </div>
      </template>
      <div v-else-if="authority === null && busy" class="admin-status-skeleton">
        <ElSkeleton :rows="2" animated />
        <p class="admin-status-text" role="status">{{ t('admin.checkingAccess') }}</p>
      </div>
      <ElButton v-else-if="authority === null" native-type="button" @click="refresh">{{ t('admin.reloadAccess') }}</ElButton>
    </div>
  </SiteAuthLayout>
</template>

<style scoped>
.admin-workspace {
  display: grid;
  gap: var(--fsus-space-5);
  min-width: 0;
}
.admin-sections {
  display: grid;
  gap: var(--fsus-space-6);
  min-width: 0;
}
.admin-sections > :deep(*) {
  margin-block: 0;
}
.admin-permission-gate,
.admin-inline-stack,
.admin-status-skeleton {
  display: grid;
  gap: var(--fsus-space-3);
  justify-items: start;
}
.admin-status-skeleton {
  justify-items: stretch;
}
.admin-status-text {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-base);
}
.admin-session-permissions {
  display: grid;
  gap: var(--fsus-space-2);
  margin-top: var(--fsus-space-3);
}
.admin-session-permissions-label {
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
  font-weight: 500;
}
.admin-permission-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-2);
}
.admin-login-surface {
  display: grid;
  gap: var(--fsus-space-5);
}
.admin-login-panel {
  display: grid;
  gap: var(--fsus-space-4);
  padding: var(--fsus-space-6);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
}
.admin-login-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-2);
  align-items: center;
}
.admin-login-actions :deep(.el-button + .el-button) {
  margin-inline-start: 0;
}
.admin-bootstrap-form {
  display: grid;
  gap: var(--fsus-space-3);
  padding-block-start: var(--fsus-space-4);
  border-block-start: 1px solid var(--el-border-color-lighter);
}
.admin-bootstrap-form label {
  color: var(--el-text-color-primary);
  font-size: var(--el-font-size-base);
  font-weight: 500;
}
.admin-setup-button {
  margin-inline-start: 0;
}
</style>
