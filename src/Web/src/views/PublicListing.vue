<script setup lang="ts">
import { t } from '../siteLocale'
import ArchiveTimeline from '../components/ArchiveTimeline.vue'
import { computed, onScopeDispose, shallowRef, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElLink, ElPaginationBar } from '@ozwasyd/element-plus'
import { api, ApiError, type ArticleCard } from '../../../Contracts/client'
import type { PopularArticle } from '../../../Contracts/article-hot'
import {
  normalizeLocalSearchQuery, normalizePublicSearchSort, type PublicSearchSort,
} from '../../../Contracts/local-search.ts'
import {
  taxonomyArticles, taxonomyMetadata, type TaxonomyKind, type TaxonomyMetadata,
} from '../../../Contracts/taxonomy-client'
import { pageNumber, readInitialListing, readInitialTaxonomy } from '../publicEntry'
import { createLocalSearch } from '../localSearch'
import { loadPublicHotArticles } from '../publicHotArticles'
import { siteTitle } from '../siteBrand'
import { WireLimits } from '../../../Contracts/wire.generated.ts'

const route = useRoute()
const router = useRouter()
const searchSort = computed<PublicSearchSort>(() => normalizePublicSearchSort(route.query.sort))
function searchRouteQuery(text: string, sort: PublicSearchSort = searchSort.value, targetPage?: number) {
  const next: Record<string, string | number> = {}
  if (text) next.q = text
  if (sort !== 'relevance') next.sort = sort
  if (targetPage !== undefined) next.page = targetPage
  return next
}
function search() {
  if (searchTooLong.value) return
  const text = input.value.trim()
  void router.push({ name: 'search', query: text ? searchRouteQuery(text) : {} })
}
const isSearch = computed(() => route.name === 'search')
const isHome = computed(() => route.name === 'home')
const isArchive = computed(() => route.name === 'archive')
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
const archiveTotal = ref(0)
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
const compactHotQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 37.99rem)')
  : undefined
const compactHotViewport = ref(compactHotQuery?.matches ?? false)
if (compactHotQuery) {
  const syncCompactHotViewport = (event: MediaQueryListEvent) => { compactHotViewport.value = event.matches }
  compactHotQuery.addEventListener('change', syncCompactHotViewport)
  onScopeDispose(() => compactHotQuery.removeEventListener('change', syncCompactHotViewport))
}
const visibleHotArticles = computed(() => hotArticles.value.slice(0, compactHotViewport.value ? 3 : 5))
const readCount = new Intl.NumberFormat('en')

watch([isSearch, isHome, taxonomy, taxonomyId, page, cursor, query, searchSort, reload], async ([search, home, kind, categoryOrTagId, ordinal, token, text, sort], _, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  articles.value = []
  nextCursor.value = null
  searchTotal.value = 0
  archiveTotal.value = 0
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
      result = await localSearch.search(text, request.signal, ordinal, pageSize, sort)
    } else if (kind) {
      const initial = !token ? readInitialTaxonomy(kind, categoryOrTagId, ordinal) : undefined
      if (initial) {
        filter.value = initial.metadata
        document.title = `${initial.metadata.name} · ${siteTitle}`
        result = initial.result
      } else {
        const [metadata, page] = await Promise.all([
          taxonomyMetadata(kind, categoryOrTagId, request.signal),
          taxonomyArticles(kind, categoryOrTagId, ordinal, pageSize, request.signal, currentCursor),
        ])
        if (request.signal.aborted) return
        filter.value = metadata
        document.title = `${metadata.name} · ${siteTitle}`
        result = page
      }
    } else {
      result = (!token ? readInitialListing(ordinal, home ? 'home' : 'archive') : undefined)
        ?? await api.publicList(ordinal, pageSize, request.signal, { archive: !home, cursor: currentCursor })
    }
    if (!request.signal.aborted) {
      articles.value = result.items
      nextCursor.value = result.nextCursor
      if (search) searchTotal.value = result.total
      if (!search && !home && !kind) archiveTotal.value = result.total
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
    if (!signal.aborted && hotRoute.value === entry) {
      hotArticles.value = items.some(item => item.views > 0) ? items.slice(0, 5) : []
    }
  } catch {
    // The primary article list has its own request and error state.
  }
}, { immediate: true, flush: 'sync' })

const date = (value: number) => new Date(value).toISOString().slice(0, 10)
</script>

