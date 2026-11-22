<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ElAlert,
  ElButton,
  ElCollectionToolbar,
  ElDialog,
  ElEmptyState,
  ElInlineActions,
  ElInput,
  ElOption,
  ElResourceList,
  ElResourceListItem,
  ElSelect,
  ElSkeleton,
  ElTag,
  ElTaskPageHeader,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  appealReason,
  authorCommentSearchLimit,
  readAuthorAppeals,
  submitAuthorAppeal,
  validAuthorCommentQuery,
  type AuthorAppeal,
  type AuthorCommentStatusFilter,
} from '../../../Contracts/comment-appeals'
import { commentAuthorEditDetail, deleteOwnComment, editOwnComment } from '../../../Contracts/comment-author'
import { WireLimits } from '../../../Contracts/wire.generated'
import { useDelayedBusy } from '../delayedBusy'
import { currentSession, credentialEpoch, identityEpoch } from '../session'

const rows = shallowRef<AuthorAppeal[] | null>(null)
const busy = ref(false)
const busySource = ref<'initial' | 'refresh' | 'search' | 'more' | null>(null)
const submittingAppeal = ref(false)
const failure = ref('')
const selected = ref<string>()
const reason = ref('')
const more = ref(false)
const notice = ref('')
const editEnabled = ref(false)
const editTarget = shallowRef<{ comment: string; article: number; handle: string }>()
const editDetail = shallowRef<Awaited<ReturnType<typeof commentAuthorEditDetail>>>()
const editBody = ref('')
const editPending = ref<'detail' | 'save'>()
const editProblem = ref('')
const deleteTarget = shallowRef<AuthorAppeal | null>(null)
const deletePending = ref(false)
const deleteProblem = ref('')
const keywordInput = ref('')
const appliedKeyword = ref('')
const statusFilter = ref<AuthorCommentStatusFilter>('all')
const encoder = new TextEncoder()

const refreshLoading = useDelayedBusy(() => busy.value && busySource.value === 'refresh')
const searchLoading = useDelayedBusy(() => busy.value && busySource.value === 'search')
const moreLoading = useDelayedBusy(() => busy.value && busySource.value === 'more')
const hasActiveFilter = computed(() => Boolean(appliedKeyword.value) || statusFilter.value !== 'all')
const locked = computed(() => Boolean(editTarget.value) || deletePending.value || submittingAppeal.value)

const editContent = computed(() => editBody.value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  .replace(/\r\n|[\r\u0085\u2028\u2029]/gu, '\n'))
const editReady = computed(() => Boolean(editDetail.value && !editPending.value && !editProblem.value &&
  editContent.value.trim() && editContent.value !== editDetail.value.body && editContent.value.length <= 1000 &&
  encoder.encode(editContent.value).length <= WireLimits.PublicCommentBodyBytes &&
  !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cs}]/u.test(editContent.value)))

const statuses = computed(() => [t('account.message155'), t('account.message156'), t('account.message157'), t('account.message158')] as const)
const appeals = computed(() => ['', t('account.message159'), t('account.message160'), t('account.message161'), t('account.message162'), t('account.message163')] as const)
const statusFilterOptions = computed<ReadonlyArray<{ value: AuthorCommentStatusFilter; label: string }>>(() => [
  { value: 'all', label: t('account.commentsFilterAll') },
  { value: 'pending', label: t('account.message155') },
  { value: 'approved', label: t('account.message156') },
  { value: 'rejected', label: t('account.message157') },
  { value: 'hidden', label: t('account.message158') },
])
const statusTagTypes = ['warning', 'success', 'danger', 'info'] as const
const appealTagTypes = ['', '', 'warning', 'success', 'danger', 'info'] as const

let scope = new AbortController()
let listRequest: AbortController | undefined
let editRequest: AbortController | undefined
let deleteRequest: AbortController | undefined

function statusTagType(status: number) {
  return statusTagTypes[status] ?? 'info'
}

function appealTagType(appeal: number) {
  return appealTagTypes[appeal] ?? 'info'
}

function clearForm() {
  selected.value = undefined
  reason.value = ''
}

