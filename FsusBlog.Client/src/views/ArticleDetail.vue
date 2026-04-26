<template>
  <ArticleDetailLoadingState v-if="loading" />

  <ArticleDetailErrorState
    v-else-if="isError"
    :view="articleDetailStates.errorState"
    @retry="loadArticle(false)"
  />

  <ArticleDetailStaticShell
    v-else-if="article"
    :view="articleView"
    :article-id="articleView.id"
    :author-name="articleAuthorName"
    :description="articleSummary"
    :canonical-url="articleCanonicalUrl || undefined"
    :comments-heading="detailView.comments.headingText"
    :comments-placeholder-title="detailView.comments.placeholderTitle"
    :comments-placeholder-body="detailView.comments.placeholderBody"
    :comments-placeholder-hint="detailView.comments.placeholderHint"
  >
    <template #header>
      <ArticleDetailHeader :view="articleView" />
    </template>

    <template #body>
      <ArticleDetailBody>
        <ArticleReadingNotice
          :visible="detailView.body.notice.visible"
          :label="detailView.body.notice.label"
        />
        <div
          v-if="!hasBodyContent"
          class="rounded-[var(--fsus-radius-xl)] border border-dashed border-[#E4E4E7] bg-[#FCFCFC]/80 px-5 py-5 text-sm leading-7 text-[#8E8E93] dark:border-[#27272A] dark:bg-[#18181B]/70 dark:text-[#D4D4D8]"
          aria-label="文章正文为空"
        >
          这篇文章目前还没有正文内容，首页显示的是摘要，不是正文。
        </div>
        <MarkdownRenderer
          v-else
          ref="articleRendererRef"
          :content="detailView.body.content"
          @render-complete="handleRenderComplete"
        />
      </ArticleDetailBody>
    </template>

    <template #footer>
      <ArticleDetailTagsFooter :view="articleView" />
    </template>

    <template #comments>
      <ArticleDetailCommentsPlaceholder
        v-if="!spaReady"
        :title="detailView.comments.placeholderTitle"
        :body="detailView.comments.placeholderBody"
        :hint="detailView.comments.placeholderHint"
      />
      <template v-else>
        <ArticleCommentComposer
          v-model="commentContent"
          :is-logged-in="userStore.isLoggedIn"
          :is-banned="userStore.isBanned"
          :is-pow-calculating="powProvider.isCalculating.value"
          :is-submitting="submittingComment"
          :redirect-path="route.fullPath"
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
              <span class="text-[10px] font-bold text-[#A1A1AA] uppercase animate-pulse">{{ detailView.comments.loadingText }}</span>
              <div class="w-10 h-px bg-[#F4F4F5] overflow-hidden relative">
                <div class="absolute inset-0 bg-[#0F0F11]/20 animate-loading-bar"></div>
              </div>
            </div>
            <div
              v-else-if="!hasMore"
              key="end"
              class="text-[10px] font-mono text-[#D4D4D8] uppercase px-4"
            >
              {{ detailView.comments.endText }}
            </div>
          </Transition>
        </div>
      </template>
    </template>
  </ArticleDetailStaticShell>

  <ArticleDetailNotFoundState
    v-else
    :view="articleDetailStates.notFoundState"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue' 
import ArticleDetailHeader from '@/components/article/ArticleDetailHeader.vue'
import ArticleReadingNotice from '@/components/article/ArticleReadingNotice.vue'
import ArticleDetailTagsFooter from '@/components/article/ArticleDetailTagsFooter.vue'
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'
import ArticleDetailStaticShell from '@/components/public/ArticleDetailStaticShell.vue'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'
import ArticleCommentsVirtualList from '@/components/article/ArticleCommentsVirtualList.vue'
import ArticleDetailLoadingState from '@/components/article/ArticleDetailLoadingState.vue'
import ArticleDetailErrorState from '@/components/article/ArticleDetailErrorState.vue'
import ArticleDetailNotFoundState from '@/components/article/ArticleDetailNotFoundState.vue'
import { useArticleDetailView } from '@/composables/useArticleDetailView'
import { useSiteStore } from '@/store/site'
import { useHead } from '@unhead/vue'
import { buildArticleStructuredData } from '@/utils/articleStructuredData'
import { articleDetailStates } from '@/view-contracts/articleDetail'

const siteStore = useSiteStore()

const {
  route,
  userStore,
  powProvider,
  article,
  articleView,
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
  loadArticle,
  handleRenderComplete,
  submitComment,
  handleCommentDelete,

  detailView,
  spaReady
} = useArticleDetailView()

const articleAuthorName = computed(() => {
  const author = siteStore.siteInfo.author?.trim()
  if (author) {
    return author
  }

  return siteStore.siteInfo.title?.trim() || 'Fsu'
})

const articleSummary = computed(() => {
  if (!article.value) {
    return ''
  }

  return article.value.summary?.trim() || article.value.title
})

const hasBodyContent = computed(() => detailView.value.body.content.trim().length > 0)

const articleCanonicalUrl = computed(() => {
  const articleId = article.value?.id
  if (!articleId) {
    return null
  }

  if (typeof window === 'undefined') {
    return `/article/${articleId}`
  }

  return `${window.location.origin}/article/${articleId}`
})

const articleStructuredData = computed(() => {
  if (!article.value) {
    return ''
  }

  return buildArticleStructuredData({
    id: article.value.id,
    title: article.value.title,
    summary: articleSummary.value,
    articleBody: detailView.value.body.content,
    publishedTime: article.value.createTime,
    authorName: articleAuthorName.value,
    categoryName: article.value.category?.name,
    canonicalUrl: articleCanonicalUrl.value
  })
})

useHead(computed(() => ({
  script: articleStructuredData.value
    ? [{ type: 'application/ld+json', children: articleStructuredData.value }]
    : []
})))
</script>

<style scoped>
@reference "@/assets/main.css";

@keyframes loading-bar {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.animate-loading-bar {
  animation: loading-bar 1.5s infinite;
}

.state-fade-enter-active,
.state-fade-leave-active {
  transition: opacity 0.3s ease;
}
.state-fade-enter-from,
.state-fade-leave-to {
  opacity: 0;
}
</style>