<template>
  <section class="reading-column editorial-page">
    <h1 v-if="isHome" class="visually-hidden">{{ heading }}</h1>
    <header v-else-if="isArchive && (loading || cursorExpired || failed)" class="editorial-rule archive-page-header">
      <h1>{{ heading }}</h1>
    </header>
    <h1 v-else-if="!isArchive" class="editorial-rule">{{ missing ? t('reading.notFound', { heading }) : heading }}</h1>
    <p v-if="filter?.description">{{ filter.description }}</p>
    <div v-if="isSearch" role="search">
      <form class="search-form" action="/search" method="GET" @submit.prevent="search">
        <ElInput
          v-model="input"
          :label="t('reading.searchLabel')"
          :placeholder="t('reading.searchPlaceholder')"
          v-bind="{ name: 'q', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' }"
        />
        <input v-if="searchSort !== 'relevance'" type="hidden" name="sort" :value="searchSort">
        <ElButton type="primary" native-type="submit" :disabled="searchTooLong">{{ t('page.search') }}</ElButton>
      </form>
      <div v-if="!loading && !failed && !searchRouteTooLong && query && searchTotal > 0" class="search-toolbar">
        <span class="metadata">{{ t(searchTotal === 1 ? 'reading.searchMatch' : 'reading.searchMatches', { count: readCount.format(searchTotal) }) }}</span>
        <nav v-if="searchTotal > 1" class="search-sort" :aria-label="t('reading.searchSort')">
          <RouterLink :to="{ name: 'search', query: searchRouteQuery(query, 'relevance') }" :aria-current="searchSort === 'relevance' ? 'true' : undefined">
            {{ t('reading.searchSortRelevance') }}
          </RouterLink>
          <RouterLink :to="{ name: 'search', query: searchRouteQuery(query, 'latest') }" :aria-current="searchSort === 'latest' ? 'true' : undefined">
            {{ t('reading.searchSortLatest') }}
          </RouterLink>
        </nav>
      </div>
    </div>
    <section v-if="hotRoute && !loading && !failed && visibleHotArticles.length" class="popular-articles" aria-labelledby="popular-articles-heading">
      <h2 id="popular-articles-heading">{{ t('reading.popular') }}</h2>
      <ol role="list">
        <li v-for="(item, index) in visibleHotArticles" :key="item.id">
          <span class="popular-rank" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
          <RouterLink :to="{ name: 'article', params: { id: item.id } }" custom v-slot="{ href, navigate }">
            <ElLink class="popular-article-link" :href="href" :underline="false" @click="navigate">
              <span class="popular-article-title">{{ item.title }}</span>
            </ElLink>
          </RouterLink>
          <span class="popular-views">{{ t(item.views === 1 ? 'reading.verifiedRead' : 'reading.verifiedReads', { count: readCount.format(item.views) }) }}</span>
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
    <ArchiveTimeline v-else-if="isArchive" :heading="heading" :items="articles" :total="archiveTotal" />
    <p v-else-if="!articles.length" class="muted">
      {{ t(isSearch ? query ? 'reading.noSearchMatches' : 'reading.searchPrompt' : taxonomy ? 'reading.noTaxonomyArticles' : 'reading.noArticles') }}
    </p>
    <ol v-else class="article-list">
      <li v-for="item in articles" :key="item.id">
        <article>
          <h2><RouterLink :to="{ name: 'article', params: { id: item.id } }">{{ item.title }}</RouterLink></h2>
          <div class="article-taxonomy metadata">
            <time v-if="item.publishedAt" :datetime="date(item.publishedAt)">{{ date(item.publishedAt) }}</time>
            <RouterLink v-if="item.category.id > 0" :to="{ name: 'category', params: { id: item.category.id } }">{{ item.category.name }}</RouterLink>
            <RouterLink v-for="tag in item.tags" :key="tag.id" :to="{ name: 'tag', params: { id: tag.id } }">#{{ tag.name }}</RouterLink>
          </div>
          <p v-if="item.summary">{{ item.summary }}</p>
        </article>
      </li>
    </ol>
    <ElPaginationBar v-if="isSearch && !loading && !failed && !searchRouteTooLong && query && (page > 1 || searchTotal > pageSize)" :ariaLabel="t('reading.searchPages')" class="page-links">
      <template #summary>
        <span aria-current="page">{{ t('reading.pageNumber', { page }) }}</span>
      </template>
      <template #pagination>
        <RouterLink v-if="searchPageOutOfRange" :to="{ query: searchRouteQuery(query) }" custom v-slot="{ href, navigate }">
          <ElButton tag="a" v-bind="{ href }" @click="navigate">{{ t('reading.firstPage') }}</ElButton>
        </RouterLink>
        <RouterLink v-else-if="page > 1" :to="{ query: searchRouteQuery(query, searchSort, page - 1) }" custom v-slot="{ href, navigate }">
          <ElButton tag="a" v-bind="{ href }" @click="navigate">{{ t('reading.previous') }}</ElButton>
        </RouterLink>
        <RouterLink v-if="page * pageSize < searchTotal" :to="{ query: searchRouteQuery(query, searchSort, page + 1) }" custom v-slot="{ href, navigate }">
          <ElButton tag="a" v-bind="{ href }" @click="navigate">{{ t('reading.next') }}</ElButton>
        </RouterLink>
      </template>
    </ElPaginationBar>
    <ElPaginationBar v-if="!isSearch && !loading && !failed && !cursorExpired && !missing && (nextCursor || page > 1)" :ariaLabel="t('reading.articlePages')" class="page-links">
      <template #summary>
        <span aria-current="page">{{ t('reading.pageNumber', { page }) }}</span>
      </template>
      <template #pagination>
        <RouterLink v-if="page > 1" :to="{ query: previousPageQuery }" custom v-slot="{ href, navigate }">
          <ElButton tag="a" v-bind="{ href }" @click="navigate">{{ t(page > 2 && !priorCursor ? 'reading.firstPage' : 'reading.previous') }}</ElButton>
        </RouterLink>
        <RouterLink v-if="nextCursor" :to="{ query: { page: page + 1, cursor: nextCursor } }" custom v-slot="{ href, navigate }">
          <ElButton tag="a" v-bind="{ href }" @click="navigate">{{ t('reading.next') }}</ElButton>
        </RouterLink>
      </template>
    </ElPaginationBar>
  </section>