function clearDelete() {
  deleteRequest?.abort()
  deleteRequest = undefined
  deleteTarget.value = null
  deletePending.value = false
  deleteProblem.value = ''
}

function activeQuery() {
  return {
    q: appliedKeyword.value || undefined,
    status: statusFilter.value,
  }
}

function abortListRequest() {
  listRequest?.abort()
  listRequest = undefined
  busy.value = false
  busySource.value = null
}

async function load(
  append = false,
  source: 'initial' | 'refresh' | 'search' | 'more' = append ? 'more' : 'refresh',
  message = t('account.message164'),
) {
  const session = currentSession.value?.siteSessionId
  if (!session || locked.value) return
  if (append && busy.value) return
  listRequest?.abort()
  const request = new AbortController()
  listRequest = request
  const before = append ? rows.value?.at(-1)?.comment ?? null : null
  busy.value = true
  busySource.value = source
  failure.value = ''
  try {
    const page = await readAuthorAppeals(before, session, request.signal, activeQuery())
    if (request.signal.aborted || listRequest !== request) return
    rows.value = before ? [...(rows.value ?? []), ...page.rows] : page.rows
    more.value = page.more
    editEnabled.value = page.editEnabled
  } catch {
    if (!request.signal.aborted && listRequest === request) failure.value = message
  } finally {
    if (listRequest === request) {
      listRequest = undefined
      busy.value = false
      busySource.value = null
    }
  }
}

function submitSearch() {
  if (locked.value) return
  const trimmed = keywordInput.value.trim()
  if (!validAuthorCommentQuery(trimmed)) {
    failure.value = t('account.message164')
    return
  }
  appliedKeyword.value = trimmed
  clearForm()
  void load(false, 'search')
}

function clearSearch() {
  if (locked.value) return
  keywordInput.value = ''
  if (!appliedKeyword.value) return
  appliedKeyword.value = ''
  clearForm()
  void load(false, 'search')
}

function onStatusFilterChange() {
  if (locked.value) return
  clearForm()
  void load(false, 'search')
}

function resetFilters() {
  if (locked.value) return
  keywordInput.value = ''
  appliedKeyword.value = ''
  statusFilter.value = 'all'
  clearForm()
  void load(false, 'search')
}

async function submit(comment: string) {
  const session = currentSession.value?.siteSessionId
  if (!session || locked.value || selected.value !== comment || !appealReason(reason.value)) return
  abortListRequest()
  const signal = scope.signal
  const explanation = reason.value
  submittingAppeal.value = true
  failure.value = ''
  try {
    await submitAuthorAppeal(comment, explanation, session, signal)
    if (signal.aborted) return
    clearForm()
    rows.value = rows.value?.map(row => row.comment === comment ? { ...row, appeal: 2 } : row) ?? null
    notice.value = t('account.message165')
  } catch {
    if (!signal.aborted) failure.value = t('account.message166')
  } finally {
    if (!signal.aborted) submittingAppeal.value = false
  }
}

function canEdit(row: AuthorAppeal) {
  return editEnabled.value && row.editable && row.status === 0 && row.appeal === 0 && !!row.body
}

function canDelete(row: AuthorAppeal) {
  return !!row.body
}

function clearEdit() {
  editRequest?.abort()
  editRequest = undefined
  editTarget.value = undefined
  editDetail.value = undefined
  editBody.value = ''
  editPending.value = undefined
  editProblem.value = ''
}

function liveHandle() {
  const session = currentSession.value
  return session && session.expiresAt > Date.now() ? session.siteSessionId : undefined
}

function startEditRequest(pending: 'detail' | 'save') {
  const request = new AbortController()
  editRequest = request
  editPending.value = pending
  return request
}

function finishEditRequest(request: AbortController) {
  if (editRequest !== request) return
  editRequest = undefined
  editPending.value = undefined
}

