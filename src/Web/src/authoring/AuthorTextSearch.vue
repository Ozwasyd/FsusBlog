<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElButton, ElInput } from '@ozwasyd/element-plus'
import { authorTextSearch, type AuthorTextSearchPage } from '../../../Contracts/author-text-search'
import { ApiError } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import { credentialEpoch, currentSession, invalidateSession } from '../session'

const details = ref<HTMLDetailsElement>()
const query = ref('')
const pending = shallowRef<AbortController>()
const result = shallowRef<AuthorTextSearchPage>()
const error = ref('')

function reset() {
  pending.value?.abort()
  pending.value = undefined
  result.value = undefined
  error.value = ''
}

watch(query, reset, { flush: 'sync' })
watch(credentialEpoch, () => {
  query.value = ''
  reset()
}, { flush: 'sync' })
onBeforeUnmount(reset)

function toggle(event: Event) {
  if (!(event.currentTarget as HTMLDetailsElement).open) reset()
}

async function search() {
  const session = currentSession.value
  const text = query.value.trim()
  if (!text || pending.value || !details.value?.open || !session?.canAuthor ||
    !session.siteSessionId || session.expiresAt <= Date.now()) return
  const handle = session.siteSessionId
  const epoch = credentialEpoch.value
  const request = new AbortController()
  pending.value = request
  result.value = undefined
  error.value = ''
  const current = () => {
    const live = currentSession.value
    return pending.value === request && !request.signal.aborted && details.value?.open &&
      query.value.trim() === text && credentialEpoch.value === epoch && live?.canAuthor &&
      live.siteSessionId === handle && live.expiresAt > Date.now()
  }

  try {
    const response = await authorTextSearch(text, handle, request.signal)
    if (current()) result.value = response
  } catch (failure) {
    if (!current()) return
    if (failure instanceof ApiError && failure.status === 401) { invalidateSession(); return }
    error.value = failure instanceof ApiError && failure.status === 400
      ? '搜索词格式无效。请检查关键词和双引号。' : '无法完成全文搜索，请重试。'
  } finally {
    if (pending.value === request) pending.value = undefined
  }
}
</script>

<template>
  <details ref="details" class="author-text-search" @toggle="toggle">
    <summary>作者全文搜索</summary>
    <form aria-label="作者全文搜索" @submit.prevent="search">
      <p id="author-text-search-help">按词搜索当前保存的标题和正文。用英文双引号查找同一字段中的连续词语。</p>
      <ElInput v-model="query" label="全文搜索词" clearable
        v-bind="{ maxlength: WireLimits.AuthorTextSearchQueryChars, 'aria-describedby': 'author-text-search-help' }" />
      <ElButton type="primary" native-type="submit" :disabled="!!pending || !query.trim()">
        {{ result?.ready === false ? '继续搜索' : error ? '重试搜索' : '搜索全文' }}
      </ElButton>
    </form>
    <p v-if="pending" role="status">正在搜索全文…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="result?.ready === false" role="status">索引正在更新，选择「继续搜索」处理下一批文章。</p>
    <section v-else-if="result?.ready" aria-label="全文搜索结果">
      <p v-if="!result.rows.length" role="status">没有匹配的文章。</p>
      <ul v-else>
        <li v-for="row in result.rows" :key="`${row.id}:${row.field}`">
          <RouterLink :to="{ name: 'edit', params: { id: row.id } }" dir="auto">{{ row.title }}</RouterLink>
          <span class="author-text-search-field">{{ row.field === 'title' ? '标题' : '正文' }}</span>
          <p class="author-text-search-snippet" dir="auto">{{ row.snippet.slice(0, row.highlightStart) }}<mark>{{ row.snippet.slice(row.highlightStart, row.highlightEnd) }}</mark>{{ row.snippet.slice(row.highlightEnd) }}</p>
        </li>
      </ul>
      <p v-if="result.more" role="status">显示前 {{ result.rows.length }} 条结果，可缩小搜索范围。</p>
    </section>
  </details>
</template>

<style scoped>
.author-text-search { max-inline-size: 34rem; }
.author-text-search summary { cursor: pointer; }
.author-text-search form { display: grid; gap: var(--fsus-space-2); justify-items: start; }
.author-text-search form > p { margin-block-end: 0; }
.author-text-search ul { display: grid; gap: var(--fsus-space-3); padding-inline-start: 1.25rem; }
.author-text-search li { overflow-wrap: anywhere; }
.author-text-search-field { margin-inline-start: var(--fsus-space-2); }
.author-text-search-snippet { margin-block: var(--fsus-space-1) 0; white-space: pre-wrap; }
</style>
