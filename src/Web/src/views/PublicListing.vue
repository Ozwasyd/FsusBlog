<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onScopeDispose, shallowRef, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElLink } from '@ozwasyd/element-plus'
import { api, ApiError, type ArticleCard } from '../../../Contracts/client'
import type { PopularArticle } from '../../../Contracts/article-hot'
import { normalizeLocalSearchQuery } from '../../../Contracts/local-search.ts'
import {
  taxonomyArticles, taxonomyMetadata, type TaxonomyKind, type TaxonomyMetadata,
} from '../../../Contracts/taxonomy-client'
import { pageNumber, readInitialListing } from '../publicEntry'
import { createLocalSearch } from '../localSearch'
import { loadPublicHotArticles } from '../publicHotArticles'
import { siteTitle } from '../siteBrand'
import { WireLimits } from '../../../Contracts/wire.generated.ts'

const route = useRoute()
const router = useRouter()
function search() {
  if (searchTooLong.value) return
  const text = input.value.trim()
  void router.push({ name: 'search', query: text ? { q: text } : {} })
}
const isSearch = computed(() => route.name === 'search')
const isHome = computed(() => route.name === 'home')
const taxonomy = computed<TaxonomyKind | undefined>(() => {
  const name = route.name
  return name === 'category' || name === 'tag' ? name : undefined
})
const taxonomyId = computed(() => Number(route.params.id))
const filter = shallowRef<TaxonomyMetadata>()
const missing = ref(false)
const heading = computed(() => filter.value?.name
  ?? (isSearch.value ? t('page.search') : isHome.value ? t('reading.latestPosts') : taxonomy.value === 'category' ? t('page.category') : taxonomy.value === 'tag' ? t('page.tag') : t('page.archive')))
const query = computed(() => typeof route.query.q === 'string' ? route.query.q.trim() : '')
const page = computed(() => pageNumber(route.query.page))
const cursor = computed(() => typeof route.query.cursor === 'string' && route.query.cursor ? route.query.cursor : undefined)
const nextCursor = ref<string | null>(null)
const searchTotal = ref(0)
const cursorExpired = ref(false)
const previousByCursor = new Map<string, string | undefined>()
const priorCursor = computed(() => cursor.value && previousByCursor.get(cursor.value))
const previousPageQuery = computed(() => page.value > 2 && priorCursor.value
  ? { page: page.value - 1, cursor: priorCursor.value }
  : {})
const input = ref('')
const articles = shallowRef<ArticleCard[]>([])
const loading = ref(true)
const failed = ref(false)
const reload = ref(0)
const pageSize = 10
const maxSearchLength = WireLimits.SearchQueryChars
const searchTooLong = computed(() => normalizeLocalSearchQuery(input.value.trim()) === undefined)
const searchRouteTooLong = computed(() => normalizeLocalSearchQuery(query.value) === undefined)
const searchPageOutOfRange = computed(() => isSearch.value && searchTotal.value > 0 &&
  (page.value - 1) * pageSize >= searchTotal.value)
const localSearch = createLocalSearch()
onScopeDispose(localSearch.dispose)

const hotEnabled = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-hot-articles"]')?.content === '1'
const hotRoute = computed(() => hotEnabled && isHome.value && page.value === 1 && !cursor.value ? route.fullPath : undefined)
const hotArticles = shallowRef<PopularArticle[]>([])
const readCount = new Intl.NumberFormat('en')

