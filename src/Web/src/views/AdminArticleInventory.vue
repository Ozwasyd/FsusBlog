<script setup lang="ts">
import { onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { listAdminArticles, type AuthorArticlePage, type AuthorArticleQuery } from '../../../Contracts/author-articles'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [cause: ApiError] }>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const page = shallowRef<AuthorArticlePage>()
const query = shallowRef<AuthorArticleQuery>({ trash: false })
const keyword = ref('')
const reading = ref(false)
const failed = ref(false)
onScopeDispose(() => lifetime.abort())

async function load(next: AuthorArticleQuery) {
  if (reading.value || signal.aborted) return
  reading.value = true
  failed.value = false
  page.value = undefined
  query.value = next
  try {
    const result = await listAdminArticles(next, signal)
    if (!signal.aborted) page.value = result
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else failed.value = true
  } finally { reading.value = false }
}

function search(trash = query.value.trash) {
  return load({ trash, keyword: keyword.value.trim(), match: 'title-summary' })
}

function nextPage() {
  if (page.value?.nextId) return load({ ...query.value, beforeId: page.value.nextId })
}
</script>

<template>
  <section class="inventory" aria-labelledby="admin-article-inventory-heading" :aria-busy="reading">
    <h2 id="admin-article-inventory-heading">Article inventory</h2>
    <div class="inventory-actions">
      <ElButton native-type="button" :disabled="reading" v-bind="{ 'aria-pressed': !query.trash }" @click="search(false)">Active articles</ElButton>
      <ElButton native-type="button" :disabled="reading" v-bind="{ 'aria-pressed': query.trash }" @click="search(true)">Article trash</ElButton>
    </div>
    <form class="inventory-actions" @submit.prevent="search()">
      <label for="admin-article-keyword">Title or summary</label>
      <ElInput id="admin-article-keyword" v-model="keyword" :disabled="reading" />
      <ElButton native-type="submit" :loading="reading">Search articles</ElButton>
    </form>
    <ElAlert v-if="failed" title="Could not load the article inventory. Try again." type="error" :closable="false" />
    <template v-if="page">
      <p role="status">{{ page.total }} {{ query.trash ? 'deleted' : 'active' }} articles</p>
      <ul v-if="page.items.length" class="inventory-list">
        <li v-for="item in page.items" :key="item.id">
          <strong>{{ item.title }}</strong>
          <div>Article {{ item.id }} · Revision {{ item.revision }} · {{ item.state }}</div>
          <div v-if="item.category || item.tags.length">{{ [item.category, ...item.tags].filter(Boolean).map(entry => entry?.name).join(' · ') }}</div>
        </li>
      </ul>
      <div v-if="query.beforeId || page.nextId" class="inventory-actions">
        <ElButton v-if="query.beforeId" native-type="button" @click="load({ ...query, beforeId: undefined })">First page</ElButton>
        <ElButton v-if="page.nextId" native-type="button" @click="nextPage">Next page</ElButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.inventory, .inventory-list { display: grid; gap: var(--fsus-space-2); overflow-wrap: anywhere; }
.inventory-actions { display: flex; gap: var(--fsus-space-2); flex-wrap: wrap; align-items: center; }
.inventory-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
</style>
