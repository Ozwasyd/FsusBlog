<script setup lang="ts">
import { computed, shallowRef, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { api, type ArticleCard } from '../../../Contracts/client'
import { pageNumber, readInitialListing } from '../publicEntry'

const route = useRoute()
const router = useRouter()
function search() {
  const text = input.value.trim()
  void router.push({ name: 'search', query: text ? { q: text } : {} })
}
const isSearch = computed(() => route.name === 'search')
const isHome = computed(() => route.name === 'home')
const query = computed(() => typeof route.query.q === 'string' ? route.query.q.trim() : '')
const page = computed(() => pageNumber(route.query.page))
const input = ref('')
const articles = shallowRef<ArticleCard[]>([])
const total = ref(0)
const loading = ref(true)
const failed = ref(false)
const reload = ref(0)
const pageSize = 10
const maxSearchLength = 256

async function localSearch(value: string, signal: AbortSignal) {
  const index = await api.publicIndex(signal)
  const term = value.toLowerCase()
  const items = index.items.filter(item => item.title.toLowerCase().includes(term)
    || item.summary.toLowerCase().includes(term))
  return { items, total: items.length }
}

watch([isSearch, page, query, reload], async ([search, pageNumber, text], _, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  articles.value = []
  total.value = 0
  failed.value = false
  input.value = text
  if (search && !text) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = search
      ? await localSearch(text.slice(0, maxSearchLength), request.signal)
      : readInitialListing(pageNumber) ?? await api.publicList(pageNumber, pageSize, request.signal)
    if (!request.signal.aborted) {
      articles.value = result.items
      total.value = result.total
    }
  } catch {
    if (!request.signal.aborted) failed.value = true
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}, { immediate: true })

const date = (value: number) => new Date(value).toISOString().slice(0, 10)
</script>

<template>
  <section class="reading-column editorial-page">
    <h1 class="editorial-rule">{{ isSearch ? 'Search' : isHome ? 'Latest posts' : 'Archive' }}</h1>
    <form v-if="isSearch" class="search-form" @submit.prevent="search">
      <ElInput v-model="input" label="Search articles" placeholder="Search titles or summaries" />
      <ElButton type="primary" native-type="submit">Search</ElButton>
    </form>
    <p v-if="loading" role="status">Loading articles…</p>
    <template v-else-if="failed">
      <ElAlert title="Could not load the articles." type="error" :closable="false" show-icon />
      <ElButton class="retry" @click="reload++">Retry</ElButton>
    </template>
    <p v-else-if="!articles.length" class="muted">
      {{ isSearch ? query ? 'No articles match your search.' : 'Enter a word or phrase to search published article titles and summaries.' : 'No articles have been published yet.' }}
    </p>
    <ol v-else class="article-list">
      <li v-for="item in articles" :key="item.id">
        <article>
          <time v-if="item.publishedAt" :datetime="date(item.publishedAt)" class="metadata">{{ date(item.publishedAt) }}</time>
          <h2><RouterLink :to="{ name: 'article', params: { id: item.id } }">{{ item.title }}</RouterLink></h2>
          <p v-if="item.summary">{{ item.summary }}</p>
        </article>
      </li>
    </ol>
    <nav v-if="!isSearch && !loading && !failed && (total > pageSize || page > 1)" aria-label="Article pages" class="page-links">
      <RouterLink v-if="page > 1" :to="{ query: { page: page - 1 } }">Previous</RouterLink>
      <span aria-current="page">Page {{ page }}</span>
      <RouterLink v-if="page * pageSize < total" :to="{ query: { page: page + 1 } }">Next</RouterLink>
    </nav>
  </section>
</template>
