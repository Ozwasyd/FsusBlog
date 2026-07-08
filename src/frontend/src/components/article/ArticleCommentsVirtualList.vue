<template>
  <div class="space-y-8" data-fsus-surface="reading">
    <article
      v-for="thread in visibleThreadItems"
      :key="thread.id"
      :class="commentDetailTokens.articleList.itemRoot"
      v-memo="[thread.id, thread.content, thread.replies.length, thread.canDelete, isCommentExpanded(rootCommentKey(thread.id)), isCommentFoldable(rootCommentKey(thread.id), thread.content)]"
    >
      <div :class="commentDetailTokens.articleList.headerRoot">
        <div :class="commentDetailTokens.articleList.headerMeta">
          <span :class="commentDetailTokens.articleList.authorName">{{ thread.author.displayName }}</span>
          <el-button
            link
            @click="$emit('reply', { id: thread.id, rootId: thread.rootId, author: thread.author, depth: 0 })"
          >
            {{ isLoggedIn ? '回复' : '登录后回复' }}
          </el-button>
          <el-button
            v-if="thread.canDelete"
            link
            type="danger"
            aria-label="删除评论"
            @click="$emit('delete', { id: thread.id, rootId: thread.rootId, parentId: null, content: thread.content })"
          >
            删除
          </el-button>
        </div>
        <span
          :class="commentDetailTokens.articleList.timeText"
          :title="thread.time.fullLocalTimeText"
          :datetime="thread.time.isoTime"
        >
          {{ thread.time.relativeTimeText }}
        </span>
      </div>
      <div :class="commentDetailTokens.articleList.content">
        <CommentMarkdownRenderer
          :content="thread.content"
          :collapsed-lines="COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines"
          :expanded="isCommentExpanded(rootCommentKey(thread.id))"
          :collapsible="isCommentFoldable(rootCommentKey(thread.id), thread.content)"
          @overflow-change="updateCommentOverflow(rootCommentKey(thread.id), $event)"
        />
        <el-button
          v-if="isCommentFoldable(rootCommentKey(thread.id), thread.content)"
          class="comment-markdown-toggle"
          link
          type="primary"
          @click="toggleCommentExpansion(rootCommentKey(thread.id))"
        >
          {{ isCommentExpanded(rootCommentKey(thread.id)) ? '收起' : '展开' }}
        </el-button>
      </div>

      <section v-if="thread.replies.length > 0 || thread.hasMoreReplies" class="mt-5 border-l border-[var(--fsusblog-panel-border)] pl-4 sm:pl-5 space-y-4">
        <div
          v-for="reply in thread.replies"
          :key="reply.id"
          class="space-y-1"
          v-memo="[reply.id, reply.content, reply.canDelete, isCommentExpanded(replyCommentKey(reply.id)), isCommentFoldable(replyCommentKey(reply.id), reply.content)]"
        >
          <div class="flex items-center gap-2 text-[11px] text-[var(--fsusblog-text-muted)]">
            <strong class="text-[var(--fsusblog-text-secondary)]">{{ reply.author.displayName }}</strong>
            <span v-if="reply.replyToAuthor">回复 @{{ reply.replyToAuthor?.displayName }}</span>
            <span>{{ reply.time.relativeTimeText }}</span>
            <el-button
              link
              @click="$emit('reply', { id: reply.id, rootId: thread.rootId, author: reply.author, depth: 1 })"
            >
              {{ isLoggedIn ? '回复' : '登录后回复' }}
            </el-button>
            <el-button
              v-if="reply.canDelete"
              link
              type="danger"
              @click="$emit('delete', { id: reply.id, rootId: thread.rootId, parentId: thread.id, content: reply.content })"
            >
              删除
            </el-button>
          </div>
          <div class="text-sm text-[var(--fsusblog-text-tertiary)] leading-relaxed break-words">
            <CommentMarkdownRenderer
              :content="reply.content"
              :collapsed-lines="COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines"
              :expanded="isCommentExpanded(replyCommentKey(reply.id))"
              :collapsible="isCommentFoldable(replyCommentKey(reply.id), reply.content)"
              @overflow-change="updateCommentOverflow(replyCommentKey(reply.id), $event)"
            />
            <el-button
              v-if="isCommentFoldable(replyCommentKey(reply.id), reply.content)"
              class="comment-markdown-toggle"
              link
              type="primary"
              @click="toggleCommentExpansion(replyCommentKey(reply.id))"
            >
              {{ isCommentExpanded(replyCommentKey(reply.id)) ? '收起' : '展开' }}
            </el-button>
          </div>
        </div>

        <el-button
          v-if="thread.hasMoreReplies"
          link
          :disabled="isThreadRepliesLoading(thread.rootId)"
          :loading="isThreadRepliesLoading(thread.rootId)"
          @click="$emit('load-more-replies', thread.rootId)"
        >
          {{ isThreadRepliesLoading(thread.rootId) ? '加载中...' : '展开更多回复' }}
        </el-button>
      </section>
    </article>

    <div v-if="hasHiddenRootThreads" class="pt-2">
      <el-button link type="primary" @click="showMoreRootThreads">
        显示更多评论（{{ hiddenRootThreadCount }}）
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CommentAuthorView, CommentReplyPreviewItem, CommentThreadItem } from '@/api/comment'
import CommentMarkdownRenderer from '@/components/article/CommentMarkdownRenderer.vue'
import { commentDetailTokens, type CommentTimeContract } from '@/view-contracts/commentDetail'
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter'
import { TimeUtils } from '@/utils/time'

