<template>
  <ArticleReadingProgress
    v-if="articleContentRoot"
    :content-root="articleContentRoot"
  />

  <ArticleDetailLoadingState v-if="showLoadingState" />

  <ArticleDetailErrorState
    v-else-if="showErrorState"
    :view="articleDetailStates.errorState"
    @retry="loadArticle(false)"
  />

  <template v-else-if="shouldRenderArticleShell">
    <PublicArticleDetailPageContent
      :detail-view="pageDetailView"
      :article-id="displayArticleId"
      :author-name="articleAuthorName"
      :article-summary="articleSummary"
      :canonical-url="articleCanonicalUrl"
      :has-body-content="hasBodyContent"
      :body-content="pageDetailView.body.content"
      :body-html="initialArticleBodyHtml"
      link-mode="anchor"
    >
      <template v-if="canRenderBodyRuntime" #header-actions>
        <ArticleShareActions
          :title="pageDetailView.header.title"
          :canonical-url="articleCanonicalUrl"
        />
      </template>

      <template v-if="canRenderBodyRuntime" #body>
        <MarkdownRenderer
          ref="articleRendererRef"
          :content="pageDetailView.body.content"
          :initial-html="initialArticleBodyHtml"
          itemprop="articleBody"
          @render-complete="handleArticleRenderComplete"
        />
      </template>

      <template v-if="canRenderCommentsRuntime" #comments>
        <ArticleCommentComposer
          v-model="commentContent"
          :is-logged-in="userStore.isLoggedIn"
          :is-banned="userStore.isBanned"
          :is-pow-calculating="powProvider.isCalculating.value"
          :is-submitting="submittingComment"
          :redirect-path="commentRedirectPath"
          :reply-target="replyTarget"
          @submit="submitComment"
          @cancel-reply="clearReplyTarget"
        />

        <ArticleCommentsVirtualList
          class="space-y-8"
          aria-live="polite"
          :threads="threads"
          :is-admin="userStore.isAdmin"
          :is-logged-in="userStore.isLoggedIn"
          :current-username="userStore.userInfo?.username ?? null"
          :loading-replies="loadingReplies"
          @delete="handleCommentDelete"
          @reply="setReplyTarget"
          @load-more-replies="loadMoreReplies"
        />

        <div ref="loadMoreTrigger" class="h-32 flex flex-col items-center justify-center mt-8">
          <Transition name="state-fade" mode="out-in">
            <div v-if="loadingComments" key="loading" class="flex flex-col items-center gap-5" role="status">
              <span class="text-[10px] font-bold text-[var(--fsusblog-text-muted)] normal-case ">{{ pageDetailView.comments.loadingText }}</span>
              <div class="w-10 h-px bg-[var(--fsusblog-panel-bg-soft)] overflow-hidden relative">
                <div class="absolute inset-0 bg-[var(--fsusblog-text-primary)]/20 animate-loading-bar"></div>
              </div>
            </div>
            <el-button
              v-else-if="hasMore"
              key="manual"
              link
              :disabled="loadingComments"
              @click="loadMoreComments"
            >
              加载更多评论
            </el-button>
            <div
              v-else-if="!hasMore"
              key="end"
              class="text-[10px] tabular-nums text-[var(--fsusblog-text-subtle)] normal-case px-4"
            >
              {{ pageDetailView.comments.endText }}
            </div>
          </Transition>
        </div>
      </template>
    </PublicArticleDetailPageContent>

    <ArticleTocPanel
      v-model:mobile-open="tocMobileOpen"
      :items="tocItems"
      :active-id="activeTocId"
      @navigate="navigateToTocItem"
    />

    <ArticleImageLightbox
      :open="lightboxOpen"
      :images="lightboxImages"
      :active-index="lightboxActiveIndex"
      @close="closeLightbox"
      @next="nextLightboxImage"
      @previous="previousLightboxImage"
    />

    <ArticleMobileActionBar
      :has-toc="tocItems.length > 0"
      @toc="tocMobileOpen = true"
      @comments="navigateToComments"
      @share="shareArticle"
      @top="scrollToArticleTop"
    />
  </template>

  <ArticleDetailNotFoundState
    v-else
    :view="articleDetailStates.notFoundState"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { runtimeReady } from '@/bootstrap/runtimeGate'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'