watch([isSearch, isHome, taxonomy, taxonomyId, page, cursor, query, reload], async ([search, home, kind, categoryOrTagId, ordinal, token, text], _, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  articles.value = []
  nextCursor.value = null
  searchTotal.value = 0
  filter.value = undefined
  missing.value = false
  cursorExpired.value = false
  failed.value = false
  input.value = text
  if (!search) localSearch.dispose()
  if (search && (!text || searchRouteTooLong.value)) {
    loading.value = false
    return
  }
  if (!search && ordinal > 1 && !token) {
    cursorExpired.value = true
    loading.value = false
    return
  }
  loading.value = true
  try {
    const currentCursor = ordinal > 1 ? token : undefined
    let result: Awaited<ReturnType<typeof api.publicList>>
    if (search) {
      result = await localSearch.search(text, request.signal, ordinal, pageSize)
    } else if (kind) {
      const [metadata, page] = await Promise.all([
        taxonomyMetadata(kind, categoryOrTagId, request.signal),
        taxonomyArticles(kind, categoryOrTagId, ordinal, pageSize, request.signal, currentCursor),
      ])
      if (request.signal.aborted) return
      filter.value = metadata
      document.title = `${metadata.name} · ${siteTitle}`
      result = page
    } else {
      result = (!token && home ? readInitialListing(ordinal) : undefined)
        ?? await api.publicList(ordinal, pageSize, request.signal, { archive: !home, cursor: currentCursor })
    }
    if (!request.signal.aborted) {
      articles.value = result.items
      nextCursor.value = result.nextCursor
      if (search) searchTotal.value = result.total
      if (result.nextCursor) {
        if (previousByCursor.size >= 100) previousByCursor.clear()
        previousByCursor.set(result.nextCursor, token)
      }
    }
  } catch (error) {
    if (!request.signal.aborted) {
      cursorExpired.value = !search && error instanceof ApiError && error.status === 400 && error.details === 'article_cursor_invalid'
      missing.value = kind !== undefined && error instanceof ApiError && error.status === 404
      failed.value = !cursorExpired.value && !missing.value
    }
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}, { immediate: true })

watch([hotRoute, reload], async ([entry], _, cleanup) => {
  hotArticles.value = []
  if (!entry) return
  const request = new AbortController()
  cleanup(() => request.abort())
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3_000)])
  try {
    const items = await loadPublicHotArticles(signal)
    if (!signal.aborted && hotRoute.value === entry) hotArticles.value = items.slice(0, 5)
  } catch {
    // The primary article list has its own request and error state.
  }
}, { immediate: true, flush: 'sync' })

const date = (value: number) => new Date(value).toISOString().slice(0, 10)
</script>

