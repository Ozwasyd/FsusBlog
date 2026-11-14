<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElMarkdownRenderer } from '@ozwasyd/element-plus'
import { api, ApiError, type Article } from '../../../Contracts/client'
import { readInitialArticle } from '../publicEntry'
import ArticleComments from '../components/ArticleComments.vue'
import PublicCommentComposer from '../components/PublicCommentComposer.vue'

const route = useRoute()
const article = shallowRef<Article>()
const error = ref('')
const cover = computed(() => {
  const source = article.value?.coverImageUrl
  if (!source) return undefined
  const url = URL.parse(source, location.origin)
  return url && ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
})
const busy = ref(true)
const retry = ref(0)
const nativeMarkdown = import.meta.env.FSUS_MARKDOWN_NATIVE
const date = (value: number) => new Date(value).toISOString().slice(0, 10)

watch([() => route.params.id, retry], async ([id], _, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  article.value = undefined
  busy.value = true
  error.value = ''
  try {
    const value = readInitialArticle(Number(id)) ?? await api.publicArticle(Number(id), request.signal)
    if (!request.signal.aborted) {
      article.value = value
      document.title = `${value.title} · Fsu's Blog`
    }
  } catch (cause) {
    if (!request.signal.aborted) {
      error.value = cause instanceof ApiError && cause.status === 404 ? 'missing' : 'failed'
    }
  } finally {
    if (!request.signal.aborted) busy.value = false
  }
}, { immediate: true })
</script>

<template>
  <section v-if="busy" class="reading-column editorial-page">
    <p role="status">Loading article…</p>
  </section>
  <section v-else-if="error" class="reading-column editorial-page">
    <h1>{{ error === 'missing' ? 'Article not found' : 'Could not load the article' }}</h1>
    <p v-if="error === 'missing'">It may have been withdrawn or removed.</p>
    <ElButton v-if="error === 'failed'" @click="retry++">Retry</ElButton>
    <RouterLink v-else to="/">Return home</RouterLink>
  </section>
  <article v-else-if="article" class="reading-column editorial-page article-body" v-bind="{ 'data-fsus-surface': 'reading' }">
    <img v-if="cover" :src="cover" alt="Article cover" class="article-cover">
    <header class="editorial-rule">
      <h1>{{ article.title }}</h1>
      <div class="article-taxonomy metadata">
        <span v-if="article.publishedAt">Published <time :datetime="date(article.publishedAt)">{{ date(article.publishedAt) }}</time></span>
        <RouterLink v-if="article.category.id > 0" :to="{ name: 'category', params: { id: article.category.id } }">{{ article.category.name }}</RouterLink>
        <RouterLink v-for="tag in article.tags" :key="tag.id" :to="{ name: 'tag', params: { id: tag.id } }">#{{ tag.name }}</RouterLink>
      </div>
    </header>
    <ElMarkdownRenderer v-if="nativeMarkdown" :content="article.body" :content-version="article.publication.toString()" mode="article" />
    <template v-else>
      <ElAlert title="Formatted view unavailable. Showing the original article text." type="info" :closable="false" />
      <pre class="article-source">{{ article.body }}</pre>
    </template>
    <ArticleComments :key="article.id" :article-id="article.id" />
    <PublicCommentComposer :key="article.publication.toString()" :article-id="article.id" :publication="article.publication" />
  </article>
</template>