import ArticleCommentsVirtualList from '@/components/article/ArticleCommentsVirtualList.vue'
import ArticleDetailLoadingState from '@/components/article/ArticleDetailLoadingState.vue'
import ArticleDetailErrorState from '@/components/article/ArticleDetailErrorState.vue'
import ArticleDetailNotFoundState from '@/components/article/ArticleDetailNotFoundState.vue'
import ArticleImageLightbox from '@/components/article/ArticleImageLightbox.vue'
import ArticleMobileActionBar from '@/components/article/ArticleMobileActionBar.vue'
import ArticleReadingProgress from '@/components/article/ArticleReadingProgress.vue'
import ArticleShareActions from '@/components/article/ArticleShareActions.vue'
import ArticleTocPanel from '@/components/article/ArticleTocPanel.vue'
import PublicArticleDetailPageContent from '@/components/public/pages/PublicArticleDetailPageContent.vue'
import { useArticleImageLightbox } from '@/composables/article/useArticleImageLightbox'
import { useArticleShare } from '@/composables/article/useArticleShare'
import { useArticleToc } from '@/composables/article/useArticleToc'
import { useCodeBlockCopy } from '@/composables/article/useCodeBlockCopy'
import { useArticleDetailView } from '@/composables/useArticleDetailView'
import { useHumanReadProof } from '@/composables/useHumanReadProof'
import { resolveMotionScrollBehavior } from '@/composables/useMotionPreference'
import { readPublicHydrationSeed } from '@/public-renderers/pageSeed'
import { buildPublicArticleRouteKey } from '@/public-renderers/publicRouteIdentity'
import { useSiteStore } from '@/store/site'
import { articleDetailStates } from '@/view-contracts/articleDetail'

const siteStore = useSiteStore()
const router = useRouter()
const initialArticlePayload = readPublicHydrationSeed('ArticleDetail')

const {
  route,
  userStore,
  powProvider,
  initialBootstrapArticle,
  article,
  loading,
  isError,
  articleRendererRef,
  commentContent,
  submittingComment,
  threads,
  hasMore,
  loadingComments,
  loadingReplies,
  loadMoreTrigger,
  replyTarget,
  setReplyTarget,
  clearReplyTarget,
  loadMoreReplies,
  loadMoreComments,
  loadArticle,
  handleRenderComplete,
  submitComment,
  handleCommentDelete,

  detailView,
  spaReady
} = useArticleDetailView()

void loadMoreTrigger

useHumanReadProof({
  scope: computed(() => 'article'),
  routeKey: computed(() => article.value ? buildPublicArticleRouteKey(article.value.id) : ''),
  articleId: computed(() => article.value?.id ?? null),
  enabled: computed(() => spaReady.value && article.value !== null && !loading.value && !isError.value)
})

const articleAuthorName = computed(() => {
  const author = siteStore.siteInfo.author?.trim()
  if (author) {
    return author
  }

  const hydratedAuthor = initialArticlePayload?.authorName?.trim()
  if (hydratedAuthor) {
    return hydratedAuthor
  }

  return siteStore.siteInfo.title?.trim() || 'Fsu'
})

const hydratedRouteArticleId = computed(() => {
  const value = Number(initialArticlePayload?.articleId)
  return Number.isFinite(value) ? value : null
})

const activeRouteArticleId = computed(() => {
  const value = Number(route.params.id)
  return Number.isFinite(value) ? value : null
})

const shouldUseHydratedDetailView = computed(() => (
  initialArticlePayload?.detailView
  && hydratedRouteArticleId.value !== null
  && activeRouteArticleId.value === hydratedRouteArticleId.value
  && !spaReady.value
))

const shouldRenderArticleShell = computed(() => (
  shouldUseHydratedDetailView.value
  || article.value !== null
  || initialBootstrapArticle !== null
))

const showLoadingState = computed(() => loading.value && !shouldRenderArticleShell.value)

const showErrorState = computed(() => isError.value && !shouldRenderArticleShell.value)