type ReplyTargetPayload = {
  id: string
  rootId: string
  author: CommentAuthorView
  depth: number
}

type DeletePayload = {
  id: string
  rootId: string
  parentId: string | null
  content: string
}

const props = defineProps<{
  threads: CommentThreadItem[]
  isAdmin: boolean
  isLoggedIn: boolean
  currentAccountId: number | null
  loadingReplies: Record<string, boolean>
  initialRenderLimit?: number
}>()

defineEmits<{
  (e: 'delete', payload: DeletePayload): void
  (e: 'reply', payload: ReplyTargetPayload): void
  (e: 'load-more-replies', rootId: string): void
}>()

const canDeleteByOwnership = (authorAccountId?: number | null): boolean =>
  props.isAdmin || (
    props.isLoggedIn &&
    typeof authorAccountId === 'number' &&
    typeof props.currentAccountId === 'number' &&
    authorAccountId === props.currentAccountId
  )

const buildTime = (iso: string): CommentTimeContract => ({
  isoTime: iso,
  relativeTimeText: TimeUtils.toRelative(iso),
  fullLocalTimeText: TimeUtils.toFullLocalString(iso)
})

const threadItems = computed(() => props.threads.map((thread) => ({
  ...thread,
  canDelete: canDeleteByOwnership(thread.authorAccountId),
  time: buildTime(thread.createTime),
  replies: thread.repliesPreview.slice(0, COMMENT_CONTENT_CONSTRAINT.replyRenderLimit).map((reply: CommentReplyPreviewItem) => ({
    ...reply,
    canDelete: canDeleteByOwnership(reply.authorAccountId),
    time: buildTime(reply.createTime)
  }))
})))
const rootRenderLimit = ref(props.initialRenderLimit ?? COMMENT_CONTENT_CONSTRAINT.rootRenderLimit)
const expandedCommentKeys = ref(new Set<string>())
const overflowCommentKeys = ref(new Set<string>())
const visibleThreadItems = computed(() => threadItems.value.slice(0, rootRenderLimit.value))
const hiddenRootThreadCount = computed(() => Math.max(0, threadItems.value.length - visibleThreadItems.value.length))
const hasHiddenRootThreads = computed(() => hiddenRootThreadCount.value > 0)

const isThreadRepliesLoading = (rootId: string): boolean => props.loadingReplies[rootId] === true
const showMoreRootThreads = (): void => {
  rootRenderLimit.value += COMMENT_CONTENT_CONSTRAINT.rootRenderLimit
}

const rootCommentKey = (id: string): string => `root:${id}`
const replyCommentKey = (id: string): string => `reply:${id}`
const isCommentExpanded = (key: string): boolean => expandedCommentKeys.value.has(key)
const isCommentFoldable = (key: string, content: string): boolean =>
  overflowCommentKeys.value.has(key) ||
  content.length > 360 ||
  content.split(/\r\n|\r|\n/u).length > COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines

const updateCommentOverflow = (key: string, hasOverflow: boolean): void => {
  const next = new Set(overflowCommentKeys.value)
  if (hasOverflow) {
    next.add(key)
  } else {
    next.delete(key)
  }
  overflowCommentKeys.value = next
}

const toggleCommentExpansion = (key: string): void => {
  const next = new Set(expandedCommentKeys.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedCommentKeys.value = next
}
</script>

<style scoped>
.comment-markdown-toggle {
  margin-top: 0.25rem;
  min-height: 1.75rem;
  padding: 0;
  font-size: 0.75rem;
  font-weight: 650;
}
</style>
