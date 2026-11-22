<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElDialog, ElEmptyState, ElInlineActions, ElInput,
  ElRadioButton, ElRadioGroup, ElResourceList, ElResourceListItem, ElSkeleton, ElTag,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import type { AdminSession } from '../../../Contracts/admin-identity'
import {
  executeReaderStatusChange,
  readAdminReaderAccounts,
  requestReaderStatusProof,
  validReaderGovernanceReason,
  type AdminReaderAccount,
  type AdminReaderAccountPage,
  type AdminReaderStatusCommand,
  type AdminReaderStatusFilter,
} from '../../../Contracts/admin-readers'
import { WireLimits } from '../../../Contracts/wire.generated'
import { t, type MessageKey } from '../siteLocale'
import { useDelayedBusy } from '../delayedBusy'
import { watchAdminSessionClear } from './adminSessionClear'

type LoadSource = 'initial' | 'search' | 'filter' | 'refresh' | 'more' | 'after-mutation'

const props = defineProps<{ session: AdminSession; sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()

const page = shallowRef<AdminReaderAccountPage | null>(null)
const items = shallowRef<AdminReaderAccount[]>([])
const keyword = ref('')
const appliedKeyword = ref('')
const statusFilter = ref<AdminReaderStatusFilter>('all')
const loading = ref(false)
const loadingSource = ref<LoadSource | null>(null)
const submitting = ref(false)
const failure = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
const noticeParams = shallowRef<Record<string, string | number>>({})

const target = shallowRef<AdminReaderAccount | null>(null)
const targetEnabled = ref(false)
const reason = ref('')
const reasonTouched = ref(false)
const dialogFailure = ref<MessageKey | ''>('')
const retryCommand = shallowRef<AdminReaderStatusCommand | null>(null)

let activeRequest: AbortController | undefined
const lifetime = new AbortController()
const busy = computed(() => loading.value || submitting.value)
const searchLoading = useDelayedBusy(() => loading.value && loadingSource.value === 'search')
const refreshLoading = useDelayedBusy(() => loading.value && loadingSource.value === 'refresh')
const moreLoading = useDelayedBusy(() => loading.value && loadingSource.value === 'more')
const reasonValid = computed(() => validReaderGovernanceReason(reason.value))
const reasonInvalid = computed(() => reasonTouched.value && !reasonValid.value)

function clearState() {
  activeRequest?.abort()
  activeRequest = undefined
  page.value = null
  items.value = []
  loading.value = false
  loadingSource.value = null
  submitting.value = false
  failure.value = ''
  notice.value = ''
  noticeParams.value = {}
  closeDialog(true)
}

function closeDialog(force = false) {
  if (submitting.value && !force) return
  target.value = null
  reason.value = ''
  reasonTouched.value = false
  dialogFailure.value = ''
  retryCommand.value = null
}

function openAction(account: AdminReaderAccount, nextEnabled: boolean) {
  if (submitting.value) return
  target.value = account
  targetEnabled.value = nextEnabled
  reason.value = ''
  reasonTouched.value = false
  dialogFailure.value = ''
  retryCommand.value = null
}

function onReasonInput() {
  dialogFailure.value = ''
  retryCommand.value = null
}

async function load(append = false, source: LoadSource = append ? 'more' : 'refresh') {
  if (props.sessionSignal.aborted || submitting.value) return
  activeRequest?.abort()
  const current = activeRequest = new AbortController()
  const signal = AbortSignal.any([current.signal, props.sessionSignal, lifetime.signal])
  loading.value = true
  loadingSource.value = source
  failure.value = ''
  if (!append) notice.value = ''
  try {
    const after = append && page.value?.hasMore
      ? { accountId: page.value.nextCursorAccountId, userId: page.value.nextCursorUserId }
      : undefined
    const next = await readAdminReaderAccounts(props.session, {
      status: statusFilter.value,
      keyword: appliedKeyword.value,
      after,
    }, signal)
    if (signal.aborted) return
    page.value = next
    items.value = append ? [...items.value, ...next.items] : [...next.items]
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else failure.value = 'admin.readers.loadFailed'
  } finally {
    if (activeRequest === current) {
      activeRequest = undefined
      loading.value = false
      loadingSource.value = null
    }
  }
}

function submitSearch() {
  appliedKeyword.value = keyword.value.trim()
  void load(false, 'search')
}

function clearSearch() {
  keyword.value = ''
  appliedKeyword.value = ''
  statusFilter.value = 'all'
  void load(false, 'filter')
}

function selectStatus(value: string | number | boolean | undefined) {
  if (value !== 'all' && value !== 'enabled' && value !== 'disabled') return
  if (statusFilter.value === value) return
  statusFilter.value = value
  void load(false, 'filter')
}

async function submitGovernance() {
  const account = target.value
  if (!account || submitting.value || props.sessionSignal.aborted) return
  reasonTouched.value = true
  const trimmedReason = reason.value.trim()
  if (!validReaderGovernanceReason(trimmedReason)) return

  const pending = retryCommand.value
  const command: AdminReaderStatusCommand = pending ?? {
    userId: account.userId,
    expectedGeneration: account.generation,
    targetEnabled: targetEnabled.value,
    idempotencyKey: crypto.randomUUID(),
    reason: trimmedReason,
  }

  activeRequest?.abort()
  loading.value = false
  loadingSource.value = null
  const current = activeRequest = new AbortController()
  const signal = AbortSignal.any([current.signal, props.sessionSignal, lifetime.signal])
  submitting.value = true
  dialogFailure.value = ''
  let submitted = Boolean(pending)
  try {
    const proof = pending ? undefined : await requestReaderStatusProof(command, signal)
    signal.throwIfAborted()
    submitted = true
    const receipt = await executeReaderStatusChange(props.session, command, proof, signal)
    if (signal.aborted) return
    const label = accountLabel(account)
    closeDialog(true)
    noticeParams.value = {
      account: label,
      sessions: receipt.revokedSessionCount,
    }
    notice.value = receipt.enabled ? 'admin.readers.enabledNotice' : 'admin.readers.disabledNotice'
    submitting.value = false
    await load(false, 'after-mutation')
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) {
      closeDialog(true)
      emit('session-lost', cause)
    } else if (cause instanceof ApiError && cause.status === 409) {
      retryCommand.value = null
      dialogFailure.value = 'admin.readers.conflict'
      submitting.value = false
      await load(false, 'after-mutation')
    } else if (cause instanceof ApiError && cause.status === 428) {
      retryCommand.value = null
      dialogFailure.value = 'admin.readers.proofRequired'
    } else if (submitted && (!(cause instanceof ApiError) || cause.status >= 500)) {
      retryCommand.value = command
      dialogFailure.value = 'admin.readers.unconfirmed'
    } else if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
      dialogFailure.value = 'admin.readers.passkeyCanceled'
    } else {
      dialogFailure.value = 'admin.readers.actionFailed'
    }
  } finally {
    if (activeRequest === current) activeRequest = undefined
    submitting.value = false
  }
}

