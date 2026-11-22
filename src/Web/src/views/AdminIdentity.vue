<script setup lang="ts">
import { siteLocale, t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import AccountWorkspace from '../AccountWorkspace.vue'
import SiteAuthLayout from '../SiteAuthLayout.vue'
import { adminWorkspacePages } from '../adminWorkspaceRoutes'
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElInlineActions,
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
import AdminSiteConfig from './AdminSiteConfig.vue'
import AdminSitePages from './AdminSitePages.vue'
import AdminSessionHistory from './AdminSessionHistory.vue'
import AdminSystemDiagnostics from './AdminSystemDiagnostics.vue'
import AdminAppearance from './AdminAppearance.vue'
import { ApiError } from '../../../Contracts/aeds'
import { passkeyAvailable } from '../../../Contracts/passkey'
import { announceAdminAuthChange, clearAuthorSession, markAdminSessionHint } from '../authorSession'
import { readInitialAdminEntry } from '../workspacePreload'
import {
  bootstrapAdminPasskey,
  readAdminAuthority,
  signInAdmin,
  signOutAdmin,
  validAdminBootstrapToken,
  type AdminAuthority,
  type AdminSession,
} from '../../../Contracts/admin-identity'
import {
  executeAdminHandleRename,
  requestAdminHandleProof,
  validAdminHandle,
  type AdminHandleCommand,
} from '../../../Contracts/admin-handle'
import { WireLimits } from '../../../Contracts/wire.generated'

defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const route = useRoute()
const router = useRouter()
const section = computed(() => adminWorkspacePages.find(page => page.name === route.name) ?? adminWorkspacePages.at(-1)!)
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
const handleNotice = ref('')
const handleDialogOpen = ref(false)
const nextHandle = ref('')
const nextHandleTouched = ref(false)
const handleSubmitting = ref(false)
const handleFailure = ref<MessageKey | ''>('')
const handleRetryCommand = shallowRef<AdminHandleCommand | null>(null)
const sessionAuthority = shallowRef(new AbortController())
const sessionEpoch = ref(0)
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let revalidateRequest: AbortController | undefined
let handleRequest: AbortController | undefined

const trimmedNextHandle = computed(() => nextHandle.value.trim())
const nextHandleValid = computed(() => validAdminHandle(trimmedNextHandle.value))
const nextHandleChanged = computed(() =>
  authority.value?.status === 'active' && trimmedNextHandle.value !== authority.value.session.handle)
const nextHandleInvalid = computed(() =>
  nextHandleTouched.value && trimmedNextHandle.value.length > 0 && (!nextHandleValid.value || !nextHandleChanged.value))
const canSubmitHandle = computed(() =>
  !handleSubmitting.value && nextHandleValid.value && nextHandleChanged.value)

function sameAdminAuthority(a: AdminAuthority | null, b: AdminAuthority | null): boolean {
  if (a === b) return true
  if (!a || !b || a.status !== b.status) return false
  if (a.status !== 'active' || b.status !== 'active') return true
  return a.session.handle === b.session.handle &&
    a.session.generation === b.session.generation &&
    a.session.permissionSession === b.session.permissionSession &&
    a.session.appearanceEnabled === b.session.appearanceEnabled &&
    a.session.siteConfigEnabled === b.session.siteConfigEnabled
}

function scheduleExpiry(session: AdminSession) {
  clearTimeout(expiryTimer)
  const remaining = session.expiresAt - Date.now()
  if (remaining <= 0) {
    markAdminSessionHint(false)
    setAuthority({ status: 'signed-out' })
    return
  }
  expiryTimer = setTimeout(() => {
    if (authority.value?.status === 'active' && authority.value.session === session) {
      scheduleExpiry(session)
    }
  }, Math.min(remaining, 2_147_483_647))
}

function resetSessionScope() {
  closeHandleRename(true)
  handleNotice.value = ''
  sessionAuthority.value.abort()
  sessionAuthority.value = new AbortController()
  sessionEpoch.value++
}

function setAuthority(next: AdminAuthority | null) {
  revalidateRequest?.abort()
  revalidateRequest = undefined
  clearTimeout(expiryTimer)
  resetSessionScope()
  if (next?.status === 'active') {
    if (next.session.expiresAt <= Date.now()) {
      markAdminSessionHint(false)
      authority.value = { status: 'signed-out' }
      return
    }
    markAdminSessionHint(true)
    authority.value = next
    scheduleExpiry(next.session)
    closeBootstrap()
    return
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

async function revalidateOnVisible() {
  if (busy.value || lifetime.signal.aborted || revalidateRequest) return
  if (authority.value?.status !== 'active') {
    void refresh()
    return
  }
  const check = new AbortController()
  revalidateRequest = check
  const signal = AbortSignal.any([lifetime.signal, check.signal])
  try {
    const next = await readAdminAuthority(signal)
    if (signal.aborted || revalidateRequest !== check) return
    if (next.status === 'signed-out') {
      if (await redirectToUnifiedLogin()) return
      setAuthority(next)
      return
    }
    if (next.status === 'active' && sameAdminAuthority(authority.value, next)) {
      if (authority.value.session.expiresAt !== next.session.expiresAt) {
        authority.value = next
        scheduleExpiry(next.session)
      }
      return
    }
    setAuthority(next)
    if (next.status === 'active') void resolveUnifiedLogin()
  } catch {
    if (signal.aborted || revalidateRequest !== check) return
    if (authority.value?.status === 'active' && authority.value.session.expiresAt <= Date.now()) {
      setAuthority({ status: 'signed-out' })
    }
  } finally {
    if (revalidateRequest === check) revalidateRequest = undefined
  }
}

function whenVisible() {
  if (document.visibilityState === 'visible') void revalidateOnVisible()
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
  revalidateRequest?.abort()
  revalidateRequest = undefined
  lifetime.abort()
  clearTimeout(expiryTimer)
  resetSessionScope()
  document.removeEventListener('visibilitychange', whenVisible)
})

const links = computed(() =>
  adminWorkspacePages.map(({ path, label }) => ({ to: path, label: t(label) })),
)

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

function openHandleRename() {
  if (authority.value?.status !== 'active' || busy.value || handleSubmitting.value) return
  handleNotice.value = ''
  nextHandle.value = authority.value.session.handle
  nextHandleTouched.value = false
  handleFailure.value = ''
  handleRetryCommand.value = null
  handleDialogOpen.value = true
}

function closeHandleRename(force = false) {
  if (handleSubmitting.value && !force) return
  handleRequest?.abort()
  handleRequest = undefined
  handleDialogOpen.value = false
  nextHandle.value = ''
  nextHandleTouched.value = false
  handleFailure.value = ''
  handleRetryCommand.value = null
  handleSubmitting.value = false
}

function onHandleInput() {
  handleFailure.value = ''
  handleRetryCommand.value = null
}

async function submitHandleRename() {
  if (authority.value?.status !== 'active' || handleSubmitting.value || sessionAuthority.value.signal.aborted) return
  const activeSession = authority.value.session
  nextHandleTouched.value = true
  const candidate = trimmedNextHandle.value
  if (!validAdminHandle(candidate) || candidate === activeSession.handle) return

  const pending = handleRetryCommand.value
  const command: AdminHandleCommand = pending ?? {
    expectedHandle: activeSession.handle,
    newHandle: candidate,
    idempotencyKey: crypto.randomUUID(),
  }

  handleRequest?.abort()
  const current = handleRequest = new AbortController()
  const signal = AbortSignal.any([current.signal, sessionAuthority.value.signal, lifetime.signal])
  handleSubmitting.value = true
  handleFailure.value = ''
  let submitted = Boolean(pending)
  try {
    const proof = pending ? undefined : await requestAdminHandleProof(command, signal)
    signal.throwIfAborted()
    submitted = true
    const receipt = await executeAdminHandleRename(activeSession, command, proof, signal)
    if (signal.aborted) return
    if (authority.value?.status === 'active' && authority.value.session.permissionSession === activeSession.permissionSession) {
      authority.value = { status: 'active', session: { ...authority.value.session, handle: receipt.handle } }
    }
    closeHandleRename(true)
    handleNotice.value = receipt.handle
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) {
      closeHandleRename(true)
      handleSessionLoss(cause)
    } else if (cause instanceof ApiError && cause.status === 409) {
      handleRetryCommand.value = null
      handleFailure.value = 'admin.renameHandleConflict'
      void revalidateOnVisible()
    } else if (cause instanceof ApiError && cause.status === 428) {
      handleRetryCommand.value = null
      handleFailure.value = 'admin.renameHandleProofRequired'
    } else if (submitted && (!(cause instanceof ApiError) || cause.status >= 500)) {
      handleRetryCommand.value = command
      handleFailure.value = 'admin.renameHandleUnconfirmed'
    } else if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
      handleFailure.value = 'admin.renameHandleCanceled'
    } else {
      handleFailure.value = 'admin.renameHandleFailed'
    }
  } finally {
    if (handleRequest === current) handleRequest = undefined
    handleSubmitting.value = false
  }
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
  <AccountWorkspace v-if="authority?.status === 'active'" :home="splitAdminHost ? '/admin/site' : '/'" :label="t('admin.menu')" :links="links"
    surface="task" :theme-mode="themeMode" @theme="emit('theme', $event)">
    <template #actions="{ drawer }">
      <ElButton :text="!drawer" native-type="button" :loading="busy" @click="logOut">{{ t('admin.logout') }}</ElButton>
    </template>
    <main class="admin-workspace">
      <ElTaskPageHeader
        :title="t(section.label)"
        :description="section.section === 'identity' ? t('admin.accountSummary') : undefined"
        density="compact"
      />
      <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
      <div class="admin-sections">
        <ElSettingsSection
          v-if="section.section === 'identity'"
          ariaLabelledby="admin-session-heading"
          :description="t('admin.sessionSummary')"
          density="compact"
        >
          <template #title><span id="admin-session-heading">{{ t('admin.session') }}</span></template>
          <template #actions>
            <ElInlineActions class="admin-session-actions" density="compact">
              <ElTag size="small" type="success">{{ t('admin.sessionActive') }}</ElTag>
              <ElButton v-if="canUsePasskeys" native-type="button" text :disabled="busy" @click="openHandleRename">
                {{ t('admin.renameHandle') }}
              </ElButton>
            </ElInlineActions>
          </template>
          <ElAlert
            v-if="handleNotice"
            :title="t('admin.renameHandleSuccess', { handle: handleNotice })"
            type="success"
            :closable="false"
            show-icon
          />
          <ElKeyValueGrid density="compact">
            <ElKeyValueItem :label="t('admin.handle')" :value="authority.session.handle" monospace />
            <ElKeyValueItem :label="t('admin.sessionGeneration')" :value="authority.session.generation.toString()" monospace />
            <ElKeyValueItem :label="t('admin.expires')">
              <time :datetime="new Date(authority.session.expiresAt).toISOString()">{{ new Date(authority.session.expiresAt).toLocaleString(siteLocale) }}</time>
            </ElKeyValueItem>
          </ElKeyValueGrid>
        </ElSettingsSection>
        <ElDialog
          v-if="section.section === 'identity'"
          :model-value="handleDialogOpen"
          :title="t('admin.renameHandleDialogTitle')"
          append-to-body
          width="min(30rem, calc(100vw - 2rem))"
          :close-on-press-escape="!handleSubmitting"
          :close-on-click-modal="!handleSubmitting"
          :show-close="!handleSubmitting"
          @update:model-value="open => { if (!open) closeHandleRename() }"
        >
          <form id="admin-handle-rename-form" class="admin-handle-dialog-body" @submit.prevent="submitHandleRename">
            <ElAlert v-if="handleFailure" :title="t(handleFailure)" type="error" :closable="false" show-icon />
            <p class="admin-handle-desc">{{ t('admin.renameHandlePasskeyNote') }}</p>
            <div class="admin-handle-field">
              <label for="admin-handle-rename-input">{{ t('admin.renameHandleLabel') }}</label>
              <ElInput
                id="admin-handle-rename-input"
                v-model="nextHandle"
                :disabled="handleSubmitting"
                :placeholder="authority.session.handle"
                v-bind="{
                  maxlength: WireLimits.AdminHandleBytes,
                  autocorrect: 'off',
                  autocapitalize: 'none',
                  spellcheck: 'false',
                  'aria-describedby': 'admin-handle-rename-hint',
                  'aria-invalid': nextHandleInvalid ? 'true' : undefined,
                }"
                @input="onHandleInput"
                @blur="nextHandleTouched = true"
              />
              <p id="admin-handle-rename-hint" :class="nextHandleInvalid ? 'admin-handle-validation' : 'admin-handle-hint'">
                {{ t(nextHandleInvalid && !nextHandleValid ? 'admin.renameHandleInvalid' : 'admin.renameHandleHint') }}
              </p>
            </div>
          </form>
          <template #footer>
            <ElInlineActions density="compact">
              <ElButton native-type="button" :disabled="handleSubmitting" @click="closeHandleRename()">
                {{ t('admin.renameHandleCancel') }}
              </ElButton>
              <ElButton
                native-type="submit"
                type="primary"
                v-bind="{ form: 'admin-handle-rename-form' }"
                :loading="handleSubmitting"
                :disabled="!canSubmitHandle"
              >
                {{ t(handleRetryCommand ? 'admin.renameHandleRetry' : 'admin.renameHandleConfirm') }}
              </ElButton>
            </ElInlineActions>
          </template>
        </ElDialog>
        <AdminSessionHistory v-if="section.section === 'identity'" :key="sessionEpoch" :session="authority.session"
          :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminInteractionWorkspace
          v-if="section.section === 'interaction'"
          :key="sessionEpoch"
          :session="authority.session"
          :session-signal="sessionAuthority.signal"
          :show-risk-controls="adminUsesHttps"
          @session-lost="handleSessionLoss"
        />
        <AdminArticlesWorkspace v-if="section.section === 'articles'" :key="sessionEpoch"
          :session-signal="sessionAuthority.signal" :can-rollback="canUsePasskeys" @session-lost="handleSessionLoss" />
        <AdminSiteTraffic v-if="section.section === 'site'" :key="sessionEpoch"
          :session="authority.session" :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminSiteConfig v-if="section.section === 'site' && authority.session.siteConfigEnabled" :key="sessionEpoch"
          :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminAppearance v-if="section.section === 'site' && authority.session.appearanceEnabled" :key="sessionEpoch"
          :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminSitePages v-if="section.section === 'site'" :key="sessionEpoch" :session-signal="sessionAuthority.signal" @session-lost="handleSessionLoss" />
        <AdminSystemDiagnostics v-if="section.section === 'site'" :key="sessionEpoch"
          :session="authority.session" :session-signal="sessionAuthority.signal"
          @session-lost="handleSessionLoss" @authority-changed="setAuthority" />
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
.admin-session-actions {
  align-items: center;
}
.admin-handle-dialog-body {
  display: grid;
  gap: var(--fsus-space-3);
}
.admin-handle-desc {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
  line-height: 1.55;
}
.admin-handle-field {
  display: grid;
  gap: 6px;
}
.admin-handle-field label {
  color: var(--el-text-color-regular);
  font-size: var(--el-font-size-small);
  font-weight: 500;
}
.admin-handle-hint,
.admin-handle-validation {
  margin: 0;
  font-size: var(--el-font-size-small);
  line-height: 1.5;
}
.admin-handle-hint {
  color: var(--el-text-color-secondary);
}
.admin-handle-validation {
  color: var(--el-color-danger);
}
</style>
