<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import AccountWorkspace from '../AccountWorkspace.vue'
import SiteAuthLayout from '../SiteAuthLayout.vue'
import { adminWorkspacePages } from '../adminWorkspaceRoutes'
import {
  ElAlert,
  ElButton,
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
import { ApiError } from '../../../Contracts/aeds'
import { passkeyAvailable } from '../../../Contracts/passkey'
import { announceAdminAuthChange, clearAuthorSession, markAdminSessionHint } from '../authorSession'
import { readInitialAdminEntry } from '../workspacePreload'
import {
  bootstrapAdminPasskey,
  readAdminAuthority,
  readAdminOperations,
  signInAdmin,
  signOutAdmin,
  validAdminBootstrapToken,
  type AdminAuthority,
  type AdminOperationsStatus,
} from '../../../Contracts/admin-identity'

defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const route = useRoute()
const router = useRouter()
const section = computed(() => adminWorkspacePages.find(page => page.name === route.name) ?? adminWorkspacePages[4])
const adminUsesHttps = globalThis.location?.protocol === 'https:'
const configuredPublicOrigin = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-origin"]')?.content ?? ''
const splitAdminHost = Boolean(configuredPublicOrigin && configuredPublicOrigin !== globalThis.location?.origin)
const unifiedLogin = ref(false)
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
const sessionAuthority = shallowRef(new AbortController())
const sessionEpoch = ref(0)
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let operationsRequest: AbortController | undefined

function resetSessionScope() {
  clearOperations()
  sessionAuthority.value.abort()
  sessionAuthority.value = new AbortController()
  sessionEpoch.value++
}

function setAuthority(next: AdminAuthority | null) {
  clearTimeout(expiryTimer)
  resetSessionScope()
  if (next?.status === 'active') {
    const remaining = next.session.expiresAt - Date.now()
    if (remaining <= 0) {
      markAdminSessionHint(false)
      authority.value = { status: 'signed-out' }
      return
    }
    markAdminSessionHint(true)
    expiryTimer = setTimeout(() => setAuthority(next), Math.min(remaining, 2_147_483_647))
    closeBootstrap()
  } else if (next?.status === 'signed-out' || next?.status === 'unavailable') {
    markAdminSessionHint(false)
  }
  authority.value = next
}

async function resolveUnifiedLogin(): Promise<boolean> {
  if (splitAdminHost) return false
  if (unifiedLogin.value) return true
  const available = await passkeyAvailable(lifetime.signal).catch(() => false)
  if (!lifetime.signal.aborted) unifiedLogin.value = available
  return available
}

async function redirectToUnifiedLogin(): Promise<boolean> {
  if (!(await resolveUnifiedLogin()) || lifetime.signal.aborted) return false
  await router.replace({ name: 'login', query: { redirect: route.fullPath } })
  return true
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
    if (lifetime.signal.aborted) return
    if (next.status === 'signed-out' && await redirectToUnifiedLogin()) return
    setAuthority(next)
    if (next.status === 'active') void resolveUnifiedLogin()
  }, 'admin.accessCheckFailed')
}

function whenVisible() {
  if (document.visibilityState === 'visible') void refresh()
}

const initialAdmin = readInitialAdminEntry()
if (initialAdmin) {
  unifiedLogin.value = initialAdmin.unifiedLogin
  setAuthority(initialAdmin.authority)
}

onMounted(() => {
  if (!initialAdmin) void refresh()
  else if (authority.value?.status === 'signed-out' && unifiedLogin.value) void redirectToUnifiedLogin()
  document.addEventListener('visibilitychange', whenVisible)
})
onUnmounted(() => {
  lifetime.abort()
  clearTimeout(expiryTimer)
  resetSessionScope()
  document.removeEventListener('visibilitychange', whenVisible)
})

const links = computed(() => [
  ...(splitAdminHost ? [] : [{ to: '/', label: t('nav.publicSite') }]),
  ...adminWorkspacePages.map(({ path, label }) => ({ to: path, label: t(label) })),
])
watch([() => authority.value, () => section.value.section], ([current, currentSection]) => {
  if (currentSection !== 'system') {
    clearOperations()
    return
  }
  if (current?.status === 'active') void checkOperations(false)
}, { immediate: true })