</template>

<style scoped>
.archive-page-header { padding-block-end: 1.25rem; margin-block-end: 2.75rem; }
.archive-page-header h1 { margin: 0; font-size: clamp(1.625rem, 1.25rem + 1.5vw, 2rem); line-height: 1.25; }
.popular-articles { margin-block: 0 1.25rem; }
.popular-articles h2 {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin: 0 0 .5rem;
  color: var(--fsus-color-text-quiet);
  font-size: .8125rem;
  font-weight: 500;
  line-height: 1.5;
}
.popular-articles h2::after {
  content: '';
  flex: 1;
  block-size: 1px;
  background: var(--fsus-border);
}
.popular-articles ol { margin: 0; padding: 0; list-style: none; }
.popular-articles li {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  column-gap: 1rem;
  align-items: baseline;
  min-block-size: 44px;
  padding-block: .625rem;
  border-block-end: 1px solid var(--el-border-color-lighter);
}
.popular-articles li:last-child { border-block-end-color: var(--fsus-border); }
.popular-rank {
  color: var(--fsus-color-text-quiet);
  font-size: .8125rem;
  font-weight: 500;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}
.popular-article-link {
  --el-link-text-color: var(--fsus-ink);
  --el-link-hover-text-color: var(--fsus-scholarly-blue);
  --el-link-font-size: 1rem;
  --el-link-font-weight: 500;
  justify-content: flex-start;
  justify-self: start;
  max-inline-size: 100%;
  margin: 0 -4px;
  padding: .125rem 4px;
  line-height: 1.45;
  text-align: start;
  overflow-wrap: anywhere;
  transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}
.popular-article-link:hover,
.popular-article-link:focus-visible {
  color: var(--fsus-scholarly-blue);
  opacity: 1;
}
.popular-article-title {
  text-decoration-thickness: 1px;
  text-underline-offset: .25em;
}
.popular-article-link:hover .popular-article-title,
.popular-article-link:focus-visible .popular-article-title {
  text-decoration: underline;
}
.popular-articles li:has(.popular-article-link:hover) .popular-rank,
.popular-articles li:has(.popular-article-link:focus-visible) .popular-rank {
  color: var(--fsus-scholarly-blue);
}
.popular-views {
  color: var(--fsus-color-text-quiet);
  font-size: .8125rem;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  justify-self: end;
}
@media (max-width: 37.99rem) {
  .popular-articles li {
    grid-template-columns: 1.75rem minmax(0, 1fr);
    column-gap: .75rem;
    row-gap: .2rem;
    padding-block: .75rem;
  }
  .popular-views {
    grid-column: 2;
    justify-self: start;
  }
}
@media (prefers-reduced-motion: reduce) {
  .popular-rank,
  .popular-article-link {
    transition-duration: 1ms;
  }
}
</style>
