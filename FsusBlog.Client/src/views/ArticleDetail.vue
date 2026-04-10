<template>
  <div>
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
          <AotHost
            v-if="aotRenderedHtml"
            class="aot-rendered-content"
            :html="aotRenderedHtml"
          />
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
            @submit="submitComment"
          />

          <!--[重构 2026-03-13] 剥离极耗性能的 TransitionGroup，引入基于切片的 O(1) 虚拟滚动容器 -->
          <div ref="virtualListRef" class="space-y-8" :style="virtualListStyle" aria-live="polite">
            <ArticleCommentsVirtualList
              :comments="visibleComments"
              :is-admin="userStore.isAdmin"
              :is-logged-in="userStore.isLoggedIn"
              :current-username="userStore.userInfo?.username ?? null"
              @delete="handleCommentDelete"
            />
          </div>

          <!-- 触底加载触发器 -->
          <div ref="loadMoreTrigger" class="h-32 flex flex-col items-center justify-center mt-8">
            <Transition name="state-fade" mode="out-in">
              <div v-if="loadingComments" key="loading" class="flex flex-col items-center gap-3" role="status">
                <span class="text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase animate-pulse">{{ detailView.comments.loadingText }}</span>
                <div class="w-10 h-px bg-zinc-100 overflow-hidden relative">
                  <div class="absolute inset-0 bg-zinc-950/20 animate-loading-bar"></div>
                </div>
              </div>
              <div v-else-if="!hasMore" key="end"
                class="text-[10px] font-mono text-zinc-300 uppercase tracking-widest px-4 text-center">
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

    <!-- 统一层级协调 -->
    <ConfirmModal v-model:visible="modalState.visible" :title="modalState.title" :content="modalState.content"
      @confirm="modalState.onConfirm" @cancel="modalState.onCancel" />
  </div>
</template>

<script setup lang="ts">
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue' 
import ArticleDetailHeader from '@/components/article/ArticleDetailHeader.vue'
import ArticleDetailTagsFooter from '@/components/article/ArticleDetailTagsFooter.vue'
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'
import ArticleDetailStaticShell from '@/components/public/ArticleDetailStaticShell.vue'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'
import ArticleCommentsVirtualList from '@/components/article/ArticleCommentsVirtualList.vue'
import ArticleDetailLoadingState from '@/components/article/ArticleDetailLoadingState.vue'
import ArticleDetailErrorState from '@/components/article/ArticleDetailErrorState.vue'
import ArticleDetailNotFoundState from '@/components/article/ArticleDetailNotFoundState.vue'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'
import AotHost from '@/components/AotHost.vue'
import { useArticleDetailView } from '@/composables/useArticleDetailView'
import { articleDetailStates } from '@/view-contracts/articleDetail'

const {
  route,
  userStore,
  powProvider,
  article,
  articleView,
  loading,
  isError,
  aotRenderedHtml,
  articleRendererRef,
  commentContent,
  submittingComment,
  comments,
  visibleComments,
  hasMore,
  loadingComments,
  loadMoreTrigger,
  virtualListRef,
  loadArticle,
  handleRenderComplete,
  submitComment,
  handleCommentDelete,
  modalState,
  detailView,
  virtualListStyle,
  spaReady
} = useArticleDetailView()
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
