<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { appealReason, readAuthorAppeals, submitAuthorAppeal, type AuthorAppeal } from '../../../Contracts/comment-appeals'
import { commentAuthorEditDetail, editOwnComment } from '../../../Contracts/comment-author'
import { WireLimits } from '../../../Contracts/wire.generated'
import { currentSession, credentialEpoch, identityEpoch } from '../session'

const rows = shallowRef<AuthorAppeal[] | null>(null)
const busy = ref(false)
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
const encoder = new TextEncoder()
const editContent = computed(() => editBody.value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  .replace(/\r\n|[\r\u0085\u2028\u2029]/gu, '\n'))
const editReady = computed(() => Boolean(editDetail.value && !editPending.value && !editProblem.value &&
  editContent.value.trim() && editContent.value !== editDetail.value.body && editContent.value.length <= 1000 &&
  encoder.encode(editContent.value).length <= WireLimits.PublicCommentBodyBytes &&
  !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cs}]/u.test(editContent.value)))
const statuses = computed(() => [t('account.message155'), t('account.message156'), t('account.message157'), t('account.message158')] as const)
const appeals = computed(() => ['', t('account.message159'), t('account.message160'), t('account.message161'), t('account.message162'), t('account.message163')] as const)
let scope = new AbortController()
let editRequest: AbortController | undefined

function clearForm() {
  selected.value = undefined
  reason.value = ''
}

async function run(action: (session: string, signal: AbortSignal) => Promise<void>, message: string) {
  const session = currentSession.value?.siteSessionId
  if (!session || busy.value) return
  const signal = scope.signal
  busy.value = true
  failure.value = ''
  try { await action(session, signal) }
  catch { if (!signal.aborted) failure.value = message }
  finally { if (!signal.aborted) busy.value = false }
}

async function reload(before: string | null, session: string, signal: AbortSignal) {
  const page = await readAuthorAppeals(before, session, signal)
  if (signal.aborted) return
  rows.value = before ? [...(rows.value ?? []), ...page.rows] : page.rows
  more.value = page.more
  editEnabled.value = page.editEnabled
}

function load(append = false) {
  if (editTarget.value) return
  return run((session, signal) => reload(append ? rows.value?.at(-1)?.comment ?? null : null, session, signal),
    t('account.message164'))
}

function submit(comment: string) {
  if (editTarget.value || selected.value !== comment || !appealReason(reason.value)) return
  const explanation = reason.value
  return run(async (session, signal) => {
    await submitAuthorAppeal(comment, explanation, session, signal)
    if (signal.aborted) return
    clearForm()
    rows.value = rows.value?.map(row => row.comment === comment ? { ...row, appeal: 2 } : row) ?? null
    notice.value = t('account.message165')
  }, t('account.message166'))
}

function canEdit(row: AuthorAppeal) {
  return editEnabled.value && row.status === 0 && row.appeal === 0 && !!row.body
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
  if (!handle || busy.value || editTarget.value || !canEdit(row) || !rows.value?.includes(row)) return
  clearForm()
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
    await run((session, signal) => reload(null, session, signal), t('account.message170'))
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
  void load()
}

watch([identityEpoch, credentialEpoch], () => {
  scope.abort()
  scope = new AbortController()
  rows.value = null
  busy.value = false
  more.value = false
  editEnabled.value = false
  failure.value = ''
  notice.value = ''
  clearForm()
  clearEdit()
  void load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => {
  scope.abort()
  clearEdit()
})
</script>

<template>
  <section class="own-comments reading-column" aria-labelledby="own-comments-title">
    <h1 id="own-comments-title">{{ t('account.message111') }}</h1>
    <p v-if="!currentSession"><RouterLink to="/login">{{ t('account.message140') }}</RouterLink></p>
    <template v-else>
      <ElButton native-type="button" :loading="busy" :disabled="!!editTarget" @click="load()">{{ t('account.message141') }}</ElButton>
      <ElAlert v-if="failure" :title="failure" type="error" :closable="false" />
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="rows?.length === 0">{{ t('account.message142') }}</p>
      <ul v-else-if="rows" class="own-comments-list">
        <li v-for="row in rows" :key="row.comment">
          <RouterLink :to="`/article/${row.article}`">{{ t('account.articleNumber', { id: row.article }) }}</RouterLink>
          <p>{{ statuses[row.status] }}<template v-if="row.appeal"> · {{ appeals[row.appeal] }}</template></p>
          <p v-if="row.body" class="own-comment-text">{{ row.body }}</p>
          <p v-if="row.decisionReason" class="own-comment-text">{{ row.decisionReason }}</p>
          <ElButton v-if="row.appeal === 1 && selected !== row.comment" native-type="button" :disabled="busy || !!editTarget"
            @click="clearForm(); selected = row.comment">{{ t('account.message143') }}</ElButton>
          <form v-if="selected === row.comment" class="appeal-form" @submit.prevent="submit(row.comment)">
            <label :for="`appeal-reason-${row.comment}`">{{ t('account.message144') }}</label>
            <ElInput :id="`appeal-reason-${row.comment}`" v-model="reason" type="textarea" :disabled="busy" />
            <div>
              <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!appealReason(reason)">{{ t('account.message145') }}</ElButton>
              <ElButton native-type="button" :disabled="busy" @click="clearForm">{{ t('account.message106') }}</ElButton>
            </div>
          </form>
          <ElButton v-if="canEdit(row) && editTarget?.comment !== row.comment" native-type="button"
            :disabled="busy || !!editTarget" @click="openEdit(row)">{{ t('account.message146') }}</ElButton>
          <form v-if="editTarget?.comment === row.comment" class="appeal-form" :aria-label="t('account.message147')" @submit.prevent="saveEdit">
            <p v-if="editPending" role="status">{{ editPending === 'detail' ? t('account.message148') : t('account.message149') }}</p>
            <template v-if="editDetail">
              <label :for="`edit-comment-${row.comment}`">{{ t('account.message150') }}</label>
              <ElInput :id="`edit-comment-${row.comment}`" v-model="editBody" type="textarea"
                v-bind="{ rows: 5, maxlength: 1000 }" :disabled="editPending === 'save'" :readonly="!!editProblem" />
            </template>
            <ElAlert v-if="editProblem" :title="editProblem" type="error" :closable="false" />
            <div>
              <ElButton v-if="editDetail && !editProblem" native-type="submit" type="primary" :disabled="!editReady"
                :loading="editPending === 'save'">{{ t('account.message151') }}</ElButton>
              <ElButton v-if="editProblem" native-type="button" @click="reloadAfterEditProblem">{{ t('account.message152') }}</ElButton>
              <ElButton native-type="button" :disabled="editPending === 'save'" @click="clearEdit">{{ t('account.message153') }}</ElButton>
            </div>
          </form>
        </li>
      </ul>
      <ElButton v-if="more" native-type="button" :loading="busy" :disabled="!!editTarget" text @click="load(true)">{{ t('account.message154') }}</ElButton>
    </template>
  </section>
</template>

<style scoped>
.own-comments { display: grid; align-content: start; gap: var(--fsus-space-3); padding-block: var(--fsus-space-4); }
.own-comments > button { justify-self: start; }
.own-comments-list { display: grid; gap: var(--fsus-space-4); padding: 0; margin: 0; list-style: none; }
.own-comments-list > li { padding-block: var(--fsus-space-3); border-block-end: 1px solid var(--el-border-color-light); }
.own-comment-text { overflow-wrap: anywhere; white-space: pre-wrap; }
.appeal-form { display: grid; gap: var(--fsus-space-2); }
</style>
