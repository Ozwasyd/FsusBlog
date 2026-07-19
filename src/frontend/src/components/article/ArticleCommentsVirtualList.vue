<template>
  <div class="fsus-comments-list" data-fsus-surface="reading">
    <article
      v-for="thread in visibleThreadItems"
      :key="thread.id"
      :class="commentDetailTokens.articleList.itemRoot"
      v-memo="[thread.id, thread.content, thread.replies.length, thread.canDelete, isCommentExpanded(rootCommentKey(thread.id)), isCommentFoldable(rootCommentKey(thread.id), thread.content)]"
    >
      <header :class="commentDetailTokens.articleList.headerRoot">
        <div :class="commentDetailTokens.articleList.headerMeta">
          <span
            :class="[
              commentDetailTokens.articleList.authorName,
              isAnonymousAuthor(thread.author) ? 'is-anonymous' : 'is-authenticated'
            ]"
          >
            {{ thread.author.displayName }}
          </span>
          <span v-if="isAnonymousAuthor(thread.author)" class="fsus-comment__badge">匿名</span>
        </div>
        <time
          :class="commentDetailTokens.articleList.timeText"
          :title="thread.time.fullLocalTimeText"
          :datetime="thread.time.isoTime"
        >
          {{ thread.time.relativeTimeText }}
        </time>
      </header>
      <div :class="commentDetailTokens.articleList.content">
        <CommentMarkdownRenderer
          :content="thread.content"
          :collapsed-lines="COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines"
          :expanded="isCommentExpanded(rootCommentKey(thread.id))"
          :collapsible="isCommentFoldable(rootCommentKey(thread.id), thread.content)"
          @overflow-change="updateCommentOverflow(rootCommentKey(thread.id), $event)"
        />
      </div>

      <footer :class="commentDetailTokens.articleList.footer">
        <button
          type="button"
          :class="commentDetailTokens.articleList.action"
          @click="$emit('reply', { id: thread.id, rootId: thread.rootId, author: thread.author, depth: 0 })"
        >
          {{ isLoggedIn ? '回复' : '登录后回复' }}
        </button>
        <button
          v-if="isCommentFoldable(rootCommentKey(thread.id), thread.content)"
          type="button"
          :class="commentDetailTokens.articleList.action"
          @click="toggleCommentExpansion(rootCommentKey(thread.id))"
        >
          {{ isCommentExpanded(rootCommentKey(thread.id)) ? '收起' : '展开' }}
        </button>
        <button
          v-if="thread.canDelete"
          type="button"
          :class="[commentDetailTokens.articleList.action, 'fsus-comment__action--danger']"
          aria-label="删除评论"
          @click="$emit('delete', { id: thread.id, rootId: thread.rootId, parentId: null, content: thread.content })"
        >
          删除
        </button>
      </footer>

      <section v-if="thread.replies.length > 0 || thread.hasMoreReplies" class="fsus-comment__replies">
        <div
          v-for="reply in thread.replies"
          :key="reply.id"
          class="fsus-comment fsus-comment--reply"
          v-memo="[reply.id, reply.content, reply.canDelete, isCommentExpanded(replyCommentKey(reply.id)), isCommentFoldable(replyCommentKey(reply.id), reply.content)]"
        >
          <header class="fsus-comment__header">
            <div class="fsus-comment__identity">
              <span
                :class="[
                  commentDetailTokens.articleList.authorName,
                  isAnonymousAuthor(reply.author) ? 'is-anonymous' : 'is-authenticated'
                ]"
              >
                {{ reply.author.displayName }}
              </span>
              <span v-if="isAnonymousAuthor(reply.author)" class="fsus-comment__badge">匿名</span>
              <span v-if="reply.replyToAuthor" class="fsus-comment__reply-target">
                回复 @{{ reply.replyToAuthor.displayName }}
              </span>
            </div>
            <time
              class="fsus-comment__time"
              :title="reply.time.fullLocalTimeText"
              :datetime="reply.time.isoTime"
            >
              {{ reply.time.relativeTimeText }}
            </time>
          </header>
          <div class="fsus-comment__content">
            <CommentMarkdownRenderer
              :content="reply.content"
              :collapsed-lines="COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines"
              :expanded="isCommentExpanded(replyCommentKey(reply.id))"
              :collapsible="isCommentFoldable(replyCommentKey(reply.id), reply.content)"
              @overflow-change="updateCommentOverflow(replyCommentKey(reply.id), $event)"
            />
          </div>

          <footer class="fsus-comment__footer">
            <button
              type="button"
              class="fsus-comment__action"
              @click="$emit('reply', { id: reply.id, rootId: thread.rootId, author: reply.author, depth: 1 })"
            >
              {{ isLoggedIn ? '回复' : '登录后回复' }}
            </button>
            <button
              v-if="isCommentFoldable(replyCommentKey(reply.id), reply.content)"
              type="button"
              class="fsus-comment__action"
              @click="toggleCommentExpansion(replyCommentKey(reply.id))"
            >
              {{ isCommentExpanded(replyCommentKey(reply.id)) ? '收起' : '展开' }}
            </button>
            <button
              v-if="reply.canDelete"
              type="button"
              class="fsus-comment__action fsus-comment__action--danger"
              aria-label="删除回复"
              @click="$emit('delete', { id: reply.id, rootId: thread.rootId, parentId: thread.id, content: reply.content })"
            >
              删除
            </button>
          </footer>
        </div>

        <button
          v-if="thread.hasMoreReplies"
          type="button"
          class="fsus-comment__action fsus-comment__load-more"
          :disabled="isThreadRepliesLoading(thread.rootId)"
          @click="$emit('load-more-replies', thread.rootId)"
        >
          {{ isThreadRepliesLoading(thread.rootId) ? '加载中...' : '展开更多回复' }}
        </button>
      </section>
    </article>

    <div v-if="hasHiddenRootThreads" class="fsus-comments-list__more">
      <button type="button" class="fsus-comment__action" @click="showMoreRootThreads">
        显示更多评论（{{ hiddenRootThreadCount }}）
      </button>
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
  ownedCommentIds: ReadonlySet<string>
  loadingReplies: Record<string, boolean>
  initialRenderLimit?: number
}>()