<template>
  <section class="reading-column editorial-page">
    <h1 class="editorial-rule">{{ missing ? t('reading.notFound', { heading }) : heading }}</h1>
    <p v-if="filter?.description">{{ filter.description }}</p>
    <form v-if="isSearch" class="search-form" @submit.prevent="search">
      <ElInput v-model="input" :label="t('reading.searchLabel')" :placeholder="t('reading.searchPlaceholder')" />
      <ElButton type="primary" native-type="submit" :disabled="searchTooLong">{{ t('page.search') }}</ElButton>
    </form>
    <section v-if="hotRoute && !loading && !failed && hotArticles.length" class="popular-articles" aria-labelledby="popular-articles-heading">
      <h2 id="popular-articles-heading">{{ t('reading.popular') }}</h2>
      <ol>
        <li v-for="item in hotArticles" :key="item.id">
          <RouterLink :to="{ name: 'article', params: { id: item.id } }" custom v-slot="{ href, navigate }">
            <ElLink :href="href" @click="navigate">{{ item.title }}</ElLink>
          </RouterLink>
          <span class="metadata">{{ t(item.views === 1 ? 'reading.verifiedRead' : 'reading.verifiedReads', { count: readCount.format(item.views) }) }}</span>
        </li>
      </ol>
    </section>
    <p v-if="isSearch && (searchTooLong || searchRouteTooLong)" role="status">{{ t('reading.searchLimit', { limit: maxSearchLength }) }}</p>
    <p v-else-if="loading" role="status">{{ t('page.loadingArticles') }}</p>
    <template v-else-if="cursorExpired">
      <p role="status">{{ t('reading.expiredPage') }}</p>
      <RouterLink :to="{ query: {} }">{{ t('reading.firstPage') }}</RouterLink>
    </template>
    <p v-else-if="missing" class="muted"><RouterLink to="/archive">{{ t('reading.browseArchive') }}</RouterLink></p>
    <template v-else-if="failed">
      <ElAlert :title="t('reading.listFailed')" type="error" :closable="false" show-icon />
      <ElButton class="retry" @click="reload++">{{ t('reading.retry') }}</ElButton>
    </template>
    <p v-else-if="searchPageOutOfRange" class="muted" role="status">{{ t('reading.searchPageEmpty') }}</p>
    <p v-else-if="!articles.length" class="muted">
      {{ t(isSearch ? query ? 'reading.noSearchMatches' : 'reading.searchPrompt' : taxonomy ? 'reading.noTaxonomyArticles' : 'reading.noArticles') }}
    </p>
    <ol v-else class="article-list">
      <li v-for="item in articles" :key="item.id">
        <article>
          <div class="article-taxonomy metadata">
            <time v-if="item.publishedAt" :datetime="date(item.publishedAt)">{{ date(item.publishedAt) }}</time>
            <RouterLink v-if="item.category.id > 0" :to="{ name: 'category', params: { id: item.category.id } }">{{ item.category.name }}</RouterLink>
            <RouterLink v-for="tag in item.tags" :key="tag.id" :to="{ name: 'tag', params: { id: tag.id } }">#{{ tag.name }}</RouterLink>
          </div>
          <h2><RouterLink :to="{ name: 'article', params: { id: item.id } }">{{ item.title }}</RouterLink></h2>
          <p v-if="item.summary">{{ item.summary }}</p>
        </article>
      </li>
    </ol>
    <nav v-if="isSearch && !loading && !failed && !searchRouteTooLong && query && (page > 1 || searchTotal > pageSize)" :aria-label="t('reading.searchPages')" class="page-links">
      <RouterLink v-if="searchPageOutOfRange" :to="{ query: { q: query } }" custom v-slot="{ href, navigate }">
        <ElLink :href="href" @click="navigate">{{ t('reading.firstPage') }}</ElLink>
      </RouterLink>
      <RouterLink v-else-if="page > 1" :to="{ query: { q: query, page: page - 1 } }">{{ t('reading.previous') }}</RouterLink>
      <span aria-current="page">{{ t('reading.pageNumber', { page }) }}</span>
      <RouterLink v-if="page * pageSize < searchTotal" :to="{ query: { q: query, page: page + 1 } }">{{ t('reading.next') }}</RouterLink>
    </nav>
    <nav v-if="!isSearch && !loading && !failed && !cursorExpired && !missing && (nextCursor || page > 1)" :aria-label="t('reading.articlePages')" class="page-links">
      <RouterLink v-if="page > 1" :to="{ query: previousPageQuery }">{{ t(page > 2 && !priorCursor ? 'reading.firstPage' : 'reading.previous') }}</RouterLink>
      <span aria-current="page">{{ t('reading.pageNumber', { page }) }}</span>
      <RouterLink v-if="nextCursor" :to="{ query: { page: page + 1, cursor: nextCursor } }">{{ t('reading.next') }}</RouterLink>
    </nav>
  </section>
</template>

<style scoped>
.popular-articles { margin-block: 1.5rem 1rem; padding-block-end: 1rem; border-block-end: 1px solid var(--fsus-border); }
.popular-articles h2 { margin-block: 0 .65rem; font-size: 1.25rem; }
.popular-articles ol { margin: 0; padding-inline-start: 1.4rem; }
.popular-articles li { margin-block: .35rem; overflow-wrap: anywhere; }
.popular-articles .el-link { max-inline-size: 100%; text-align: start; vertical-align: baseline; }
.popular-articles .metadata { margin-inline-start: .6rem; white-space: nowrap; }
</style>
