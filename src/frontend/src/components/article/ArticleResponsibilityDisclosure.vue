<template>
  <aside
    class="article-responsibility"
    data-article-responsibility
    :data-manifest-state="state"
    aria-label="作者、来源与修订说明"
  >
    <div class="article-responsibility__people">
      <span>作者</span>
      <template v-for="(author, index) in authors" :key="`${author.name}:${index}`">
        <span v-if="index > 0" aria-hidden="true">、</span>
        <a v-if="author.profileUrl" :href="author.profileUrl" rel="author noopener noreferrer">{{ author.name }}</a>
        <span v-else itemprop="author">{{ author.name }}</span>
      </template>
      <template v-if="manifest?.reviewer">
        <span aria-hidden="true"> · </span>
        <span>审阅</span>
        <a
          v-if="manifest.reviewer.profileUrl"
          :href="manifest.reviewer.profileUrl"
          rel="noopener noreferrer"
        >{{ manifest.reviewer.name }}</a>
        <span v-else>{{ manifest.reviewer.name }}</span>
      </template>
    </div>

    <details v-if="manifest && (manifest.sources.length > 0 || manifest.update)" class="article-responsibility__details">
      <summary>来源与修订</summary>
      <div v-if="manifest.update" data-article-update-note>
        <strong>{{ manifest.update.summary }}</strong>
        <span>{{ manifest.update.reason }}</span>
        <span>结论影响：{{ conclusionImpactLabel }}</span>
      </div>
      <ol v-if="manifest.sources.length > 0" data-article-sources>
        <li v-for="source in manifest.sources" :key="`${source.url}:${source.title}`">
          <a :href="source.url" rel="noopener noreferrer nofollow">{{ source.title }}</a>
          <span> · {{ source.sourceType }}</span>
          <span v-if="source.accessedOn"> · 访问于 {{ source.accessedOn }}</span>
        </li>
      </ol>
    </details>
    <div class="article-responsibility__verification">
      <a :href="verificationHref" data-article-verification-link>核验本次修订</a>
      <span :data-proof-status="proofStatus">{{ proofStatusLabel }}</span>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  normalizeArticleResponsibilityPublicView,
  type ArticleResponsiblePersonView,
  type ArticleResponsibilityPublicView
} from '@/view-contracts/articleResponsibility'

const props = defineProps<{
  articleId: number
  fallbackAuthor: string
  initialAuthors?: readonly ArticleResponsiblePersonView[]
  initialManifest?: ArticleResponsibilityPublicView | null
}>()

const manifest = ref<ArticleResponsibilityPublicView | null>(props.initialManifest ?? null)
const state = ref<'fallback' | 'ready' | 'unavailable'>(manifest.value ? 'ready' : 'fallback')
const safeFallbackAuthor = computed(() => props.fallbackAuthor.trim() || 'Fsu')
const authors = computed<readonly ArticleResponsiblePersonView[]>(() => (
  manifest.value?.authors.length
    ? manifest.value.authors
    : props.initialAuthors?.length
      ? props.initialAuthors
      : [{ name: safeFallbackAuthor.value, profileUrl: null }]
))
const verificationHref = computed(() => (
  manifest.value?.verification.url || `/integrity/article/${props.articleId}/responsibility`
))
const proofStatus = computed(() => manifest.value?.verification.proofStatus || 'unavailable')
const proofStatusLabel = computed(() => ({
  ready: '核验材料可用',
  failed: '核验失败',
  unavailable: '核验状态暂不可用'
}[proofStatus.value] || '核验状态暂不可用'))
const conclusionImpactLabel = computed(() => ({
  none: '未改变',
  clarified: '说明更清晰',
  changed: '结论已改变'
}[manifest.value?.update?.conclusionImpact || ''] || '未说明'))

onMounted(async () => {
  if (!Number.isInteger(props.articleId) || props.articleId <= 0) return
  try {
    const response = await fetch(`/integrity/article/${props.articleId}/responsibility`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) throw new Error('article_responsibility_unavailable')
    const payload = normalizeArticleResponsibilityPublicView(await response.json())
    if (!payload || payload.articleId !== props.articleId) {
      throw new Error('article_responsibility_invalid')
    }
    manifest.value = payload
    state.value = 'ready'
  } catch {
    state.value = 'unavailable'
  }
})
</script>

<style scoped>
.article-responsibility {
  margin-top: 12px;
  color: var(--fsusblog-text-quiet);
  font-size: 13px;
  line-height: 1.7;
}
.article-responsibility a {
  color: var(--fsusblog-color-primary);
  text-underline-offset: 3px;
}
.article-responsibility__details {
  margin-top: 6px;
}
.article-responsibility__details > div,
.article-responsibility__details ol {
  display: grid;
  gap: 4px;
  margin: 8px 0;
  padding-left: 18px;
}
.article-responsibility__details > div {
  padding-left: 0;
}
.article-responsibility__verification {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 4px;
}
</style>