defineEmits<{
  (e: 'delete', payload: DeletePayload): void
  (e: 'reply', payload: ReplyTargetPayload): void
  (e: 'load-more-replies', rootId: string): void
}>()

const canDeleteByOwnership = (commentId: string): boolean =>
  props.isAdmin || props.ownedCommentIds.has(String(commentId))

const isAnonymousAuthor = (author: CommentAuthorView): boolean => author.mode !== 'public'

const formatCommentRelativeTime = (iso: string): string => {
  const target = TimeUtils._parse(iso)
  if (!target) return '时间未知'

  const diffMinutes = Math.floor((Date.now() - target.valueOf()) / 60000)
  if (diffMinutes < -1) {
    return target.local().format('MM-DD HH:mm')
  }
  if (diffMinutes <= 0) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes}分钟前`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}小时前`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}天前`

  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths < 12) return `${diffMonths}个月前`

  return `${Math.floor(diffMonths / 12)}年前`
}

const buildTime = (iso: string): CommentTimeContract => ({
  isoTime: iso,
  relativeTimeText: formatCommentRelativeTime(iso),
  fullLocalTimeText: TimeUtils.toFullLocalString(iso)
})

const threadItems = computed(() => props.threads.map((thread) => ({
  ...thread,
  canDelete: canDeleteByOwnership(thread.id),
  time: buildTime(thread.createTime),
  replies: thread.repliesPreview.slice(0, COMMENT_CONTENT_CONSTRAINT.replyRenderLimit).map((reply: CommentReplyPreviewItem) => ({
    ...reply,
    canDelete: canDeleteByOwnership(reply.id),
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
.fsus-comments-list {
  display: flex;
  flex-direction: column;
}

.fsus-comment {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-block: 20px;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  color: var(--fsusblog-text-primary);
  font-family: 'Google Sans', 'Noto Sans CJK', sans-serif;
  text-align: left;
}

.fsus-comment__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.fsus-comment__identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fsus-comment__author {
  font-size: 14px;
  line-height: 1.4;
}

.fsus-comment__author.is-authenticated {
  color: var(--fsusblog-text-primary);
  font-weight: 700;
}

.fsus-comment__author.is-anonymous {
  color: var(--fsusblog-text-quiet);
  font-weight: 400;
}

.fsus-comment__badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding-inline: 6px;
  border: 1px solid var(--fsusblog-panel-border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  line-height: 1;
}

.fsus-comment__reply-target,
.fsus-comment__time {
  color: var(--fsusblog-text-quiet);
  font-size: 14px;
  line-height: 1.4;
}

.fsus-comment__time {
  flex-shrink: 0;
  margin-left: 4px;
  font-variant-numeric: tabular-nums;
}

.fsus-comment__content {
  min-width: 0;
  overflow-wrap: anywhere;
}

.fsus-comment__content.fsus-markdown-body {
  margin-bottom: 4px;
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  line-height: 1.6;
  text-align: left;
}

.fsus-comment__footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.fsus-comment__action {
  padding: 0;
  border: none;
  border-radius: var(--fsusblog-reading-radius-control, 6px);
  background: transparent;
  color: var(--fsusblog-text-muted);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  transition: color var(--blog-motion-control) var(--blog-motion-ease);
}

.fsus-comment__action:hover {
  color: var(--fsusblog-color-primary);
}

.fsus-comment__action:focus-visible {
  outline: 2px solid var(--fsusblog-color-focus-ring);
  outline-offset: 4px;
  border-radius: var(--fsusblog-reading-radius-control, 6px);
}

.fsus-comment__action:disabled {
  cursor: default;
  opacity: 0.6;
}

.fsus-comment__replies {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 8px;
  padding-left: 16px;
  border-left: 2px solid var(--fsusblog-panel-border-strong);
}

.fsus-comment--reply {
  padding-block: 16px;
}

.fsus-comment__load-more,
.fsus-comments-list__more {
  align-self: flex-start;
  margin-top: 8px;
}

.fsus-comments-list__more {
  padding-block: 12px;
}

@media (max-width: 640px) {
  .fsus-comment__header {
    align-items: flex-start;
  }

  .fsus-comment__time {
    margin-left: 0;
  }
}

.fsus-comment__action--danger {
  color: var(--fsusblog-text-muted);
}

.fsus-comment__action--danger:hover {
  color: var(--el-color-danger);
}
</style>