async function openEdit(row: AuthorAppeal) {
  const handle = liveHandle()
  if (!handle || busy.value || locked.value || !canEdit(row) || !rows.value?.includes(row)) return
  clearForm()
  clearDelete()
  notice.value = ''
  failure.value = ''
  const target = { comment: row.comment, article: row.article, handle }
  editTarget.value = target
  const request = startEditRequest('detail')
  try {
    const detail = await commentAuthorEditDetail(target.comment, handle, request.signal, true)
    if (request.signal.aborted) return
    if (liveHandle() !== handle) {
      clearEdit()
      return
    }
    if (detail.articleId !== target.article) {
      editProblem.value = t('account.message167')
      return
    }
    editDetail.value = detail
    editBody.value = detail.body
  } catch {
    if (!request.signal.aborted) editProblem.value = t('account.message168')
  } finally {
    finishEditRequest(request)
  }
}

async function saveEdit() {
  const target = editTarget.value
  const detail = editDetail.value
  if (!target || !detail || !editReady.value || liveHandle() !== target.handle ||
      !rows.value?.some(row => row.comment === target.comment && row.article === target.article && canEdit(row))) return
  const request = startEditRequest('save')
  try {
    await editOwnComment(target.comment, detail.currentVersion, editContent.value, target.handle, request.signal)
    if (request.signal.aborted) return
    if (liveHandle() !== target.handle) {
      clearEdit()
      return
    }
    clearEdit()
    rows.value = null
    more.value = false
    editEnabled.value = false
    notice.value = t('account.message169')
    await load(false, 'initial', t('account.message170'))
  } catch (error) {
    if (!request.signal.aborted) editProblem.value = error instanceof ApiError && error.status === 409
      ? t('account.message171') : t('account.message172')
  } finally {
    finishEditRequest(request)
  }
}

function reloadAfterEditProblem() {
  clearEdit()
  rows.value = null
  more.value = false
  editEnabled.value = false
  void load(false, 'refresh')
}

function requestDelete(row: AuthorAppeal) {
  if (busy.value || locked.value || !canDelete(row)) return
  clearForm()
  deleteProblem.value = ''
  deleteTarget.value = row
}

function closeDeleteDialog() {
  if (deletePending.value) return
  clearDelete()
}

async function confirmDelete() {
  const target = deleteTarget.value
  const handle = liveHandle()
  if (!target || !handle || deletePending.value) return
  const request = new AbortController()
  deleteRequest = request
  deletePending.value = true
  deleteProblem.value = ''
  notice.value = ''
  try {
    await deleteOwnComment(target.comment, handle, request.signal)
    if (request.signal.aborted || liveHandle() !== handle) return
    clearDelete()
    notice.value = t('account.commentsDeleteSuccess')
    await load(false, 'refresh')
  } catch {
    if (!request.signal.aborted) deleteProblem.value = t('account.commentsDeleteFailed')
  } finally {
    if (deleteRequest === request) {
      deleteRequest = undefined
      deletePending.value = false
    }
  }
}

watch([identityEpoch, credentialEpoch], () => {
  scope.abort()
  scope = new AbortController()
  abortListRequest()
  submittingAppeal.value = false
  rows.value = null
  more.value = false
  editEnabled.value = false
  failure.value = ''
  notice.value = ''
  keywordInput.value = ''
  appliedKeyword.value = ''
  statusFilter.value = 'all'
  clearForm()
  clearEdit()
  clearDelete()
  void load(false, 'initial')
}, { immediate: true, flush: 'sync' })

onBeforeUnmount(() => {
  scope.abort()
  abortListRequest()
  clearEdit()
  clearDelete()
})
</script>

