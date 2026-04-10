<template>
  <div class="max-w-3xl mx-auto w-full py-10 sm:py-16 px-6 sm:px-8">
    
    <header class="mb-12 sm:mb-20">
      <div class="text-[9px] sm:text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">交互</div>
      <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950 mb-6 sm:mb-8">
        我的评论
      </h1>
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

    <!-- 模态框统一调用 -->
    <ConfirmModal 
      v-model:visible="showConfirm"
      title="删除评论"
      content="确定要永久移除这条评论吗？此操作无法撤销。"
      @confirm="executeDelete"
    />

  </div>
</template>

<script setup lang="ts">
import { useUserCommentsPage } from '@/composables/useUserCommentsPage'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'
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
  showConfirm,
  fetchComments,
  onDelete,
  executeDelete
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