function clearOperations() {
  operationsRequest?.abort()
  operationsRequest = undefined
  operations.value = null
  operationsBusy.value = false
  operationsFailure.value = ''
}

async function checkOperations(force = true) {
  const active = authority.value
  if (active?.status !== 'active' || busy.value || (!force && operationsBusy.value)) return
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
    if (!force && error instanceof ApiError && error.status === 403) return
    operationsFailure.value = 'admin.operationsFailed'
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
  if (unifiedLogin.value) void router.replace({ name: 'login', query: { redirect: route.fullPath } })
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
    if (!lifetime.signal.aborted) {
      setAuthority({ status: 'active', session })
      announceAdminAuthChange()
    }
  }, 'admin.passkeyLoginFailed')
}

function logOut() {
  if (authority.value?.status !== 'active') return
  return run(async () => {
    notice.value = ''
    setAuthority(null)
    await clearAuthorSession(lifetime.signal)
    await signOutAdmin(lifetime.signal)
    announceAdminAuthChange()
    if (lifetime.signal.aborted) return
    if (unifiedLogin.value) {
      await router.replace({ name: 'home' })
      return
    }
    setAuthority({ status: 'signed-out' })
  }, 'admin.logoutUnconfirmed')
}
</script>

<template>
  <AccountWorkspace v-if="authority?.status === 'active'" home="/admin/site" :label="t('admin.menu')" :links="links"
    surface="task" :theme-mode="themeMode" @theme="emit('theme', $event)">
    <template #actions="{ drawer }">
      <ElButton :text="!drawer" native-type="button" :loading="busy" @click="logOut">{{ t('admin.logout') }}</ElButton>
    </template>
    <main class="admin-workspace">
      <ElTaskPageHeader :title="t(section.label)" density="compact" />
      <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
      <div class="admin-sections">
        <ElSettingsSection v-if="section.section === 'identity'" ariaLabelledby="admin-session-heading" density="compact">
          <template #title><span id="admin-session-heading">{{ t('admin.session') }}</span></template>
          <ElKeyValueGrid density="compact">
            <ElKeyValueItem :label="t('admin.handle')" :value="authority.session.handle" monospace />
            <ElKeyValueItem :label="t('admin.expires')">
              <time :datetime="new Date(authority.session.expiresAt).toISOString()">{{ new Date(authority.session.expiresAt).toLocaleString() }}</time>
            </ElKeyValueItem>
          </ElKeyValueGrid>
        </ElSettingsSection>
        <AdminSessionHistory v-if="section.section === 'identity'" :key="sessionEpoch" :session="authority.session"
          :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminInteractionWorkspace
          v-if="section.section === 'interaction'"
          :key="sessionEpoch"
          :session="authority.session"
          :session-signal="sessionAuthority.signal"
          @session-lost="handleSessionLoss"
        />
        <ElSettingsSection v-if="section.section === 'system'" class="admin-operations"
          ariaLabelledby="admin-operations-heading" density="compact">
          <template #title><span id="admin-operations-heading">{{ t('admin.operationsStatus') }}</span></template>
          <template #actions>
            <ElButton native-type="button" :disabled="busy" :loading="operationsBusy" @click="checkOperations(true)">{{ t('admin.checkOperations') }}</ElButton>
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
        <AdminArticlesWorkspace v-if="section.section === 'articles'" :key="sessionEpoch"
          :session-signal="sessionAuthority.signal" :can-rollback="canUsePasskeys" @session-lost="handleSessionLoss" />
        <AdminSiteTraffic v-if="section.section === 'site'" :key="sessionEpoch"
          :session="authority.session" :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminAppearance v-if="section.section === 'site' && authority.session.appearanceEnabled" :key="sessionEpoch"
          :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminCluster v-if="section.section === 'system'" :key="sessionEpoch"
          :session="authority.session" :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminRiskReadiness v-if="section.section === 'system' && adminUsesHttps" :key="sessionEpoch"
          :session="authority.session" :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminSitePages v-if="section.section === 'site'" :key="sessionEpoch" :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
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
.admin-status-skeleton {
  display: grid;
  gap: var(--fsus-space-3);
  justify-items: stretch;
}
.admin-status-text {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-base);
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
