<template>
    <section class="account-page">
        <FsusUiTaskPageHeader
            title="公开评论记录"
            description="查看、筛选和删除公开发送的评论。匿名评论不进入账号记录。"
            class="account-task-page-header"
        />

        <UserCommentsCollectionToolbar>
            <ElInput
                v-model="searchKeyword"
                name="userCommentSearch"
                clearable
                placeholder="搜索评论内容或文章标题"
                aria-label="搜索评论"
            />
            <ElSelect
                v-model="timeFilter"
                name="userCommentTimeFilter"
                aria-label="筛选评论时间"
            >
                <ElOption
                    label="全部时间"
                    value="all"
                />
                <ElOption
                    label="近 7 天"
                    value="7d"
                />
                <ElOption
                    label="近 30 天"
                    value="30d"
                />
            </ElSelect>
            <ElButton
                v-if="hasActiveFilter"
                @click="clearFilters"
            >重置</ElButton>
        </UserCommentsCollectionToolbar>

        <UserCommentsErrorState
            v-if="isError"
            @retry="fetchComments"
        />

        <div
            v-else-if="loading && list.length === 0"
            class="comments-skeleton-wrap"
        >
            <div
                v-for="i in 3"
                :key="i"
                class="comment-skeleton-item"
            >
                <ElSkeleton animated>
                    <template #template>
                        <div class="skeleton-header">
                            <div class="skeleton-line skeleton-line--header-primary">
                                <ElSkeletonItem variant="text" />
                            </div>
                            <div class="skeleton-line skeleton-line--header-secondary">
                                <ElSkeletonItem variant="text" />
                            </div>
                        </div>
                        <div class="skeleton-line skeleton-line--body-full">
                            <ElSkeletonItem variant="p" />
                        </div>
                        <div class="skeleton-line skeleton-line--body-short">
                            <ElSkeletonItem variant="p" />
                        </div>
                    </template>
                </ElSkeleton>
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
                <ElButton @click="clearFilters">清除筛选</ElButton>
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
import UserCommentsCollectionToolbar from '@/components/user/UserCommentsCollectionToolbar.vue';
import UserCommentsEmptyState from '@/components/user/UserCommentsEmptyState.vue';
import UserCommentsErrorState from '@/components/user/UserCommentsErrorState.vue';
import UserCommentsList from '@/components/user/UserCommentsList.vue';
import { useUserCommentsPage } from '@/composables/useUserCommentsPage';
import { FsusUiTaskPageHeader } from '@/fsusui';

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
    useUserCommentsPage();
</script>

<style scoped>
@reference "@/assets/main.css";

.comments-skeleton-wrap
 {
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-6);
}

.comment-skeleton-item
 {
    padding: var(--fsus-space-6);
    background: var(--fsusblog-panel-bg, Canvas);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-popover);
}

.skeleton-header
 {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.skeleton-line
 {
    display: block;
}

.skeleton-line--header-primary
 {
    width: 30%;
}

.skeleton-line--header-secondary
 {
    width: 20%;
}

.skeleton-line--body-full
 {
    margin-top: var(--fsus-space-3);
    width: 100%;
}

.skeleton-line--body-short
 {
    margin-top: var(--fsus-space-2);
    width: 80%;
}

.wrap-break-word
 {
    overflow-wrap: break-word;
    word-break: break-word;
}
</style>
