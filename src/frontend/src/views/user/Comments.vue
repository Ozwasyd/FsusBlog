<template>
  <section class="account-page">
    <header class="account-page-header">
      <div class="account-page-eyebrow">交互</div>
      <h1 class="account-page-title">我的评论</h1>
      <p class="account-page-description">
        查看你在站内留下的历史互动，并在需要时移除不再保留的评论内容。
      </p>
    </header>

    <transition name="fade-fast" mode="out-in">
      <UserCommentsErrorState v-if="isError" @retry="fetchComments" />

      <div v-else-if="loading && list.length === 0" class="comments-skeleton-wrap">
        <div v-for="i in 3" :key="i" class="comment-skeleton-item">
          <el-skeleton animated>
            <template #template>
              <div class="skeleton-header">
                <div class="skeleton-line skeleton-line--header-primary">
                  <el-skeleton-item variant="text" />
                </div>
                <div class="skeleton-line skeleton-line--header-secondary">
                  <el-skeleton-item variant="text" />
                </div>
              </div>
              <div class="skeleton-line skeleton-line--body-full">
                <el-skeleton-item variant="p" />
              </div>
              <div class="skeleton-line skeleton-line--body-short">
                <el-skeleton-item variant="p" />
              </div>
            </template>
          </el-skeleton>
        </div>
      </div>

      <UserCommentsEmptyState v-else-if="list.length === 0" />

      <UserCommentsList
        v-else
        :list="list"
        :loading="loading"
        :show-load-more-button="showLoadMoreButton"
        :show-end-hint="showEndHint"
        :load-more-button-text="loadMoreButtonText"
        :end-hint-text="endHintText"
        @delete="onDelete"
        @load-more="fetchComments"
      />
    </transition>
  </section>
</template>

<script setup lang="ts">
import { useUserCommentsPage } from '@/composables/useUserCommentsPage'
import UserCommentsErrorState from '@/components/user/UserCommentsErrorState.vue'
import UserCommentsEmptyState from '@/components/user/UserCommentsEmptyState.vue'
import UserCommentsList from '@/components/user/UserCommentsList.vue'

const {
  list,
  loading,
  showLoadMoreButton,
  showEndHint,
  loadMoreButtonText,
  endHintText,
  isError,
  fetchComments,
  onDelete
} =
  useUserCommentsPage()
</script>

<style scoped>
@reference "@/assets/main.css";

.fade-fast-enter-active,
.fade-fast-leave-active {
  transition: opacity var(--fsus-motion-control) var(--fsus-motion-standard);
}

.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
}

.comments-skeleton-wrap {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.comment-skeleton-item {
  padding: 1.5rem;
  background: var(--fsusblog-panel-bg, Canvas);
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-popover);
}

.skeleton-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.skeleton-line {
  display: block;
}

.skeleton-line--header-primary {
  width: 30%;
}

.skeleton-line--header-secondary {
  width: 20%;
}

.skeleton-line--body-full {
  margin-top: 12px;
  width: 100%;
}

.skeleton-line--body-short {
  margin-top: 8px;
  width: 80%;
}

.list-fade-enter-active,
.list-fade-leave-active {
  transition: opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    transform var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.list-fade-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.list-fade-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

.list-fade-leave-active {
  position: absolute;
  width: 100%;
}

@media (max-width: 640px) {
  .list-fade-leave-active {
    width: calc(100% - 3rem);
  }
}

.wrap-break-word {
  overflow-wrap: break-word;
  word-break: break-word;
}

@media (prefers-reduced-motion: reduce) {
  .fade-fast-enter-active,
  .fade-fast-leave-active,
  .list-fade-enter-active,
  .list-fade-leave-active {
    transition: none;
  }
}
</style>
