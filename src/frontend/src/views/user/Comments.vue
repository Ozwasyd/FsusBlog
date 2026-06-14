<template>
  <section class="account-page">
    <header class="account-page-header">
      <h1 class="account-page-title">我的评论</h1>
      <p class="account-page-description">
        查看你在站内留下的历史互动，并在需要时移除不再保留的评论内容。
      </p>
    </header>

    <div class="comments-filter-bar">
      <el-input
        v-model="searchKeyword"
        name="userCommentSearch"
        clearable
        placeholder="搜索评论内容或文章标题"
        aria-label="搜索评论"
      />
      <el-select v-model="timeFilter" name="userCommentTimeFilter" aria-label="筛选评论时间">
        <el-option label="全部时间" value="all" />
        <el-option label="近 7 天" value="7d" />
        <el-option label="近 30 天" value="30d" />
      </el-select>
      <el-button v-if="hasActiveFilter" @click="clearFilters">重置</el-button>
    </div>

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

      <div v-else-if="filteredList.length === 0" class="comments-filter-empty">
        <p>没有匹配的评论。</p>
        <el-button @click="clearFilters">清除筛选</el-button>
      </div>

      <UserCommentsList
        v-else
        :list="filteredList"
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
  filteredList,
  loading,
  searchKeyword,
  timeFilter,
  hasActiveFilter,
  showLoadMoreButton,
  showEndHint,
  loadMoreButtonText,
  endHintText,
  isError,
  fetchComments,
  clearFilters,
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

.comments-filter-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(8rem, 12rem) auto;
  gap: 0.75rem;
  margin-bottom: 2rem;
}

.comments-filter-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
  border: 1px solid var(--fsusblog-panel-border);
  padding: 2rem;
  color: var(--fsusblog-text-muted);
  font-size: 0.875rem;
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
  .comments-filter-bar {
    grid-template-columns: minmax(0, 1fr);
  }

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
