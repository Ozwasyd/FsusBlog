<template>
  <section class="account-page">
    <header class="account-page-header">
      <div class="account-page-eyebrow">交互</div>
      <h1 class="account-page-title">我的评论</h1>
      <p class="account-page-description">
        查看你在站内留下的历史互动，并在需要时移除不再保留的评论内容。
      </p>
    </header>

    <UserCommentsErrorState v-if="isError" @retry="fetchComments" />

    <UserCommentsEmptyState v-else-if="!loading && list.length === 0" />

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

.list-fade-enter-active,
.list-fade-leave-active {
  transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform, opacity;
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
</style>
