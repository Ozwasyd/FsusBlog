<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { appealReason, readAuthorAppeals, submitAuthorAppeal, type AuthorAppeal } from '../../../Contracts/comment-appeals'
import { currentSession, credentialEpoch, identityEpoch } from '../session'

const rows = shallowRef<AuthorAppeal[] | null>(null)
const busy = ref(false)
const failure = ref('')
const selected = ref<string>()
const reason = ref('')
const more = ref(false)
const notice = ref('')
const statuses = ['待审核', '已通过', '已驳回', '已隐藏'] as const
const appeals = ['', '可以申诉', '申诉待复核', '申诉已通过', '申诉未通过', '原审核结论已变化'] as const
let scope = new AbortController()

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
}

function load(append = false) {
  return run((session, signal) => reload(append ? rows.value?.at(-1)?.comment ?? null : null, session, signal),
    '无法读取我的评论，请重试。')
}

function submit(comment: string) {
  if (selected.value !== comment || !appealReason(reason.value)) return
  const explanation = reason.value
  return run(async (session, signal) => {
    await submitAuthorAppeal(comment, explanation, session, signal)
    if (signal.aborted) return
    clearForm()
    rows.value = rows.value?.map(row => row.comment === comment ? { ...row, appeal: 2 } : row) ?? null
    notice.value = '申诉已提交，等待独立复核。'
  }, '无法提交申诉。若请求已送达，可刷新查看进度。')
}

watch([identityEpoch, credentialEpoch], () => {
  scope.abort()
  scope = new AbortController()
  rows.value = null
  busy.value = false
  more.value = false
  failure.value = ''
  notice.value = ''
  clearForm()
  void load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => scope.abort())
</script>

<template>
  <section class="own-comments reading-column" aria-labelledby="own-comments-title">
    <h1 id="own-comments-title">我的评论</h1>
    <p v-if="!currentSession"><RouterLink to="/login">登录后查看我的评论</RouterLink></p>
    <template v-else>
      <ElButton native-type="button" :loading="busy" @click="load()">刷新评论与申诉</ElButton>
      <ElAlert v-if="failure" :title="failure" type="error" :closable="false" />
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="rows?.length === 0">没有可显示的评论。</p>
      <ul v-else-if="rows" class="own-comments-list">
        <li v-for="row in rows" :key="row.comment">
          <RouterLink :to="`/article/${row.article}`">文章 {{ row.article }}</RouterLink>
          <p>{{ statuses[row.status] }}<template v-if="row.appeal"> · {{ appeals[row.appeal] }}</template></p>
          <p v-if="row.body" class="own-comment-text">{{ row.body }}</p>
          <p v-if="row.decisionReason" class="own-comment-text">{{ row.decisionReason }}</p>
          <ElButton v-if="row.appeal === 1 && selected !== row.comment" native-type="button" :disabled="busy"
            @click="clearForm(); selected = row.comment">发起申诉</ElButton>
          <form v-if="selected === row.comment" class="appeal-form" @submit.prevent="submit(row.comment)">
            <label :for="`appeal-reason-${row.comment}`">申诉理由（10 至 1,000 字符）</label>
            <ElInput :id="`appeal-reason-${row.comment}`" v-model="reason" type="textarea" :disabled="busy" />
            <div>
              <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!appealReason(reason)">提交申诉</ElButton>
              <ElButton native-type="button" :disabled="busy" @click="clearForm">取消</ElButton>
            </div>
          </form>
        </li>
      </ul>
      <ElButton v-if="more" native-type="button" :loading="busy" text @click="load(true)">加载更多评论</ElButton>
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
