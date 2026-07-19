<template>
  <div class="fsus-comments-list" data-fsus-surface="reading" aria-label="评论树">
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
      @delete="$emit('delete', $event)"
    />

    <div v-if="hasHiddenRootThreads" class="fsus-comments-list__more">
      <button type="button" class="fsus-comments-list__action" @click="showMoreRootThreads">
        显示更多评论（{{ hiddenRootThreadCount }}）
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CommentAuthorView } from '@/api/comment'
import ArticleCommentTreeNode from '@/components/article/ArticleCommentTreeNode.vue'
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream'
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter'

type ReplyTargetPayload = { id: string; rootId: string; author: CommentAuthorView; depth: number }
type DeletePayload = { id: string; rootId: string; parentId: string | null; content: string }

const props = defineProps<{
  threads: CommentTreeViewNode[]
  isAdmin: boolean
  isLoggedIn: boolean
  ownedCommentIds: ReadonlySet<string>
  loadingReplies: Record<string, boolean>
  initialRenderLimit?: number
}>()

defineEmits<{
  delete: [payload: DeletePayload]
  reply: [payload: ReplyTargetPayload]
  loadMoreReplies: [parentId: string]
}>()

const rootRenderLimit = ref(props.initialRenderLimit ?? COMMENT_CONTENT_CONSTRAINT.rootRenderLimit)
const visibleThreadItems = computed(() => props.threads.slice(0, rootRenderLimit.value))
const hiddenRootThreadCount = computed(() => Math.max(0, props.threads.length - visibleThreadItems.value.length))
const hasHiddenRootThreads = computed(() => hiddenRootThreadCount.value > 0)
const showMoreRootThreads = (): void => { rootRenderLimit.value += COMMENT_CONTENT_CONSTRAINT.rootRenderLimit }
</script>

<style scoped>
.fsus-comments-list { display: flex; flex-direction: column; }
.fsus-comments-list__more { padding-block: 12px; }
.fsus-comments-list__action {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fsusblog-text-muted);
  font: inherit;
  cursor: pointer;
}
.fsus-comments-list__action:hover { color: var(--fsusblog-color-primary); }
.fsus-comments-list__action:focus-visible { outline: 2px solid var(--fsusblog-color-focus-ring); outline-offset: 4px; }
</style>