function accountLabel(item: AdminReaderAccount): string {
  return item.displayName || item.name
}

function formatTime(unixMs: bigint): string {
  return new Date(Number(unixMs)).toLocaleString()
}

function securitySummary(item: AdminReaderAccount): string {
  const parts = [
    item.passkeyCount > 0
      ? t('admin.readers.passkeyCount', { count: item.passkeyCount })
      : t('admin.readers.noPasskey'),
    t('admin.readers.activeSessions', { count: item.activeSessionCount }),
    t('admin.readers.comments', { count: item.commentCount }),
  ]
  if (item.hasRecoveryKey) parts.push(t('admin.readers.recoveryConfigured'))
  if (item.hasTotp) parts.push(t('admin.readers.totpConfigured'))
  return parts.join(' · ')
}

watchAdminSessionClear(() => [props.session, props.sessionSignal] as const, clearState)
watch(() => props.sessionSignal, signal => {
  if (!signal.aborted && page.value === null && !loading.value) void load(false, 'initial')
})
onMounted(() => {
  if (!props.sessionSignal.aborted && page.value === null) void load(false, 'initial')
})
onBeforeUnmount(() => {
  activeRequest?.abort()
  lifetime.abort()
})
</script>

<template>
  <section class="admin-readers" aria-labelledby="admin-readers-heading" :aria-busy="busy">
    <h2 id="admin-readers-heading" class="readers-sr-title">{{ t('admin.readers.heading') }}</h2>

    <div class="readers-toolbar">
      <div class="readers-search-region" role="search">
        <form class="readers-search-form" @submit.prevent="submitSearch">
          <label for="admin-readers-keyword">{{ t('admin.readers.searchLabel') }}</label>
          <ElInput
            id="admin-readers-keyword"
            v-model="keyword"
            :placeholder="t('admin.readers.searchPlaceholder')"
            :disabled="submitting"
            clearable
            v-bind="{ maxlength: WireLimits.AdminReaderKeywordChars, autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' }"
          />
          <ElButton native-type="submit" :disabled="submitting" :loading="searchLoading">{{ t('admin.readers.search') }}</ElButton>
        </form>
      </div>
      <div class="readers-filter-row">
        <ElRadioGroup
          class="readers-status-group fsus-radio-group--touch"
          size="small"
          :label="t('admin.readers.statusFilter')"
          :model-value="statusFilter"
          :disabled="submitting"
          @update:model-value="selectStatus"
        >
          <ElRadioButton value="all">
            {{ page ? t('admin.readers.filterAllCount', { count: page.enabledTotal + page.disabledTotal }) : t('admin.readers.filterAll') }}
          </ElRadioButton>
          <ElRadioButton value="enabled">
            {{ page ? t('admin.readers.filterEnabledCount', { count: page.enabledTotal }) : t('admin.readers.filterEnabled') }}
          </ElRadioButton>
          <ElRadioButton value="disabled">
            {{ page ? t('admin.readers.filterDisabledCount', { count: page.disabledTotal }) : t('admin.readers.filterDisabled') }}
          </ElRadioButton>
        </ElRadioGroup>
        <ElInlineActions>
          <ElButton v-if="appliedKeyword || statusFilter !== 'all'" native-type="button" text :disabled="submitting" @click="clearSearch">
            {{ t('admin.readers.resetFilters') }}
          </ElButton>
          <ElButton native-type="button" text :loading="refreshLoading" :disabled="submitting" @click="load(false, 'refresh')">
            {{ t('admin.readers.refresh') }}
          </ElButton>
        </ElInlineActions>
      </div>
    </div>

    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="t(notice, noticeParams)" type="success" :closable="false" show-icon />
    <ElSkeleton v-if="loading && page === null" :rows="4" animated />

    <template v-else-if="page">
      <p class="readers-summary" role="status">{{ t('admin.readers.countSummary', { count: page.total }) }}</p>
      <ElEmptyState
        v-if="items.length === 0"
        size="inline"
        :title="t(appliedKeyword || statusFilter !== 'all' ? 'admin.readers.emptyFiltered' : 'admin.readers.empty')"
        role="status"
      />
      <ElResourceList v-else class="readers-list" density="compact">
        <ElResourceListItem
          v-for="item in items"
          :key="item.userId"
          :title="accountLabel(item)"
        >
          <template #meta>
            <div class="readers-item-tags">
              <ElTag size="small" :type="item.enabled ? 'success' : 'danger'">
                {{ t(item.enabled ? 'admin.readers.statusEnabled' : 'admin.readers.statusDisabled') }}
              </ElTag>
              <span v-if="item.accountId > 0" class="readers-mono">#{{ item.accountId }}</span>
              <span v-if="item.displayName && item.displayName !== item.name" class="readers-mono">{{ item.name }}</span>
              <span>{{ t('admin.readers.generation', { generation: item.generation.toString() }) }}</span>
            </div>
            <p class="readers-meta-line">{{ securitySummary(item) }}</p>
            <p v-if="item.registeredAtUnixMs > 0n || item.lastUsedAtUnixMs > 0n" class="readers-meta-line">
              <template v-if="item.registeredAtUnixMs > 0n">
                {{ t('admin.readers.registeredAt') }}
                <time :datetime="new Date(Number(item.registeredAtUnixMs)).toISOString()">{{ formatTime(item.registeredAtUnixMs) }}</time>
              </template>
              <template v-if="item.registeredAtUnixMs > 0n && item.lastUsedAtUnixMs > 0n"> · </template>
              <template v-if="item.lastUsedAtUnixMs > 0n">
                {{ t('admin.readers.lastUsedAt') }}
                <time :datetime="new Date(Number(item.lastUsedAtUnixMs)).toISOString()">{{ formatTime(item.lastUsedAtUnixMs) }}</time>
              </template>
            </p>
            <p v-if="item.lastGovernanceAtUnixMs > 0n" class="readers-meta-line readers-audit-line">
              {{ t('admin.readers.lastGovernance', {
                actor: item.lastGovernanceActor,
                time: formatTime(item.lastGovernanceAtUnixMs),
                reason: item.lastGovernanceReason,
              }) }}
            </p>
          </template>
          <template #actions>
            <ElButton
              v-if="item.enabled"
              native-type="button"
              text
              type="danger"
              :disabled="submitting"
              @click="openAction(item, false)"
            >{{ t('admin.readers.disableAction') }}</ElButton>
            <ElButton
              v-else
              native-type="button"
              text
              :disabled="submitting"
              @click="openAction(item, true)"
            >{{ t('admin.readers.enableAction') }}</ElButton>
          </template>
        </ElResourceListItem>
      </ElResourceList>

      <div v-if="page.hasMore" class="readers-more">
        <ElButton native-type="button" text :loading="moreLoading" :disabled="submitting" @click="load(true, 'more')">
          {{ t('admin.readers.loadMore') }}
        </ElButton>
      </div>
    </template>

    <ElDialog
      :model-value="target !== null"
      :title="t(targetEnabled ? 'admin.readers.enableDialogTitle' : 'admin.readers.disableDialogTitle')"
      append-to-body
      width="min(30rem, calc(100vw - 2rem))"
      :close-on-press-escape="!submitting"
      :close-on-click-modal="!submitting"
      :show-close="!submitting"
      @update:model-value="open => { if (!open) closeDialog() }"
    >
      <form v-if="target" id="admin-reader-governance-form" class="readers-dialog-body" @submit.prevent="submitGovernance">
        <ElAlert v-if="dialogFailure" :title="t(dialogFailure)" type="error" :closable="false" show-icon />
        <p class="readers-dialog-target">
          <strong>{{ accountLabel(target) }}</strong>
          <span v-if="target.accountId > 0" class="readers-mono"> #{{ target.accountId }}</span>
        </p>
        <p class="readers-dialog-desc">
          {{ t(targetEnabled ? 'admin.readers.enableConsequence' : 'admin.readers.disableConsequence', {
            sessions: target.activeSessionCount,
          }) }}
        </p>
        <div class="readers-field">
          <label for="admin-reader-governance-reason">{{ t('admin.readers.reasonLabel') }}</label>
          <ElInput
            id="admin-reader-governance-reason"
            v-model="reason"
            type="textarea"
            :disabled="submitting"
            :placeholder="t('admin.readers.reasonPlaceholder')"
            v-bind="{ maxlength: WireLimits.AdminReaderReasonChars, 'aria-describedby': 'admin-reader-governance-reason-hint', 'aria-invalid': reasonInvalid ? 'true' : undefined }"
            @input="onReasonInput"
            @blur="reasonTouched = true"
          />
          <p id="admin-reader-governance-reason-hint" :class="reasonInvalid ? 'readers-validation' : 'readers-hint'">
            {{ t('admin.readers.reasonHint') }}
          </p>
        </div>
      </form>
      <template #footer>
        <ElInlineActions>
          <ElButton native-type="button" :disabled="submitting" @click="closeDialog()">
            {{ t('admin.readers.cancel') }}
          </ElButton>
          <ElButton
            native-type="submit"
            v-bind="{ form: 'admin-reader-governance-form' }"
            :type="targetEnabled ? 'primary' : 'danger'"
            :loading="submitting"
            :disabled="submitting"
          >
            {{ retryCommand
              ? t('admin.readers.retryConfirm')
              : t(targetEnabled ? 'admin.readers.confirmEnable' : 'admin.readers.confirmDisable') }}
          </ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.admin-readers {
  display: grid;
  gap: var(--fsus-space-3);
  min-width: 0;
}
.readers-sr-title {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.readers-toolbar {
  display: grid;
  gap: var(--fsus-space-3);
}
.readers-search-region {
  display: block;
}
.readers-search-form {
  display: grid;
  grid-template-columns: auto minmax(12rem, 28rem) auto;
  align-items: center;
  justify-content: start;
  gap: 10px;
}
.readers-search-form label,
.readers-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}
.readers-filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.readers-status-group {
  max-inline-size: 100%;
}
.readers-summary {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
}
.readers-item-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-block-end: 4px;
}
.readers-mono {
  font-family: var(--el-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
.readers-meta-line {
  margin: 2px 0 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.readers-audit-line {
  color: var(--el-text-color-regular);
}
.readers-more {
  display: flex;
  justify-content: flex-start;
}
.readers-dialog-body {
  display: grid;
  gap: 12px;
}
.readers-dialog-target,
.readers-dialog-desc {
  margin: 0;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.readers-dialog-desc {
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
}
.readers-field {
  display: grid;
  gap: 6px;
}
.readers-hint,
.readers-validation {
  margin: 0;
  font-size: var(--el-font-size-small);
}
.readers-hint {
  color: var(--el-text-color-secondary);
}
.readers-validation {
  color: var(--el-color-danger);
}
@media (max-width: 40rem) {
  .readers-search-form {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .readers-search-form label {
    grid-column: 1 / -1;
  }
}
</style>