<template>
  <main class="own-comments-page" aria-labelledby="own-comments-title">
    <ElTaskPageHeader
      :key="currentSession ? 'signed-in' : 'signed-out'"
      :description="currentSession ? t('account.commentsSummary') : undefined"
      density="compact"
    >
      <template #title>
        <span id="own-comments-title">{{ t('account.message111') }}</span>
      </template>
      <template v-if="currentSession" #actions>
        <ElButton
          native-type="button"
          text
          :loading="refreshLoading"
          :disabled="locked"
          @click="load(false, 'refresh')"
        >{{ t('account.message141') }}</ElButton>
      </template>
    </ElTaskPageHeader>

    <ElCollectionToolbar
      v-if="currentSession"
      class="own-comments-toolbar"
      :ariaLabel="t('account.commentsToolbarLabel')"
      density="compact"
    >
      <template #primary>
        <form class="own-comments-search-form" @submit.prevent="submitSearch">
          <ElInput
            id="own-comments-search"
            v-model="keywordInput"
            :placeholder="t('account.commentsSearchPlaceholder')"
            :disabled="locked"
            clearable
            v-bind="{
              maxlength: authorCommentSearchLimit,
              enterkeyhint: 'search',
              'aria-label': t('account.commentsSearchLabel'),
            }"
            @clear="clearSearch"
          />
          <ElButton native-type="submit" :loading="searchLoading" :disabled="locked">
            {{ t('account.commentsSearchAction') }}
          </ElButton>
        </form>
      </template>

      <template #filters>
        <ElSelect
          v-model="statusFilter"
          class="own-comments-status-filter"
          :ariaLabel="t('account.commentsStatusFilter')"
          :disabled="locked"
          @change="onStatusFilterChange"
        >
          <ElOption
            v-for="option in statusFilterOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </ElSelect>
      </template>

      <template v-if="hasActiveFilter" #actions>
        <ElButton
          native-type="button"
          text
          :disabled="locked"
          @click="resetFilters"
        >{{ t('account.commentsResetFilters') }}</ElButton>
      </template>
    </ElCollectionToolbar>

    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="notice" type="success" show-icon @close="notice = ''" />

    <ElEmptyState v-if="!currentSession" :title="t('account.message113')">
      <template #actions>
        <RouterLink class="own-comments-login-link" to="/login">{{ t('account.message140') }}</RouterLink>
      </template>
    </ElEmptyState>

    <ElSkeleton v-else-if="busy && rows === null" :rows="4" animated />

    <ElEmptyState
      v-else-if="rows?.length === 0"
      :key="hasActiveFilter ? 'empty-filtered' : 'empty-all'"
      size="inline"
      :title="hasActiveFilter ? t('account.commentsEmptyFiltered') : t('account.message142')"
      :description="hasActiveFilter ? t('account.commentsEmptyFilteredHint') : t('account.commentsEmptyDescription')"
    >
      <template v-if="hasActiveFilter" #actions>
        <ElButton native-type="button" text @click="resetFilters">
          {{ t('account.commentsResetFilters') }}
        </ElButton>
      </template>
    </ElEmptyState>

    <template v-else-if="rows">
      <ElResourceList class="own-comments-surface" :divided="false" density="compact">
        <ul class="own-comments-list" role="presentation">
          <li v-for="row in rows" :key="row.comment" class="own-comments-row" role="presentation">
            <ElResourceListItem density="compact">
              <template #title>
                <RouterLink class="own-comment-article" :to="`/article/${row.article}`">
                  {{ t('account.articleNumber', { id: row.article }) }}
                </RouterLink>
              </template>

              <template #badge>
                <span class="own-comment-badges">
                  <ElTag size="small" :type="statusTagType(row.status)" disable-transitions>
                    {{ statuses[row.status] }}
                  </ElTag>
                  <ElTag v-if="row.appeal" size="small" :type="appealTagType(row.appeal)" disable-transitions>
                    {{ appeals[row.appeal] }}
                  </ElTag>
                </span>
              </template>

              <template #actions>
                <ElInlineActions density="compact">
                  <ElButton
                    v-if="row.appeal === 1 && selected !== row.comment"
                    native-type="button"
                    text
                    type="primary"
                    :disabled="busy || locked"
                    @click="clearForm(); selected = row.comment"
                  >{{ t('account.message143') }}</ElButton>
                  <ElButton
                    v-if="canEdit(row) && editTarget?.comment !== row.comment"
                    native-type="button"
                    text
                    :disabled="busy || locked"
                    @click="openEdit(row)"
                  >{{ t('account.message146') }}</ElButton>
                  <ElButton
                    v-if="canDelete(row) && selected !== row.comment && editTarget?.comment !== row.comment"
                    native-type="button"
                    text
                    type="danger"
                    :disabled="busy || locked"
                    @click="requestDelete(row)"
                  >{{ t('account.commentsDeleteAction') }}</ElButton>
                </ElInlineActions>
              </template>

              <p v-if="row.body" class="own-comment-body">{{ row.body }}</p>
              <p v-else class="own-comment-deleted">{{ t('account.commentsDeletedPlaceholder') }}</p>

              <div v-if="row.decisionReason" class="own-comment-decision">
                <span class="own-comment-decision-label">{{ t('account.commentsDecisionReason') }}</span>
                <p class="own-comment-decision-text">{{ row.decisionReason }}</p>
              </div>

              <form
                v-if="selected === row.comment"
                class="own-comment-inline-form"
                @submit.prevent="submit(row.comment)"
              >
                <div class="own-comment-field">
                  <div class="own-comment-field-head">
                    <label :for="`appeal-reason-${row.comment}`">{{ t('account.message144') }}</label>
                    <span class="own-comment-counter">
                      {{ t('account.commentsCharCount', { count: reason.trim().length, max: 1000 }) }}
                    </span>
                  </div>
                  <ElInput
                    :id="`appeal-reason-${row.comment}`"
                    v-model="reason"
                    type="textarea"
                    :placeholder="t('account.commentsAppealPlaceholder')"
                    :autosize="{ minRows: 3, maxRows: 7 }"
                    :disabled="submittingAppeal"
                  />
                </div>
                <ElInlineActions density="compact">
                  <ElButton
                    native-type="submit"
                    type="primary"
                    :loading="submittingAppeal"
                    :disabled="!appealReason(reason)"
                  >{{ t('account.message145') }}</ElButton>
                  <ElButton native-type="button" :disabled="submittingAppeal" @click="clearForm">
                    {{ t('account.message106') }}
                  </ElButton>
                </ElInlineActions>
              </form>

              <form
                v-if="editTarget?.comment === row.comment"
                class="own-comment-inline-form"
                :aria-label="t('account.message147')"
                @submit.prevent="saveEdit"
              >
                <p v-if="editPending" class="own-comment-status" role="status">
                  {{ editPending === 'detail' ? t('account.message148') : t('account.message149') }}
                </p>
                <ElSkeleton v-if="editPending === 'detail' && !editDetail" :rows="2" animated />
                <div v-if="editDetail" class="own-comment-field">
                  <div class="own-comment-field-head">
                    <label :for="`edit-comment-${row.comment}`">{{ t('account.message150') }}</label>
                    <span class="own-comment-counter">
                      {{ t('account.commentsCharCount', { count: editContent.length, max: 1000 }) }}
                    </span>
                  </div>
                  <ElInput
                    :id="`edit-comment-${row.comment}`"
                    v-model="editBody"
                    type="textarea"
                    :placeholder="t('account.commentsEditPlaceholder')"
                    :autosize="{ minRows: 4, maxRows: 8 }"
                    v-bind="{ maxlength: 1000 }"
                    :disabled="editPending === 'save'"
                    :readonly="!!editProblem"
                  />
                </div>
                <ElAlert v-if="editProblem" :title="editProblem" type="error" :closable="false" show-icon />
                <ElInlineActions density="compact">
                  <ElButton
                    v-if="editDetail && !editProblem"
                    native-type="submit"
                    type="primary"
                    :disabled="!editReady"
                    :loading="editPending === 'save'"
                  >{{ t('account.message151') }}</ElButton>
                  <ElButton v-if="editProblem" native-type="button" @click="reloadAfterEditProblem">
                    {{ t('account.message152') }}
                  </ElButton>
                  <ElButton native-type="button" :disabled="editPending === 'save'" @click="clearEdit">
                    {{ t('account.message153') }}
                  </ElButton>
                </ElInlineActions>
              </form>
            </ElResourceListItem>
          </li>
        </ul>
      </ElResourceList>

      <div v-if="more" class="own-comments-more">
        <ElButton
          native-type="button"
          text
          :loading="moreLoading"
          :disabled="locked"
          @click="load(true, 'more')"
        >{{ t('account.message154') }}</ElButton>
      </div>
    </template>

    <ElDialog
      :model-value="Boolean(deleteTarget)"
      :title="t('account.commentsDeleteDialogTitle')"
      append-to-body
      width="min(30rem, calc(100vw - 2rem))"
      :close-on-press-escape="!deletePending"
      :close-on-click-modal="!deletePending"
      :show-close="!deletePending"
      @update:model-value="open => { if (!open) closeDeleteDialog() }"
    >
      <div v-if="deleteTarget" class="own-comment-delete-dialog">
        <ElAlert v-if="deleteProblem" :title="deleteProblem" type="error" :closable="false" show-icon />
        <p class="own-comment-delete-note">{{ t('account.commentsDeleteNote') }}</p>
        <blockquote class="own-comment-delete-preview">{{ deleteTarget.body }}</blockquote>
      </div>
      <template #footer>
        <ElInlineActions density="compact">
          <ElButton native-type="button" :disabled="deletePending" @click="closeDeleteDialog">
            {{ t('account.message106') }}
          </ElButton>
          <ElButton
            native-type="button"
            type="danger"
            :loading="deletePending"
            @click="confirmDelete"
          >{{ t('account.commentsDeleteConfirm') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </main>
</template>

<style scoped lang="scss">
@use '../shared-fields' as fields;

.own-comments-page {
  display: grid;
  align-content: start;
  gap: var(--fsus-space-4);
  min-inline-size: 0;
}

.own-comments-search-form {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--fsus-space-2);
  align-items: safe center;
  min-inline-size: 0;
  inline-size: 100%;
}

.own-comments-status-filter {
  inline-size: 10rem;
}

@media (max-width: 639px) {
  .own-comments-status-filter {
    inline-size: 100%;
  }
}

.own-comments-login-link {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--fsus-scholarly-blue);
  font-weight: 500;
}

