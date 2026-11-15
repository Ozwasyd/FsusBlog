<script setup lang="ts">
import { siteTitle } from '../siteBrand'
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElMarkdownRenderer } from '@ozwasyd/element-plus'
import { api, ApiError, ProtocolError } from '../../../Contracts/client'
import { fetchPublicArticleMedia, type PublicArticleImage } from '../../../Contracts/published-media'
import { useArticleReadProof } from '../article-read-proof'
import { readInitialArticle } from '../publicEntry'
import ArticleComments from '../components/ArticleComments.vue'
import ArticlePublicationProof from '../components/ArticlePublicationProof.vue'
import RelatedReading from '../components/RelatedReading.vue'

const route = useRoute()
const article = shallowRef<Awaited<ReturnType<typeof api.publicArticle>>>()
const readBody = ref<HTMLElement | null>(null)
const renderedArticle = shallowRef<typeof article.value>()
const images = shallowRef<readonly PublicArticleImage[]>()
const failedImages = shallowRef<ReadonlySet<string>>(new Set())
const imageLoadFailed = ref(false)
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

useArticleReadProof(readBody, () => {
  const current = article.value
  return current?.id === Number(route.params.id) && (!nativeMarkdown || renderedArticle.value === current) ? current : undefined
})

function imageUnavailable(image: PublicArticleImage) {
  if (images.value?.includes(image)) failedImages.value = new Set([...failedImages.value, image.digest])
}

watch([() => route.params.id, retry], async ([id], _, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  article.value = undefined
  renderedArticle.value = undefined
  images.value = undefined
  failedImages.value = new Set()
  imageLoadFailed.value = false
  busy.value = true
  error.value = ''
  const articleId = Number(id)
  const current = () => !request.signal.aborted && route.params.id === id
  const initial = readInitialArticle(articleId)
  let value: Awaited<ReturnType<typeof api.publicArticle>>
  try {
    value = initial?.value ?? await api.publicArticle(articleId, request.signal)
    if (!current()) return
    if (value.id !== articleId) throw new ProtocolError('Unexpected article coordinates.')
    images.value = initial?.images
    article.value = value
    document.title = `${value.title} · ${siteTitle}`
  } catch (cause) {
    if (current()) error.value = cause instanceof ApiError && cause.status === 404 ? 'missing' : 'failed'
    return
  } finally {
    if (current()) busy.value = false
  }

  if (!value.hasPublishedMedia || images.value !== undefined) return
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
    const loaded = await fetchPublicArticleMedia(articleId, value.publication, signal)
    if (current()) images.value = loaded
  } catch {
    if (current()) imageLoadFailed.value = true
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
    <ElAlert v-if="!nativeMarkdown" title="Formatted view unavailable. Showing the original article text." type="info" :closable="false" />
    <div ref="readBody" v-bind="{ 'data-fsus-article-read-body': '' }">
      <ElMarkdownRenderer v-if="nativeMarkdown" :key="`${article.id}:${article.publication}`" :content="article.body"
        :content-version="article.publication.toString()" mode="article" @render-complete="renderedArticle = article" />
      <pre v-else class="article-source">{{ article.body }}</pre>
    </div>
    <section v-if="images?.length && failedImages.size < images.length" aria-label="Published images"
      v-bind="{ 'data-fsus-public-article-media': '', 'data-article-id': article.id, 'data-publication': article.publication.toString() }">
      <template v-for="(image, index) in images" :key="image.digest">
        <img v-if="!failedImages.has(image.digest)" :src="image.url" :width="image.width" :height="image.height"
          :alt="`Published image ${index + 1}`" loading="lazy" decoding="async" @error="imageUnavailable(image)">
      </template>
    </section>
    <div v-if="imageLoadFailed || failedImages.size" class="article-image-error">
      <p>Could not load the published images.</p>
      <ElButton @click="retry++">Reload article and images</ElButton>
    </div>
    <aside v-if="article.rights?.enabled && article.rights.showPublicBadge" class="article-rights" aria-label="Article rights">
      <p>{{ article.rights.licenseType }}</p>
      <p v-if="article.rights.copyrightHolder || article.rights.copyrightYear">
        {{ article.rights.copyrightHolder }} {{ article.rights.copyrightYear }}
      </p>
      <p v-if="article.rights.rightsStatement">{{ article.rights.rightsStatement }}</p>
    </aside>
    <ArticlePublicationProof v-if="article.rights?.enabled && article.rights.proofBindingEnabled"
      :key="article.publication.toString()" :article="article" />
    <RelatedReading :article-id="article.id" :publication="article.publication" />
    <ArticleComments :key="article.id" :article-id="article.id" :publication="article.publication" />
  </article>
</template>

<style scoped>
.article-image-error { margin-block: 2rem; }
</style>