const displayArticleId = computed(() => (
  article.value?.id
  ?? initialBootstrapArticle?.id
  ?? hydratedRouteArticleId.value
  ?? 0
))

const pageDetailView = computed(() => (
  shouldUseHydratedDetailView.value && initialArticlePayload?.detailView
    ? initialArticlePayload.detailView
    : detailView.value
))

const canRenderBodyRuntime = ref(false)
const canRenderCommentsRuntime = computed(() => spaReady.value && runtimeReady.value)
const tocMobileOpen = ref(false)

const commentRedirectPath = computed(() => {
  const basePath = route.fullPath.split('#')[0] || route.path
  return `${basePath}#comments`
})

const articleSummary = computed(() => {
  if (article.value) {
    return article.value.summary?.trim() || article.value.title
  }

  if (initialBootstrapArticle) {
    return initialBootstrapArticle.summary?.trim() || initialBootstrapArticle.title
  }

  return pageDetailView.value.header.title
})

const hasBodyContent = computed(() => pageDetailView.value.body.content.trim().length > 0)

const articleCanonicalUrl = computed(() => {
  const articleId = displayArticleId.value
  if (!articleId) {
    return null
  }

  const baseUrl = initialArticlePayload?.baseUrl?.trim()
  if (!baseUrl) {
    return null
  }

  return `${baseUrl.replace(/\/+$/, '')}/article/${articleId}`
})

const initialArticleBodyHtml = computed(() => {
  const hydratedHtml = initialArticlePayload?.bodyHtml?.trim()
  return hydratedHtml || ''
})

const articleContentRoot = computed<HTMLElement | null>(() => {
  const exposed = articleRendererRef.value?.rootEl as HTMLElement | { value?: HTMLElement | null } | null | undefined
  if (typeof HTMLElement !== 'undefined' && exposed instanceof HTMLElement) {
    return exposed
  }
  return exposed?.value ?? null
})

const {
  items: tocItems,
  activeId: activeTocId,
  refresh: refreshToc,
  navigateTo: navigateToTocItem
} = useArticleToc(() => articleContentRoot.value)

const {
  refresh: refreshCodeBlocks
} = useCodeBlockCopy(() => articleContentRoot.value)

const {
  images: lightboxImages,
  activeIndex: lightboxActiveIndex,
  open: lightboxOpen,
  refresh: refreshLightboxImages,
  close: closeLightbox,
  next: nextLightboxImage,
  previous: previousLightboxImage
} = useArticleImageLightbox(() => articleContentRoot.value)

const {
  shareOrCopy: shareArticle
} = useArticleShare({
  title: computed(() => pageDetailView.value.header.title),
  canonicalUrl: articleCanonicalUrl
})

const refreshArticleEnhancements = async (): Promise<void> => {
  await nextTick()
  await Promise.all([
    refreshToc(),
    refreshCodeBlocks(),
    refreshLightboxImages()
  ])
}

const handleArticleRenderComplete = (): void => {
  handleRenderComplete()
  void refreshArticleEnhancements()
}

const navigateToComments = (): void => {
  const basePath = route.fullPath.split('#')[0] || route.path
  void router.replace(`${basePath}#comments`)
}

const scrollToArticleTop = (): void => {
  window.history.replaceState(window.history.state, '', route.fullPath.split('#')[0] || route.path)
  window.scrollTo({
    top: 0,
    behavior: resolveMotionScrollBehavior()
  })
}

onMounted(() => {
  void nextTick(() => {
    canRenderBodyRuntime.value = true
    void refreshArticleEnhancements()
  })
})

</script>

<style scoped>
@reference "@/assets/main.css";

.animate-loading-bar {
  animation: blog-motion-loading-bar calc(var(--blog-motion-panel) * 4) linear infinite;
}

.state-fade-enter-active,
.state-fade-leave-active {
  transition: opacity var(--fsus-motion-control) var(--fsus-motion-standard);
}
.state-fade-enter-from,
.state-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .animate-loading-bar,
  .state-fade-enter-active,
  .state-fade-leave-active {
    animation: none !important;
    transition: none !important;
  }
}
</style>