.own-comments-surface {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--el-bg-color);
  overflow: hidden;
}

.own-comments-list {
  display: grid;
  padding: 0;
  margin: 0;
  list-style: none;
  min-inline-size: 0;
}

.own-comments-row {
  min-inline-size: 0;
}

.own-comments-row + .own-comments-row {
  border-block-start: 1px solid var(--el-border-color-lighter);
}

.own-comment-article {
  color: var(--fsus-scholarly-blue);
  text-decoration: none;
  font-weight: 700;
}

.own-comment-article:hover {
  text-decoration: underline;
  text-underline-offset: 4px;
}

.own-comment-badges {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: safe center;
  gap: 6px;
}

.own-comment-body {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: var(--el-font-size-base);
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.own-comment-deleted {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
  font-style: italic;
}

.own-comment-decision {
  display: grid;
  gap: 4px;
  margin-block-start: 4px;
  padding: var(--fsus-space-2) var(--fsus-space-3);
  border-inline-start: 2px solid var(--el-border-color-darker);
  border-radius: 0 var(--fsus-radius-control-small, 4px) var(--fsus-radius-control-small, 4px) 0;
  background: var(--el-fill-color-lighter);
}

.own-comment-decision-label {
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-extra-small);
  font-weight: 500;
  line-height: 1.4;
}

