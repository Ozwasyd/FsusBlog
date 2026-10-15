<template>
    <div
        class="fsus-comments-list"
        data-fsus-surface="reading"
        aria-label="评论树"
    >
        <ArticleCommentTreeNode
            v-for="thread in visibleThreadItems"
            :key="thread.id"
            :node="thread"
            :depth="0"
            :is-admin="isAdmin"
            :is-logged-in="isLoggedIn"
            :owned-comment-ids="ownedCommentIds"
            :loading-replies="loadingReplies"
            @reply="$emit('reply', $event)"
            @load-more="$emit('loadMoreReplies', $event)"
            @edit="$emit('edit', $event)"
            @delete="$emit('delete', $event)"
        />

        <div
            v-if="hasHiddenRootThreads"
            class="fsus-comments-list__more"
        >
            <FsusUiButton
                native-type="button"
                link
                @click="showMoreRootThreads"
            >
                显示更多评论（{{ hiddenRootThreadCount }}）
            </FsusUiButton>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { CommentAuthorView } from '@/api/comment';
import ArticleCommentTreeNode from '@/components/article/ArticleCommentTreeNode.vue';
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream';
import { FsusUiButton } from '@/fsusui/button';
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter';

interface ReplyTargetPayload { id: string; rootId: string; author: CommentAuthorView; depth: number; }
interface DeletePayload { id: string; rootId: string; parentId: string | null; content: string; }
interface EditPayload { id: string; content: string; }

const props = defineProps<{
    threads: CommentTreeViewNode[];
    isAdmin: boolean;
    isLoggedIn: boolean;
    ownedCommentIds: ReadonlySet<string>;
    loadingReplies: Record<string, boolean>;
    initialRenderLimit?: number;
}>();

defineEmits<{
    delete: [payload: DeletePayload];
    edit: [payload: EditPayload];
    reply: [payload: ReplyTargetPayload];
    loadMoreReplies: [parentId: string];
}>();

const rootRenderLimit = ref(props.initialRenderLimit ?? COMMENT_CONTENT_CONSTRAINT.rootRenderLimit);
const visibleThreadItems = computed(() => props.threads.slice(0, rootRenderLimit.value));
const hiddenRootThreadCount = computed(() => Math.max(0, props.threads.length - visibleThreadItems.value.length));
const hasHiddenRootThreads = computed(() => hiddenRootThreadCount.value > 0);
const showMoreRootThreads = (): void =>
{
    rootRenderLimit.value += COMMENT_CONTENT_CONSTRAINT.rootRenderLimit;
};
</script>

<style scoped>
.fsus-comments-list
 {
    display: flex;
    flex-direction: column;
}

.fsus-comments-list__more
 {
    padding-block: 12px;
}

.fsus-comment__reply-target,
.fsus-comment__time
 {
    font-size: 14px;
    line-height: 1.4;
}
</style>
