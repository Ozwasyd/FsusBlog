<template>
  <section class="account-page">
    <FsusUiTaskPageHeader
      title="公开评论记录"
      description="匿名评论不进入账号记录。"
      class="account-task-page-header"
    />

    <UserCommentsCollectionToolbar>
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
    </UserCommentsCollectionToolbar>

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

    <UserCommentsEmptyState
      v-else-if="list.length === 0"
      title="暂无公开评论记录"
      description="公开发送的评论会显示在这里。匿名评论不会按账号检索。"
    />

    <UserCommentsEmptyState
      v-else-if="filteredList.length === 0"
      title="没有匹配的公开评论"
      description="调整关键词或清除筛选。"
    >
      <template #actions>
        <el-button @click="clearFilters">清除筛选</el-button>
      </template>
    </UserCommentsEmptyState>

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
  </section>
</template>

<script setup lang="ts">
import { FsusUiTaskPageHeader } from '@/fsusui'
import { useUserCommentsPage } from '@/composables/useUserCommentsPage'
import UserCommentsCollectionToolbar from '@/components/user/UserCommentsCollectionToolbar.vue'
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

.comments-skeleton-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--fsus-space-6);
}

.comment-skeleton-item {
  padding: var(--fsus-space-6);
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
  margin-top: var(--fsus-space-3);
  width: 100%;
}

.skeleton-line--body-short {
  margin-top: var(--fsus-space-2);
  width: 80%;
}

.wrap-break-word {
  overflow-wrap: break-word;
  word-break: break-word;
}
</style>