.own-comment-decision-text {
  margin: 0;
  color: var(--el-text-color-regular);
  font-size: var(--el-font-size-small);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.own-comment-inline-form {
  display: grid;
  gap: var(--fsus-space-3);
  margin-block-start: var(--fsus-space-2);
  padding: var(--fsus-space-3);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--el-fill-color-lighter);
}

.own-comment-field {

  @include fields.account-field;
}

.own-comment-field-head {
  display: flex;
  flex-wrap: wrap;
  align-items: safe center;
  justify-content: space-between;
  gap: var(--fsus-space-2);
}

.own-comment-field-head label {

  @include fields.account-label;
}

.own-comment-counter {
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-extra-small);
  font-variant-numeric: tabular-nums;
}

.own-comment-status {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
}

.own-comments-more {
  display: flex;
  justify-content: center;
}

.own-comment-delete-dialog {
  display: grid;
  gap: var(--fsus-space-3);
}

.own-comment-delete-note {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
  line-height: 1.6;
}

.own-comment-delete-preview {
  margin: 0;
  padding: var(--fsus-space-3);
  border-inline-start: 2px solid var(--el-border-color);
  border-radius: 0 var(--fsus-radius-control-small, 4px) var(--fsus-radius-control-small, 4px) 0;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-primary);
  font-size: var(--el-font-size-small);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-block-size: 9rem;
  overflow-y: auto;
}
</style>
