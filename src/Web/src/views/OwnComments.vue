<script setup lang="ts">
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
const statuses = ['待审核', '已通过', '已驳回', '已隐藏'] as const
const appeals = ['', '可以申诉', '申诉待复核', '申诉已通过', '申诉未通过', '原审核结论已变化'] as const
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
    '无法读取我的评论，请重试。')
}

function submit(comment: string) {
  if (editTarget.value || selected.value !== comment || !appealReason(reason.value)) return
  const explanation = reason.value
  return run(async (session, signal) => {
    await submitAuthorAppeal(comment, explanation, session, signal)
    if (signal.aborted) return
    clearForm()
    rows.value = rows.value?.map(row => row.comment === comment ? { ...row, appeal: 2 } : row) ?? null
    notice.value = '申诉已提交，等待独立复核。'
  }, '无法提交申诉。若请求已送达，可刷新查看进度。')
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
      editProblem.value = '评论所属文章已变化，请重新加载评论。'
      return
    }
    editDetail.value = detail
    editBody.value = detail.body
  } catch {
    if (!request.signal.aborted) editProblem.value = '此评论暂时无法编辑，请重新加载评论。'
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
    notice.value = '评论已修改，仍待审核。'
    await run((session, signal) => reload(null, session, signal), '评论已保存，但无法刷新列表，请重试。')
  } catch (error) {
    if (!request.signal.aborted) editProblem.value = error instanceof ApiError && error.status === 409
      ? '评论版本已变化，请重新加载评论后再编辑。' : '无法确认修改结果，请重新加载评论。'
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
    <h1 id="own-comments-title">我的评论</h1>
    <p v-if="!currentSession"><RouterLink to="/login">登录后查看我的评论</RouterLink></p>
    <template v-else>
      <ElButton native-type="button" :loading="busy" :disabled="!!editTarget" @click="load()">刷新评论与申诉</ElButton>
      <ElAlert v-if="failure" :title="failure" type="error" :closable="false" />
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="rows?.length === 0">没有可显示的评论。</p>
      <ul v-else-if="rows" class="own-comments-list">
        <li v-for="row in rows" :key="row.comment">
          <RouterLink :to="`/article/${row.article}`">文章 {{ row.article }}</RouterLink>
          <p>{{ statuses[row.status] }}<template v-if="row.appeal"> · {{ appeals[row.appeal] }}</template></p>
          <p v-if="row.body" class="own-comment-text">{{ row.body }}</p>
          <p v-if="row.decisionReason" class="own-comment-text">{{ row.decisionReason }}</p>
          <ElButton v-if="row.appeal === 1 && selected !== row.comment" native-type="button" :disabled="busy || !!editTarget"
            @click="clearForm(); selected = row.comment">发起申诉</ElButton>
          <form v-if="selected === row.comment" class="appeal-form" @submit.prevent="submit(row.comment)">
            <label :for="`appeal-reason-${row.comment}`">申诉理由（10 至 1,000 字符）</label>
            <ElInput :id="`appeal-reason-${row.comment}`" v-model="reason" type="textarea" :disabled="busy" />
            <div>
              <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!appealReason(reason)">提交申诉</ElButton>
              <ElButton native-type="button" :disabled="busy" @click="clearForm">取消</ElButton>
            </div>
          </form>
          <ElButton v-if="canEdit(row) && editTarget?.comment !== row.comment" native-type="button"
            :disabled="busy || !!editTarget" @click="openEdit(row)">编辑评论</ElButton>
          <form v-if="editTarget?.comment === row.comment" class="appeal-form" aria-label="编辑待审核评论" @submit.prevent="saveEdit">
            <p v-if="editPending" role="status">{{ editPending === 'detail' ? '正在读取评论…' : '正在保存修改…' }}</p>
            <template v-if="editDetail">
              <label :for="`edit-comment-${row.comment}`">评论内容</label>
              <ElInput :id="`edit-comment-${row.comment}`" v-model="editBody" type="textarea"
                v-bind="{ rows: 5, maxlength: 1000 }" :disabled="editPending === 'save'" :readonly="!!editProblem" />
            </template>
            <ElAlert v-if="editProblem" :title="editProblem" type="error" :closable="false" />
            <div>
              <ElButton v-if="editDetail && !editProblem" native-type="submit" type="primary" :disabled="!editReady"
                :loading="editPending === 'save'">保存修改</ElButton>
              <ElButton v-if="editProblem" native-type="button" @click="reloadAfterEditProblem">重新加载评论</ElButton>
              <ElButton native-type="button" :disabled="editPending === 'save'" @click="clearEdit">取消编辑</ElButton>
            </div>
          </form>
        </li>
      </ul>
      <ElButton v-if="more" native-type="button" :loading="busy" :disabled="!!editTarget" text @click="load(true)">加载更多评论</ElButton>
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
